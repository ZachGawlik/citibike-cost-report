#!/usr/bin/env zx
// Runs citibike-ride-costs.js against mock GraphQL servers; see --help.
import vm from 'node:vm';

// ── tunables ──────────────────────────────────────────────────────────────────────
const SNIPPET = path.join(__dirname, 'citibike-ride-costs.js');
const YEAR = 2026;                                  // year the snippet exports
const NOW = new Date(2026, 10, 23, 16, 0).getTime(); // frozen "now" (2026-11-23 16:00)
const DATA_START = new Date(2025, 11, 1).getTime(); // synthetic rides begin (before YEAR, to test the floor)
const RIDES_PER_DAY_MAX = 4;                        // random 0..max rides per normal day
const BURST_DAY = new Date(2026, 5, 14).getTime();  // one day with far more rides than a page holds
const BURST_RIDES = 37;
const SERVER_DEFAULT_LIMIT = 10;                    // real server's page size
const FUZZ_MS = 30_000;                             // "fuzzy" cursor variant: includes rides up to cursor+30s
const SEED = 42;
const CAP_CENTS = 365;                              // must match the snippet's PRICE_CAP_CENTS default
const FLAKY_BEFORE = new Date(2026, 3, 1).getTime(); // nullOnce/hangOnce: cursors older than this fail on first try
const DEAD_CURSOR_MONTH = '2026-05-';               // deadPage fault: cursors in this month always fail
const HTTP502_EVERY = 3;                            // http502 fault: every Nth request is a bad gateway
const TEST_TIMEOUT_MS = 50;                         // snippet request timeout during tests (hangOnce fault)
const MS_PER_DAY = 86_400_000;
const MS_PER_MIN = 60_000;

const HELP = `usage: test-ride-costs.mjs [-v]
       test-ride-costs.mjs --help | -h | help

Runs citibike-ride-costs.js in a vm against mock /bikesharefe-gql servers.
The mock data is synthetic: random rides from Dec 2025 plus a ${BURST_RIDES}-ride burst day.
Each case checks the exported ride set, total, capped total, and that the request
count stays within one request per ${SERVER_DEFAULT_LIMIT - 1} rides (+1).

Server variants cover what we can't observe directly:
  cursor semantics: exclusive (<), inclusive (<=), fuzzy (< cursor+30s)
  faults: hangOnce  (older pages hang on first try)
          http502   (every ${HTTP502_EVERY}rd request, HTML body)
          nullOnce  (older pages return null + GraphQL error on first try)
          deadPage  (pages in one month always fail: run must stop loudly)

  -v   show the snippet's own console output`;

if (['--help', '-h'].includes(argv._[0] ?? '') || argv.help || argv.h || argv._[0] === 'help') {
  echo(HELP);
  process.exit(0);
}

// ── synthetic ground truth ────────────────────────────────────────────────────────
let seed = SEED;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const rides = [];
let id = 1_000_000;
const addRide = (t) => {
  const mins = 2 + Math.floor(rand() * 40);
  const cents = rand() < 0.1 ? 0 : Math.round(mins * 29.4);
  rides.push({
    __typename: 'Ride', rideId: String(id++), startTimeMs: String(t), endTimeMs: String(t + mins * MS_PER_MIN),
    duration: mins * MS_PER_MIN, rideableName: `${100 + (id % 900)}-${1000 + (id % 9000)}`,
    price: { __typename: 'Money', amount: cents, currency: 'USD', formatted: `$${(cents / 100).toFixed(2)}` },
  });
};
for (let d = DATA_START; d < NOW; d += MS_PER_DAY) {
  const n = Math.floor(rand() * (RIDES_PER_DAY_MAX + 1));
  for (let i = 0; i < n; i++) addRide(d + Math.floor(rand() * MS_PER_DAY));
}
for (let i = 0; i < BURST_RIDES; i++) addRide(BURST_DAY + i * 7 * MS_PER_MIN);
addRide(new Date(YEAR, 0, 1).getTime());         // exactly at the year start
addRide(new Date(YEAR, 0, 1).getTime() - 1);     // 1ms before: must be excluded
rides.sort((a, b) => b.startTimeMs - a.startTimeMs);

const yearStart = new Date(YEAR, 0, 1).getTime();
const truth = rides.filter((r) => r.startTimeMs >= yearStart && r.startTimeMs < NOW);
const truthCents = truth.reduce((s, r) => s + r.price.amount, 0);
const truthCapped = truth.reduce((s, r) => s + Math.min(r.price.amount, CAP_CENTS), 0);
const maxRequests = Math.ceil(truth.length / (SERVER_DEFAULT_LIMIT - 1)) + 1; // inclusive cursor repeats 1/page

// ── mock server ───────────────────────────────────────────────────────────────────
const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
const dayOf = (ms) => new Date(ms).toLocaleDateString('sv-SE', { timeZone: 'America/New_York' });
const hang = (signal) => new Promise((_, rej) => signal.addEventListener('abort', () => rej(new Error('aborted'))));
const nullPage = () => json({ data: { member: { id: 'u1', rideHistory: null } }, errors: [{ message: 'Internal server error' }] });

// Faults; returning a value short-circuits the normal response.
const FAULTS = {
  hangOnce: ({ cursor, seen, signal }) => (cursor < FLAKY_BEFORE && !seen.has(cursor) && seen.add(cursor) ? hang(signal) : null),
  http502: ({ stats }) => (stats.requests % HTTP502_EVERY === 0
    ? { ok: false, status: 502, json: async () => { throw new SyntaxError('Unexpected token <'); } }
    : null),
  nullOnce: ({ cursor, seen }) => (cursor < FLAKY_BEFORE && !seen.has(cursor) && seen.add(cursor) ? nullPage() : null),
  deadPage: ({ cursor }) => (dayOf(cursor).startsWith(DEAD_CURSOR_MONTH) ? nullPage() : null),
};

function mockFetch({ cursorMode, fault, stats }) {
  const before = {
    exclusive: (t, c) => t < c,
    inclusive: (t, c) => t <= c,
    fuzzy: (t, c) => t < c + FUZZ_MS,
  }[cursorMode];
  const seen = new Set();
  return async (url, opts) => {
    stats.requests++;
    const { variables } = JSON.parse(opts.body);
    const cursor = variables.startTimeMs == null ? Infinity : Number(variables.startTimeMs);
    const short = FAULTS[fault]?.({ cursor, seen, signal: opts.signal, stats });
    if (short) return short;
    const matching = rides.filter((r) => before(Number(r.startTimeMs), cursor));
    return json({ data: { member: { __typename: 'User', id: 'u1', rideHistory: {
      limit: SERVER_DEFAULT_LIMIT, hasMore: matching.length > SERVER_DEFAULT_LIMIT,
      rideHistoryList: matching.slice(0, SERVER_DEFAULT_LIMIT),
    } } } });
  };
}

// ── run cases ─────────────────────────────────────────────────────────────────────
const code = fs.readFileSync(SNIPPET, 'utf8');
const quiet = { log() {}, warn() {}, table() {}, error() {} };
const CASES = [
  ...['exclusive', 'inclusive', 'fuzzy'].map((cursorMode) => ({ cursorMode, fault: 'none' })),
  ...['hangOnce', 'http502', 'nullOnce', 'deadPage'].map((fault) => ({ cursorMode: 'exclusive', fault })),
];
let failures = 0;

for (const { cursorMode, fault } of CASES) {
  const stats = { requests: 0 };
  let downloaded;
  const env = {
    year: YEAR, now: () => NOW, gapMs: 0, timeoutMs: TEST_TIMEOUT_MS,
    fetch: mockFetch({ cursorMode, fault, stats }),
    console: argv.v ? console : quiet,
    download: (name, csv) => { downloaded = { name, csv }; },
  };
  const sandbox = { setTimeout, clearTimeout, AbortController, URL, console: argv.v ? console : quiet, __CITIBIKE_ENV__: env };
  let res, err;
  try { res = await vm.runInNewContext(code, sandbox); } catch (e) { err = e; }

  let ok, detail;
  if (fault === 'deadPage') {
    // Expected: the run stops with an error naming the failed page; no silent partial export.
    const partial = sandbox.citibikeRidesPartial;
    ok = Boolean(err) && /failed 3×/.test(err.message) && !downloaded && partial?.size > 0;
    detail = `stopped: ${err ? err.message.slice(0, 60) : 'NO ERROR'}  partial ${partial?.size ?? 0} rides`;
  } else {
    const got = new Set(res.rows.map((r) => r.rideId));
    const missing = truth.filter((r) => !got.has(r.rideId)).length;
    const extra = res.rows.filter((r) => !truth.some((t) => t.rideId === r.rideId)).length;
    const pageRequests = res.requests;
    ok = missing === 0 && extra === 0 && res.totalCents === truthCents
      && res.cappedCents === truthCapped && res.savedCents === truthCents - truthCapped
      && pageRequests <= maxRequests && downloaded?.csv.split('\n').length === truth.length + 1;
    detail = `rides ${res.rows.length}/${truth.length}  missing ${missing}  extra ${extra}`
      + `  pages ${pageRequests} (≤${maxRequests})  http ${stats.requests}`;
  }
  if (!ok) failures++;
  echo(`${ok ? '✓ PASS' : '✗ FAIL'}  cursor ${cursorMode.padEnd(9)}  fault ${fault.padEnd(8)}  ${detail}`);
}
echo(failures
  ? `\n✗ ${failures} case(s) failed`
  : `\n✓ all cases pass (${truth.length} rides, $${(truthCents / 100).toFixed(2)}, capped $${(truthCapped / 100).toFixed(2)})`);
process.exit(failures ? 1 : 0);
