# Citi Bike ride-cost export

Get a list of every Citi Bike ride you took in the last 365 days, with monthly
cost totals. It also works out what you'd have paid if every ride had been
capped at $3.65, and how much that cap would have saved you.

It's a short script that you paste into your browser while you're logged in to
your Citi Bike account. Citi Bike doesn't offer a download of your ride
history, so the script asks for it the same way the "Ride history" page does.

## Is it safe?

The script only *reads* your ride history. It can't change your account, make
payments or send your data anywhere.

- It only talks to Citi Bike's own website, using the login you already have.
- It doesn't change the page or save anything in your browser.
- Everything it finds is shown in the browser console, and stays there until
  you close the tab.

You don't have to take that on trust: the top of `citibike-ride-costs.js`
explains what it does in plain terms, and the part that contacts Citi Bike is
one short, clearly labelled function. As with any script you paste into a
browser, it's worth a quick read first.

## How to use it

1. Log in at <https://account.citibikenyc.com/ride-history>.
2. Open your browser's DevTools console. In most browsers: right-click
   anywhere on the page → **Inspect** → the **Console** tab.
3. Copy the whole of `citibike-ride-costs.js`, paste it into the console and
   press Enter.
   - The first time, Chrome and Firefox block pasting and ask you to type
     `allow pasting` first. That's a general safety warning about pasting
     code, which is why the "Is it safe?" section above is worth a read.
4. Wait a few seconds while it fetches your rides. You'll see a few
   `request …` lines, then a table of results.
5. To get the full list of rides, type `copy(citibikeRides.csv)` into the
   console and press Enter. That puts it on your clipboard as CSV, which you
   can paste into a spreadsheet (Google Sheets, Excel, Numbers).

## What you get

**A table** with one row per month, plus a `total` row at the bottom:

| column          | meaning                                          |
|-----------------|--------------------------------------------------|
| `rides`         | how many rides started that month                |
| `total`         | what you actually paid                           |
| `rides > $3.65` | how many rides cost more than $3.65              |
| `capped total`  | what you'd have paid if no ride cost over $3.65  |
| `saved`         | the difference between the two                   |

The first and last months only cover part of the month, because the period is
exactly the last 365 days.

**The ride list** (from `copy(citibikeRides.csv)`), one ride per line, oldest
first:

| column        | example               | meaning                          |
|---------------|-----------------------|----------------------------------|
| `start`       | `2026-11-20 16:27:14` | when the ride started (New York time) |
| `minutes`     | `6`                   | how long it lasted               |
| `cents`       | `176`                 | what it cost, in cents ($1.76)   |
| `cappedCents` | `176`                 | what it would cost with the cap  |

## If something goes wrong

- **Every line says `↻ request failed, retrying`** — you've most likely been
  logged out. Reload the page, log in again and paste the script again.
- **It ends with `✗ INCOMPLETE`** — Citi Bike's site didn't answer for some
  dates, so a few rides are missing from the totals. Running it again usually
  fixes this.
- **It stops with `unexpected price format`** — Citi Bike has changed how
  prices are shown, and the script stops rather than risk wrong totals. It
  needs a small update before it will work again.

## Changing the cap or the time period

Near the top of `citibike-ride-costs.js`, under "Settings", you can edit two
numbers before pasting:

- `LOOKBACK_DAYS = 365` — how many days back to look.
- `PRICE_CAP_CENTS = 365` — the per-ride cap, in cents (`365` means $3.65).

## Technical details

See [DEVELOPMENT.md](DEVELOPMENT.md) for how it fetches rides, its internal settings and the tests.
