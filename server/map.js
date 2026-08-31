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
 * Built-in tile source. Every map setting is an OVERRIDE, never a requirement: on a TREK
 * without an instance-settings form the config arrives empty, and a plugin that treated
 * these as required would simply have no map there. Keyless OSM works everywhere.
 */
const DEFAULT_TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const DEFAULT_ATTRIBUTION = '© OpenStreetMap contributors';

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

async function fetchTile(url) {
  if (tileCache.has(url)) return tileCache.get(url);
  const res = await fetch(url, { headers: { 'User-Agent': TILE_UA }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`tile ${res.status}`);
  const type = (res.headers.get('content-type') || '').split(';')[0].trim();
  if (!type.startsWith('image/')) throw new Error('tile is not an image');
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

module.exports = { staticMap, project, tileUrl, TILE, GRID, DEFAULT_TILE_URL, DEFAULT_ATTRIBUTION };
