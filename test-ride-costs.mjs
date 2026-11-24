#!/usr/bin/env zx
// Runs citibike-ride-costs.js against a fake GraphQL server; see --help.
import vm from 'node:vm';

const HELP = `usage: test-ride-costs.mjs [-v]
       test-ride-costs.mjs --help | -h | help

Runs citibike-ride-costs.js in a vm against a fake /bikesharefe-gql server with
synthetic rides, and checks the exported rides and totals exactly match.

Cases vary what we can't observe directly:
  cursor semantics  exclusive (<), inclusive (<=), fuzzy (< cursor + 30s)
  faults            hangOnce    first request never answers (snippet must time out)
                    http502     every 3rd request is a bad gateway with an HTML body
                    partial     older windows error on their first try
                    deadWindow  May's windows always error: must be reported, not hidden
                    requestLimit  snippet stops after 3 requests: unfinished windows reported

  -v   show the snippet's own console output`;

if (['--help', '-h', 'help'].includes(argv._[0]) || argv.help || argv.h) {
  echo(HELP);
  process.exit(0);
}

// ── settings ──────────────────────────────────────────────────────────────────────
const SNIPPET = path.join(__dirname, 'citibike-ride-costs.js');
const NOW = new Date(2026, 10, 23, 16, 0).getTime(); // frozen "now"
const MS_PER_DAY = 86_400_000;
const MS_PER_MIN = 60_000;
const PERIOD_START = NOW - 365 * MS_PER_DAY;          // must match the snippet's LOOKBACK_DAYS
const CAP_CENTS = 365;                                // must match the snippet's PRICE_CAP_CENTS
const PAGE_SIZE = 10;                                 // the real server's page size
const PARTIAL_BEFORE = new Date(2026, 3, 1).getTime(); // partial: cursors older than this fail once
const DEAD_MONTH = new Date(2026, 4, 1).getMonth();   // deadWindow: cursors in May always fail
const REQUEST_LIMIT = 3;                              // requestLimit: stop after this many requests (a full run needs 7)

// ── synthetic rides: random 0–4 per day from Oct 2025, plus edge cases ────────────
let seed = 42;
const random = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const rides = [];
function addRide(startMs) {
  const minutes = 2 + Math.floor(random() * 40);
  const cents = random() < 0.1 ? 0 : Math.round(minutes * 29.4);
  rides.push({
    rideId: String(1_000_000 + rides.length), startTimeMs: String(startMs),
    duration: minutes * MS_PER_MIN,
    price: { formatted: `$${(cents / 100).toFixed(2)}` }, cents,
  });
}
for (let day = new Date(2025, 9, 1).getTime(); day < NOW; day += MS_PER_DAY) {
  const count = Math.floor(random() * 5);
  for (let i = 0; i < count; i++) addRide(day + Math.floor(random() * MS_PER_DAY));
}
for (let i = 0; i < 37; i++) addRide(new Date(2026, 5, 14).getTime() + i * 7 * MS_PER_MIN); // busy day
addRide(PERIOD_START);     // exactly at the period start: included
addRide(PERIOD_START - 1); // 1 ms before: excluded
rides.sort((a, b) => b.startTimeMs - a.startTimeMs);

// Same format as the snippet's `start` column.
const formatStart = (ms) => new Date(Number(ms)).toLocaleString('sv-SE', { timeZone: 'America/New_York' });
const expected = rides.filter((r) => r.startTimeMs >= PERIOD_START && r.startTimeMs < NOW);
const expectedCents = expected.reduce((sum, r) => sum + r.cents, 0);
const expectedCapped = expected.reduce((sum, r) => sum + Math.min(r.cents, CAP_CENTS), 0);

// ── fake server ───────────────────────────────────────────────────────────────────
const jsonResponse = (body) => ({ status: 200, json: async () => body });
const neverAnswer = (signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
const badGateway = { status: 502, json: async () => { throw new SyntaxError('Unexpected token <'); } };

function fakeServer({ cursorMode, fault }) {
  const isBefore = {
    exclusive: (t, cursor) => t < cursor,
    inclusive: (t, cursor) => t <= cursor,
    fuzzy: (t, cursor) => t < cursor + 30_000,
  }[cursorMode];
  const failedOnce = new Set();
  const stats = { requests: 0 };

  function windowFails(cursor) {
    if (fault === 'deadWindow') return new Date(cursor).getMonth() === DEAD_MONTH;
    if (fault === 'partial' && cursor < PARTIAL_BEFORE && !failedOnce.has(cursor)) return failedOnce.add(cursor);
    return false;
  }

  async function fetch(url, { body, signal }) {
    stats.requests += 1;
    if (fault === 'hangOnce' && stats.requests === 1) return neverAnswer(signal);
    if (fault === 'http502' && stats.requests % 3 === 0) return badGateway;

    const member = {};
    for (const [name, value] of Object.entries(JSON.parse(body).variables)) {
      const alias = `r${name.match(/\d+$/)[0]}`; // variable "cursor7" answers alias "r7"
      const cursor = Number(value);
      if (windowFails(cursor)) { member[alias] = null; continue; }
      const matching = rides.filter((r) => isBefore(Number(r.startTimeMs), cursor));
      member[alias] = { limit: PAGE_SIZE, hasMore: matching.length > PAGE_SIZE, rideHistoryList: matching.slice(0, PAGE_SIZE) };
    }
    return jsonResponse({ data: { member } });
  }
  return { fetch, stats };
}

// ── run cases ─────────────────────────────────────────────────────────────────────
const code = fs.readFileSync(SNIPPET, 'utf8');
const quiet = { log() {}, warn() {}, table() {} };
const CASES = [
  ...['exclusive', 'inclusive', 'fuzzy'].map((cursorMode) => ({ cursorMode, fault: 'none' })),
  ...['hangOnce', 'http502', 'partial', 'deadWindow', 'requestLimit'].map((fault) => ({ cursorMode: 'exclusive', fault })),
];
let failures = 0;
// Node doesn't let AbortSignal.timeout keep the process alive (browsers do), so a
// request that never answers would otherwise end the whole test run silently.
const keepAlive = setInterval(() => {}, 1_000);

for (const { cursorMode, fault } of CASES) {
  const server = fakeServer({ cursorMode, fault });
  const testHooks = {
    now: NOW, pauseMs: 0, maxRequests: fault === 'requestLimit' ? REQUEST_LIMIT : undefined, timeoutMs: 50, fetch: server.fetch,
    console: argv.v ? console : quiet,
  };
  const sandbox = { setTimeout, AbortSignal, URL, console, __CITIBIKE_TEST_HOOKS__: testHooks };
  const result = await vm.runInNewContext(code, sandbox);

  // Rows have no ride ID, so match them to expected rides by start time (count
  // per time, since two rides could start in the same second).
  const unmatched = new Map();
  for (const row of result.rows) unmatched.set(row.start, (unmatched.get(row.start) ?? 0) + 1);
  const missing = expected.filter((ride) => {
    const start = formatStart(ride.startTimeMs);
    if (!unmatched.get(start)) return true;
    unmatched.set(start, unmatched.get(start) - 1);
    return false;
  });
  const extra = [...unmatched.values()].reduce((sum, n) => sum + n, 0);

  let ok;
  if (fault === 'deadWindow' || fault === 'requestLimit') {
    // Failed windows must be reported, and every missing ride must fall inside one.
    const inFailedWindow = (ms) => result.failedWindows.some((w) => ms >= w.startMs && ms < w.cursorMs);
    ok = result.failedWindows.length > 0 && result.rows.length > expected.length / 2 && extra === 0
      && missing.every((r) => inFailedWindow(Number(r.startTimeMs)));
  } else {
    ok = missing.length === 0 && extra === 0 && result.failedWindows.length === 0
      && result.total.cents === expectedCents && result.total.cappedCents === expectedCapped
      && result.csv.split('\n').length === expected.length + 1;
  }
  if (!ok) failures += 1;
  echo(`${ok ? '✓ PASS' : '✗ FAIL'}  cursor ${cursorMode.padEnd(9)}  fault ${fault.padEnd(10)}`
    + `  rides ${result.rows.length}/${expected.length}  missing ${missing.length}  extra ${extra}`
    + `  failed windows ${result.failedWindows.length}  requests ${server.stats.requests}`);
}

clearInterval(keepAlive);
const dollars = (cents) => `$${(cents / 100).toFixed(2)}`;
echo(failures
  ? `\n✗ ${failures} case(s) failed`
  : `\n✓ all cases pass (${expected.length} rides, ${dollars(expectedCents)}, capped ${dollars(expectedCapped)})`);
process.exit(failures ? 1 : 0);
