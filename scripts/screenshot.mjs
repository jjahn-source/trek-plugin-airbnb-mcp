#!/usr/bin/env node
/**
 * Render the packed frame (design kit already inlined) against fixture data and
 * write docs/screenshot.png.
 *
 * The page is loaded top-level, so the kit's postMessage to `window.parent` lands
 * back on the same window. That lets us stand in for the host using only the
 * documented protocol — no patching of the kit, so what is captured is the real UI.
 */
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const frame = process.argv[2];
const out = process.argv[3] || 'docs/screenshot.png';
if (!frame) {
  console.error('usage: node scripts/screenshot.mjs <packed client/index.html> [out.png]');
  process.exit(1);
}

const RESULTS = [
  { id: '1', url: 'https://www.airbnb.com/rooms/1', name: 'Sunlit loft above Rue des Rosiers', subtitle: 'Entire rental unit', area: 'Le Marais · 2 beds', badge: 'Guest favourite', priceLabel: '$1,240 for 4 nights', priceAmount: 1240, rating: 4.92, reviews: 148, photos: [] },
  { id: '2', url: 'https://www.airbnb.com/rooms/2', name: 'Quiet studio by Canal Saint-Martin', subtitle: 'Entire rental unit', area: '10th arr. · 1 bed', badge: null, priceLabel: '$860 for 4 nights', priceAmount: 860, rating: 4.78, reviews: 92, photos: [] },
  { id: '3', url: 'https://www.airbnb.com/rooms/3', name: 'Haussmann apartment with balcony', subtitle: 'Entire home', area: '9th arr. · 3 beds', badge: 'Superhost', priceLabel: '$1,910 for 4 nights', priceAmount: 1910, rating: 4.99, reviews: 311, photos: [] },
  { id: '4', url: 'https://www.airbnb.com/rooms/4', name: 'Artist’s atelier near Montmartre', subtitle: 'Entire loft', area: '18th arr. · 2 beds', badge: null, priceLabel: '$1,120 for 4 nights', priceAmount: 1120, rating: 4.65, reviews: 57, photos: [] },
  { id: '5', url: 'https://www.airbnb.com/rooms/5', name: 'Room in a townhouse, Latin Quarter', subtitle: 'Private room', area: '5th arr. · 1 bed', badge: null, priceLabel: '$540 for 4 nights', priceAmount: 540, rating: null, reviews: null, photos: [] },
  { id: '6', url: 'https://www.airbnb.com/rooms/6', name: 'Riverside flat facing Île de la Cité', subtitle: 'Entire rental unit', area: '4th arr. · 2 beds', badge: 'Guest favourite', priceLabel: '$1,680 for 4 nights', priceAmount: 1680, rating: 4.88, reviews: 204, photos: [] },
  { id: '7', url: 'https://www.airbnb.com/rooms/7', name: 'Bright two-bed near Jardin du Luxembourg', subtitle: 'Entire home', area: '6th arr. · 2 beds', badge: 'Superhost', priceLabel: '$1,540 for 4 nights', priceAmount: 1540, rating: 4.94, reviews: 176, photos: [] },
  { id: '8', url: 'https://www.airbnb.com/rooms/8', name: 'Attic hideaway on Rue Mouffetard', subtitle: 'Entire rental unit', area: '5th arr. · 1 bed', badge: null, priceLabel: '$720 for 4 nights', priceAmount: 720, rating: 4.55, reviews: 41, photos: [] },
  { id: '9', url: 'https://www.airbnb.com/rooms/9', name: 'Design flat by Place des Vosges', subtitle: 'Entire rental unit', area: '3rd arr. · 2 beds', badge: 'Guest favourite', priceLabel: '$1,780 for 4 nights', priceAmount: 1780, rating: 4.9, reviews: 133, photos: [] },
  { id: '10', url: 'https://www.airbnb.com/rooms/10', name: 'Courtyard studio, Bastille', subtitle: 'Entire rental unit', area: '11th arr. · 1 bed', badge: null, priceLabel: '$690 for 4 nights', priceAmount: 690, rating: 4.71, reviews: 88, photos: [] },
  { id: '11', url: 'https://www.airbnb.com/rooms/11', name: 'Family apartment near Parc Monceau', subtitle: 'Entire home', area: '17th arr. · 3 beds', badge: null, priceLabel: '$1,460 for 4 nights', priceAmount: 1460, rating: 4.82, reviews: 64, photos: [] },
  { id: '12', url: 'https://www.airbnb.com/rooms/12', name: 'Loft with mezzanine, Belleville', subtitle: 'Entire loft', area: '20th arr. · 2 beds', badge: null, priceLabel: '$980 for 4 nights', priceAmount: 980, rating: 4.6, reviews: 29, photos: [] },
  { id: '13', url: 'https://www.airbnb.com/rooms/13', name: 'Classic pied-à-terre, Saint-Germain', subtitle: 'Entire rental unit', area: '6th arr. · 1 bed', badge: 'Superhost', priceLabel: '$1,320 for 4 nights', priceAmount: 1320, rating: 4.97, reviews: 251, photos: [] },
  { id: '14', url: 'https://www.airbnb.com/rooms/14', name: 'Top-floor view over Père-Lachaise', subtitle: 'Entire rental unit', area: '20th arr. · 2 beds', badge: null, priceLabel: '$870 for 4 nights', priceAmount: 870, rating: 4.44, reviews: 37, photos: [] },
  { id: '15', url: 'https://www.airbnb.com/rooms/15', name: 'Garden-level flat, Butte-aux-Cailles', subtitle: 'Entire home', area: '13th arr. · 2 beds', badge: null, priceLabel: '$1,050 for 4 nights', priceAmount: 1050, rating: 4.86, reviews: 119, photos: [] },
];

const FIXTURES = {
  '/status': { configured: true, connected: true, endpoint: 'https://mcp.openbnb.ai/mcp' },
  '/last': { params: { location: 'Paris, France', checkin: '2026-10-10', checkout: '2026-10-14', adults: 2 }, results: RESULTS, cursor: 'next' },
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
      const sub = String(m.sub || '').split('?')[0];
      const data = Object.prototype.hasOwnProperty.call(fixtures, sub) ? fixtures[sub] : {};
      window.postMessage({ type: 'trek:response', requestId: m.requestId, data }, '*');
    }
  });
}, FIXTURES);

await page.goto('file://' + path.resolve(frame));
// Wait for the restored results to paint rather than racing a fixed delay.
await page.waitForSelector('.trek-card', { timeout: 15000 });
await page.waitForTimeout(400);
await page.screenshot({ path: out });
await browser.close();
console.log(`wrote ${out}`);
