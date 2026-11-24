// Citi Bike ride-cost export.
//
// Paste this whole file into the DevTools console on
// https://account.citibikenyc.com/ride-history while logged in.
// It fetches your every ride from the last 365 days and prints monthly totals
// before and after the upcoming $3.65 price capping.
// You can opt to then manually copy a csv of your individual ride data.
//
// Read-only: it only sends GraphQL queries to the same endpoint the ride-history page itself uses.
// There are no reads or alterations from the page itself.

(async () => {
  // ── Settings ────────────────────────────────────────────────────────────────────
  const LOOKBACK_DAYS = 365;                    // rides that started within this many days
  const PRICE_CAP_CENTS = 365;                  // upcoming ride fare cap, https://citibikenyc.com/memberebikecap
  const TIME_ZONE = 'America/New_York';         // for ride times and month grouping
  const MS_PER_DAY = 86_400_000;

  // ── Helpers ─────────────────────────────────────────────────────────────────────

  /**
   * "2026-11-20 16:27:14" in New York time, whatever this computer's time zone.
   * Ride times and the month each ride is counted in both come from this.
   */
  const dateTimeFormat = new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  function formatDateTime(ms) {
    const p = Object.fromEntries(dateTimeFormat.formatToParts(Number(ms)).map(({ type, value }) => [type, value]));
    return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
  }

  /** 353 → "$3.53" */
  const formatDollars = (cents) => `$${(cents / 100).toFixed(2)}`;

  /** "$3.53" → 353. Throws on anything else, so a format change can't skew totals. */
  function parseCents(priceText) {
    const match = /^\$(\d+)\.(\d\d)$/.exec(priceText);
    if (!match) throw new Error(`unexpected price format: ${JSON.stringify(priceText)}`);
    return Number(match[1]) * 100 + Number(match[2]);
  }

  // ── Rows, totals and report ─────────────────────────────────────────────────────

  function toRow(ride) {
    const cents = parseCents(ride.price.formatted);
    return {
      start: formatDateTime(ride.startTimeMs),
      minutes: Math.round(ride.duration / 60_000),
      cents,
      cappedCents: Math.min(cents, PRICE_CAP_CENTS),
    };
  }

  function summarize(rows) {
    const byMonth = {}; // "2026-11" → totals; insertion order = row order
    const total = { rides: 0, overCap: 0, cents: 0, cappedCents: 0 };
    for (const row of rows) {
      const month = (byMonth[row.start.slice(0, 7)] ??= { rides: 0, overCap: 0, cents: 0, cappedCents: 0 });
      for (const totals of [month, total]) {
        totals.rides += 1;
        totals.overCap += row.cents > PRICE_CAP_CENTS ? 1 : 0;
        totals.cents += row.cents;
        totals.cappedCents += row.cappedCents;
      }
    }
    return { byMonth, total };
  }

  function printReport({ byMonth, total }, requestCount, failedWindows) {
    const tableRow = (t) => ({
      rides: t.rides,
      total: formatDollars(t.cents),
      [`rides > ${formatDollars(PRICE_CAP_CENTS)}`]: t.overCap,
      'capped total': formatDollars(t.cappedCents),
      saved: formatDollars(t.cents - t.cappedCents),
    });
    const table = {};
    for (const [month, totals] of Object.entries(byMonth)) table[month] = tableRow(totals);
    table.total = tableRow(total);
    console.table(table);
    console.log(`${total.rides} rides in the last ${LOOKBACK_DAYS} days, ${requestCount} requests`);
    if (failedWindows.length > 0) {
      console.warn(`✗ INCOMPLETE: ${failedWindows.length} windows failed; totals are missing their rides`);
    }
  }

  function toCsv(rows) {
    const columns = Object.keys(rows[0] ?? {});
    return [columns, ...rows.map((row) => columns.map((c) => row[c]))]
      .map((cells) => cells.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(','))
      .join('\n');
  }

  // ── Run ─────────────────────────────────────────────────────────────────────────
  const periodEnd = Date.now();
  const periodStart = periodEnd - LOOKBACK_DAYS * MS_PER_DAY;

  const { items: rides, requestCount, failedWindows } = await collectByTimeWindows({
    start: periodStart,
    end: periodEnd,
    fetchPages: fetchRidePages,
    timeOf: (ride) => Number(ride.startTimeMs),
    idOf: (ride) => ride.rideId,
    windowMs: 4 * MS_PER_DAY, // span per window (aim: < 10 rides each, one page)
    batchSize: 30,            // windows asked for in one request
    maxAttempts: 3,           // per window, then it's reported as failed
    maxRequests: 100,         // safety stop; a normal year needs ~5–10
    pauseMs: 300,             // between requests, to be polite
  });
  const rows = rides.sort((a, b) => a.startTimeMs - b.startTimeMs).map(toRow); // oldest first
  const summary = summarize(rows);
  printReport(summary, requestCount, failedWindows);

  globalThis.citibikeRides = { rows, csv: toCsv(rows), ...summary, requestCount, failedWindows };
  console.log('To copy the rides as CSV to your clipboard, run:  copy(citibikeRides.csv)');


  // ── Citi Bike requests ──────────────────────────────────────────────────────────
  //
  // The server returns rides newest-first, 10 per page, for "rides that started
  // before <startTimeMs>". There is no page-size option, so one request asks for
  // several pages at once, one per start time, as GraphQL aliases r0, r1, …

  /**
   * Fetches one page of rides before each of `cursorsMs`. Returns one entry per
   * cursor: { items: rides, full: whether more rides follow }, or null if the server
   * errored on just that page. Throws if the whole request failed.
   */
  async function fetchRidePages(cursorsMs) {
    const ENDPOINT = '/bikesharefe-gql'; // the ride-history page's own GraphQL endpoint
    const TIMEOUT_MS = 45_000;           // give up on a request after this long

    const indexes = cursorsMs.map((_, i) => i);
    const query = `query (${indexes.map((i) => `$cursor${i}: String`).join(', ')}) {
      member {
        ${indexes.map((i) => `r${i}: rideHistory(startTimeMs: $cursor${i}) {
          limit hasMore
          rideHistoryList { rideId startTimeMs duration price { formatted } }
        }`).join('\n')}
      }
    }`;
    const variables = Object.fromEntries(cursorsMs.map((ms, i) => [`cursor${i}`, String(ms)]));

    const response = await fetch(ENDPOINT, {
      method: 'POST',
      credentials: 'include', // send the logged-in session cookies
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'content-type': 'application/json', 'Apollo-Require-Preflight': 'true' },
      body: JSON.stringify({ query, variables }),
    });
    const body = await response.json().catch(() => {
      throw new Error(`HTTP ${response.status}, response wasn't JSON`);
    });
    const member = body.data?.member;
    if (!member) throw new Error(`GraphQL error: ${body.errors?.[0]?.message}`);

    return indexes.map((i) => {
      const page = member[`r${i}`];
      if (!page) return null;
      const rides = page.rideHistoryList;
      return { items: rides, full: page.hasMore && rides.length >= page.limit };
    });
  }

  // ── Batching (generic) ──────────────────────────────────────────────────────────
  //
  // Collects every item whose time is in [start, end) from a source that pages
  // newest-first by "items before time T". No network code and nothing Citi Bike
  // specific: it only calls the functions it's handed.
  //
  //   - [start, end) is cut into windows of `windowMs`; each window's first page
  //     starts at the window's end.
  //   - `batchSize` windows' pages are asked for in one fetchPages() call.
  //   - A full page that hasn't reached back to its window's start gets a follow-up
  //     page from its oldest item.
  //   - A failing window is retried up to `maxAttempts` times, then reported in
  //     `failedWindows`. After `maxRequests` calls, unfinished windows are reported
  //     there too.
  //
  // Returns { items (each once, by idOf), requestCount, failedWindows }.
  async function collectByTimeWindows({
    start, end, fetchPages, timeOf, idOf, windowMs, batchSize, maxAttempts, maxRequests, pauseMs,
  }) {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const day = (ms) => new Date(ms).toISOString().slice(0, 10);

    // A window covers [startMs, end of window); cursorMs is where its next page starts.
    const queue = [];
    for (let windowEnd = end; windowEnd > start; windowEnd -= windowMs) {
      queue.push({ startMs: Math.max(start, windowEnd - windowMs), cursorMs: windowEnd, attempts: 0 });
    }
    const items = new Map(); // idOf(item) → item; the same item seen twice is stored once
    const failedWindows = [];
    let requestCount = 0;

    function retryOrGiveUp(window, reason) {
      window.attempts += 1;
      if (window.attempts < maxAttempts) {
        queue.unshift(window);
      } else {
        console.warn(`✗ giving up on window from ${day(window.startMs)}: ${reason}`);
        failedWindows.push({ ...window, reason });
      }
    }

    while (queue.length > 0) {
      if (requestCount >= maxRequests) {
        // Keep what was fetched; report the unfinished windows instead of throwing.
        failedWindows.push(...queue.splice(0).map((w) => ({ ...w, reason: `hit ${maxRequests}-request limit` })));
        break;
      }
      const batch = queue.splice(0, batchSize);
      requestCount += 1;
      console.log(`request ${requestCount}: ${batch.length} windows, ${items.size} items so far`);

      let pages;
      try {
        pages = await fetchPages(batch.map((window) => window.cursorMs));
      } catch (error) {
        console.warn(`↻ request failed, retrying: ${error.message}`);
        batch.forEach((window) => retryOrGiveUp(window, error.message));
        await sleep(pauseMs);
        continue;
      }

      batch.forEach((window, i) => {
        const page = pages[i];
        if (page === null) return retryOrGiveUp(window, 'error for this window');

        const times = page.items.map(timeOf);
        page.items.forEach((item, j) => {
          if (times[j] >= start && times[j] < end) items.set(idOf(item), item);
        });

        const oldest = Math.min(...times);
        if (page.full && oldest > window.startMs && oldest < window.cursorMs) {
          queue.push({ startMs: window.startMs, cursorMs: oldest, attempts: 0 });
        }
      });
      await sleep(pauseMs);
    }
    return { items: [...items.values()], requestCount, failedWindows };
  }
})();
