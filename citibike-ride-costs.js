// Citi Bike ride-cost export.
//
// Paste this whole file into the DevTools console on
// https://account.citibikenyc.com/ride-history while logged in. It fetches every ride
// from the last 365 days, prints monthly totals (actual, and what they would be with a
// per-ride price cap), and leaves the rides as CSV in `citibikeRides.csv`; run
// `copy(citibikeRides.csv)` afterwards to put it on the clipboard. Read-only: it only
// sends GraphQL queries to the same endpoint the ride-history page itself uses.
//
// What it does in your browser:
//   - Network: fetchAllRides(), in the "Fetching" section at the bottom, is the only
//     code that sends requests, all of them POSTs to /bikesharefe-gql on this same
//     site, using your existing login. Nothing is sent anywhere else.
//   - Page: nothing changes. It doesn't read or write cookies, localStorage or any
//     other browser storage.
//   - Console: progress lines, the totals table, and the `citibikeRides` variable
//     (which holds the CSV text).
//
// Layout: settings and helpers, then the cost math and report, then the run steps.
// How rides are fetched is kept separate, at the bottom; the rest of the code only
// relies on fetchAllRides() returning the rides in the period.

(async () => {
  // ── Settings ────────────────────────────────────────────────────────────────────
  const LOOKBACK_DAYS = 365;                    // rides that started within this many days
  const PRICE_CAP_CENTS = 365;                  // hypothetical per-ride ceiling: $3.65
  const TIME_ZONE = 'America/New_York';         // for printed times and month grouping
  const MS_PER_DAY = 86_400_000;

  // ── Helpers ─────────────────────────────────────────────────────────────────────

  /** "2026-11-20 16:27:14" in New York time (the sv-SE locale gives ISO-like dates). */
  const formatDateTime = (ms) => new Date(Number(ms)).toLocaleString('sv-SE', { timeZone: TIME_ZONE });

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

  const { rides, requestCount, failedWindows } = await fetchAllRides(periodStart, periodEnd);
  const rows = rides.sort((a, b) => a.startTimeMs - b.startTimeMs).map(toRow); // oldest first
  const summary = summarize(rows);
  printReport(summary, requestCount, failedWindows);

  globalThis.citibikeRides = { rows, csv: toCsv(rows), ...summary, requestCount, failedWindows };
  // copy() is a DevTools console helper: it only works when typed at the prompt.
  console.log('To copy the rides as CSV to your clipboard, run:  copy(citibikeRides.csv)');

  // ── Fetching ────────────────────────────────────────────────────────────────────
  //
  // Everything about talking to the server lives in fetchAllRides(), including its
  // own settings. It returns:
  //   rides          every ride that started in [periodStart, periodEnd), each once:
  //                  { rideId, startTimeMs, duration, price: { formatted } }
  //   requestCount   how many requests it sent
  //   failedWindows  date ranges it gave up on (their rides are missing)
  //
  // How it works:
  //   - The server returns rides newest-first, 10 per page, for "rides that started
  //     before <startTimeMs>". There is no page-size option.
  //   - The period is cut into 4-day windows. Each window starts its own page at the
  //     window's end time.
  //   - Up to 30 windows are asked for in one request (GraphQL aliases r0, r1, …).
  //   - A window whose page came back full, without reaching the window's start, is
  //     queued again from its oldest ride, so busy windows take extra lookups.
  //
  // (A function declaration, so the Run steps above can call it before this point.)
  async function fetchAllRides(periodStart, periodEnd) {
    const ENDPOINT = '/bikesharefe-gql';        // the ride-history page's own GraphQL endpoint
    const WINDOW_DAYS = 4;                      // time span per window (aim: < 10 rides each)
    const WINDOWS_PER_REQUEST = 30;             // windows asked for in one request
    const MAX_ATTEMPTS_PER_WINDOW = 3;          // then the window is reported as failed
    const MAX_REQUESTS = 100;                   // safety stop; a normal year needs ~5–10
    const PAUSE_MS = 300;                       // between requests, to be polite
    const TIMEOUT_MS = 45_000;                  // give up on a request after this long

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    /** One query asking for one page per window, as aliases r0, r1, … */
    function buildQuery(windowCount) {
      const indexes = [...Array(windowCount).keys()];
      return `query (${indexes.map((i) => `$cursor${i}: String`).join(', ')}) {
        member {
          ${indexes.map((i) => `r${i}: rideHistory(startTimeMs: $cursor${i}) {
            limit hasMore
            rideHistoryList { rideId startTimeMs duration price { formatted } }
          }`).join('\n')}
        }
      }`;
    }

    /**
     * Fetches one page per window. pages[i] belongs to windows[i], and is null if the
     * server errored on just that window. Throws if the whole request failed.
     */
    async function fetchPages(windows) {
      const variables = Object.fromEntries(windows.map((w, i) => [`cursor${i}`, String(w.cursorMs)]));
      const response = await fetch(ENDPOINT, {
        method: 'POST',
        credentials: 'include', // send the logged-in session cookies
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { 'content-type': 'application/json', 'Apollo-Require-Preflight': 'true' },
        body: JSON.stringify({ query: buildQuery(windows.length), variables }),
      });
      const body = await response.json().catch(() => {
        throw new Error(`HTTP ${response.status}, response wasn't JSON`);
      });
      const member = body.data?.member;
      if (!member) throw new Error(`GraphQL error: ${body.errors?.[0]?.message}`);
      return windows.map((_, i) => member[`r${i}`] ?? null);
    }

    // A window covers [startMs, endMs); cursorMs is where its next page starts.
    const queue = [];
    for (let endMs = periodEnd; endMs > periodStart; endMs -= WINDOW_DAYS * MS_PER_DAY) {
      const startMs = Math.max(periodStart, endMs - WINDOW_DAYS * MS_PER_DAY);
      queue.push({ startMs, cursorMs: endMs, attempts: 0 });
    }
    const rides = new Map(); // rideId → ride; the same ride seen twice is stored once
    const failedWindows = [];
    let requestCount = 0;

    function retryOrGiveUp(window, reason) {
      window.attempts += 1;
      if (window.attempts < MAX_ATTEMPTS_PER_WINDOW) {
        queue.unshift(window);
      } else {
        console.warn(`✗ giving up on window from ${formatDateTime(window.startMs)}: ${reason}`);
        failedWindows.push({ ...window, reason });
      }
    }

    while (queue.length > 0) {
      if (requestCount >= MAX_REQUESTS) {
        // Keep what was fetched; report the unfinished windows instead of throwing.
        failedWindows.push(...queue.splice(0).map((w) => ({ ...w, reason: `hit ${MAX_REQUESTS}-request limit` })));
        break;
      }
      const batch = queue.splice(0, WINDOWS_PER_REQUEST);
      requestCount += 1;
      console.log(`request ${requestCount}: ${batch.length} windows, ${rides.size} rides so far`);

      let pages;
      try {
        pages = await fetchPages(batch);
      } catch (error) {
        console.warn(`↻ request failed, retrying: ${error.message}`);
        batch.forEach((window) => retryOrGiveUp(window, error.message));
        await sleep(PAUSE_MS);
        continue;
      }

      batch.forEach((window, i) => {
        const page = pages[i];
        if (page === null) return retryOrGiveUp(window, 'GraphQL error for this window');

        const startTimes = page.rideHistoryList.map((ride) => Number(ride.startTimeMs));
        for (const ride of page.rideHistoryList) {
          const startMs = Number(ride.startTimeMs);
          if (startMs >= periodStart && startMs < periodEnd) rides.set(ride.rideId, ride);
        }

        // A full page that hasn't reached back to the window's start means there are
        // more rides in this window: queue another page starting at the oldest ride.
        const oldestMs = Math.min(...startTimes);
        const pageWasFull = page.hasMore && startTimes.length >= page.limit;
        if (pageWasFull && oldestMs > window.startMs && oldestMs < window.cursorMs) {
          queue.push({ startMs: window.startMs, cursorMs: oldestMs, attempts: 0 });
        }
      });
      await sleep(PAUSE_MS);
    }
    return { rides: [...rides.values()], requestCount, failedWindows };
  }
})();
