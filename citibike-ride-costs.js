// Citi Bike: export one year of ride costs to CSV. Paste into the DevTools console on
// https://account.citibikenyc.com/ride-history while logged in. Edit YEAR below first.
//
// Fetching: plain sequential paging, the same way the page's "Show more" button
// works. One GraphQL request = one page of rides (the server fixes the page size at
// 10; `limit` is rejected). Each request's cursor is the oldest ride of the previous
// page, starting from Jan 1 of the following year, and the crawl stops once a page
// reaches back past Jan 1 of YEAR. Cost: about one request per 10 rides in the year,
// plus one.
//
// Monthly/yearly totals and the price-cap math are computed afterwards from the
// fetched rides. The result lands in `citibikeRides` (window global), and a CSV is
// downloaded.
(async (env = {}) => {
  // ── tunables ────────────────────────────────────────────────────────────────────
  const YEAR = env.year ?? new Date().getFullYear(); // calendar year to export
  const TIME_ZONE = 'America/New_York';               // timestamps in the CSV / month buckets
  const ENDPOINT = '/bikesharefe-gql';                // same-origin GraphQL endpoint the page uses
  const CURSOR_BACKOFF_MS = 30_000;                   // the page's own step, used only if a page makes no progress
  const REQUEST_GAP_MS = env.gapMs ?? 300;            // pause between requests (be polite)
  const REQUEST_TIMEOUT_MS = env.timeoutMs ?? 45_000; // abort a request that hangs this long
  const RETRY_BACKOFF_MS = env.gapMs ?? 3_000;        // pause after a failed request
  const MAX_TRIES = 3;                                // attempts per page before stopping
  const MAX_REQUESTS = 1_000;                         // runaway guard (~10,000 rides)
  const PRICE_CAP_CENTS = env.capCents ?? 365;        // hypothetical per-ride price ceiling ($3.65)
  const CSV_LOCALE = 'sv-SE';                         // locale whose format is "YYYY-MM-DD HH:MM:SS"
  const CSV_COLUMNS = ['rideId', 'start', 'end', 'minutes', 'bike', 'price', 'cents', 'cappedCents', 'amountRaw', 'currency'];
  const MS_PER_MIN = 60_000;

  const doFetch = env.fetch ?? globalThis.fetch.bind(globalThis);
  const now = env.now ?? Date.now;
  const log = env.console ?? console;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const QUERY = `query CitibikeRidePage($startTimeMs: String) {
    member { id rideHistory(startTimeMs: $startTimeMs) { limit hasMore rideHistoryList {
      rideId startTimeMs endTimeMs duration rideableName price { amount currency formatted } } } } }`;

  // ── small helpers ───────────────────────────────────────────────────────────────
  const localTime = (ms) => new Date(Number(ms)).toLocaleString(CSV_LOCALE, { timeZone: TIME_ZONE });
  const dollars = (c) => `$${(c / 100).toFixed(2)}`;
  const toCents = (formatted) => {
    const m = /(-)?\$?\s*([\d,]+)\.(\d{2})/.exec(formatted ?? '');
    if (!m) return null;
    return (m[1] ? -1 : 1) * (Number(m[2].replace(/,/g, '')) * 100 + Number(m[3]));
  };

  // ── network ─────────────────────────────────────────────────────────────────────
  // Returns the parsed body ({data, errors}); throws on timeout, HTTP error without
  // a JSON body, or network failure.
  async function gql(variables) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await doFetch(ENDPOINT, {
        method: 'POST',
        credentials: 'include',
        signal: ctl.signal,
        headers: { 'content-type': 'application/json', 'Apollo-Require-Preflight': 'true' },
        body: JSON.stringify({ operationName: 'CitibikeRidePage', query: QUERY, variables }),
      });
      let body;
      try { body = await res.json(); } catch { body = null; }
      if (!body) throw new Error(`HTTP ${res.status} with no JSON body${res.status === 401 ? ' (logged out?)' : ''}`);
      return body;
    } catch (e) {
      if (ctl.signal.aborted) throw new Error(`timed out after ${REQUEST_TIMEOUT_MS / 1000}s`);
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  // One page, retried up to MAX_TRIES. Each cursor depends on the previous page, so
  // a page that keeps failing stops the run (rides so far stay in
  // citibikeRidesPartial).
  async function fetchPage(cursor) {
    for (let attempt = 1; ; attempt++) {
      let why;
      try {
        const res = await gql({ startTimeMs: String(cursor) });
        const page = res.data?.member?.rideHistory;
        if (page) return page;
        why = `GraphQL error: ${res.errors?.map((e) => e.message).join('; ') ?? 'no data'}`;
      } catch (e) {
        why = e.message;
      }
      if (attempt >= MAX_TRIES) throw new Error(`page before ${localTime(cursor)} failed ${MAX_TRIES}×: ${why}`);
      log.warn(`  ↻ ${why} — try ${attempt + 1}/${MAX_TRIES}`);
      await sleep(RETRY_BACKOFF_MS);
    }
  }

  // ── step 1: fetch every ride in [yearStart, yearEnd), newest first ──────────────
  async function crawlYear(yearStart, yearEnd) {
    const rides = new Map(); // rideId → raw ride; dedupes any page overlap
    globalThis.citibikeRidesPartial = rides;
    let requests = 0;
    let cursor = yearEnd;
    for (;;) {
      if (requests >= MAX_REQUESTS) throw new Error(`gave up after ${MAX_REQUESTS} requests`);
      requests++;
      const page = await fetchPage(cursor);
      const list = page.rideHistoryList ?? [];
      let oldest = Infinity;
      for (const r of list) {
        const t = Number(r.startTimeMs);
        oldest = Math.min(oldest, t);
        if (t >= yearStart && t < yearEnd) rides.set(r.rideId, r);
      }
      log.log(`request ${requests}: ${list.length} rides back to ${list.length ? localTime(oldest) : '—'}`
        + ` → ${rides.size} in ${YEAR} so far`);
      if (!list.length || !page.hasMore || oldest < yearStart) break;
      // Next page starts at this page's oldest ride; dedupe by rideId absorbs any
      // overlap if the server treats the cursor inclusively.
      cursor = oldest < cursor ? oldest : cursor - CURSOR_BACKOFF_MS;
      await sleep(REQUEST_GAP_MS);
    }
    return { rides, requests };
  }

  // ── step 2: raw rides → flat rows (newest first), with capped price ─────────────
  function toRows(rides) {
    return [...rides.values()]
      .sort((a, b) => Number(b.startTimeMs) - Number(a.startTimeMs))
      .map((r) => {
        const cents = toCents(r.price?.formatted);
        return {
          rideId: r.rideId,
          start: localTime(r.startTimeMs),
          end: localTime(r.endTimeMs),
          minutes: Math.round(Number(r.duration) / MS_PER_MIN),
          bike: r.rideableName,
          price: r.price?.formatted ?? '',
          cents,
          cappedCents: Math.min(cents ?? 0, PRICE_CAP_CENTS),
          amountRaw: r.price?.amount ?? '',
          currency: r.price?.currency ?? '',
        };
      });
  }

  // ── step 3: per-month and whole-year totals, actual vs capped ───────────────────
  function summarize(rows) {
    const bucket = () => ({ rides: 0, minutes: 0, cents: 0, capped: 0, over: 0, free: 0 });
    const months = {};
    const year = bucket();
    for (const r of rows) {
      for (const m of [(months[r.start.slice(0, 7)] ??= bucket()), year]) {
        m.rides++; m.minutes += r.minutes; m.cents += r.cents ?? 0; m.capped += r.cappedCents;
        if (r.cents > PRICE_CAP_CENTS) m.over++;
        if (r.cents === 0) m.free++;
      }
    }
    return { months, year, unparsed: rows.filter((r) => r.cents === null) };
  }

  function monthTable({ months, year }) {
    const capLabel = dollars(PRICE_CAP_CENTS);
    const tableRow = (m) => ({
      rides: m.rides, free: m.free, minutes: m.minutes, total: dollars(m.cents),
      [`rides > ${capLabel}`]: m.over, 'capped total': dollars(m.capped), saved: dollars(m.cents - m.capped),
    });
    const table = Object.fromEntries(Object.entries(months).sort().map(([k, m]) => [k, tableRow(m)]));
    table[`${YEAR} total`] = tableRow(year); // non-numeric key, so console.table lists it last
    return table;
  }

  // ── step 4: console report ──────────────────────────────────────────────────────
  function report({ rows, summary, requests }) {
    const { year, unparsed } = summary;
    log.table(monthTable(summary));
    log.log([
      `${YEAR}: ${rows.length} rides, total ${dollars(year.cents)}`,
      `with a ${dollars(PRICE_CAP_CENTS)}/ride cap: ${dollars(year.capped)}, saving ${dollars(year.cents - year.capped)}`
        + ` across ${year.over} rides over the cap`,
      `requests: ${requests} for ${rows.length} rides`,
      unparsed.length ? `✗ ${unparsed.length} prices could not be parsed: ${unparsed.map((r) => r.price).join(', ')}` : '',
    ].filter(Boolean).join('\n'));
  }

  // ── step 5: CSV download ────────────────────────────────────────────────────────
  function toCsv(rows) {
    const esc = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? ''));
    return [CSV_COLUMNS.join(','), ...rows.map((r) => CSV_COLUMNS.map((c) => esc(r[c])).join(','))].join('\n');
  }

  function download(csv) {
    const today = new Date().toLocaleDateString(CSV_LOCALE, { timeZone: TIME_ZONE });
    const filename = `${today}-citibike-rides-${YEAR}.csv`;
    if (env.download) return env.download(filename, csv);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // ── main ────────────────────────────────────────────────────────────────────────
  const yearStart = new Date(YEAR, 0, 1).getTime();
  const yearEnd = Math.min(new Date(YEAR + 1, 0, 1).getTime(), now());

  const { rides, requests } = await crawlYear(yearStart, yearEnd);
  const rows = toRows(rides);
  const summary = summarize(rows);
  report({ rows, summary, requests });
  const csv = toCsv(rows);
  download(csv);

  const { cents: totalCents, capped: cappedCents, over: overCap } = summary.year;
  const result = {
    year: YEAR, rows, totalCents, cappedCents, savedCents: totalCents - cappedCents, overCap,
    requests, csv,
  };
  globalThis.citibikeRides = result;
  return result;
})(typeof __CITIBIKE_ENV__ !== 'undefined' ? __CITIBIKE_ENV__ : {})
  .catch((e) => { console.error('✗ citibike snippet stopped:', e); throw e; });
