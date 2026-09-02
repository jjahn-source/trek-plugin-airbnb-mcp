#!/usr/bin/env node
/**
 * Render the packed frame (design kit already inlined) against fixture data and
 * write docs/screenshot.png.
 *
 * The page is loaded top-level, so the kit's postMessage to `window.parent` lands
 * back on the same window. That lets us stand in for the host using only the
 * documented protocol, with no patching of the kit, so what is captured is the real UI.
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const frame = process.argv[2];
const out = process.argv[3] || 'docs/screenshot.png';
if (!frame) {
  console.error('usage: node scripts/screenshot.mjs <packed client/index.html> [out.png]');
  process.exit(1);
}

// Real listings, normalised from the captured hosted-endpoint response, so the
// store card shows what the plugin actually renders, not a hand-written mock.
const { normalizeSearch } = await import('../server/normalize.js').then((m) => m.default ?? m);
const { staticMap } = await import('../server/map.js').then((m) => m.default ?? m);
const captured = JSON.parse(readFileSync(new URL('../test/fixtures/hosted-search.json', import.meta.url), 'utf8'));
const RESULTS = normalizeSearch(captured, null).results;

// Listing photos are public on the MCP host; inline them as data URIs so the page
// needs no network at render time (and the frame's CSP would block remote images).
const PHOTOS = {};
await Promise.all(
  RESULTS.flatMap((r) => r.photos.slice(0, 1)).map(async (url) => {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) return;
      const type = (res.headers.get('content-type') || 'image/jpeg').split(';')[0];
      const buf = Buffer.from(await res.arrayBuffer());
      PHOTOS[url] = `data:${type};base64,${buf.toString('base64')}`;
    } catch { /* the card renders without it */ }
  }),
);
console.log(`fetched ${Object.keys(PHOTOS).length}/${RESULTS.length} listing photos`);

// A REAL mosaic from the default tile source, so the captured image shows the map a
// traveller actually gets rather than a stand-in.
const firstWithCoords = RESULTS.find((r) => r.lat != null && r.lng != null);
const MAP = firstWithCoords
  ? Object.assign(
      { attribution: '© OpenStreetMap contributors' },
      await staticMap({
        lat: Number(firstWithCoords.lat),
        lng: Number(firstWithCoords.lng),
        zoom: 15,
        template: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      }),
    )
  : { unavailable: true, reason: 'no coordinates in the fixture' };
console.log(`map tiles: ${(MAP.tiles || []).filter(Boolean).length}/${(MAP.tiles || []).length}`);

const FIXTURES = {
  '/status': { configured: true, connected: true, endpoint: 'https://mcp.openbnb.ai/mcp' },
  '/map': MAP,
  '/last': { params: { location: 'Paris, France', checkin: '2026-10-10', checkout: '2026-10-14', adults: 2 }, results: RESULTS, cursor: 'next' },
  '/photos': PHOTOS,
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });

await page.addInitScript((fixtures) => {
  // Stand in for the TREK host: answer the frame's postMessage protocol.
  window.addEventListener('message', (ev) => {
    const m = ev.data;
    if (!m || typeof m.type !== 'string') return;
    if (m.type === 'trek:ready' || m.type === 'trek:context:request') {
      // The kit reads context fields off the message itself, not a nested object.
      window.postMessage({
        type: 'trek:context',
        tripId: '7', placeId: null, dayId: null, reservationId: null, dir: 'ltr',
        userId: '42', theme: 'light', locale: 'en', hostOrigin: 'https://trek.example.com',
        user: { name: 'Alex', avatar: null, isAdmin: true },
        formats: { locale: 'en', currency: 'USD', timeFormat: '24h', distanceUnit: 'km', temperatureUnit: 'c', timezone: 'Europe/Paris', blurBookingCodes: false },
        appearance: { scheme: 'light', density: 'comfortable', reducedMotion: false, noTransparency: false },
        tokens: {},
      }, '*');
      return;
    }
    if (m.type === 'trek:invoke') {
      const raw = String(m.sub || '');
      const sub = raw.split('?')[0];
      let data = Object.prototype.hasOwnProperty.call(fixtures, sub) ? fixtures[sub] : {};
      if (sub === '/photo') {
        const url = decodeURIComponent((raw.split('url=')[1] || ''));
        data = fixtures['/photos'][url] ? { dataUri: fixtures['/photos'][url] } : {};
      }
      window.postMessage({ type: 'trek:response', requestId: m.requestId, data }, '*');
    }
  });
}, FIXTURES);

await page.goto('file://' + path.resolve(frame));
// Wait for the restored results to paint rather than racing a fixed delay.
await page.waitForSelector('.card:not(.sk)', { timeout: 15000 });
// SHOT_OPEN=<selector> opens one control before capturing, for documenting the
// calendar and the guest picker rather than only the closed bar.
if (process.env.SHOT_OPEN) {
  await page.locator(process.env.SHOT_OPEN).first().click();
  await page.waitForTimeout(250);
}
await page.waitForTimeout(400);
await page.screenshot({ path: out });
await browser.close();
console.log(`wrote ${out}`);
