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
  { id: '1', url: 'https://www.airbnb.com/rooms/1', name: 'Sunlit loft above Rue des Rosiers', subtitle: 'Entire rental unit', area: 'Le Marais · 2 beds', badge: 'Guest favourite', priceLabel: '$1,240 USD total', priceAmount: 1240, pricePerNight: 280, priceNights: 4, priceBase: 1120, priceTaxes: 120, priceTotal: 1240, priceCurrency: 'USD', rating: 4.92, reviews: 148, lat: 48.86, lng: 2.35, photos: [
    'https://a0.muscache.com/im/pictures/one.jpg',
    'https://a0.muscache.com/im/pictures/two.jpg',
    'https://a0.muscache.com/im/pictures/three.jpg',
  ] },
  // Taken from real captured data: apostrophes, en-dashes and an ampersand are what
  // Airbnb listing names actually contain, and they are exactly what a double-escaping
  // bug turns into "&#39;" on screen.
  { id: '2', url: 'https://www.airbnb.com/rooms/2', name: "Paris 10th – Gare de l'Est & Gare du Nord", subtitle: 'Entire rental unit', area: '10th arr. · 1 bed', badge: null, priceLabel: '$860 USD total', priceAmount: 860, pricePerNight: 240, priceNights: 4, priceBase: 960, priceDiscount: 130, priceDiscountLabel: 'Early booking discount', priceTaxes: 30, priceTotal: 860, priceCurrency: 'USD', rating: 4.78, reviews: 92, lat: 48.88, lng: 2.36, photos: [] },
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
    // Per-tab view state. The real host persists these; standing in for it here is what
    // keeps a session read from hanging on an unresolved promise.
    if (m.type === 'trek:session:set') {
      window.__session = window.__session || {};
      window.__sessionScopes = window.__sessionScopes || {};
      window.__sessionScopes[m.key] = m.scope;
      window.__session[m.key] = m.value;
      window.postMessage({ type: 'trek:response', requestId: m.requestId, data: undefined }, '*');
      return;
    }
    if (m.type === 'trek:session:get') {
      window.postMessage({
        type: 'trek:response', requestId: m.requestId,
        data: (window.__session || {})[m.key],
      }, '*');
      return;
    }
    if (m.type === 'trek:invoke') {
      window.__record(m.sub, m.method || 'GET', m.body || null);
      const sub = String(m.sub || '').split('?')[0];
      let data = {};
      if (sub === '/status') data = { configured: true, connected: true, endpoint: 'https://mcp.openbnb.ai/mcp' };
      else if (sub === '/last') data = { params: { location: 'Paris, France', adults: 2 }, results: R, cursor: null };
      else if (sub === '/listing') data = L;
      else if (sub === '/commute') data = {
        mode: m.body.mode,
        destinations: [{ placeId: 10, name: 'Louvre' }],
        times: {
          1: [{ placeId: 10, name: 'Louvre', label: m.body.mode === 'walking' ? '22 min' : '14 min', seconds: 840, distance: '3.2 km' }],
          2: [{ placeId: 10, name: 'Louvre', label: m.body.mode === 'walking' ? '31 min' : '18 min', seconds: 1080, distance: '4.1 km' }],
        },
      };
      else if (sub === '/add') data = { place: { id: 99 }, accommodation: { id: 5 } };
      else if (sub === '/photo') data = String(m.sub).includes('three.jpg')
        ? {}
        : { dataUri: 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==' };
      else if (sub === '/places') data = { suggestions: [
        { label: 'Tokyo', sublabel: 'Tokyo, Japan', lat: 35.6762, lng: 139.6503 },
        { label: 'Shibuya', sublabel: 'Shibuya City, Tokyo, Japan', lat: 35.6595, lng: 139.7005 },
      ] };
      else if (sub === '/search') data = { results: R, cursor: null };
      else if (sub === '/map') data = {
        tiles: new Array(9).fill('data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw=='),
        grid: 3, tileSize: 256, width: 768, height: 768,
        markerX: 300, markerY: 340, zoom: 14, attribution: '© OpenStreetMap contributors © CARTO',
      };
      window.postMessage({ type: 'trek:response', requestId: m.requestId, data }, '*');
    }
  });
}, { results: RESULTS, listing: LISTING });

page.on('pageerror', (err) => console.log('  [pageerror]', err.message));
await page.goto('file://' + path.resolve(frame));

// 1. results render from the restored search
await page.waitForSelector('.card:not(.sk)', { timeout: 15000 });
t('renders restored search results', (await page.locator('.card:not(.sk)').count()) === 2);

// 1a. the client turns the server-side matrix into per-card travel times
await page.waitForSelector('[data-commute="1"]:not([hidden])', { timeout: 10000 });
const commuteCall = invoked.find((c) => c.sub === '/commute');
t('measures the result set against trip places in one call', !!commuteCall
  && commuteCall.body.tripId === 7 && commuteCall.body.mode === 'transit'
  && commuteCall.body.listings.length === 2);
// The card carries BOTH figures: the total for the stay and the nightly rate people
// compare on. A total alone hides how long the stay is; a rate alone is what booking
// sites were regulated for.
t('a card shows the total and the nightly rate together', await page.evaluate(() => {
  const el = document.querySelector('[data-details="1"] .card-price');
  return el ? /total/i.test(el.textContent) && /\/night/.test(el.textContent) : false;
}), await page.locator('[data-details="1"] .card-price').innerText());

t('shows the travel time and destination on its listing card',
  /Louvre/.test(await page.locator('[data-commute="1"]').innerText())
  && /14 min/.test(await page.locator('[data-commute="1"]').innerText()));

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
t('sorting does not remeasure travel times', invoked.filter((c) => c.sub === '/commute').length === 1);

// Each result previews all of the photos the search already returned, with the same
// over-image arrows and position dots travellers expect from Airbnb cards.
const listingCallsBeforePreview = invoked.filter((c) => c.sub.startsWith('/listing')).length;
await page.locator('[data-details="1"] .card-photo-next').click();
await page.waitForFunction(() => {
  const img = document.querySelector('[data-details="1"] img[data-card-at]');
  return img?.getAttribute('data-card-at') === '1' && img.src.startsWith('data:');
});
t('next previews the next listing photo without opening details',
  await page.locator('[data-details="1"] img[data-card-at]').getAttribute('data-card-at') === '1'
  && invoked.filter((c) => c.sub.startsWith('/listing')).length === listingCallsBeforePreview);
t('the card carousel marks the current photo',
  (await page.locator('[data-details="1"] .card-dot.is-current').count()) === 1);
await page.locator('[data-details="1"] .card-photo-next').click();
await page.waitForFunction(() => {
  const img = document.querySelector('[data-details="1"] img[data-card-at]');
  return img?.getAttribute('data-card-at') === '1' && !img.classList.contains('is-loading');
});
t('a failed preview keeps the current photo instead of showing a broken tile',
  await page.locator('[data-details="1"] img[data-card-at]').evaluate((img) =>
    img.src.startsWith('data:') && img.alt.startsWith('Photo 2 of')));
await page.locator('[data-details="1"] .card-photo-prev').click();
t('previous returns to the prior listing photo',
  await page.locator('[data-details="1"] img[data-card-at]').getAttribute('data-card-at') === '0');

await page.selectOption('#commute-mode', 'walking');

// Sort and Travel-by are the traveller's view of a result set, not part of the search,
// so the server-side restore cache never carried them and they reset on every tab
// switch. They now ride the bridge's per-tab, trip-scoped state.
// Wait for the VALUE, not the key: an earlier sort change already wrote this key, so
// waiting for its mere existence returns instantly and reads the previous mode.
await page.waitForFunction(
  () => (window.__session || {})['view-prefs']?.commuteMode === 'walking',
  { timeout: 5000 },
).catch(() => {});
t('the travel mode is remembered for this trip', await page.evaluate(() => {
  const v = (window.__session || {})['view-prefs'];
  return !!v && v.commuteMode === 'walking' && window.__sessionScopes['view-prefs'] === 'trip';
}), await page.evaluate(() => JSON.stringify((window.__session || {})['view-prefs'] ?? null)));
await page.waitForFunction(() => document.querySelector('[data-commute="1"]')?.textContent.includes('22 min'));
t('changing travel mode refreshes the card times', invoked.filter((c) => c.sub === '/commute').length === 2);

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

// The breakdown is itemised from the payload, never recomputed — real results carry
// discount lines that make nights x nightly larger than the total, so a plugin doing
// the arithmetic itself would quote figures that are confidently wrong.
t('the detail view itemises the price rather than restating one number', await page.evaluate(() => {
  const rows = [...document.querySelectorAll('#detail .price-row')].map((r) => r.textContent);
  return rows.length >= 3
    && rows.some((r) => /nights?\s*\u00d7/.test(r))
    && rows.some((r) => /Taxes/.test(r))
    && rows.some((r) => /Total/.test(r));
}), await page.locator('#detail .price-rows').innerText().catch(() => '(no price rows)'));
t('shows house rules', detailText.includes('Quiet hours'));
t('hides the results grid while the detail is open', await page.locator('#results').isHidden());

// 2b. focus follows the view change, and comes back again
t('opening details moves focus into the detail view',
  await page.evaluate(() => document.activeElement && document.activeElement.id === 'detail-back'));

// 2c. the detail view shows the area the stay is in. The map fills in after the panel
// paints, like the photos do, so wait for it rather than racing it.
await page.waitForSelector('#detail-map .map-mosaic img', { timeout: 10000 });
await page.waitForSelector('#map-scroll[data-centered="true"]', { timeout: 5000 });
t('the detail view renders a map for a listing with coordinates',
  (await page.locator('#detail-map .map-mosaic img').count()) === 9);
t('the map asks for the tiles matching the current theme',
  invoked.some((c) => c.sub.startsWith('/map?') && c.sub.includes('theme=light')));
t('the map shows an approximate area, not a precise pin',
  (await page.locator('#detail-map .map-area').count()) === 1
  && /approximate area/i.test(await page.locator('#detail').innerText()));
t('the map credits the tile source',
  /Esri|OpenStreetMap/i.test(await page.locator('#detail-map .map-attr').innerText()));

// 2d. The box shows ~620x240 of a 768px mosaic, so most of the neighbourhood is out of
// frame. It has to be reachable, and it has to open centred on the listing rather than
// on a corner.
const mapPan = await page.evaluate(() => {
  const sc = document.getElementById('map-scroll');
  if (!sc) return null;
  const marker = document.querySelector('#detail-map .map-area');
  const markerX = parseFloat(marker.style.left);
  const markerY = parseFloat(marker.style.top);
  const expectedLeft = Math.min(sc.scrollWidth - sc.clientWidth, Math.max(0, markerX - sc.clientWidth / 2));
  const expectedTop = Math.min(sc.scrollHeight - sc.clientHeight, Math.max(0, markerY - sc.clientHeight / 2));
  const before = { left: sc.scrollLeft, top: sc.scrollTop };
  sc.scrollLeft = before.left + 60;
  return {
    scrollable: sc.scrollWidth > sc.clientWidth && sc.scrollHeight > sc.clientHeight,
    centred: Math.abs(before.left - expectedLeft) <= 1 && Math.abs(before.top - expectedTop) <= 1,
    moved: sc.scrollLeft !== before.left,
    before, expected: { left: expectedLeft, top: expectedTop },
  };
});
t('the map can be panned to the rest of the mosaic',
  !!mapPan && mapPan.scrollable && mapPan.moved, JSON.stringify(mapPan));
t('the map opens centred on the listing, clamped only where the mosaic ends',
  !!mapPan && mapPan.centred, JSON.stringify(mapPan));
t('the attribution stays pinned while the tiles scroll',
  await page.evaluate(() => {
    const attr = document.querySelector('#detail-map .map-attr');
    const sc = document.getElementById('map-scroll');
    return !!attr && !!sc && !sc.contains(attr);
  }));

// 2e. Photos open as a carousel rather than being a strip you can only squint at.
const shots = await page.locator('.detail-photos img').count();
if (shots > 1) {
  await page.waitForFunction(() =>
    document.querySelector('.detail-photos img[data-lb="0"]')?.src.startsWith('data:'),
  );
  await page.locator('.detail-photos img[data-lb="0"]').click();
  await page.waitForSelector('#lb:not([hidden])', { timeout: 5000 });
  t('clicking a photo opens the carousel', await page.locator('#lb').isVisible());
  t('the carousel starts on the photo that was clicked',
    (await page.locator('#lb-count').innerText()).trim().startsWith('1 /'));
  t('previous is disabled on the first photo', await page.locator('#lb-prev').isDisabled());

  // It declares aria-modal="true" and sits last in the document, so without a trap
  // Shift+Tab walks backwards into the search bar and result cards — live controls
  // sitting under an opaque backdrop.
  t('the carousel takes the page behind it out of the tab order',
    await page.evaluate(() => !!document.querySelector('.trek-scroll')?.inert));
  await page.keyboard.down('Shift');
  await page.keyboard.press('Tab');
  await page.keyboard.up('Shift');
  t('Shift+Tab from the close button stays inside the carousel',
    await page.evaluate(() => !!document.getElementById('lb')?.contains(document.activeElement)),
    await page.evaluate(() => document.activeElement?.id || document.activeElement?.tagName));
  await page.locator('#lb-next').click();
  t('next advances the carousel',
    (await page.locator('#lb-count').innerText()).trim().startsWith('2 /'));
  t('previous becomes available once past the first', !(await page.locator('#lb-prev').isDisabled()));
  await page.keyboard.press('ArrowLeft');
  t('the arrow keys drive the carousel too',
    (await page.locator('#lb-count').innerText()).trim().startsWith('1 /'));
  await page.keyboard.press('Escape');
  t('Escape closes the carousel', await page.locator('#lb').isHidden());
}

// 2f. The amenity values are the point of the section — the kit's nowrap+ellipsis on
// .trek-field-value was hiding most of every list.
t('amenity values wrap instead of being cut off with an ellipsis',
  await page.evaluate(() => {
    const v = document.querySelector('.amenities .trek-field-value');
    if (!v) return false;
    const cs = getComputedStyle(v);
    return cs.whiteSpace !== 'nowrap' && cs.textOverflow !== 'ellipsis' && v.scrollWidth <= v.clientWidth + 1;
  }));

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
    // A hidden input is not interactive and has no accessible name to give.
    if (el.type === 'hidden') return;
    const named = (el.labels && el.labels.length > 0) || el.getAttribute('aria-label')
      || el.getAttribute('aria-labelledby') || el.getAttribute('title');
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


/** Wait for a recorded plugin call. `invoked` is filled via an exposed function, so the
 *  record lands a tick or two after the click that caused it — polling beats guessing. */
async function waitForCall(sub, timeout = 5000) {
  const started = Date.now();
  for (;;) {
    const hit = [...invoked].reverse().find((c) => c.sub === sub);
    if (hit) return hit;
    if (Date.now() - started > timeout) return null;
    await new Promise((r) => setTimeout(r, 50));
  }
}

// --- the revamped search bar ----------------------------------------------------
// These four cover exactly what was broken or missing before the revamp: a page that
// could not be scrolled, a Where box with no help, guests as two bare number inputs,
// and filters with no indication that any were set.

// 6. the frame scrolls itself. On a FILLING surface the kit anchors body at
// overflow:hidden and scrolls `.trek-scroll` instead; without that container the grid
// was clipped at the frame edge with no way to reach the results below the fold.
const scroll = await page.evaluate(() => {
  const el = document.querySelector('.trek-scroll');
  if (!el) return { ok: false, why: 'no .trek-scroll container' };
  document.documentElement.setAttribute('data-fill', '');
  const style = getComputedStyle(el);
  return { ok: style.overflowY === 'auto' || style.overflowY === 'scroll', why: style.overflowY };
});
t('the results area is inside a scroll container', scroll.ok, scroll.why);

// 7. destination autocomplete: debounced lookup, then a pick that fills the box with
// the fuller name (searching Airbnb for "Shibuya" alone is ambiguous).
await page.fill('#location', 'tok');
await page.waitForSelector('#suggest li', { timeout: 10000 });
t('typing a destination offers suggestions', (await page.locator('#suggest li').count()) === 2);
t('the suggestion asked the plugin for the typed query',
  invoked.some((c) => c.sub.startsWith('/places?q=tok')));
await page.locator('#suggest li').nth(1).click();
const pickedValue = await page.locator('#location').inputValue();
// The fuller name wins, but without repeating the leading word: "Shibuya" +
// "Shibuya City, Tokyo, Japan" is the address, not "Shibuya, Shibuya City, ...".
t('picking a suggestion fills in the fuller place name',
  pickedValue === 'Shibuya City, Tokyo, Japan', `got: ${JSON.stringify(pickedValue)}`);
t('picking a suggestion closes the list', await page.locator('#suggest').isHidden());

// 8. guests are a stepper with a running summary, not two bare number inputs
await page.locator('#who-btn').click();
await page.locator('[data-step="adults"][data-delta="1"]').click();
await page.locator('[data-step="children"][data-delta="1"]').click();
t('the guest stepper summarises the party',
  (await page.locator('#who-value').innerText()) === '4 guests, 1 child');
t('the adult stepper will not go below one',
  await page.evaluate(async () => {
    const minus = document.querySelector('[data-step="adults"][data-delta="-1"]');
    for (let i = 0; i < 6; i++) minus.click();
    return document.getElementById('adults-out').textContent === '1';
  }));

// 9. filters live in a popover and say how many are active
await page.locator('[data-close-pop="who-pop"]').click();

// Escape, "Done" and "Show stays" all live INSIDE the panel they close, and [hidden]
// is display:none — so hiding the panel used to drop focus onto <body>, leaving a
// keyboard user at the top of the document with no idea where they had been.
await page.locator('#who-btn').click();
await page.keyboard.press('Escape');
t('closing a popover hands focus back to the button that opened it',
  await page.evaluate(() => document.activeElement?.id === 'who-btn'),
  await page.evaluate(() => document.activeElement?.id || document.activeElement?.tagName));
await page.locator('#filters-btn').click();
await page.fill('#minPrice', '80');
// Place type is a plain <select> the design kit upgrades into an in-document dropdown.
// Setting it is enough; what matters is that the KIT'S trigger shows the choice, since
// that is the part the traveller actually reads.
await page.selectOption('#propertyType', 'entire_home');
t('the place-type select reports the choice back on the kit trigger',
  (await page.locator('#propertyType').evaluate((sel) => {
    const trigger = sel.parentNode.querySelector('.trek-select-value');
    return trigger ? trigger.textContent.trim() : '(no kit trigger)';
  })) === 'Entire home');
await page.locator('#filters-apply').click();
const lastSearch = await waitForCall('/search');
t('the filter chip counts the active filters',
  (await page.locator('#filters-count').innerText()) === '2');
t('applying filters runs a search carrying them',
  !!lastSearch && lastSearch.body.minPrice === 80 && lastSearch.body.propertyType === 'entire_home'
    && lastSearch.body.adults === 1 && lastSearch.body.children === 1,
  JSON.stringify(lastSearch?.body ?? 'no /search call'));

// 10. popovers open under the control that opened them. The guests panel used to be
// parented to the bar itself, so it anchored to the bar's left edge and appeared under
// Where — the bug being fixed here is positional, so the assertion is geometric.
await page.locator('#who-btn').click();
const anchoring = await page.evaluate(() => {
  const r = (sel) => document.querySelector(sel).getBoundingClientRect();
  const pop = r('#who-pop'), who = r('#who-btn'), where = r('.seg-where'), bar = r('.segbar');
  return {
    rightAligned: Math.abs(pop.right - who.right) <= 2,
    notUnderWhere: pop.left > where.right - 1,
    insideBar: pop.right <= bar.right + 2,
  };
});
t('the guests panel opens under Who, not under Where',
  anchoring.rightAligned && anchoring.notUnderWhere && anchoring.insideBar, JSON.stringify(anchoring));
await page.locator('[data-close-pop="who-pop"]').click();

// 11. dates use a real range calendar, not two bare date inputs
await page.locator('#checkin-btn').click();
await page.waitForSelector('#dates-pop:not([hidden]) .cal-day', { timeout: 10000 });
t('the date picker shows two months side by side',
  (await page.locator('#cal-months .cal-grid').count()) === 2);
t('the calendar opens anchored inside the bar', await page.evaluate(() => {
  const pop = document.querySelector('#dates-pop').getBoundingClientRect();
  const bar = document.querySelector('.segbar').getBoundingClientRect();
  return pop.right <= bar.right + 2 && pop.left >= bar.left - 2;
}));

// Pick a check-in, then a check-out two days later, from the first month on screen.
const firstDays = page.locator('#cal-months > div').first().locator('.cal-day:not([disabled])');
await firstDays.nth(9).click();
t('choosing a check-in advances to picking check-out',
  /check-out/i.test(await page.locator('#cal-title').innerText()));
t('dates before the check-in are disabled while picking check-out',
  (await page.locator('#cal-months .cal-day[disabled]').count()) > 0);
await firstDays.nth(11).click();
const picked = await page.evaluate(() => ({
  ci: document.getElementById('checkin').value,
  co: document.getElementById('checkout').value,
  ciLabel: document.getElementById('checkin-value').textContent,
  closed: document.getElementById('dates-pop').hidden,
}));
t('picking both ends fills in the range and closes the calendar',
  !!picked.ci && !!picked.co && picked.co > picked.ci && picked.closed, JSON.stringify(picked));
t('the segment shows the chosen date instead of "Add date"',
  picked.ciLabel !== 'Add date' && picked.ciLabel.trim().length > 0, picked.ciLabel);

// The nights between the ends read as one block.
await page.locator('#checkin-btn').click();
t('the nights between the two ends are marked as a range',
  (await page.locator('#cal-months .cal-day.in-range').count()) >= 1);
await page.locator('#dates-clear').click();
t('Clear dates empties both ends', await page.evaluate(() =>
  !document.getElementById('checkin').value && !document.getElementById('checkout').value
  && document.getElementById('checkin-value').textContent === 'Add date'));
await page.locator('[data-close-pop="dates-pop"]').click();

// The plugin often lives in a narrow side panel. The filter sheet must stay inside
// that frame, and its two price inputs must remain separate usable controls.
await page.setViewportSize({ width: 360, height: 700 });
await page.locator('#filters-btn').click();
const mobileFilters = await page.evaluate(() => {
  const pop = document.getElementById('filters-pop').getBoundingClientRect();
  const min = document.getElementById('minPrice').getBoundingClientRect();
  const max = document.getElementById('maxPrice').getBoundingClientRect();
  const row = getComputedStyle(document.querySelector('#filters-pop .pop-row'));
  return {
    inside: pop.left >= 0 && pop.right <= innerWidth,
    separate: min.right < max.left && min.width > 40 && max.width > 40,
    stacked: row.flexDirection === 'column',
    pop: { left: pop.left, right: pop.right, width: pop.width },
  };
});
t('the filter panel fits a narrow frame without crushed controls',
  mobileFilters.inside && mobileFilters.separate && mobileFilters.stacked,
  JSON.stringify(mobileFilters));
// Scoped to THIS select's own menu: Sort and Travel-by are kit-upgraded too, so an
// unscoped .trek-select-menu query would measure whichever one the DOM yielded first.
t('place-type names stay fully visible in the narrow filter panel',
  await page.locator('#propertyType').evaluate((sel) => {
    sel.parentNode.querySelector('.trek-select-trigger').click();
    const options = [...sel.parentNode.querySelectorAll('.trek-select-menu [role="option"]')];
    return options.length === 5 && options.every((o) => o.scrollWidth <= o.clientWidth + 1);
  }));
await page.keyboard.press('Escape');

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
  t('first run shows guidance instead of a blank area',
    /Where to\?/i.test(introText) && /press Search/i.test(introText));
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
        // Mirrors a STOCK TREK install: `default`s were never honoured and there is no
        // settings form, so nothing is configured and every required key is missing.
        const data = sub === '/status'
          ? { configured: false, connected: false,
              missing: ['oauth_authorize_url', 'oauth_token_url', 'oauth_client_id', 'oauth_client_secret'],
              missingLabels: ['OAuth authorize URL', 'OAuth token URL', 'OAuth client id', 'OAuth client secret'] }
          : {};
        window.postMessage({ type: 'trek:response', requestId: m.requestId, data }, '*');
      }
    });
  });
  await page3.goto('file://' + path.resolve(frame));
  await page3.waitForSelector('#gate .trek-title', { timeout: 10000 });
  const gateText = await page3.locator('#gate').innerText();
  t('unconfigured instance explains what the admin must do', /administrator/i.test(gateText));
  // By their FORM LABEL, not their storage key: the gate sends the admin to the settings
  // form, and "OAuth client id" is a field they can point at where `oauth_client_id` is not.
  t('the gate names the still-blank settings the way the form labels them',
    /OAuth client id/.test(gateText) && /OAuth client secret/.test(gateText), gateText.slice(0, 200));

  // The setup story is now the button, not a CLI. An admin who installed this from the
  // registry has no repo to run a script in, so leading with one stranded exactly the
  // person most likely to be reading this panel.
  t('the gate walks through the setup steps and leads with the button, not a CLI',
    /Register with OpenBnB/i.test(gateText)
      && /This TREK server/i.test(gateText)
      && !/npm run register/i.test(gateText),
    gateText.slice(0, 320));
  // Described by capability, never by a version number. The gate has to serve both hosts
  // at once — it points at the Instance settings menu first, and still names the admin
  // API for a TREK that has no such menu — because it cannot tell which one it is on.
  t('the gate points at Instance settings, keeps the admin API fallback, and names no version',
    /Instance settings/i.test(gateText) && /admin API/i.test(gateText) && !/4\.\d/.test(gateText),
    gateText.slice(0, 240));
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
