# Airbnb Stays 2.0 — design

**Date:** 2026-09-01
**Status:** approved, not yet implemented
**Baseline:** 1.8.0 (118 unit tests + 67 smoke checks green)

## Why

Three things are true of 1.8.0 at once: the server is solid, the setup path is the
worst part of the product, and the plugin is a full SDK generation behind what
`trek-plugin-sdk@1.6.0` now offers.

Setup today costs an admin a repo checkout, a Node install, a CLI run, four values
copied off a terminal, two of which must be re-typed by hand because a manifest
`default` is silently ignored. An admin who installed this from the registry has no
repo to check out. That is the barrier worth removing.

Meanwhile the SDK grew capabilities this plugin does not use: `settings[].options`
(real dropdowns), `trek.session` (per-tab state), a design kit that upgrades native
`<select>` in-document, and a set of planner hooks — `trip-warning-provider`,
`map-marker-provider` — plus `ctx.costs` and `ctx.rates`.

## Non-goals

- Rewriting the client script. Its correctness lives in 67 smoke checks and in
  comments that record past bugs; a wholesale rewrite trades that away for style.
  Modernisation here is targeted at idioms that hide real risk.
- Removing the `oauth_authorize_url` / `oauth_token_url` settings. The HOST's broker
  reads them straight from stored config, so the plugin cannot supply them however
  much it knows their values.
- Storing an OAuth client secret anywhere the plugin controls. It belongs in the
  host's encrypted config and nowhere else.

## Track 1 — Setup

### 1.1 Register from the settings page

A new `register_client` action does what `scripts/register-oauth-client.mjs` does,
from inside the running plugin: RFC 8414 discovery against the issuer, then RFC 7591
dynamic client registration for a confidential (`client_secret_post`) client.

It needs one input the plugin cannot know — the server's public `APP_URL`, from which
TREK derives the OAuth redirect URI. That becomes a new **optional** instance setting,
`trek_url`. Optional, not required: an admin who registered with the CLI must never be
blocked by a field they do not need.

Flow: type `trek_url` → **Save** (which restarts the plugin, so the action sees it) →
press **Register with OpenBnB** → paste the two credentials it returns into the two
fields above → **Save**.

The action returns the client id and secret in its `message`. That message is bounded
host-side by an amount the SDK does not specify, so it stays terse and leads with the
two values; the two constant URLs are already in the fields' placeholders and are not
repeated. The secret is never written to the plugin's own database — a truncated
message is recoverable by pressing the button again, an unencrypted secret at rest is
not.

`scripts/register-oauth-client.mjs` stays, for scripted and CI installs. Both paths
must produce the same redirect URI, so the derivation moves into a shared module that
each imports.

Egress: discovery and registration both hit the issuer host, already declared as
`http:outbound:mcp.openbnb.ai`.

### 1.2 One map setting instead of three

`map_tile_url`, `map_tile_url_dark` and `map_attribution` are three free-text fields
asking an admin to paste `{z}/{y}/{x}` templates. They become one `map_style` select
(`options` is supported by `ManifestSettingField`):

| value | meaning |
|---|---|
| `esri` | Esri grey canvas — matches TREK's own basemap. The fallback when unset. |
| `osm` | OpenStreetMap. |
| `custom` | Use the three URL fields below. |

The three URL fields remain as the `custom` escape hatch, marked as such.

**Back-compatibility is load-bearing:** an install that already set `map_tile_url` has
no `map_style`. Resolution order is therefore: an explicit `map_style` wins; otherwise
a set `map_tile_url` is honoured as if `custom`; otherwise `esri`. An upgrade must
never silently change the map an operator chose.

### 1.3 A checklist, not a paragraph

The unconfigured gate prints a CLI command an admin often cannot run. It becomes a
numbered checklist driven by `/status`, each step ticked or open, naming the fields
still blank and pointing at the settings page rather than a terminal.

## Track 2 — Capabilities

### 2.1 Nights with nowhere to stay (`hook:trip-warning-provider`)

For a plugin about *stays*, the highest-value thing it can say is that a night has
none. `getWarnings` reads the trip's days and accommodations and reports the gap.

**It only speaks when spoken to.** A trip with zero accommodations gets no warning:
that is a trip whose lodging is handled elsewhere, or not yet started, and nagging it
would make this plugin the noisiest thing in the planner. The warning fires only when
the trip has at least one lodging block AND uncovered nights — i.e. someone is
actively booking and has a hole. Level `info`.

### 2.2 A budget line on add (`ctx.costs`)

Adding a stay creates a place and a lodging block, and records the price as a *note
string*. It should also be money the trip knows about. When the nightly amount and
both dates are known, `/add` creates a cost item for nightly × nights.

Opportunistic, exactly like `lodgingFor`: a missing `db:write:costs` grant, or any
refusal, must not lose the place the traveller just added.

### 2.3 Total price, not just per-night (client + normalize)

Every booking decision is made on the total; the card shows only the nightly rate.
`normalize` already parses `priceAmount` out of the label. With both dates known the
card gains a total, the detail view shows the arithmetic, and 2.2 has its number.

### 2.4 Candidate stays on the trip map (`hook:map-marker-provider`)

`last_search` is already stored per (trip, user), so the trip map can show the stays
under consideration next to the places already pinned — spatial comparison the
travel-time rows approximate but do not replace.

Opt-in via a `scope:'user'` setting, defaulting off. Not because it is not useful, but
because a manifest cannot express a default, and forty unexpected pins on someone
else's map is a worse first impression than a feature they had to switch on.

### 2.5 Controls that remember (`trek.session`)

Sort and Travel-by reset on every tab switch. The bridge offers per-tab, trip-scoped
state; use it for sort, commute mode and the filter values.

## Track 3 — Modernisation

### 3.1 Delete the custom place-type listbox

`.pt` — roughly 110 lines of CSS and JS — exists because a native `<select>` inside a
plugin frame dropped its option list through the iframe edge. The design kit now
upgrades native selects into host-styled, keyboard-accessible, in-document dropdowns;
the `sort` and `commute-mode` selects in the same file already prove it. The control
is now a reimplementation of the kit, and goes.

### 3.2 Targeted client modernisation

Modernise where an ES5 idiom hides risk — HTML built by string concatenation, manual
`Array.prototype` calls, `var` in closures that capture. Leave working code and its
explanatory comments alone.

### 3.3 CI

Node 20 is a generation behind; build on current LTS, and keep 20 in a matrix so the
plugin's stated floor stays tested.

## Testing

Every track is testable at the level it lives at:

- **Server** (`node --test`, through the SDK mock host, so the permission model is
  exercised rather than stubbed): registration discovery + failure modes; map-style
  resolution including the back-compat ladder; the warning hook's silence on a
  zero-lodging trip and its speech on a gap; cost creation and its degradation when
  `db:write:costs` is absent; total-price arithmetic.
- **Client** (`npm run smoke`, driving the packed frame): the setup checklist, the
  native place-type select, total price on a card, and session persistence of the
  controls across a remount.

The existing 118 + 67 must stay green throughout; that is the regression net for the
client work in 3.2.

## Release

Breaking-ish for operators (settings reshaped, new permissions requested), so **2.0.0**.
New permissions: `hook:trip-warning-provider`, `hook:map-marker-provider`,
`db:write:costs`. Each is declared with the user-facing justification the README's
permission table already sets as the standard.
