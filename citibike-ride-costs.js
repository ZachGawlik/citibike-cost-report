// Citi Bike ride-cost export.
//
// Paste this whole file into the DevTools console on
// https://account.citibikenyc.com/ride-history while logged in. It fetches every ride
// from the last 365 days, prints monthly totals (actual, and what they would be with a
// per-ride price cap), and downloads a CSV. Read-only: it only sends GraphQL queries
// to the same endpoint the ride-history page itself uses.
//
// How fetching works:
//   - The server returns rides newest-first, 10 per page, for "rides that started
//     before <startTimeMs>". There is no page-size option.
//   - The 365 days are cut into 4-day windows. Each window starts its own page at the
//     window's end time.
//   - Up to 30 windows are asked for in one request (GraphQL aliases r0, r1, …).
//   - A window whose page came back full, without reaching the window's start, is
//     queued again from its oldest ride, so busy windows take extra lookups.
//
// Results: the console shows a table; `citibikeRides` holds the rows and totals.

(async (testHooks = {}) => {
  // ── Settings ────────────────────────────────────────────────────────────────────

  // What to export
  const LOOKBACK_DAYS = testHooks.days ?? 365;           // rides that started within this many days
  const PRICE_CAP_CENTS = testHooks.capCents ?? 365;     // hypothetical per-ride ceiling: $3.65
  const TIME_ZONE = 'America/New_York';                  // for printed times and month grouping

  // Server
  const ENDPOINT = '/bikesharefe-gql';                   // the ride-history page's own GraphQL endpoint
  const WINDOW_DAYS = 4;                                 // time span per window (aim: < 10 rides each)
  const WINDOWS_PER_REQUEST = 30;                        // windows asked for in one request
  const NO_PROGRESS_STEP_MS = 30_000;                    // step back this far if a page doesn't move back in time

  // Politeness and failure handling
  const PAUSE_BETWEEN_REQUESTS_MS = testHooks.gapMs ?? 300;
  const PAUSE_AFTER_FAILURE_MS = testHooks.gapMs ?? 3_000;
  const REQUEST_TIMEOUT_MS = testHooks.timeoutMs ?? 45_000;
  const MAX_ATTEMPTS_PER_WINDOW = 3;                     // then the window is reported as failed
  const MAX_REQUESTS = 600;                              // safety stop for a runaway loop

  // Output
  const DATE_LOCALE = 'sv-SE';                           // this locale formats dates as YYYY-MM-DD HH:MM:SS
  const CSV_COLUMNS = ['rideId', 'start', 'end', 'minutes', 'bike', 'price', 'cents', 'cappedCents', 'amountRaw', 'currency'];

  const MS_PER_MINUTE = 60_000;
  const MS_PER_DAY = 86_400_000;
  const PERIOD_LABEL = `last ${LOOKBACK_DAYS} days`;

  // Test hooks let test-ride-costs.mjs run this file against a fake server.
  const fetchFn = testHooks.fetch ?? globalThis.fetch.bind(globalThis);
  const getNow = testHooks.now ?? Date.now;
  const log = testHooks.console ?? console;

  // ── Small helpers ───────────────────────────────────────────────────────────────

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** "2026-11-20 16:27:14" in New York time. */
  function formatDateTime(ms) {
    return new Date(Number(ms)).toLocaleString(DATE_LOCALE, { timeZone: TIME_ZONE });
  }

  /** "2026-11-20" in New York time. */
  function formatDate(ms) {
    return new Date(Number(ms)).toLocaleDateString(DATE_LOCALE, { timeZone: TIME_ZONE });
  }

  /** 353 → "$3.53" */
  function formatDollars(cents) {
    return `$${(cents / 100).toFixed(2)}`;
  }

  /** "$3.53" → 353, "-$1.00" → -100. Returns null if the text isn't a dollar amount. */
  function parseCents(priceText) {
    const match = /(?<minus>-)?\$?\s*(?<dollars>[\d,]+)\.(?<cents>\d{2})/.exec(priceText ?? '');
    if (!match) return null;
    const { minus, dollars, cents } = match.groups;
    const value = Number(dollars.replaceAll(',', '')) * 100 + Number(cents);
    return minus ? -value : value;
  }

  /** "2025-11-23..2025-12-03" for a list of windows. */
  function describeWindows(windows) {
    const earliest = Math.min(...windows.map((w) => w.startMs));
    const latest = Math.max(...windows.map((w) => w.cursorMs));
    return `${formatDate(earliest)}..${formatDate(latest)}`;
  }

  // ── Talking to the server ───────────────────────────────────────────────────────

  const RIDE_PAGE_FIELDS = `
    limit
    hasMore
    rideHistoryList {
      rideId startTimeMs endTimeMs duration rideableName
      price { amount currency formatted }
    }`;

  /** One query that asks for one page per window, as aliases r0, r1, … */
  function buildQuery(windowCount) {
    const variables = [];
    const fields = [];
    for (let i = 0; i < windowCount; i++) {
      variables.push(`$cursor${i}: String`);
      fields.push(`r${i}: rideHistory(startTimeMs: $cursor${i}) { ${RIDE_PAGE_FIELDS} }`);
    }
    return `query CitibikeRidePages(${variables.join(', ')}) {
      member { id
        ${fields.join('\n')}
      }
    }`;
  }

  /**
   * POSTs a GraphQL query and returns the parsed JSON body ({ data, errors }).
   * Throws on timeout, network failure, or a response that isn't JSON.
   */
  async function postGraphQL(query, variables) {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetchFn(ENDPOINT, {
        method: 'POST',
        credentials: 'include', // send the logged-in session cookies
        signal: abort.signal,
        headers: { 'content-type': 'application/json', 'Apollo-Require-Preflight': 'true' },
        body: JSON.stringify({ operationName: 'CitibikeRidePages', query, variables }),
      });
      const body = await response.json().catch(() => null);
      if (body === null) {
        const hint = response.status === 401 ? ' (logged out?)' : '';
        throw new Error(`HTTP ${response.status} with no JSON body${hint}`);
      }
      return body;
    } catch (error) {
      if (abort.signal.aborted) throw new Error(`timed out after ${REQUEST_TIMEOUT_MS / 1000}s`);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Fetches one page for each window. Returns { pages, errorMessage }, where pages[i]
   * belongs to windows[i] and is null if the server errored on just that window.
   * Throws if the whole request failed.
   */
  async function fetchPages(windows) {
    const variables = {};
    windows.forEach((w, i) => { variables[`cursor${i}`] = String(w.cursorMs); });

    const body = await postGraphQL(buildQuery(windows.length), variables);
    const errorMessage = body.errors?.map((e) => e.message).join('; ');
    const member = body.data?.member;
    if (!member) throw new Error(`GraphQL error: ${errorMessage ?? 'no data'}`);

    const pages = windows.map((_, i) => member[`r${i}`] ?? null);
    return { pages, errorMessage: errorMessage ?? 'null result' };
  }

  // ── Step 1: fetch every ride in the period ──────────────────────────────────────

  /**
   * A window covers [startMs, endMs). `cursorMs` is where its next page starts; it
   * begins at endMs and moves back as pages come in.
   */
  function makeWindows(periodStart, periodEnd) {
    const windows = [];
    for (let endMs = periodEnd; endMs > periodStart; endMs -= WINDOW_DAYS * MS_PER_DAY) {
      const startMs = Math.max(periodStart, endMs - WINDOW_DAYS * MS_PER_DAY);
      windows.push({ startMs, cursorMs: endMs, attempts: 0 });
    }
    return windows;
  }

  async function fetchAllRides(periodStart, periodEnd) {
    const rides = new Map(); // rideId → ride; the same ride seen twice is stored once
    const queue = makeWindows(periodStart, periodEnd);
    const failedWindows = [];
    let requestCount = 0;
    let followUpCount = 0;
    let batchSize = WINDOWS_PER_REQUEST;

    // If the run stops early, whatever was fetched is still reachable from the console.
    globalThis.citibikeRidesPartial = { rides, queue, failedWindows };

    // Put a window back at the front of the queue, or give up on it.
    function retryOrGiveUp(window, reason) {
      window.attempts += 1;
      if (window.attempts < MAX_ATTEMPTS_PER_WINDOW) {
        log.warn(`  ↻ ${reason} — window ${describeWindows([window])}, try ${window.attempts + 1}/${MAX_ATTEMPTS_PER_WINDOW}`);
        queue.unshift(window);
      } else {
        log.warn(`  ✗ ${reason} — giving up on window ${describeWindows([window])}`);
        failedWindows.push({ ...window, reason });
      }
    }

    while (queue.length > 0) {
      if (requestCount >= MAX_REQUESTS) throw new Error(`gave up after ${MAX_REQUESTS} requests`);

      const batch = queue.splice(0, batchSize);
      requestCount += 1;
      log.log(`request ${requestCount}: ${batch.length} windows ${describeWindows(batch)} …`);

      let result;
      try {
        result = await fetchPages(batch);
      } catch (error) {
        // The whole request failed. A big batch is retried as smaller batches (in case
        // the server limits query size); a single window counts as a failed attempt.
        if (batch.length > 1) {
          batchSize = Math.max(1, Math.floor(batch.length / 2));
          log.warn(`  ↻ ${error.message} — retrying these ${batch.length} windows in batches of ${batchSize}`);
          queue.unshift(...batch);
        } else {
          retryOrGiveUp(batch[0], error.message);
        }
        await sleep(PAUSE_AFTER_FAILURE_MS);
        continue;
      }

      for (const [i, window] of batch.entries()) {
        const page = result.pages[i];
        if (page === null) {
          retryOrGiveUp(window, `GraphQL error: ${result.errorMessage}`);
          continue;
        }

        const pageRides = page.rideHistoryList ?? [];
        let oldestMs = Infinity;
        for (const ride of pageRides) {
          const startMs = Number(ride.startTimeMs);
          oldestMs = Math.min(oldestMs, startMs);
          if (startMs >= periodStart && startMs < periodEnd) rides.set(ride.rideId, ride);
        }

        // A full page that hasn't reached back to the window's start means there are
        // more rides in this window: queue another page starting at the oldest ride.
        const pageWasFull = page.hasMore && pageRides.length >= page.limit;
        if (pageWasFull && oldestMs > window.startMs) {
          const movedBack = oldestMs < window.cursorMs;
          const nextCursor = movedBack ? oldestMs : window.cursorMs - NO_PROGRESS_STEP_MS;
          queue.push({ startMs: window.startMs, cursorMs: nextCursor, attempts: 0 });
          followUpCount += 1;
        }
      }

      log.log(`  → ${rides.size} rides so far, ${queue.length} windows pending`);
      if (queue.length > 0) await sleep(PAUSE_BETWEEN_REQUESTS_MS);
    }

    return { rides, requestCount, followUpCount, failedWindows };
  }

  // ── Step 2: turn raw rides into flat rows ───────────────────────────────────────

  function toRow(ride) {
    const cents = parseCents(ride.price?.formatted);
    return {
      rideId: ride.rideId,
      start: formatDateTime(ride.startTimeMs),
      end: formatDateTime(ride.endTimeMs),
      minutes: Math.round(Number(ride.duration) / MS_PER_MINUTE),
      bike: ride.rideableName,
      price: ride.price?.formatted ?? '',
      cents,
      cappedCents: Math.min(cents ?? 0, PRICE_CAP_CENTS),
      amountRaw: ride.price?.amount ?? '',
      currency: ride.price?.currency ?? '',
    };
  }

  /** Rows sorted newest first. */
  function toRows(rides) {
    return [...rides.values()]
      .sort((a, b) => Number(b.startTimeMs) - Number(a.startTimeMs))
      .map(toRow);
  }

  // ── Step 3: totals per month and for the whole period ───────────────────────────

  function emptyTotals() {
    return { rides: 0, freeRides: 0, ridesOverCap: 0, minutes: 0, cents: 0, cappedCents: 0 };
  }

  function addToTotals(totals, row) {
    totals.rides += 1;
    totals.minutes += row.minutes;
    totals.cents += row.cents ?? 0;
    totals.cappedCents += row.cappedCents;
    if (row.cents === 0) totals.freeRides += 1;
    if (row.cents > PRICE_CAP_CENTS) totals.ridesOverCap += 1;
  }

  function summarize(rows) {
    const byMonth = {}; // "2026-11" → totals
    const wholePeriod = emptyTotals();
    for (const row of rows) {
      const month = row.start.slice(0, 7);
      byMonth[month] ??= emptyTotals();
      addToTotals(byMonth[month], row);
      addToTotals(wholePeriod, row);
    }
    const unparsedRows = rows.filter((row) => row.cents === null);
    return { byMonth, wholePeriod, unparsedRows };
  }

  // ── Step 4: print the report ────────────────────────────────────────────────────

  function toTableRow(totals) {
    return {
      rides: totals.rides,
      free: totals.freeRides,
      minutes: totals.minutes,
      total: formatDollars(totals.cents),
      [`rides > ${formatDollars(PRICE_CAP_CENTS)}`]: totals.ridesOverCap,
      'capped total': formatDollars(totals.cappedCents),
      saved: formatDollars(totals.cents - totals.cappedCents),
    };
  }

  function printReport({ rows, summary, fetchResult, periodStart, periodEnd }) {
    const { byMonth, wholePeriod, unparsedRows } = summary;
    const { requestCount, followUpCount, failedWindows } = fetchResult;

    const table = {};
    for (const month of Object.keys(byMonth).sort()) table[month] = toTableRow(byMonth[month]);
    table[`${PERIOD_LABEL} total`] = toTableRow(wholePeriod); // not a number, so console.table lists it last
    log.table(table);

    const saved = wholePeriod.cents - wholePeriod.cappedCents;
    const lines = [
      `${PERIOD_LABEL} (${formatDate(periodStart)}..${formatDate(periodEnd)}): `
        + `${rows.length} rides, total ${formatDollars(wholePeriod.cents)}`,
      `with a ${formatDollars(PRICE_CAP_CENTS)}/ride cap: ${formatDollars(wholePeriod.cappedCents)}, `
        + `saving ${formatDollars(saved)} across ${wholePeriod.ridesOverCap} rides over the cap`,
      `requests: ${requestCount} (${followUpCount} window follow-ups)`,
    ];
    if (failedWindows.length > 0) {
      const details = failedWindows.map((w) => `${describeWindows([w])} (${w.reason})`).join('; ');
      lines.push(`✗ INCOMPLETE: ${failedWindows.length} windows failed: ${details}`);
    }
    if (unparsedRows.length > 0) {
      lines.push(`✗ ${unparsedRows.length} prices could not be parsed: ${unparsedRows.map((r) => r.price).join(', ')}`);
    }
    log.log(lines.join('\n'));
  }

  // ── Step 5: CSV download ────────────────────────────────────────────────────────

  /** Quote a CSV cell only if it contains a quote, comma or newline. */
  function csvCell(value) {
    const text = String(value ?? '');
    return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  }

  function toCsv(rows) {
    const header = CSV_COLUMNS.join(',');
    const lines = rows.map((row) => CSV_COLUMNS.map((column) => csvCell(row[column])).join(','));
    return [header, ...lines].join('\n');
  }

  function downloadCsv(csv) {
    const filename = `${formatDate(Date.now())}-citibike-rides-last-${LOOKBACK_DAYS}-days.csv`;
    if (testHooks.download) {
      testHooks.download(filename, csv);
      return;
    }
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    link.download = filename;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  // ── Run ─────────────────────────────────────────────────────────────────────────

  const periodEnd = getNow();
  const periodStart = periodEnd - LOOKBACK_DAYS * MS_PER_DAY;

  const fetchResult = await fetchAllRides(periodStart, periodEnd);
  const rows = toRows(fetchResult.rides);
  const summary = summarize(rows);
  printReport({ rows, summary, fetchResult, periodStart, periodEnd });
  const csv = toCsv(rows);
  downloadCsv(csv);

  const { cents, cappedCents, ridesOverCap } = summary.wholePeriod;
  const result = {
    periodStart,
    periodEnd,
    days: LOOKBACK_DAYS,
    rows,
    totalCents: cents,
    cappedCents,
    savedCents: cents - cappedCents,
    ridesOverCap,
    requestCount: fetchResult.requestCount,
    followUpCount: fetchResult.followUpCount,
    failedWindows: fetchResult.failedWindows,
    csv,
  };
  globalThis.citibikeRides = result;
  return result;
})(globalThis.__CITIBIKE_TEST_HOOKS__).catch((error) => {
  console.error('✗ citibike export stopped:', error);
  throw error;
});
