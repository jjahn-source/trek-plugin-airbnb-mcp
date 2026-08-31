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
  { id: '1', url: 'https://www.airbnb.com/rooms/1', name: 'Sunlit loft above Rue des Rosiers', subtitle: 'Entire rental unit', area: 'Le Marais · 2 beds', badge: 'Guest favourite', priceLabel: '$1,240 for 4 nights', priceAmount: 1240, rating: 4.92, reviews: 148, photos: ['https://a0.muscache.com/im/pictures/one.jpg'] },
  // Taken from real captured data: apostrophes, en-dashes and an ampersand are what
  // Airbnb listing names actually contain, and they are exactly what a double-escaping
  // bug turns into "&#39;" on screen.
  { id: '2', url: 'https://www.airbnb.com/rooms/2', name: "Paris 10th – Gare de l'Est & Gare du Nord", subtitle: 'Entire rental unit', area: '10th arr. · 1 bed', badge: null, priceLabel: '$860 for 4 nights', priceAmount: 860, rating: 4.78, reviews: 92, photos: [] },
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
      else if (sub === '/add') data = { place: { id: 99 }, accommodation: { id: 5 } };
      else if (sub === '/photo') data = { dataUri: 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==' };
      window.postMessage({ type: 'trek:response', requestId: m.requestId, data }, '*');
    }
  });
}, { results: RESULTS, listing: LISTING });

await page.goto('file://' + path.resolve(frame));

// 1. results render from the restored search
await page.waitForSelector('.trek-card', { timeout: 15000 });
t('renders restored search results', (await page.locator('.trek-card').count()) === 2);

// 1b. photos load through the proxy, and a re-render reuses them
await page.waitForFunction(() => {
  const img = document.querySelector('.thumb');
  return img && img.src.startsWith('data:');
}, { timeout: 10000 });
const photoCallsBefore = invoked.filter((c) => c.sub.startsWith('/photo')).length;
t('fetches the listing photo through the proxy as a data URI', photoCallsBefore === 1);
await page.selectOption('#sort', 'price');   // forces a full re-render of the grid
await page.waitForTimeout(300);
const photoCallsAfter = invoked.filter((c) => c.sub.startsWith('/photo')).length;
t('reuses the cached photo across a re-render', photoCallsAfter === photoCallsBefore);
t('the photo survives the re-render', await page.locator('.thumb').first().evaluate((e) => e.src.startsWith('data:')));

// 1c. real-world characters survive escaping without turning into entities
const gridText = await page.locator('#results').innerText();
t('renders apostrophes, dashes and ampersands as themselves',
  gridText.includes("Gare de l'Est & Gare du Nord") && !/&#39;|&amp;|&quot;/.test(gridText));

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

// 2b. focus follows the view change, and comes back again
t('opening details moves focus into the detail view',
  await page.evaluate(() => document.activeElement && document.activeElement.id === 'detail-back'));

// 3. Back returns to the grid
await page.locator('#detail-back').click();
t('Back restores the results grid', await page.locator('#results').isVisible() && (await page.locator('#detail').isHidden()));
t('Back returns focus to the card it came from',
  await page.evaluate(() => {
    const a = document.activeElement;
    return !!a && a.getAttribute('data-details') === '1';
  }));

// 3b. every control carries an accessible name, and none is keyboard-unreachable
const a11y = await page.evaluate(() => {
  const problems = [];
  document.querySelectorAll('input, select').forEach((el) => {
    const named = (el.labels && el.labels.length > 0) || el.getAttribute('aria-label') || el.getAttribute('title');
    if (!named) problems.push(`unlabelled ${el.tagName.toLowerCase()}#${el.id || '?'}`);
  });
  document.querySelectorAll('button').forEach((el) => {
    const name = (el.textContent || '').trim() || el.getAttribute('aria-label');
    if (!name) problems.push(`button with no accessible name: ${el.className}`);
    if (el.tabIndex < 0) problems.push(`button not reachable by keyboard: ${name}`);
  });
  document.querySelectorAll('img').forEach((el) => {
    if (el.getAttribute('alt') === null) problems.push('img with no alt attribute');
  });
  return problems;
});
t('every control has an accessible name and is keyboard-reachable', a11y.length === 0, a11y.join('; '));

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
const notify = await page.evaluate(() => window.__lastNotify);
t('says the stay became lodging, not just a pin',
  !!notify && notify.level === 'success' && /lodging for those nights/i.test(notify.message));

// --- second scenario: a connected user with no previous search ------------------
{
  const page2 = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page2.addInitScript(() => {
    window.addEventListener('message', (ev) => {
      const m = ev.data;
      if (!m || typeof m.type !== 'string') return;
      if (m.type === 'trek:ready' || m.type === 'trek:context:request') {
        window.postMessage({
          type: 'trek:context', tripId: '7', theme: 'light', locale: 'en', dir: 'ltr',
          user: { name: 'Alex' }, formats: {}, appearance: {}, tokens: {},
        }, '*');
        return;
      }
      if (m.type === 'trek:invoke') {
        const sub = String(m.sub || '').split('?')[0];
        let data = {};
        if (sub === '/status') data = { configured: true, connected: true };
        else if (sub === '/last') data = {};                       // nothing cached yet
        else if (sub === '/defaults') data = { checkin: '2026-10-10', checkout: '2026-10-14', location: 'Paris' };
        window.postMessage({ type: 'trek:response', requestId: m.requestId, data }, '*');
      }
    });
  });
  await page2.goto('file://' + path.resolve(frame));
  await page2.waitForSelector('#results .empty', { timeout: 10000 });
  const introText = await page2.locator('#results').innerText();
  t('first run shows guidance instead of a blank area', /just press Search/i.test(introText));
  t('first run seeds the form from the trip', (await page2.locator('#location').inputValue()) === 'Paris'
    && (await page2.locator('#checkin').inputValue()) === '2026-10-10');
  await page2.close();
}

// --- third scenario: the admin has not configured OAuth -------------------------
{
  const page3 = await browser.newPage({ viewport: { width: 1280, height: 700 } });
  await page3.addInitScript(() => {
    window.addEventListener('message', (ev) => {
      const m = ev.data;
      if (!m || typeof m.type !== 'string') return;
      if (m.type === 'trek:ready' || m.type === 'trek:context:request') {
        window.postMessage({ type: 'trek:context', tripId: '7', theme: 'light', locale: 'en', dir: 'ltr', user: null, formats: {}, appearance: {}, tokens: {} }, '*');
        return;
      }
      if (m.type === 'trek:invoke') {
        const sub = String(m.sub || '').split('?')[0];
        const data = sub === '/status' ? { configured: false, connected: false } : {};
        window.postMessage({ type: 'trek:response', requestId: m.requestId, data }, '*');
      }
    });
  });
  await page3.goto('file://' + path.resolve(frame));
  await page3.waitForSelector('#gate .trek-title', { timeout: 10000 });
  const gateText = await page3.locator('#gate').innerText();
  t('unconfigured instance explains what the admin must do', /administrator/i.test(gateText));
  t('unconfigured instance hides the search form', await page3.locator('#app').isHidden());
  await page3.close();
}

await browser.close();

let failed = 0;
for (const r of results) {
  console.log(`  ${r.ok ? '✓' : '✗'} ${r.name}${r.extra ? ' — ' + r.extra : ''}`);
  if (!r.ok) failed++;
}
console.log(failed ? `\n${failed} smoke check(s) failed` : `\nall ${results.length} smoke checks passed`);
process.exit(failed ? 1 : 0);
