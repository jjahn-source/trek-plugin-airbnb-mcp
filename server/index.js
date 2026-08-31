'use strict';

const { definePlugin } = require('trek-plugin-sdk');
const { McpClient, McpError } = require('./mcp');
const { normalizeSearch, normalizeListing } = require('./normalize');

const DEFAULT_MCP_URL = 'https://mcp.openbnb.ai/mcp';
const PHOTO_MAX_BYTES = 3 * 1024 * 1024;
const PHOTO_CACHE_MAX = 120;
const SEARCH_PAGE_MAX = 40;

/** Photo bytes are immutable per URL, so an in-process LRU is safe and cheap. */
const photoCache = new Map();

function reply(status, body) {
  return { status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

function mcpUrl(ctx) {
  const raw = ctx.config && typeof ctx.config.mcp_url === 'string' ? ctx.config.mcp_url.trim() : '';
  if (!raw) return DEFAULT_MCP_URL;
  try {
    const u = new URL(raw);
    // A plugin's outbound allow-list is per-host, so an http:// or odd-host override
    // would be refused by the host anyway — fail loudly here instead.
    if (u.protocol !== 'https:') return DEFAULT_MCP_URL;
    return u.toString();
  } catch {
    return DEFAULT_MCP_URL;
  }
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

function cacheClient(key, client) {
  if (clientCache.size >= CLIENT_CACHE_MAX) clientCache.delete(clientCache.keys().next().value);
  clientCache.set(key, { client, createdAt: Date.now() });
}

/**
 * Call an OpenBnB tool as the ACTING USER. Every call uses that user's own
 * short-lived token — the plugin never holds a credential of its own.
 *
 * Throws NOT_CONNECTED when the user has not linked an OpenBnB account yet.
 */
async function callTool(ctx, name, args) {
  const token = await ctx.oauth.getAccessToken();
  if (!token) throw new McpError('no OpenBnB account linked', 'NOT_CONNECTED');

  const url = mcpUrl(ctx);
  const key = `${url}\n${token}`;
  const entry = clientCache.get(key);

  if (entry) {
    if (Date.now() - entry.createdAt > CLIENT_TTL_MS) {
      clientCache.delete(key);
    } else {
      try {
        return await entry.client.callTool(name, args);
      } catch (err) {
        clientCache.delete(key);
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
  const payload = await client.callTool(name, args);
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

function toInt(v, fallback = null) {
  const n = Number.parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? n : fallback;
}

function isDate(v) {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
}

/** Only Airbnb's own image CDN is proxyable — anything else is refused before egress. */
function parsePhotoUrl(raw) {
  if (typeof raw !== 'string' || raw.length > 2000) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (!/(^|\.)muscache\.com$/i.test(url.hostname)) return null;
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
        const cfg = ctx.config || {};
        const configured = !!(cfg.oauth_authorize_url && cfg.oauth_token_url && cfg.oauth_client_id);
        let connected = false;
        try {
          connected = !!(await ctx.oauth.getAccessToken());
        } catch {
          connected = false;
        }
        return reply(200, { configured, connected, endpoint: mcpUrl(ctx) });
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
          const out = normalizeSearch(payload);
          out.results = out.results.slice(0, SEARCH_PAGE_MAX);

          const tripId = toInt(b.tripId);
          if (tripId && req.user && req.user.id) {
            // Best-effort: losing the restore cache must never fail the search.
            try {
              await ctx.db.exec(
                `INSERT INTO last_search (trip_id, user_id, payload, updated_at) VALUES (?, ?, ?, ?)
                 ON CONFLICT(trip_id, user_id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`,
                tripId,
                req.user.id,
                JSON.stringify({ params: b, ...out }).slice(0, 400000),
                Date.now(),
              );
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
          const payload = await callTool(ctx, 'airbnb_listing_details', args);
          return reply(200, normalizeListing(id, payload));
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
        const url = parsePhotoUrl(req.query && req.query.url);
        if (!url) return reply(400, { error: 'unsupported photo URL' });
        const key = url.toString();
        if (photoCache.has(key)) return reply(200, { dataUri: photoCache.get(key) });
        try {
          const res = await fetch(key, { signal: AbortSignal.timeout(10000) });
          if (!res.ok) return reply(502, { error: `photo fetch failed (${res.status})` });
          const type = (res.headers.get('content-type') || '').split(';')[0].trim();
          if (!type.startsWith('image/')) return reply(502, { error: 'not an image' });
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
