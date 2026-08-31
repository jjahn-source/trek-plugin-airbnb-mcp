#!/usr/bin/env node
/**
 * Browser smoke test for the packed frame.
 *
 * Unit tests cover the server; this covers the half they cannot reach — that the
 * real UI, with the design kit inlined exactly as it ships, drives the documented
 * host protocol correctly. The page is loaded top-level so the kit's postMessage
 * to `window.parent` lands back on the same window, letting us stand in for TREK
 * without patching the kit.
 *
 *   node scripts/smoke.mjs <packed client/index.html>
 */
import { chromium } from 'playwright';
import path from 'node:path';

const frame = process.argv[2];
if (!frame) {
  console.error('usage: node scripts/smoke.mjs <packed client/index.html>');
  process.exit(1);
}

const RESULTS = [
  { id: '1', url: 'https://www.airbnb.com/rooms/1', name: 'Sunlit loft above Rue des Rosiers', subtitle: 'Entire rental unit', area: 'Le Marais · 2 beds', badge: 'Guest favourite', priceLabel: '$1,240 for 4 nights', priceAmount: 1240, rating: 4.92, reviews: 148, photos: [] },
  { id: '2', url: 'https://www.airbnb.com/rooms/2', name: 'Quiet studio by Canal Saint-Martin', subtitle: 'Entire rental unit', area: '10th arr. · 1 bed', badge: null, priceLabel: '$860 for 4 nights', priceAmount: 860, rating: 4.78, reviews: 92, photos: [] },
];

const LISTING = {
  id: '1',
  url: 'https://www.airbnb.com/rooms/1',
  title: 'Sunlit loft above Rue des Rosiers',
  description: 'A quiet top-floor loft with original beams.\nTwo minutes from the Saint-Paul métro.',
  highlights: 'Self check-in, Great location',
  houseRules: 'No parties. Quiet hours after 22:00.',
  amenities: { Bathroom: 'Hair dryer, Shampoo', Kitchen: 'Oven, Dishwasher', 'Not included': 'Dryer, Air conditioning' },
  photos: [],
};

const results = [];
const t = (name, ok, extra = '') => { results.push({ name, ok, extra }); };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const invoked = [];
page.on('console', (m) => { if (m.type() === 'error') console.error('  [page error]', m.text()); });

await page.exposeFunction('__record', (sub, method, body) => { invoked.push({ sub, method, body }); });

await page.addInitScript(({ results: R, listing: L }) => {
  window.addEventListener('message', (ev) => {
    const m = ev.data;
    if (!m || typeof m.type !== 'string') return;
    if (m.type === 'trek:ready' || m.type === 'trek:context:request') {
      window.postMessage({
        type: 'trek:context', tripId: '7', placeId: null, dayId: null, reservationId: null,
        dir: 'ltr', userId: '42', theme: 'light', locale: 'en', hostOrigin: 'https://trek.example.com',
        user: { name: 'Alex', avatar: null, isAdmin: true },
        formats: { locale: 'en', currency: 'USD', timeFormat: '24h', distanceUnit: 'km', temperatureUnit: 'c', timezone: 'Europe/Paris', blurBookingCodes: false },
        appearance: { scheme: 'light', density: 'comfortable', reducedMotion: false, noTransparency: false },
        tokens: {},
      }, '*');
      return;
    }
    if (m.type === 'trek:notify') { window.__lastNotify = m; return; }
    if (m.type === 'trek:invoke') {
      window.__record(m.sub, m.method || 'GET', m.body || null);
      const sub = String(m.sub || '').split('?')[0];
      let data = {};
      if (sub === '/status') data = { configured: true, connected: true, endpoint: 'https://mcp.openbnb.ai/mcp' };
      else if (sub === '/last') data = { params: { location: 'Paris, France', adults: 2 }, results: R, cursor: null };
      else if (sub === '/listing') data = L;
      else if (sub === '/add') data = { place: { id: 99 } };
      window.postMessage({ type: 'trek:response', requestId: m.requestId, data }, '*');
    }
  });
}, { results: RESULTS, listing: LISTING });

await page.goto('file://' + path.resolve(frame));

// 1. results render from the restored search
await page.waitForSelector('.trek-card', { timeout: 15000 });
t('renders restored search results', (await page.locator('.trek-card').count()) === 2);

// 2. Details opens the listing view
await page.locator('[data-details="1"]').click();
await page.waitForSelector('#detail .trek-title', { timeout: 10000 });
const detailText = await page.locator('#detail').innerText();
t('calls /listing with the listing id', invoked.some((c) => c.sub.startsWith('/listing?id=1')));
t('shows the description', detailText.includes('original beams'));
// The kit uppercases .trek-field-label, so innerText yields "BATHROOM" — match loosely.
const detailLower = detailText.toLowerCase();
t('shows amenity groups', detailLower.includes('bathroom') && detailLower.includes('not included'));
t('shows house rules', detailText.includes('Quiet hours'));
t('hides the results grid while the detail is open', await page.locator('#results').isHidden());

// 3. Back returns to the grid
await page.locator('#detail-back').click();
t('Back restores the results grid', await page.locator('#results').isVisible() && (await page.locator('#detail').isHidden()));

// 4. a second Details click is served from cache (no second /listing call)
const before = invoked.filter((c) => c.sub.startsWith('/listing')).length;
await page.locator('[data-details="1"]').click();
await page.waitForSelector('#detail .trek-title', { timeout: 10000 });
const after = invoked.filter((c) => c.sub.startsWith('/listing')).length;
t('caches the listing instead of refetching', after === before);

// 5. Add to trip works from inside the detail view, keyed by id
await page.locator('#detail [data-add="1"]').click();
await page.waitForFunction(() => document.querySelector('#detail [data-add]')?.textContent.includes('Added'), { timeout: 10000 });
const addCall = invoked.find((c) => c.sub === '/add');
t('adds from the detail view', !!addCall && addCall.body.listing.id === '1' && addCall.body.tripId === 7);

await browser.close();

let failed = 0;
for (const r of results) {
  console.log(`  ${r.ok ? '✓' : '✗'} ${r.name}${r.extra ? ' — ' + r.extra : ''}`);
  if (!r.ok) failed++;
}
console.log(failed ? `\n${failed} smoke check(s) failed` : `\nall ${results.length} smoke checks passed`);
process.exit(failed ? 1 : 0);
