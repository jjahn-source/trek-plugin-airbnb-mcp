'use strict';

/**
 * A small static map for the listing detail view.
 *
 * The plugin frame's CSP is `img-src 'self' data: blob:` — it will not load a tile from
 * a map host, ever. So tiles are fetched HERE and handed to the frame as data URIs, the
 * same way listing photos already are, and the frame composes them with CSS grid. No
 * image library is involved, which matters: the manifest declares `nativeModules: false`.
 *
 * What is shown is an AREA, not an address. Airbnb only publishes an approximate
 * location for a listing before booking, so a precise pin would claim more accuracy than
 * the data has; the client draws a circle instead.
 */

/**
 * Built-in tile source: Esri's grey canvas, matching the muted basemap TREK draws its
 * own maps on, so the detail map does not look like a different application.
 *
 * TREK's own default is OpenFreeMap Positron, which cannot be used here: OpenFreeMap
 * serves VECTOR tiles only, as MapLibre style documents, and this is a raster stitcher —
 * it has to fetch finished {z}/{x}/{y} images because the plugin frame's CSP forbids
 * loading a tile from a map host at all. Esri's grey canvas is the same design intent in
 * raster form, it is keyless, and TREK offers it as a basemap of its own, so the two
 * surfaces agree. CARTO's Positron raster would have been the closest match but has
 * carried an "API KEY REQUIRED" watermark on keyless tiles since 26.08.2026.
 *
 * Note the {z}/{y}/{x} order — Esri puts the row before the column, unlike every other
 * template here. tileUrl() substitutes by NAME, so this needs no special handling.
 *
 * Every map setting remains an OVERRIDE, never a requirement: on a TREK that cannot fill
 * in instance settings the config arrives empty, and a plugin that treated these as
 * required would simply have no map there.
 */
const ESRI_BASE = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas';
const DEFAULT_TILE_URL = `${ESRI_BASE}/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}`;
const DEFAULT_TILE_URL_DARK = `${ESRI_BASE}/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}`;
const DEFAULT_ATTRIBUTION = 'Tiles © Esri — Esri, DeLorme, NAVTEQ';
const OSM_ATTRIBUTION = '© OpenStreetMap contributors';

/**
 * OpenStreetMap's standard raster tiles, offered as a named "Map style" choice.
 *
 * Its host is already declared in the manifest's egress, so choosing it needs no
 * Allowed-hosts step — which is the point of naming it in the dropdown rather than
 * leaving an admin to paste this template and then wonder why nothing loads.
 */
const OSM_TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

/**
 * The credit owed by whichever tile source a map was actually drawn from.
 *
 * The source decides, not the call site. An operator who points `map_tile_url` at OSM
 * and leaves `map_attribution` alone would otherwise get Esri's credit printed under
 * OpenStreetMap tiles — wrong, and a licence problem in both directions.
 */
function attributionFor(template) {
  const t = String(template || '');
  if (!t || t.includes('arcgisonline.com')) return DEFAULT_ATTRIBUTION;
  if (t.includes('openstreetmap.org')) return OSM_ATTRIBUTION;
  // An unknown source gets no invented credit — the operator who pointed us at it
  // knows who owns it and can say so with `map_attribution`.
  return '';
}

const TILE = 256;
const GRID = 3; // 3x3 tiles around the centre — enough context to recognise a neighbourhood
const TILE_MAX_BYTES = 512 * 1024;
const CACHE_MAX = 240;

/** z/x/y/style -> data URI. Tiles are immutable, so a plain bounded LRU is enough. */
const tileCache = new Map();

/**
 * Web-Mercator: fractional tile coordinates for a lat/lng at a zoom level.
 *
 * The result is pinned inside [0, n). At the Mercator limit the arithmetic lands a few
 * billionths BELOW zero, and `Math.floor` turns that into tile -1 — which silently
 * shifted the whole mosaic by one tile for a listing at an extreme latitude.
 */
function project(lat, lng, zoom) {
  const n = Math.pow(2, zoom);
  const clamped = Math.max(-85.05112878, Math.min(85.05112878, lat));
  const rad = (clamped * Math.PI) / 180;
  const y = ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n;
  const EDGE = 1e-9;
  return {
    x: ((lng + 180) / 360) * n,
    y: Math.min(Math.max(y, 0), n - EDGE),
  };
}

/**
 * Substitute a slippy-map template. `{s}` (the subdomain shard) is resolved to a fixed
 * value rather than a random one so the cache key and the URL stay in step.
 */
function tileUrl(template, z, x, y) {
  return String(template)
    .replace(/\{s\}/g, 'a')
    .replace(/\{z\}/g, String(z))
    .replace(/\{x\}/g, String(x))
    .replace(/\{y\}/g, String(y))
    .replace(/\{r\}/g, '');
}

/**
 * OpenStreetMap's tile usage policy requires an identifying User-Agent and refuses
 * anonymous clients. Providers that do not care ignore it, so it is sent unconditionally.
 */
const TILE_UA = 'TREK-airbnb-stays-plugin/1.6 (+https://github.com/jjahn-source/trek-plugin-airbnb-mcp)';

/**
 * The image content type, or null if the header is not one we are willing to embed.
 *
 * This value is not merely a gate — it is CONCATENATED into the `data:` URI that ends
 * up in an `<img src>` inside the frame. A tile host answering
 *   Content-Type: image/png" onerror="…
 * satisfies any `startsWith('image/')` test, then closes the src attribute and opens an
 * event handler. So the check NAMES the subtypes it accepts rather than describing the
 * prefix it hopes for: an allow-list cannot be talked into admitting a quote.
 *
 * Shared with /photo in index.js, which embeds CDN bytes the same way and is reachable
 * by the same trick. The frame escapes the URI as well — this is the half that holds
 * even if a future caller forgets to.
 *
 * Raster only: SVG is a document format that happens to draw, and no tile or listing
 * photo has ever needed it.
 */
function imageContentType(raw) {
  const type = String(raw || '').split(';')[0].trim().toLowerCase();
  return /^image\/(png|jpeg|jpg|webp|gif|avif)$/.test(type) ? type : null;
}

async function fetchTile(url) {
  if (tileCache.has(url)) return tileCache.get(url);
  const res = await fetch(url, { headers: { 'User-Agent': TILE_UA }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`tile ${res.status}`);
  const type = imageContentType(res.headers.get('content-type'));
  if (!type) throw new Error('tile is not an image');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > TILE_MAX_BYTES) throw new Error('tile too large');
  const dataUri = `data:${type};base64,${buf.toString('base64')}`;
  if (tileCache.size >= CACHE_MAX) tileCache.delete(tileCache.keys().next().value);
  tileCache.set(url, dataUri);
  return dataUri;
}

/**
 * Build the tile mosaic for a point. Returns the tiles in row-major order plus where the
 * point falls inside the mosaic, in pixels, so the caller can centre it.
 *
 * A tile that fails is returned as null rather than failing the whole map: a hole in the
 * corner of a mosaic is a much better outcome than no map at all.
 */
async function staticMap({ lat, lng, zoom = 14, template }) {
  const p = project(lat, lng, zoom);
  const cx = Math.floor(p.x);
  const cy = Math.floor(p.y);
  const half = Math.floor(GRID / 2);
  const n = Math.pow(2, zoom);

  const coords = [];
  for (let row = 0; row < GRID; row++) {
    for (let col = 0; col < GRID; col++) {
      const x = cx - half + col;
      const y = cy - half + row;
      // Wrap horizontally (the world repeats east-west); clamp vertically (it does not).
      coords.push({ x: ((x % n) + n) % n, y, valid: y >= 0 && y < n });
    }
  }

  const tiles = await Promise.all(
    coords.map(async (c) => {
      if (!c.valid) return null;
      try {
        return await fetchTile(tileUrl(template, zoom, c.x, c.y));
      } catch {
        return null;
      }
    }),
  );

  return {
    tiles,
    grid: GRID,
    tileSize: TILE,
    width: GRID * TILE,
    height: GRID * TILE,
    // Offset of the point inside the mosaic: whole tiles to the centre, then the
    // fraction within the centre tile.
    markerX: half * TILE + (p.x - cx) * TILE,
    markerY: half * TILE + (p.y - cy) * TILE,
    zoom,
  };
}

module.exports = {
  staticMap, project, tileUrl, TILE, GRID, imageContentType,
  DEFAULT_TILE_URL, DEFAULT_TILE_URL_DARK, DEFAULT_ATTRIBUTION, OSM_ATTRIBUTION, OSM_TILE_URL, attributionFor,
};
