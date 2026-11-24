# Development notes

The snippet calls the private GraphQL endpoint the ride-history page uses,
`POST /bikesharefe-gql`, with the page's own login cookies.
`rideHistory(startTimeMs)` returns 10 rides per page, newest first, all
started before that time. There's no page-size option, but GraphQL aliases
work, so one request can ask for many pages.

`citibike-ride-costs.js` has three parts:

- **Core:** settings, cost math, report, run steps.
- **`fetchRidePages()`:** everything Citi Bike specific (endpoint, query,
  response fields). It's the only `fetch`.
- **`collectByTimeWindows()`:** generic batching. It cuts the period into
  4-day windows and asks for 30 windows' pages per request. A window that
  fills a page gets a follow-up page, and a window that keeps failing is
  reported as missing. A typical year takes about 7 requests.

## Why not one request per month?

A simpler design was also tried: each calendar month pages back on its own,
one plain page per request, with 4 months running at once. The queries are
easier to read, but the speed is limited:

- Within a month, each page starts at the oldest ride of the page before it,
  so a month's pages have to be fetched one after another. The busiest month
  decides how long the whole run takes.
- The only way to fetch more at once is to split the period into more,
  smaller ranges. Each extra range costs one more request, and running more
  requests at the same time puts more load on the server and risks being
  throttled.

That works out to about 75 requests a year instead of about 7. With fixed
windows, every start time is known up front, so they can all go into the
same few requests.

## Tests

```sh
./test-ride-costs.mjs       # needs zx; -v shows the snippet's output
```

The test runs the snippet in a Node `vm` against a fake server with synthetic
rides, under different cursor behaviours and injected failures. It checks
that the rides and totals match exactly. Instead of test hooks, the sandbox
supplies fakes for `fetch`, `console`, `Date`, `setTimeout` and
`AbortSignal`.
