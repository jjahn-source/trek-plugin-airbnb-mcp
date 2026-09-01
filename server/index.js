'use strict';

const { definePlugin } = require('trek-plugin-sdk');
const { McpClient, McpError } = require('./mcp');
const { normalizeSearch, normalizeListing, placeCandidates } = require('./normalize')
const {
  staticMap, DEFAULT_TILE_URL, DEFAULT_TILE_URL_DARK, OSM_TILE_URL, attributionFor, imageContentType,
} = require('./map');
const commute = require('./commute');
const { registerClient } = require('./register');

const DEFAULT_MCP_URL = 'https://mcp.openbnb.ai/mcp';
const PHOTO_MAX_BYTES = 3 * 1024 * 1024;
const PHOTO_CACHE_MAX = 120;
const SEARCH_PAGE_MAX = 40;
const LAST_SEARCH_MAX_BYTES = 400000;

/** Photo bytes are immutable per URL, so an in-process LRU is safe and cheap. */
const photoCache = new Map();

function reply(status, body) {
  return { status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

/**
 * Whether a string is an endpoint this plugin could actually call.
 *
 * A plugin's outbound allow-list is per-host, so an http:// or malformed override would
 * be refused by the host anyway. Shared by the silent fallback below and by the settings
 * page's "Test connection", which must agree on what "bad" means — the test exists to
 * report the fallback, so it cannot use a different rule to decide one happened.
 */
function isHttpsUrl(raw) {
  try {
    return new URL(raw).protocol === 'https:';
  } catch {
    return false;
  }
}

function mcpUrl(ctx) {
  const raw = ctx.config && typeof ctx.config.mcp_url === 'string' ? ctx.config.mcp_url.trim() : '';
  if (!raw || !isHttpsUrl(raw)) return DEFAULT_MCP_URL;
  return new URL(raw).toString();
}

/**
 * The instance settings the HOST's OAuth broker reads, paired with the labels the
 * settings form shows for them.
 *
 * The pairing is the point. These four are the only settings this plugin cannot
 * supply a fallback for — the broker reads them straight out of the stored config,
 * so a blank one is a dead end no amount of plugin-side defaulting can rescue.
 * Naming them by their FORM LABEL rather than their storage key is what makes the
 * message actionable now that an admin has a form to look at: "OAuth client id" is
 * a field they can point at, `oauth_client_id` is not.
 */
const REQUIRED_SETTINGS = [
  { key: 'oauth_authorize_url', label: 'OAuth authorize URL' },
  { key: 'oauth_token_url', label: 'OAuth token URL' },
  { key: 'oauth_client_id', label: 'OAuth client id' },
  { key: 'oauth_client_secret', label: 'OAuth client secret' },
];

/**
 * Which tile template to draw on, from the instance settings.
 *
 * "Map style" replaced three free-text fields that asked an admin to paste {z}/{x}/{y}
 * templates, so the resolution has to answer for installs configured under either
 * shape. In order:
 *
 *   1. An explicit `map_style` wins — the admin chose from the list.
 *   2. Otherwise a set `map_tile_url` is honoured as if Custom had been chosen. This
 *      is the load-bearing rung: an operator who pointed 1.x at their own tile server
 *      must not silently get Esri back after upgrading.
 *   3. Otherwise Esri's grey canvas, which matches TREK's own basemap and needs no key.
 *
 * Dark has a real source of its own rather than falling through to the light one,
 * which used to put a bright map inside a dark trip page.
 */
function tileTemplate(cfg, dark) {
  const style = String(cfg.map_style || '').trim().toLowerCase();
  const custom = (dark ? cfg.map_tile_url_dark : cfg.map_tile_url) || cfg.map_tile_url || '';

  if (style === 'custom') return custom || (dark ? DEFAULT_TILE_URL_DARK : DEFAULT_TILE_URL);
  if (style === 'osm') return OSM_TILE_URL;
  if (style === 'esri') return dark ? DEFAULT_TILE_URL_DARK : DEFAULT_TILE_URL;
  // No style set: an install from before the dropdown existed.
  if (custom) return custom;
  return dark ? DEFAULT_TILE_URL_DARK : DEFAULT_TILE_URL;
}

/** The required settings still blank, in manifest order. */
function missingSettings(ctx) {
  const cfg = ctx.config || {};
  return REQUIRED_SETTINGS.filter((s) => !String(cfg[s.key] || '').trim());
}

/** "a", "a and b", "a, b and c" — a list a person reads, not a JSON array. */
function sentenceList(items) {
  if (items.length <= 1) return items[0] || '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/**
 * Connected MCP clients, keyed by endpoint + access token. Reusing one saves the
 * initialize/initialized handshake on every search — otherwise each query costs
 * three round trips and leaves another session behind on OpenBnB's server. The
 * key includes the token, so a refreshed token never reuses another's session and
 * entries fall out naturally as tokens rotate.
 */
const clientCache = new Map();
const CLIENT_TTL_MS = 10 * 60 * 1000;
const CLIENT_CACHE_MAX = 50;

/** Drop a cached client and hand its MCP session back to the server. */
function evict(key) {
  const entry = clientCache.get(key);
  if (!entry) return;
  clientCache.delete(key);
  // Fire-and-forget: the caller is already building a replacement.
  Promise.resolve(entry.client.close()).catch(() => {});
}

function cacheClient(key, client) {
  // Two calls that both miss the empty cache both handshake, and only one can have the
  // slot. Overwriting blindly would drop the loser's client while its MCP session is
  // still open on OpenBnB's server — the very leak close() exists to prevent, reached
  // by a race rather than by an eviction. A debounced /places typeahead overlapping a
  // /search submit is the ordinary way to get here.
  const existing = clientCache.get(key);
  if (existing && existing.client !== client) {
    // Fire-and-forget: the winner is already serving the caller.
    Promise.resolve(existing.client.close()).catch(() => {});
  } else if (!existing && clientCache.size >= CLIENT_CACHE_MAX) {
    evict(clientCache.keys().next().value);
  }
  clientCache.set(key, { client, createdAt: Date.now() });
}

/**
 * Call an OpenBnB tool as the ACTING USER. Every call uses that user's own
 * short-lived token — the plugin never holds a credential of its own.
 *
 * Throws NOT_CONNECTED when the user has not linked an OpenBnB account yet.
 */
async function callTool(ctx, name, args, alternatives) {
  const token = await ctx.oauth.getAccessToken();
  if (!token) throw new McpError('no OpenBnB account linked', 'NOT_CONNECTED');

  const url = mcpUrl(ctx);
  const key = `${url}\n${token}`;
  const entry = clientCache.get(key);

  if (entry) {
    if (Date.now() - entry.createdAt > CLIENT_TTL_MS) {
      evict(key);
    } else {
      try {
        return await entry.client.callTool(alternatives ? entry.client.pickTool(alternatives) : name, args);
      } catch (err) {
        evict(key);
        // A bad token or a real tool failure (robots.txt, unknown listing) will
        // fail again identically — only a dropped SESSION is worth retrying, and
        // retrying a tool error would hit Airbnb twice for nothing.
        const code = err instanceof McpError ? err.code : null;
        if (code === 'UNAUTHORIZED' || code === 'TOOL') throw err;
      }
    }
  }

  const client = new McpClient({ url, token });
  await client.connect();
  const payload = await client.callTool(alternatives ? client.pickTool(alternatives) : name, args);
  cacheClient(key, client);
  return payload;
}

/**
 * Turn an upstream failure into something a traveller can act on.
 *
 * The raw text is fine for the log but poor on screen: an AbortSignal timeout reads
 * "The operation was aborted", and a robots.txt refusal names a file the user has
 * never heard of. The original message is always logged; only the display copy changes.
 */
function friendlyError(message) {
  const m = String(message || '');
  if (/robots\.txt/i.test(m)) {
    return 'That MCP server was blocked by Airbnb\u2019s robots.txt. The hosted OpenBnB endpoint handles this for you \u2014 check the "OpenBnB MCP endpoint" setting with your administrator.';
  }
  if (/abort|timed? ?out|timeout/i.test(m)) {
    return 'OpenBnB took too long to answer. Try again, or narrow the search to fewer dates.';
  }
  if (/returned 429/.test(m)) {
    return 'OpenBnB is rate-limiting this account right now. Wait a moment and try again.';
  }
  if (/returned 5\d\d/.test(m)) {
    return 'OpenBnB is having trouble right now. Try again shortly.';
  }
  return m || 'The search failed.';
}

/** Map a thrown error onto an HTTP reply the client can act on. */
function errorReply(err, ctx) {
  if (err instanceof McpError && err.code === 'NOT_CONNECTED') {
    return reply(403, {
      error: 'Connect your OpenBnB account under Settings → Plugins to search.',
      connect: true,
    });
  }
  if (err instanceof McpError && err.code === 'UNAUTHORIZED') {
    return reply(401, { error: 'Your OpenBnB session expired. Reconnect under Settings → Plugins.', reconnect: true });
  }
  // Log the real message, show the actionable one.
  ctx.log.warn(`airbnb-mcp: ${err && err.message}`);
  return reply(502, { error: friendlyError(err && err.message) });
}

/**
 * Serialise the restore cache, trimming RESULTS until it fits.
 *
 * Slicing the JSON string instead (what this used to do) cuts it mid-structure:
 * the blob is then unparseable, `/last` throws, the error is swallowed, and restore
 * silently stops working — after having written a few hundred KB of garbage per
 * trip and user. Returns null when even an empty result set will not fit, which
 * means "do not cache", not "cache something broken".
 */
function cachePayload(params, out, maxBytes) {
  let results = out.results;
  for (;;) {
    const json = JSON.stringify({ params, ...out, results });
    if (json.length <= maxBytes) return json;
    if (!results.length) return null;
    results = results.slice(0, Math.floor(results.length / 2));
  }
}

function toInt(v, fallback = null) {
  const n = Number.parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? n : fallback;
}

function isDate(v) {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
}

/**
 * Only Airbnb's image CDN or the configured MCP host are proxyable; anything else
 * is refused before egress. The hosted OpenBnB server rewrites listing images
 * through its own /image endpoint, so restricting this to muscache.com (as it was)
 * rejected every real photo.
 */
function parsePhotoUrl(raw, mcpHost) {
  if (typeof raw !== 'string' || raw.length > 2000) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  const onCdn = /(^|\.)muscache\.com$/i.test(url.hostname);
  const onMcpHost = !!mcpHost && url.hostname.toLowerCase() === mcpHost.toLowerCase();
  if (!onCdn && !onMcpHost) return null;
  return url;
}

/**
 * Turn an added stay into a real lodging block when we can.
 *
 * A bare place is a poor fit for somewhere you SLEEP: TREK models that as a
 * day_accommodation spanning the nights, which also creates the partner hotel
 * reservation. That needs the trip to actually have days on the chosen dates, so
 * this is opportunistic — if the dates fall outside the trip, or the user lacks
 * day_edit, the place still stands on its own and the add succeeds either way.
 *
 * `check_in`/`check_out` on an accommodation are TIMES (the planner renders them
 * with fmtTime, alongside a check_in_end window), not dates — the dates come from
 * start_day_id/end_day_id. We do not know Airbnb's times, so they stay null.
 */
async function lodgingFor(ctx, tripId, place, listing, body) {
  if (!isDate(body.checkin) || !isDate(body.checkout)) return null;
  try {
    const days = await ctx.trips.getDays(tripId);
    const dayIdByDate = {};
    for (const d of days || []) {
      if (d && d.id != null && d.date) dayIdByDate[String(d.date).slice(0, 10)] = d.id;
    }
    const startDayId = dayIdByDate[body.checkin];
    const endDayId = dayIdByDate[body.checkout];
    if (!startDayId || !endDayId) return null;

    return await ctx.accommodations.create(tripId, {
      place_id: place.id,
      start_day_id: startDayId,
      end_day_id: endDayId,
      notes: [listing.url, listing.priceLabel].filter(Boolean).join(' — ').slice(0, 2000) || null,
    });
  } catch (err) {
    // A missing day_edit permission, or any other refusal, must not lose the place
    // the user just added.
    ctx.log.warn(`airbnb-mcp: could not create the lodging block — ${err && err.message}`);
    return null;
  }
}

module.exports = definePlugin({
  async onLoad(ctx) {
    await ctx.db.migrate(
      '001_init',
      `CREATE TABLE IF NOT EXISTS last_search (
         trip_id INTEGER NOT NULL,
         user_id INTEGER NOT NULL,
         payload TEXT NOT NULL,
         updated_at INTEGER NOT NULL,
         PRIMARY KEY (trip_id, user_id)
       )`,
    );
    ctx.log.info('airbnb-mcp loaded');
  },

  routes: [
    {
      // Does this instance have OAuth configured, and has THIS user connected?
      // The client uses it to decide between the search form and a "Connect" prompt.
      method: 'GET',
      path: '/status',
      auth: true,
      async handler(_req, ctx) {
        // Name what is missing rather than just saying "not configured", and name it
        // twice: `missing` is the storage keys (what an admin PUTs to the config API on
        // a TREK with no settings form), `missingLabels` is the field labels (what an
        // admin READS off the form on a TREK that has one). Which of the two helps
        // depends on the host, and the plugin cannot tell from here which host it is on.
        const gaps = missingSettings(ctx);
        let connected = false;
        try {
          connected = !!(await ctx.oauth.getAccessToken());
        } catch {
          connected = false;
        }
        return reply(200, {
          configured: gaps.length === 0,
          missing: gaps.map((s) => s.key),
          missingLabels: gaps.map((s) => s.label),
          connected,
          endpoint: mcpUrl(ctx),
        });
      },
    },

    {
      // Seed the form from the trip: dates and a destination guess.
      method: 'GET',
      path: '/defaults',
      auth: true,
      async handler(req, ctx) {
        const tripId = toInt(req.query && req.query.tripId);
        if (!tripId) return reply(400, { error: 'tripId is required' });
        try {
          const trip = await ctx.trips.getById(tripId);
          if (!trip) return reply(404, { error: 'trip not found' });
          return reply(200, {
            checkin: isDate(trip.start_date) ? trip.start_date : null,
            checkout: isDate(trip.end_date) ? trip.end_date : null,
            location: trip.title || '',
          });
        } catch (err) {
          return errorReply(err, ctx);
        }
      },
    },

    {
      /**
       * Destination typeahead. `maps_search_places` takes a bare query and returns
       * several candidates, which is what a suggestion list wants; `maps_geocode`
       * resolves exactly one and is the better answer for a region ("tokyo japan"),
       * so it backfills when places comes back empty. Both ride the acting user's
       * existing OpenBnB session — no extra vendor, no extra egress host.
       *
       * A failure here is never fatal: the user can always type a location by hand,
       * so an upstream error degrades to an empty list rather than an error banner.
       */
      method: 'GET',
      path: '/places',
      auth: true,
      async handler(req, ctx) {
        const q = typeof (req.query && req.query.q) === 'string' ? req.query.q.trim() : '';
        if (q.length < 2) return reply(200, { suggestions: [] });

        const seen = new Set();
        const out = [];
        const push = (label, sub, lat, lng) => {
          const name = String(label || '').trim();
          if (!name) return;
          const key = name.toLowerCase();
          if (seen.has(key)) return;
          seen.add(key);
          out.push({ label: name, sublabel: String(sub || '').trim() || null, lat: lat ?? null, lng: lng ?? null });
        };

        try {
          const payload = await callTool(ctx, 'maps_search_places', { query: q });
          for (const p of placeCandidates(payload)) push(p.label, p.sublabel, p.lat, p.lng);
        } catch (err) {
          // NOT_CONNECTED is the one case worth surfacing — the caller shows the
          // connect gate rather than a silently empty list.
          if (err && err.code === 'NOT_CONNECTED') return errorReply(err, ctx);
          ctx.log.info(`places: search failed (${err && err.message})`);
        }

        if (!out.length) {
          try {
            const payload = await callTool(ctx, 'maps_geocode', { address: q });
            for (const p of placeCandidates(payload)) push(p.label, p.sublabel, p.lat, p.lng);
          } catch (err) {
            ctx.log.info(`places: geocode failed (${err && err.message})`);
          }
        }

        return reply(200, { suggestions: out.slice(0, 6) });
      },
    },

    {
      method: 'POST',
      path: '/search',
      auth: true,
      async handler(req, ctx) {
        const b = (req.body && typeof req.body === 'object' ? req.body : {});
        const location = typeof b.location === 'string' ? b.location.trim() : '';
        if (!location) return reply(400, { error: 'location is required' });

        const args = { location };
        if (isDate(b.checkin)) args.checkin = b.checkin;
        if (isDate(b.checkout)) args.checkout = b.checkout;
        for (const k of ['adults', 'children', 'infants', 'pets', 'minPrice', 'maxPrice']) {
          const n = toInt(b[k]);
          if (n != null && n >= 0) args[k] = n;
        }
        if (typeof b.propertyType === 'string' && b.propertyType) args.propertyType = b.propertyType;
        if (typeof b.cursor === 'string' && b.cursor) args.cursor = b.cursor;

        try {
          const payload = await callTool(ctx, 'airbnb_search', args);
          const out = normalizeSearch(payload, args.cursor || null);
          out.results = out.results.slice(0, SEARCH_PAGE_MAX);

          const tripId = toInt(b.tripId);
          if (tripId && req.user && req.user.id) {
            // Best-effort: losing the restore cache must never fail the search.
            try {
              const payload = cachePayload(b, out, LAST_SEARCH_MAX_BYTES);
              if (payload) {
                await ctx.db.exec(
                  `INSERT INTO last_search (trip_id, user_id, payload, updated_at) VALUES (?, ?, ?, ?)
                   ON CONFLICT(trip_id, user_id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`,
                  tripId,
                  req.user.id,
                  payload,
                  Date.now(),
                );
              }
            } catch (err) {
              ctx.log.warn(`airbnb-mcp: could not cache last search — ${err && err.message}`);
            }
          }
          return reply(200, out);
        } catch (err) {
          return errorReply(err, ctx);
        }
      },
    },

    {
      method: 'GET',
      path: '/last',
      auth: true,
      async handler(req, ctx) {
        const tripId = toInt(req.query && req.query.tripId);
        if (!tripId || !req.user || !req.user.id) return reply(200, {});
        try {
          const rows = await ctx.db.query(
            'SELECT payload FROM last_search WHERE trip_id = ? AND user_id = ?',
            tripId,
            req.user.id,
          );
          if (!rows.length) return reply(200, {});
          return reply(200, JSON.parse(rows[0].payload));
        } catch {
          return reply(200, {});
        }
      },
    },

    {
      method: 'GET',
      path: '/listing',
      auth: true,
      async handler(req, ctx) {
        const id = req.query && req.query.id ? String(req.query.id) : '';
        if (!/^\d{1,20}$/.test(id)) return reply(400, { error: 'a numeric listing id is required' });

        const args = { id };
        if (isDate(req.query.checkin)) args.checkin = req.query.checkin;
        if (isDate(req.query.checkout)) args.checkout = req.query.checkout;
        const adults = toInt(req.query.adults);
        if (adults != null && adults > 0) args.adults = adults;

        try {
          // The hosted server names this `airbnb_listing`; the open-source one
          // `airbnb_listing_details`. Ask the session which it has.
          const payload = await callTool(ctx, 'airbnb_listing', args, ['airbnb_listing', 'airbnb_listing_details']);
          return reply(200, normalizeListing(id, payload));
        } catch (err) {
          return errorReply(err, ctx);
        }
      },
    },

    {
      // Travel time from each stay to the places already on the trip. One matrix
      // call covers up to 20 results, so this costs one round trip rather than one
      // per listing.
      method: 'POST',
      path: '/commute',
      auth: true,
      async handler(req, ctx) {
        const b = req.body && typeof req.body === 'object' ? req.body : {};
        const tripId = toInt(b.tripId);
        if (!tripId) return reply(400, { error: 'tripId is required' });

        const origins = commute.pickOrigins(b.listings);
        if (!origins.length) return reply(200, { destinations: [], times: {}, reason: 'no listings with coordinates' });

        let destinations;
        try {
          destinations = commute.pickDestinations(await ctx.trips.getPlaces(tripId));
        } catch (err) {
          return errorReply(err, ctx);
        }
        if (!destinations.length) {
          // Not an error: a trip with nothing pinned yet simply has nothing to
          // measure against, and the UI says so rather than showing a failure.
          return reply(200, { destinations: [], times: {}, reason: 'no places on this trip have coordinates yet' });
        }

        const mode = commute.normalizeMode(b.mode);
        try {
          const payload = await callTool(ctx, 'maps_distance_matrix', {
            origins: origins.map((o) => o.coord),
            destinations: destinations.map((d) => d.coord),
            mode,
          });
          return reply(200, {
            mode,
            destinations: destinations.map((d) => ({ placeId: d.id, name: d.name })),
            times: commute.normalizeMatrix(payload, origins, destinations),
          });
        } catch (err) {
          return errorReply(err, ctx);
        }
      },
    },

    {
      // The plugin frame's CSP is `img-src 'self' data: blob:` — a remote <img>
      // never renders. Listing photos therefore come back as data URIs through here.
      method: 'GET',
      path: '/photo',
      auth: true,
      async handler(req, ctx) {
        const url = parsePhotoUrl(req.query && req.query.url, new URL(mcpUrl(ctx)).hostname);
        if (!url) return reply(400, { error: 'unsupported photo URL' });
        const key = url.toString();
        if (photoCache.has(key)) return reply(200, { dataUri: photoCache.get(key) });
        try {
          const res = await fetch(key, { signal: AbortSignal.timeout(10000) });
          if (!res.ok) return reply(502, { error: `photo fetch failed (${res.status})` });
          // Named subtypes, not an `image/` prefix: this string is concatenated into the
          // data: URI the frame puts in an <img src>. See imageContentType in map.js.
          const type = imageContentType(res.headers.get('content-type'));
          if (!type) return reply(502, { error: 'not an image' });
          const buf = Buffer.from(await res.arrayBuffer());
          if (buf.length > PHOTO_MAX_BYTES) return reply(502, { error: 'image too large' });
          const dataUri = `data:${type};base64,${buf.toString('base64')}`;
          if (photoCache.size >= PHOTO_CACHE_MAX) photoCache.delete(photoCache.keys().next().value);
          photoCache.set(key, dataUri);
          return reply(200, { dataUri });
        } catch (err) {
          return reply(502, { error: (err && err.message) || 'photo fetch failed' });
        }
      },
    },

    {
      /**
       * Static map tiles around a listing, as data URIs. The frame's CSP forbids remote
       * images, so the fetch has to happen here — same reason as /photo.
       *
       * The tile source is an INSTANCE setting, so an operator who runs their own tile
       * server (or pays for one) points this at it and adds the host under Admin →
       * Plugins → Allowed hosts; the manifest declares `operatorEgress` for exactly that.
       */
      method: 'GET',
      path: '/map',
      auth: true,
      async handler(req, ctx) {
        const q = req.query || {};
        const lat = Number(q.lat);
        const lng = Number(q.lng);
        if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
          return reply(400, { error: 'lat and lng are required' });
        }
        const zoom = Math.min(18, Math.max(3, Number(q.zoom) || 14));
        const cfg = ctx.config || {};
        const dark = String(q.theme || '') === 'dark';
        const template = tileTemplate(cfg, dark);

        try {
          const map = await staticMap({ lat, lng, zoom, template });
          if (!map.tiles.some(Boolean)) {
            return reply(200, { unavailable: true, reason: 'The map service did not return any tiles.' });
          }
          // The credit follows the SOURCE actually used, so an operator who overrides the
          // tiles and forgets the attribution does not publish the wrong one.
          const attribution = cfg.map_attribution || attributionFor(template);
          return reply(200, Object.assign({ attribution }, map));
        } catch (err) {
          // A missing map must never take the listing down with it.
          ctx.log.info(`map: ${(err && err.message) || 'failed'}`);
          return reply(200, { unavailable: true, reason: 'The map could not be loaded.' });
        }
      },
    },

    {
      // Add a listing to the trip as a place, and remember the booking context so
      // the place-detail panel can show it later.
      method: 'POST',
      path: '/add',
      auth: true,
      async handler(req, ctx) {
        const b = (req.body && typeof req.body === 'object' ? req.body : {});
        const tripId = toInt(b.tripId);
        const listing = b.listing && typeof b.listing === 'object' ? b.listing : null;
        if (!tripId || !listing || !listing.id) return reply(400, { error: 'tripId and listing are required' });

        try {
          const fields = {
            name: String(listing.name || `Airbnb ${listing.id}`).slice(0, 200),
            category: 'Accommodation',
          };
          if (Number.isFinite(Number(listing.lat)) && Number.isFinite(Number(listing.lng))) {
            fields.lat = Number(listing.lat);
            fields.lng = Number(listing.lng);
          }
          const notes = [listing.priceLabel, listing.ratingLabel, listing.url].filter(Boolean).join('\n');
          if (notes) fields.notes = notes.slice(0, 2000);

          const place = await ctx.places.create(tripId, fields);
          const accommodation = await lodgingFor(ctx, tripId, place, listing, b);
          await ctx.meta.set('place', place.id, 'airbnb', {
            listingId: String(listing.id),
            listingUrl: listing.url || null,
            priceLabel: listing.priceLabel || null,
            rating: listing.rating ?? null,
            reviews: listing.reviews ?? null,
            checkin: isDate(b.checkin) ? b.checkin : null,
            checkout: isDate(b.checkout) ? b.checkout : null,
            adults: toInt(b.adults),
            addedAt: new Date().toISOString(),
          });
          return reply(200, { place, accommodation: accommodation || null });
        } catch (err) {
          return errorReply(err, ctx);
        }
      },
    },
  ],

  /**
   * Buttons on the plugin's own settings page. The keys match the manifest's `actions`.
   *
   * This exists because saving these settings is a one-way conversation otherwise: the
   * four OAuth fields are consumed by the HOST's broker, never by plugin code, so a typo
   * in the token URL does not surface until some traveller clicks Connect days later and
   * gets a sign-in that never completes. An admin who can check their own work while the
   * form is still open in front of them fixes it in seconds instead.
   */
  actions: {
    /**
     * Register this TREK instance with OpenBnB, from the settings page.
     *
     * Setup used to require a repo checkout, a Node install and a CLI run before an
     * admin could paste anything — and an admin who installed this from the registry
     * has no repo to check out. The same registration runs here instead, one button
     * away from the fields the values go into.
     *
     * It cannot finish the job: `ctx.config` is read-only and the host's broker reads
     * the credentials straight out of the encrypted instance config, so the last step
     * is still a paste. The message therefore leads with the two values that cannot be
     * guessed and does NOT repeat the two constant URLs, which are already sitting in
     * their fields as placeholders — an action message is bounded host-side, and the
     * secret is the part that must survive the trim.
     */
    async register_client(ctx) {
      const cfg = ctx.config || {};
      const appUrl = String(cfg.trek_url || '').trim();
      if (!appUrl) {
        return {
          ok: false,
          message:
            'Fill in "This TREK server\'s URL" above — the address your users reach TREK on — then press Save and run this again.',
        };
      }

      try {
        const out = await registerClient({ appUrl, mcpUrl: mcpUrl(ctx) });
        ctx.log.info(`airbnb-mcp: registered OAuth client for ${out.redirectUri}`);
        // The secret is returned and never stored: the host's encrypted config is its
        // only home, and writing a copy into this plugin's own database would be a
        // plaintext credential at rest that nothing later would clean up.
        return {
          ok: true,
          message:
            `Registered. Client id: ${out.clientId} — Client secret: ${out.clientSecret} — ` +
            'paste both into the fields above and press Save. Type the two URLs shown as ' +
            'grey placeholder text in as well; they are hints, not values.',
        };
      } catch (err) {
        const detail = String((err && err.message) || 'registration failed');
        ctx.log.warn(`airbnb-mcp: register_client failed — ${detail}`);
        return { ok: false, message: detail };
      }
    },

    async test_connection(ctx) {
      const gaps = missingSettings(ctx);
      if (gaps.length) {
        return {
          ok: false,
          message: `Not configured yet — still empty: ${sentenceList(gaps.map((s) => s.label))}.`,
        };
      }

      // mcpUrl() falls back silently on a bad override, which is right for a search (a
      // traveller should not be blocked by an admin's typo) but wrong here: a test that
      // quietly passes against a DIFFERENT endpoint than the one configured is worse
      // than no test. Say so instead.
      //
      // Judge the raw value on its own terms rather than by comparing it against what
      // mcpUrl() returned: URL normalisation rewrites perfectly good input ("https://h"
      // gains a trailing slash), so a mismatch there means nothing.
      const raw = String((ctx.config || {}).mcp_url || '').trim();
      if (raw && !isHttpsUrl(raw)) {
        return {
          ok: false,
          message: `"OpenBnB MCP endpoint" is not a usable https URL, so the hosted ${DEFAULT_MCP_URL} is being used instead. Clear the field to accept that, or correct it.`,
        };
      }
      const url = mcpUrl(ctx);

      let token = null;
      try {
        token = await ctx.oauth.getAccessToken();
      } catch {
        token = null;
      }
      if (!token) {
        // Everything checkable without a user is checked. The client id and secret are
        // only ever exercised by the broker's token exchange, so claiming they are good
        // here would be a guess — say exactly how far the test got.
        return {
          ok: true,
          message:
            'All four settings are filled in. Connect your own OpenBnB account under Settings → Plugins → Airbnb Stays → Connect, then run this again to check the credentials end to end.',
        };
      }

      const client = new McpClient({ url, token });
      try {
        await client.connect();
        // hasTool() already treats "the server would not list its tools" as good enough
        // — the same benefit of the doubt a real search gets. Only a server that listed
        // its tools and omitted this one is a configuration error worth reporting.
        if (!client.hasTool('airbnb_search')) {
          return {
            ok: false,
            message: `Connected to ${url}, but it does not offer an "airbnb_search" tool. Check the "OpenBnB MCP endpoint" setting.`,
          };
        }
        return { ok: true, message: `Connected to ${url} and signed in. Search is ready.` };
      } catch (err) {
        const code = err instanceof McpError ? err.code : null;
        if (code === 'UNAUTHORIZED') {
          return {
            ok: false,
            message:
              'OpenBnB rejected the token. Disconnect and reconnect your account; if that does not help, re-check the client id and secret.',
          };
        }
        const detail = String((err && err.message) || '');
        ctx.log.warn(`airbnb-mcp: test_connection failed — ${detail}`);
        // friendlyError's own fallback is search copy ("The search failed."), which is
        // the wrong sentence on a settings page — only borrow it when it recognised
        // something, and say where the failure was otherwise.
        const friendly = detail ? friendlyError(detail) : '';
        return {
          ok: false,
          message: friendly && friendly !== detail
            ? `Could not reach ${url}. ${friendly}`
            : `Could not reach ${url}${detail ? ` — ${detail}` : ''}. Check the endpoint and this server's outbound access.`,
        };
      } finally {
        // A test must not leave a session behind on OpenBnB's server, and it is
        // deliberately not put in the shared client cache: a search should not inherit
        // a connection opened to prove a point.
        await Promise.resolve(client.close()).catch(() => {});
      }
    },
  },

  hooks: {
    placeDetailProvider: {
      async getDetails(placeId, ctx) {
        const info = await ctx.meta.get('place', placeId, 'airbnb');
        if (!info) return [];
        const rows = [];
        if (info.listingUrl) rows.push({ label: 'Airbnb', url: info.listingUrl });
        if (info.priceLabel) {
          const range =
            info.checkin && info.checkout ? ` (${info.checkin} → ${info.checkout})` : '';
          rows.push({ label: 'Price', value: `${info.priceLabel}${range}` });
        }
        if (info.rating != null) {
          rows.push({
            label: 'Rating',
            value: `${info.rating} ★${info.reviews != null ? ` (${info.reviews})` : ''}`,
          });
        }
        return rows;
      },
    },
  },
});

// Exposed for tests; the host only ever uses the default plugin export above.
module.exports.friendlyError = friendlyError;
module.exports.cachePayload = cachePayload;
