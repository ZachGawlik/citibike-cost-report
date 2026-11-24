// Citi Bike: export the last 365 days of ride costs to CSV. Paste into the DevTools
// console on https://account.citibikenyc.com/ride-history while logged in.
//
// Fetching: the server pages by time ("rides before startTimeMs", 10 at a time, no
// page-size arg). To cut round trips, the period is split into WINDOW_DAYS windows and
// one cursor per window goes into a single GraphQL request as field aliases
// (r0..rN); a window only gets a follow-up lookup if its page filled before
// reaching the window's start.
//
// Monthly/period totals and the price-cap math are computed afterwards from the
// fetched rides. The result lands in `citibikeRides` (window global), and a CSV is
// downloaded.
(async (env = {}) => {
  // ── tunables ────────────────────────────────────────────────────────────────────
  const LOOKBACK_DAYS = env.days ?? 365;              // export rides that started within this many days of now
  const TIME_ZONE = 'America/New_York';               // timestamps in the CSV / month buckets
  const ENDPOINT = '/bikesharefe-gql';                // same-origin GraphQL endpoint the page uses
  const WINDOW_DAYS = 4;                              // span per cursor; aim for <10 rides/window
  const ALIASES_PER_REQUEST = 30;                     // cursors batched into one request
  const CURSOR_BACKOFF_MS = 30_000;                   // the page's own step, used if no progress
  const REQUEST_GAP_MS = env.gapMs ?? 300;            // pause between requests (be polite)
  const REQUEST_TIMEOUT_MS = env.timeoutMs ?? 45_000; // abort a request that hangs this long
  const RETRY_BACKOFF_MS = env.gapMs ?? 3_000;        // pause after a failed request
  const MAX_TRIES = 3;                                // attempts per single window before skipping it
  const MAX_REQUESTS = 600;                           // runaway guard
  const PRICE_CAP_CENTS = env.capCents ?? 365;        // hypothetical per-ride price ceiling ($3.65)
  const CSV_LOCALE = 'sv-SE';                         // locale whose format is "YYYY-MM-DD HH:MM:SS"
  const CSV_COLUMNS = ['rideId', 'start', 'end', 'minutes', 'bike', 'price', 'cents', 'cappedCents', 'amountRaw', 'currency'];
  const MS_PER_DAY = 86_400_000;
  const PERIOD_LABEL = `last ${LOOKBACK_DAYS} days`;
  const MS_PER_MIN = 60_000;

  const doFetch = env.fetch ?? globalThis.fetch.bind(globalThis);
  const now = env.now ?? Date.now;
  const log = env.console ?? console;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const RIDE_FIELDS = `limit hasMore rideHistoryList {
    rideId startTimeMs endTimeMs duration rideableName price { amount currency formatted } }`;

  // ── small helpers ───────────────────────────────────────────────────────────────
  const localTime = (ms) => new Date(Number(ms)).toLocaleString(CSV_LOCALE, { timeZone: TIME_ZONE });
  const day = (ms) => new Date(ms).toLocaleDateString(CSV_LOCALE, { timeZone: TIME_ZONE });
  const span = (ws) => `${day(Math.min(...ws.map((w) => w.floor)))}..${day(Math.max(...ws.map((w) => w.cursor)))}`;
  const dollars = (c) => `$${(c / 100).toFixed(2)}`;
  const toCents = (formatted) => {
    const m = /(-)?\$?\s*([\d,]+)\.(\d{2})/.exec(formatted ?? '');
    if (!m) return null;
    return (m[1] ? -1 : 1) * (Number(m[2].replace(/,/g, '')) * 100 + Number(m[3]));
  };

  // ── network ─────────────────────────────────────────────────────────────────────
  function buildQuery(n) {
    const vars = Array.from({ length: n }, (_, i) => `$c${i}: String`).join(', ');
    const fields = Array.from({ length: n }, (_, i) =>
      `r${i}: rideHistory(startTimeMs: $c${i}) { ${RIDE_FIELDS} }`).join('\n');
    return `query CitibikeYearRides(${vars}) { member { id\n${fields} } }`;
  }

  // Returns the parsed body ({data, errors}); throws on timeout, HTTP error without
  // a JSON body, or network failure.
  async function gql(query, variables) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await doFetch(ENDPOINT, {
        method: 'POST',
        credentials: 'include',
        signal: ctl.signal,
        headers: { 'content-type': 'application/json', 'Apollo-Require-Preflight': 'true' },
        body: JSON.stringify({ operationName: 'CitibikeYearRides', query, variables }),
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

  // ── step 1: fetch every ride in [periodStart, periodEnd) via batched windows ───
  // A failed request (error, timeout, HTTP 4xx/5xx) is split in half and retried,
  // so one bad window or a server-side size limit can't stall the whole run. A
  // single window that keeps failing is recorded in `failed` and skipped.
  async function crawlPeriod(periodStart, periodEnd) {
    const windowMs = WINDOW_DAYS * MS_PER_DAY;
    const pending = [];
    for (let hi = periodEnd; hi > periodStart; hi -= windowMs) {
      pending.push({ cursor: hi, floor: Math.max(periodStart, hi - windowMs), tries: 0 });
    }

    const rides = new Map(); // rideId → raw ride; dedupes any page overlap
    const failed = [];
    let requests = 0;
    let followUps = 0;
    let batchSize = ALIASES_PER_REQUEST;
    globalThis.citibikeRidesPartial = { rides, pending, failed };

    const retry = (ws, why) => {
      if (ws.length > 1) {
        batchSize = Math.max(1, Math.floor(ws.length / 2));
        log.warn(`  ↻ ${why} — retrying these ${ws.length} windows in batches of ${batchSize}`);
        pending.unshift(...ws);
        return;
      }
      const w = ws[0];
      if (++w.tries < MAX_TRIES) {
        log.warn(`  ↻ ${why} — window ${span(ws)}, try ${w.tries + 1}/${MAX_TRIES}`);
        pending.unshift(w);
      } else {
        log.warn(`  ✗ ${why} — giving up on window ${span(ws)}`);
        failed.push({ ...w, why });
      }
    };

    while (pending.length) {
      if (requests >= MAX_REQUESTS) throw new Error(`gave up after ${MAX_REQUESTS} requests`);
      const batch = pending.splice(0, batchSize);
      const vars = Object.fromEntries(batch.map((w, i) => [`c${i}`, String(w.cursor)]));
      requests++;
      log.log(`request ${requests}: ${batch.length} windows ${span(batch)} …`);
      let res;
      try {
        res = await gql(buildQuery(batch.length), vars);
      } catch (e) {
        retry(batch, e.message);
        await sleep(RETRY_BACKOFF_MS);
        continue;
      }
      if (!res.data?.member) {
        retry(batch, `GraphQL error: ${res.errors?.map((e) => e.message).join('; ') ?? 'no data'}`);
        await sleep(RETRY_BACKOFF_MS);
        continue;
      }
      // Partial errors: aliases that errored come back null; requeue just those.
      const bad = [];
      batch.forEach((w, i) => {
        const page = res.data.member[`r${i}`];
        if (!page) { bad.push(w); return; }
        const list = page.rideHistoryList ?? [];
        let oldest = Infinity;
        for (const r of list) {
          const t = Number(r.startTimeMs);
          oldest = Math.min(oldest, t);
          if (t >= periodStart && t < periodEnd) rides.set(r.rideId, r);
        }
        // Window not exhausted: page was full and still hasn't reached the window floor.
        if (page.hasMore && list.length >= page.limit && oldest > w.floor) {
          const cursor = oldest < w.cursor ? oldest : w.cursor - CURSOR_BACKOFF_MS;
          pending.push({ cursor, floor: w.floor, tries: 0 });
          followUps++;
        }
      });
      if (bad.length) {
        const why = `GraphQL error: ${res.errors?.[0]?.message ?? 'null result'}`;
        for (const w of bad) retry([w], why);
      }
      log.log(`  → ${rides.size} rides so far, ${pending.length} windows pending`);
      if (pending.length) await sleep(REQUEST_GAP_MS);
    }
    return { rides, requests, followUps, failed };
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

  // ── step 3: per-month and whole-period totals, actual vs capped ─────────────────
  function summarize(rows) {
    const bucket = () => ({ rides: 0, minutes: 0, cents: 0, capped: 0, over: 0, free: 0 });
    const months = {};
    const period = bucket();
    for (const r of rows) {
      for (const m of [(months[r.start.slice(0, 7)] ??= bucket()), period]) {
        m.rides++; m.minutes += r.minutes; m.cents += r.cents ?? 0; m.capped += r.cappedCents;
        if (r.cents > PRICE_CAP_CENTS) m.over++;
        if (r.cents === 0) m.free++;
      }
    }
    return { months, period, unparsed: rows.filter((r) => r.cents === null) };
  }

  function monthTable({ months, period }) {
    const capLabel = dollars(PRICE_CAP_CENTS);
    const tableRow = (m) => ({
      rides: m.rides, free: m.free, minutes: m.minutes, total: dollars(m.cents),
      [`rides > ${capLabel}`]: m.over, 'capped total': dollars(m.capped), saved: dollars(m.cents - m.capped),
    });
    const table = Object.fromEntries(Object.entries(months).sort().map(([k, m]) => [k, tableRow(m)]));
    table[`${PERIOD_LABEL} total`] = tableRow(period); // non-numeric key, so console.table lists it last
    return table;
  }

  // ── step 4: console report ──────────────────────────────────────────────────────
  function report({ rows, summary, crawl }) {
    const { period, unparsed } = summary;
    const { requests, followUps, failed } = crawl;
    log.table(monthTable(summary));
    log.log([
      `${PERIOD_LABEL} (${day(periodStart)}..${day(periodEnd)}): ${rows.length} rides, total ${dollars(period.cents)}`,
      `with a ${dollars(PRICE_CAP_CENTS)}/ride cap: ${dollars(period.capped)}, saving ${dollars(period.cents - period.capped)}`
        + ` across ${period.over} rides over the cap`,
      `requests: ${requests} (${followUps} window follow-ups)`,
      failed.length
        ? `✗ INCOMPLETE: ${failed.length} windows failed: ${failed.map((w) => `${span([w])} (${w.why})`).join('; ')}`
        : '',
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
    const filename = `${today}-citibike-rides-last-${LOOKBACK_DAYS}-days.csv`;
    if (env.download) return env.download(filename, csv);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // ── main ────────────────────────────────────────────────────────────────────────
  const periodEnd = now();
  const periodStart = periodEnd - LOOKBACK_DAYS * MS_PER_DAY;

  const crawl = await crawlPeriod(periodStart, periodEnd);
  const rows = toRows(crawl.rides);
  const summary = summarize(rows);
  report({ rows, summary, crawl });
  const csv = toCsv(rows);
  download(csv);

  const { cents: totalCents, capped: cappedCents, over: overCap } = summary.period;
  const result = {
    periodStart, periodEnd, days: LOOKBACK_DAYS, rows, totalCents, cappedCents, savedCents: totalCents - cappedCents, overCap,
    requests: crawl.requests, followUps: crawl.followUps, failed: crawl.failed, csv,
  };
  globalThis.citibikeRides = result;
  return result;
})(typeof __CITIBIKE_ENV__ !== 'undefined' ? __CITIBIKE_ENV__ : {})
  .catch((e) => { console.error('✗ citibike snippet stopped:', e); throw e; });
