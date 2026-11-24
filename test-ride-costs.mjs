#!/usr/bin/env zx
// Runs citibike-ride-costs.js against mock GraphQL servers; see --help.
import vm from 'node:vm';

// ── tunables ──────────────────────────────────────────────────────────────────────
const SNIPPET = path.join(__dirname, 'citibike-ride-costs.js');
const LOOKBACK_DAYS = 365;                          // must match the snippet's LOOKBACK_DAYS default
const NOW = new Date(2026, 10, 23, 16, 0).getTime(); // frozen "now" (2026-11-23 16:00)
const DATA_START = new Date(2025, 9, 1).getTime();  // synthetic rides begin (before the lookback, to test the floor)
const RIDES_PER_DAY_MAX = 4;                        // random 0..max rides per normal day
const BURST_DAY = new Date(2026, 5, 14).getTime();  // one day with far more rides than a page holds
const BURST_RIDES = 37;
const SERVER_DEFAULT_LIMIT = 10;                    // real server's page size
const FUZZ_MS = 30_000;                             // "fuzzy" cursor variant: includes rides up to cursor+30s
const SEED = 42;
const ALIAS_CAP = 12;                               // sizeCap/hang faults: max aliases the mock tolerates
const PARTIAL_BEFORE = new Date(2026, 3, 1).getTime(); // partial fault: older cursors fail on first try
const DEAD_CURSOR_MONTH = '2026-05-';               // deadWindow fault: cursors in this month always fail
const HTTP502_EVERY = 3;                            // http502 fault: every Nth request is a bad gateway
const TEST_TIMEOUT_MS = 50;                         // snippet request timeout during tests (hang fault)
const MS_PER_DAY = 86_400_000;
const MS_PER_MIN = 60_000;
const PERIOD_START = NOW - LOOKBACK_DAYS * MS_PER_DAY; // earliest ride the snippet should include

const HELP = `usage: test-ride-costs.mjs [-v]
       test-ride-costs.mjs --help | -h | help

Runs citibike-ride-costs.js in a vm against mock /bikesharefe-gql servers.
The mock data is synthetic: random rides from Dec 2025 plus a ${BURST_RIDES}-ride burst day.
Each case checks that the exported ride set and total exactly match the truth.

Server variants cover what we can't observe directly:
  cursor semantics: exclusive (<), inclusive (<=), fuzzy (< cursor+30s)
  faults: sizeCap  (HTTP 400 above ${ALIAS_CAP} aliases)
          hang     (no response above ${ALIAS_CAP} aliases)
          http502  (every ${HTTP502_EVERY}rd request, HTML body)
          partial  (some aliases null on first try)
          deadWindow (one month always fails: must be reported, not hidden)

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
addRide(PERIOD_START);                           // exactly at the lookback start
addRide(PERIOD_START - 1);                       // 1ms before: must be excluded
rides.sort((a, b) => b.startTimeMs - a.startTimeMs);


const truth = rides.filter((r) => r.startTimeMs >= PERIOD_START && r.startTimeMs < NOW);
const truthCents = truth.reduce((s, r) => s + r.price.amount, 0);
const CAP_CENTS = 365;                           // must match the snippet's PRICE_CAP_CENTS default
const truthCapped = truth.reduce((s, r) => s + Math.min(r.price.amount, CAP_CENTS), 0);

// ── mock server ───────────────────────────────────────────────────────────────────
const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
const dayOf = (ms) => new Date(ms).toLocaleDateString('sv-SE', { timeZone: 'America/New_York' });

// Whole-request faults; returning a value short-circuits the normal response.
const FAULTS = {
  sizeCap: ({ n }) => (n > ALIAS_CAP ? json({ errors: [{ message: 'Query is too complex' }] }, 400) : null),
  hang: ({ n, signal }) => (n > ALIAS_CAP
    ? new Promise((_, rej) => signal.addEventListener('abort', () => rej(new Error('aborted'))))
    : null),
  http502: ({ stats }) => (stats.requests % HTTP502_EVERY === 0
    ? { ok: false, status: 502, json: async () => { throw new SyntaxError('Unexpected token <'); } }
    : null),
};
// Per-alias faults: true nulls out that alias and adds an error entry.
const ALIAS_FAULTS = {
  partial: (cursor, seen) => cursor < PARTIAL_BEFORE && !seen.has(cursor) && Boolean(seen.add(cursor)),
  deadWindow: (cursor) => dayOf(cursor).startsWith(DEAD_CURSOR_MONTH),
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
    const { query, variables } = JSON.parse(opts.body);
    if (/limit:/.test(query)) {
      return json({ errors: [{ message: 'Unknown argument "limit" on field "User.rideHistory".' }] }, 400);
    }
    const n = Object.keys(variables).length;
    const short = FAULTS[fault]?.({ n, signal: opts.signal, stats });
    if (short) return short;
    const member = { __typename: 'User', id: 'u1' };
    const errors = [];
    for (const [k, v] of Object.entries(variables)) {
      const alias = `r${k.slice(1)}`;
      const cursor = v === null ? Infinity : Number(v);
      if (ALIAS_FAULTS[fault]?.(cursor, seen)) {
        member[alias] = null;
        errors.push({ message: 'Internal server error', path: ['member', alias] });
        continue;
      }
      const matching = rides.filter((r) => before(Number(r.startTimeMs), cursor));
      member[alias] = {
        limit: SERVER_DEFAULT_LIMIT, hasMore: matching.length > SERVER_DEFAULT_LIMIT,
        rideHistoryList: matching.slice(0, SERVER_DEFAULT_LIMIT),
      };
    }
    return json(errors.length ? { data: { member }, errors } : { data: { member } });
  };
}

// ── run cases ─────────────────────────────────────────────────────────────────────
const code = fs.readFileSync(SNIPPET, 'utf8');
const quiet = { log() {}, warn() {}, table() {} };
const sandbox = { setTimeout, clearTimeout, AbortController, URL, console };
const CASES = [
  ...['exclusive', 'inclusive', 'fuzzy'].map((cursorMode) => ({ cursorMode, fault: 'none' })),
  ...['sizeCap', 'hang', 'http502', 'partial', 'deadWindow'].map((fault) => ({ cursorMode: 'exclusive', fault })),
];
let failures = 0;

for (const { cursorMode, fault } of CASES) {
  const stats = { requests: 0 };
  let downloaded;
  const env = {
    now: () => NOW, gapMs: 0, timeoutMs: TEST_TIMEOUT_MS,
    fetch: mockFetch({ cursorMode, fault, stats }),
    console: argv.v ? console : quiet,
    download: (name, csv) => { downloaded = { name, csv }; },
  };
  const res = await vm.runInNewContext(code, { ...sandbox, __CITIBIKE_ENV__: env });
  const got = new Set(res.rows.map((r) => r.rideId));
  const missingRides = truth.filter((r) => !got.has(r.rideId));
  const extra = res.rows.filter((r) => !truth.some((t) => t.rideId === r.rideId)).length;
  let ok;
  if (fault === 'deadWindow') {
    // Expected: those windows are reported failed, and every missing ride falls inside one.
    const inFailed = (t) => res.failed.some((w) => t >= w.floor && t < w.cursor);
    ok = res.failed.length > 0 && extra === 0 && missingRides.every((r) => inFailed(Number(r.startTimeMs)));
  } else {
    ok = missingRides.length === 0 && extra === 0 && res.totalCents === truthCents && res.failed.length === 0
      && res.cappedCents === truthCapped && res.savedCents === truthCents - truthCapped
      && downloaded?.csv.split('\n').length === truth.length + 1;
  }
  if (!ok) failures++;
  echo(`${ok ? '✓ PASS' : '✗ FAIL'}  cursor ${cursorMode.padEnd(9)}  fault ${fault.padEnd(10)}`
    + `  rides ${String(res.rows.length).padStart(3)}/${truth.length}  missing ${String(missingRides.length).padStart(2)}`
    + `  extra ${extra}  failed windows ${String(res.failed.length).padStart(2)}  requests ${stats.requests}`);
}
const seq = Math.ceil(truth.length / SERVER_DEFAULT_LIMIT);
echo(failures
  ? `\n✗ ${failures} case(s) failed`
  : `\n✓ all cases pass (${truth.length} rides, $${(truthCents / 100).toFixed(2)}, capped $${(truthCapped / 100).toFixed(2)}; page-by-page would need ~${seq} requests)`);
process.exit(failures ? 1 : 0);
