# Citi Bike ride-cost export

A browser console snippet that pulls every Citi Bike ride from the last 365
days out of your account, prints monthly cost totals, and gets the rides ready
to copy as CSV. It also shows what you would have paid if every ride were capped at
$3.65, and how much that cap would have saved.

There's no public API for your own ride history, so the snippet runs inside
the logged-in account page and asks the same private GraphQL endpoint that
the page itself uses. It only reads data; it changes nothing on your account.

## Usage

1. Log in at <https://account.citibikenyc.com/ride-history>.
2. Open your browser's DevTools console.
3. Paste the whole of `citibike-ride-costs.js` and press Enter.
   - The first time, Chrome blocks pasting and asks you to type
     `allow pasting` first. Firefox does the same with `allow pasting`.
4. Wait a few seconds. You'll see one `request N: …` line per request
   (around 5–10 for a typical year), then the results.
5. To get the rides as CSV, run `copy(citibikeRides.csv)` in the same
   console and paste into a spreadsheet or file. (`copy()` is a DevTools
   helper, so it has to be typed at the console prompt.)

## What you get

**A table in the console**, one row per month plus a `total` row:

| column         | meaning                                         |
|----------------|-------------------------------------------------|
| `rides`        | rides that started in that month                |
| `total`        | what you actually paid                          |
| `rides > $3.65`| rides that cost more than the cap               |
| `capped total` | what you'd have paid with every ride capped     |
| `saved`        | `total` − `capped total`                        |

The first and last months are partial, since the period is exactly the last
365 days rather than calendar months.

**CSV text** in `citibikeRides.csv` (copy it with `copy(citibikeRides.csv)`),
one row per ride, oldest first:

| column        | example               |
|---------------|-----------------------|
| `start`       | `2026-11-20 16:27:14` (New York time) |
| `minutes`     | `6`                   |
| `cents`       | `176`                 |
| `cappedCents` | `176`                 |

**A console global**, `citibikeRides`, holding the CSV, the rows and the
totals, for poking at further (e.g. `citibikeRides.total`).

## If something goes wrong

- **`✗ INCOMPLETE: N windows failed`** — some date ranges kept erroring after
  3 tries (or the 100-request safety stop was hit). The totals and CSV cover
  everything else, but are missing those rides. Running it again usually
  fixes a transient failure.
- **`↻ request failed, retrying: …` on every request** — usually an expired
  session. Reload the page, log in again, and re-run.
- **`unexpected price format: …`** — Citi Bike changed how prices look (or a
  ride cost $1,000+). The snippet stops rather than guess, so totals can't be
  silently wrong; `parseCents` would need updating.

## Settings

What to export is set at the top of `citibike-ride-costs.js`:

| constant              | default | what it does |
|-----------------------|---------|--------------|
| `LOOKBACK_DAYS`       | `365`   | how far back to fetch |
| `PRICE_CAP_CENTS`     | `365`   | the hypothetical per-ride cap ($3.65) |

How rides are fetched is set in the `collectByTimeWindows({ … })` call in the
run steps:

| option        | default      | what it does |
|---------------|--------------|--------------|
| `windowMs`    | 4 days       | date span per lookup window |
| `batchSize`   | `30`         | windows asked for in one request; lower it if requests start failing as "too complex" |
| `maxAttempts` | `3`          | tries per window before it's reported as failed |
| `maxRequests` | `100`        | safety stop |
| `pauseMs`     | `300`        | pause between requests, to be polite |

The request timeout (45 s) is in `fetchRidePages()`.

## How fetching works

The server returns rides newest first, 10 per page, for "rides that started
before time T". There's no way to ask for bigger pages, and the server rejects
introspection and batched requests.

To avoid one request per 10 rides, the 365 days are cut into 4-day windows,
and up to 30 windows go into a single GraphQL query as aliases
(`r0: rideHistory(...)`, `r1: …`). A window whose page comes back full before
reaching the window's start gets a follow-up lookup from its oldest ride. The
same ride showing up twice is stored once.

## Tests

`test-ride-costs.mjs` runs the snippet in a Node `vm` against a fake server
with ~700 synthetic rides, under a few guesses about how the real server
treats the cursor and with injected failures (timeouts, 502s, windows that
always error, hitting the request limit). It checks that the exported rides
and totals match exactly.

```sh
./test-ride-costs.mjs       # needs zx (npm i -g zx)
./test-ride-costs.mjs -v    # also show the snippet's console output
```

## Privacy

The exported CSV is your personal ride history. `*.csv` is git-ignored; keep
it that way.
