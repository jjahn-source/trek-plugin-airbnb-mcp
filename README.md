# Airbnb Stays

[![CI](https://github.com/jjahn-source/trek-plugin-airbnb-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/jjahn-source/trek-plugin-airbnb-mcp/actions/workflows/ci.yml)

Find somewhere to stay without leaving your trip. Search Airbnb for your dates,
compare prices and ratings, and add the winner to the plan in one tap.

## What it does

Adds an **Airbnb** tab to the trip planner, with the search bar you already know:
where, check in, check out, and a guest picker. The destination box completes as you
type, dates are picked on a two-month range calendar, and both dates come from the trip
you are looking at, so most searches are one click. Filters for price and place type,
sorting by price or rating, and paging through more results are all there when you
want them.

Open any stay and **"Where you'll be"** shows the neighbourhood it sits in. Airbnb only
publishes an approximate location until a booking is confirmed, so the map marks an
area rather than pretending to know the front door.

Each result also shows travel time to the places already pinned on the trip. One
distance-matrix request compares up to 20 stays at once, and the traveller can
switch between transit, driving, walking and cycling without leaving the results.

Every card carries both figures a booking decision is made on: the **total for the
stay** and the **nightly rate**. Open one and the price is itemised the way Airbnb
itemises it (nights × rate, any discount, taxes, total), read out of the payload
rather than multiplied out, because real listings carry discounts that make the total
*lower* than nights × nightly.

A stay is somewhere you sleep, so when your check-in and check-out dates match days
on the trip it is added as a **lodging block spanning those nights**, the same thing
the planner creates by hand, partner hotel reservation included, not just a pin on
the map. Dates outside the trip still add the place on its own. Either way it keeps
its price, rating and booking dates, which show up again in the place-detail panel.

Adding a stay also puts its total on the **trip budget**, so the largest line on most
trips is money the trip knows about rather than a note attached to a pin.

And the planner will tell you when nights have **no accommodation booked**, but only
on a trip that already has at least one stay on it. A trip with no lodging at all is
one being handled elsewhere, and this plugin has no standing to nag about it.

**Details** on any card opens the full listing for your dates: description, highlights,
amenities grouped the way Airbnb groups them (including what is *not* included), and the
house rules, without leaving TREK. Listings are fetched once and cached for the session.

### How the search works

Searches run against the hosted [OpenBnB MCP server](https://openbnb.ai). The plugin
holds no API key, no cookie and no shared account: every query is made with the
short-lived OAuth token of the person who typed it, which TREK obtains and stores on
their behalf. One traveller's account is never used for another's searches.

Airbnb has no public API for third-party apps, so going through OpenBnB is what makes
this work without your TREK server taking on that relationship. Each traveller signs
up to OpenBnB themselves, under their own terms. Accounts are free.

If you have not connected an account yet the tab explains what to do rather than
failing; if your session expires mid-search the plugin says so and sends you back to
reconnect.

## Screenshots

![The Airbnb tab showing real search results for a trip to Paris](./docs/screenshot.png)

## Setup

Three steps, all of them on screens you already have open. An admin does the first two
once; every traveller does the third for themselves.

### 1. Connect this TREK server to OpenBnB (admin, once)

This crosses two screens, because TREK puts plugin **settings** in the admin area and
plugin **buttons** on your own settings page:

1. **Admin → Plugins → Airbnb Stays → ⋯ → Instance settings.** Put the address your
   users reach TREK on into **This TREK server's URL**, including any path, if TREK is
   hosted under one (`https://example.com/trek`), and press **Save**. Saving restarts
   the plugin, which is how it comes to know the value.
2. **Settings → Plugins → Airbnb Stays.** Press **Register with OpenBnB**. The plugin
   performs OAuth dynamic client registration and prints a **client id** and a
   **client secret**.
3. **Back to Admin → ⋯ → Instance settings.** Paste those two into **OAuth client id**
   and **OAuth client secret**, type the two OAuth URLs shown in grey (they are
   placeholders, not values), and press **Save**.

No account, no dashboard, no support ticket. OpenBnB implements RFC 7591, so the
endpoint mints the credentials on request. The plugin cannot fill the fields in for
itself: TREK hands a plugin its config read-only, and the host's OAuth broker reads
these values straight out of the encrypted store, so the paste is the one step that has
to stay manual.

Then press **Test connection**, which sits beside the Register button on your own
Settings → Plugins card. It reports the first thing that is
actually wrong (a field still blank, an endpoint that will not answer, a token OpenBnB
rejects) instead of leaving you to discover it when a traveller's sign-in fails days
later.

> **Why the URL matters.** TREK builds the OAuth redirect from your `APP_URL`, and
> OpenBnB will only redirect to the URI registered here. OAuth compares the two
> exactly, so a missing subpath or a stray slash does not fail at registration. It
> fails much later, as a sign-in that never completes.

<details>
<summary>Scripted installs, and TREKs with no settings form</summary>

For provisioning or CI, the same registration runs from a terminal, and it calls the same
module, so both paths derive an identical redirect URI:

```bash
npm run register -- https://trek.example.com
```

On a TREK too old to build a settings form from the manifest, send the values to the
admin API instead. Activate the plugin first (**Admin → Plugins → Airbnb Stays**, toggle
it on), then, signed in as an admin, from the browser console on your TREK tab:

```js
await fetch('/api/admin/plugins/airbnb-mcp/config', {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    oauth_authorize_url: 'https://mcp.openbnb.ai/authorize',
    oauth_token_url:     'https://mcp.openbnb.ai/token',
    oauth_client_id:     'PASTE_CLIENT_ID',
    oauth_client_secret: 'PASTE_CLIENT_SECRET',
  }),
}).then(r => r.json())
```

Then **restart it**: **Admin → Plugins → ⋯ → Restart**. On such a host this is required
rather than tidiness. A plugin reads its settings once, when its process starts, so
without a restart the save appears to work and nothing changes. (Do not reach for
`POST /reload`: that endpoint is dev-only and answers 403 on a normal install. The
panel's Restart is a deactivate/activate cycle, which is the mechanism you want.)

</details>

The secret is stored encrypted either way and never leaves the host. It is also never
written anywhere the plugin controls: not to its database, not to a log.

### 2. Choose a map style (admin, optional)

**Map style** picks the basemap the "Where you'll be" map draws on: Esri's grey canvas
(the default: keyless, and the same muted basemap TREK draws its own maps on, with a
dark variant used automatically on a dark theme), OpenStreetMap, or a custom tile
server. The first two need nothing else; the third reads the three **Custom map…**
fields below it, and that host has to be added under **Allowed hosts**.

Leave the whole section alone and the map works.

### 3. Each traveller connects their own account

Every user goes to **Settings → Plugins → Airbnb Stays → Connect** once and signs in to
OpenBnB with Google, an email address or SSO. OpenBnB accounts are free. TREK never sees
the password, and one person's account is never used for another's searches. Until a
user connects, the tab shows a prompt instead of a search form.

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
| `http:outbound:server.arcgisonline.com` | Map tiles for the "Where you'll be" map in a listing's details. Esri's grey canvas is the default because it matches the basemap TREK draws its own maps on, and it needs no key. Same reason as the photos: the frame's CSP blocks remote images, so tiles are fetched here and passed to the page as data URIs. |
| `http:outbound:tile.openstreetmap.org` | The other named **Map style**, declared so choosing OpenStreetMap needs no extra step. Not used unless an admin picks it. Any other provider works too, via **Custom**: add that host under **Allowed hosts**. |
| `hook:place-detail-provider` | Adds the Airbnb link, price and rating rows to the detail panel of a place this plugin added. |
| `hook:trip-warning-provider` | Tells the planner when nights on the trip have no accommodation booked. It only speaks to a trip that already has at least one stay on it. A trip with no lodging at all is one being handled elsewhere, and nagging about it would make this plugin the noisiest thing in the planner. |
| `db:write:costs` | Adds the stay's total to the trip budget when you add it, so the largest line on most trips is money the trip knows about rather than a note on a pin. Skipped silently if the price cannot be read, and never at the cost of the place itself. |

## Development

```bash
npm install
npm test          # 164 unit tests: MCP transport, session reuse, normalisation, price parsing,
                  # OAuth registration, tile maths, the warning hook, every route
npm run smoke     # 70 browser checks: packs the frame and drives the real UI
npm run dev       # hot-reloaded local harness
npm run validate  # the registry's own publish gates
```

`npm test` covers the server through the SDK's mock host, so the permission model is
exercised rather than stubbed. `npm run smoke` covers the half unit tests cannot reach:
it packs the plugin, loads the frame with the design kit inlined exactly as it ships, and
stands in for the host over the documented `postMessage` protocol, so the search, detail,
back and add flows are checked against the real UI, not a mock of it, along with the
first-run and not-yet-configured states, plus focus management and an
accessible-name/keyboard-reachability audit of every control.

### Releasing

`trek-plugin publish` opens a fresh registry PR per version. That is right when the last
entry is already merged, but while a PR is open it hands a maintainer one PR per bump for
the same plugin. This entry's own history is nine `Ship airbnb-mcp 1.x` commits on a
single branch, merged together.

So: if a registry PR is open, release and amend it rather than opening another.

```bash
npx trek-plugin-sdk release . --repo jjahn-source/trek-plugin-airbnb-mcp --tag vX.Y.Z
node scripts/registry-bump.mjs vX.Y.Z --dry-run   # shows the diff, pushes nothing
node scripts/registry-bump.mjs vX.Y.Z
```

`release` cuts the GitHub release and stops short of the PR; `registry-bump` finds the one
open PR for this plugin, merges the new version into the entry already on its branch, and
pushes. It refuses to guess: no open PR and it tells you to use `publish`; more than one
and it stops rather than pick. Re-running for a version already on the branch is a no-op,
the original `publishedAt` is kept, so nothing is pushed just to move a timestamp.

Both paths leave the same artifact and sha256; the only difference is how many PRs a
maintainer has to look at.

`server/mcp.js` is a dependency-free Streamable-HTTP MCP client (a TREK plugin ships as
a flat bundle with no install step, so the official SDK is not worth its weight here).
It reuses one session per access token, re-handshakes a dropped one exactly once, and
terminates sessions it replaces rather than leaving them for the server to expire.
`server/normalize.js` flattens OpenBnB payloads into what the UI renders. It searches
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

It signs you in to OpenBnB in your browser, calls the listing and map tools, and writes the raw
payloads to `test/fixtures/hosted-*.json`. The access token stays in the process. It
is never printed and never written to disk; only public listing data is saved.

`test/hosted.test.js` runs against those fixtures. It is the only part of the suite
that checks the payload *shape* rather than assuming it, and it earns its keep: the
first capture found five shape bugs in the search payload, and the second found four
more in the listing payload, every one invisible to a fully green suite.

## Licence

MIT, see [LICENSE](./LICENSE).
