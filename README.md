# Airbnb via OpenBnB

[![CI](https://github.com/jjahn-source/trek-plugin-airbnb-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/jjahn-source/trek-plugin-airbnb-mcp/actions/workflows/ci.yml)

A TREK trip-page plugin that searches Airbnb stays for your trip dates and adds the
ones you like to the trip as places — with each traveller signed in to **their own**
free [OpenBnB](https://openbnb.ai) account.

## What it does

Adds an **Airbnb** tab to the trip planner. It seeds the search from the trip you are
looking at (destination and the trip's start/end dates), then lets you filter by
guests, price and property type, sort by price or rating, page through more results,
and add any stay to the trip with one click.

A stay is somewhere you sleep, so when your check-in and check-out dates match days
on the trip it is added as a **lodging block spanning those nights** — the same thing
the planner creates by hand, partner hotel reservation included — not just a pin on
the map. Dates outside the trip still add the place on its own. Either way it keeps
its price, rating and booking dates, which show up again in the place-detail panel.

**Details** on any card opens the full listing for your dates — description, highlights,
amenities grouped the way Airbnb groups them (including what is *not* included), and the
house rules — without leaving TREK. Listings are fetched once and cached for the session.

The search itself runs against the hosted [OpenBnB MCP server](https://openbnb.ai)
over the Model Context Protocol. **This plugin does no scraping of its own.** It holds
no API key, no cookie and no shared account: every query is made with the short-lived
OAuth token of the person who typed it, which TREK obtains and stores on their behalf.

Why that matters: Airbnb has no public API for third-party apps, and their
`robots.txt` disallows the search path outright — a self-hosted scraper has to be run
with `--ignore-robots-txt` to return anything at all. Routing through OpenBnB moves
that relationship to a service the traveller signs up to themselves, under their own
terms, instead of burying it inside your TREK server.

If you have not connected an account yet the tab explains what to do rather than
failing; if your session expires mid-search the plugin says so and sends you back to
reconnect.

## Screenshots

![The Airbnb tab showing real search results for a trip to Paris](./docs/screenshot.png)

## Setup

### 1. Register this TREK instance with OpenBnB (admin, once)

OpenBnB supports OAuth Dynamic Client Registration, so this is one command — no
account, no dashboard, no support ticket:

```bash
node scripts/register-oauth-client.mjs https://trek.example.com
```

Pass exactly your server's **`APP_URL`** — the public base URL your users reach TREK
on, *including any path* if TREK is hosted under one (`https://example.com/trek`).
TREK builds the OAuth redirect from `APP_URL`, and OpenBnB only redirects to the URI
registered here, so a mismatch shows up later as a sign-in that never completes. The
script prints the redirect URI it registers — check it against your `APP_URL`.

It discovers OpenBnB's endpoints, registers a confidential client and prints five values.

### 2. Paste them into the plugin's settings (admin, once)

In TREK, go to **Admin → Plugins → Airbnb via OpenBnB → Settings** and fill in
`OAuth authorize URL`, `OAuth token URL`, `OAuth client id` and `OAuth client secret`
exactly as printed. Leave `OAuth scopes` blank. The secret is stored encrypted and
never leaves the host.

`OpenBnB MCP endpoint` is optional — leave it blank to use `https://mcp.openbnb.ai/mcp`.

### 3. Each traveller connects their own account

Every user goes to **Settings → Plugins → Airbnb via OpenBnB → Connect** once and
signs in to OpenBnB with Google, an email address or SSO. OpenBnB accounts are free.
TREK never sees the password, and one person's account is never used for another's
searches. Until a user connects, the tab shows a prompt instead of a search form.

## Permissions

| Permission | Why this plugin needs it |
|---|---|
| `db:own` | Stores your last search per trip in the plugin's own table, so switching tabs and coming back does not throw the results away. |
| `db:meta` | Records the listing id, price, rating and booking dates against a place you added, so the place-detail panel can show them later. |
| `db:read:trips` | Reads the open trip's title and start/end dates to pre-fill the destination and check-in/check-out fields. |
| `db:write:places` | Creates the place on the trip when you press "Add to trip". |
| `db:write:accommodations` | When the check-in and check-out dates line up with days on the trip, the stay is added as a lodging block spanning those nights (which also creates the matching hotel reservation), rather than just a pin on the map. If the dates fall outside the trip, or you cannot edit days, the place is still added on its own. |
| `oauth:client` | Lets TREK run the OAuth flow to OpenBnB for each user and hand this plugin a short-lived access token for whoever is searching. The client secret and refresh token stay with the host. |
| `http:outbound:mcp.openbnb.ai` | The one network call this plugin makes: the MCP request that runs the search or fetches a listing's details. |
| `http:outbound:*.muscache.com` | Listing photos live on Airbnb's image CDN. The plugin frame's CSP blocks remote images, so photos are fetched here and passed to the page as data URIs. No other host is proxied. |
| `hook:place-detail-provider` | Adds the Airbnb link, price and rating rows to the detail panel of a place this plugin added. |

## Development

```bash
npm install
npm test          # 67 unit tests: MCP transport, session reuse, normalisation, every route
npm run smoke     # 21 browser checks: packs the frame and drives the real UI
npm run dev       # hot-reloaded local harness
npm run validate  # the registry's own publish gates
```

`npm test` covers the server through the SDK's mock host, so the permission model is
exercised rather than stubbed. `npm run smoke` covers the half unit tests cannot reach:
it packs the plugin, loads the frame with the design kit inlined exactly as it ships, and
stands in for the host over the documented `postMessage` protocol — so the search, detail,
back and add flows are checked against the real UI, not a mock of it, along with the
first-run and not-yet-configured states, plus focus management and an
accessible-name/keyboard-reachability audit of every control.

`server/mcp.js` is a dependency-free Streamable-HTTP MCP client (a TREK plugin ships as
a flat bundle with no install step, so the official SDK is not worth its weight here).
It reuses one session per access token, re-handshakes a dropped one exactly once, and
terminates sessions it replaces rather than leaving them for the server to expire.
`server/normalize.js` flattens OpenBnB payloads into what the UI renders — it searches
for the fields it wants rather than indexing fixed paths, because the hosted endpoint
is a superset of the open-source server and both reshape whatever Airbnb's page
happens to contain.

## Verifying against the real service

The normalisers were written against the **open-source** OpenBnB server's schema. The
hosted endpoint is a superset, so its exact shapes are an assumption until something
checks them. To capture real responses:

```bash
node scripts/capture-fixtures.mjs "Paris, France" 2026-10-10 2026-10-14
```

It signs you in to OpenBnB in your browser, calls both tools, and writes the raw
payloads to `test/fixtures/hosted-*.json`. The access token stays in the process — it
is never printed and never written to disk; only public listing data is saved.

`test/hosted.test.js` runs against those fixtures. It is the only part of the suite
that checks the payload *shape* rather than assuming it, and it earns its keep: the
first capture found five shape bugs in the search payload, and the second found four
more in the listing payload — every one invisible to a fully green suite.

## Licence

MIT — see [LICENSE](./LICENSE).
