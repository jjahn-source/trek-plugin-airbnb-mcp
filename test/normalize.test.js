'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeSearch, normalizeListing, parseRating, parsePriceAmount, parsePriceDetails, findCoords, findPhotos,
} = require('../server/normalize');

/**
 * Mirrors what the OpenBnB server actually emits: the fields its allow-schema keeps,
 * after `flattenArraysInObject` has joined arrays into strings.
 */
const SEARCH_FIXTURE = {
  searchUrl: 'https://www.airbnb.com/s/Paris--France/homes',
  searchResults: [
    {
      id: '12345678',
      url: 'https://www.airbnb.com/rooms/12345678',
      demandStayListing: {
        id: 'RGVtYW5kU3RheUxpc3Rpbmc6MTIzNDU2Nzg=',
        description: { name: { localizedStringWithTranslationPreference: 'Charming loft in Le Marais' } },
        location: { coordinate: { latitude: 48.8566, longitude: 2.3522 } },
      },
      badges: { text: 'Guest favourite' },
      structuredContent: {
        mapCategoryInfo: { body: 'Entire rental unit' },
        mapSecondaryLine: { body: '2 beds' },
        primaryLine: { body: 'Loft in Paris' },
      },
      avgRatingA11yLabel: '4.92 out of 5 average rating, 148 reviews',
      structuredDisplayPrice: {
        primaryLine: { accessibilityLabel: '$1,240 for 4 nights' },
        secondaryLine: { accessibilityLabel: '$310 per night' },
      },
    },
  ],
  paginationInfo: { nextPageCursor: 'cursor-page-2' },
};

test('normalizeSearch flattens a real-shaped result', () => {
  const out = normalizeSearch(SEARCH_FIXTURE);
  assert.equal(out.results.length, 1);
  const r = out.results[0];
  assert.equal(r.id, '12345678');
  assert.equal(r.url, 'https://www.airbnb.com/rooms/12345678');
  assert.equal(r.name, 'Charming loft in Le Marais');
  assert.equal(r.subtitle, 'Entire rental unit');
  assert.equal(r.area, '2 beds');
  assert.equal(r.badge, 'Guest favourite');
  assert.equal(r.priceLabel, '$1,240 for 4 nights');
  assert.equal(r.priceAmount, 1240);
  assert.equal(r.rating, 4.92);
  assert.equal(r.reviews, 148);
  assert.equal(r.lat, 48.8566);
  assert.equal(r.lng, 2.3522);
  assert.equal(out.cursor, 'cursor-page-2');
});

test('a listing missing price/rating/coords still renders instead of being dropped', () => {
  const out = normalizeSearch({ searchResults: [{ id: '99', demandStayListing: { description: {} } }] });
  assert.equal(out.results.length, 1);
  const r = out.results[0];
  assert.equal(r.id, '99');
  assert.equal(r.name, 'Listing 99');
  assert.equal(r.url, 'https://www.airbnb.com/rooms/99');
  assert.equal(r.priceLabel, null);
  assert.equal(r.rating, null);
  assert.equal(r.lat, null);
});

test('a result with no id is dropped rather than rendered as a dead card', () => {
  const out = normalizeSearch({ searchResults: [{ demandStayListing: {} }, { id: '5' }] });
  assert.deepEqual(out.results.map((r) => r.id), ['5']);
});

test('normalizeSearch rethrows a tool-level error payload', () => {
  assert.throws(
    () => normalizeSearch({ error: "This path is disallowed by Airbnb's robots.txt", url: 'https://x' }),
    /robots\.txt/,
  );
});

test('an absent paginationInfo yields a null cursor, not undefined', () => {
  assert.equal(normalizeSearch({ searchResults: [] }).cursor, null);
});

test('parseRating handles an unrated "New" listing', () => {
  assert.deepEqual(parseRating('New'), { rating: null, reviews: null });
  assert.deepEqual(parseRating('5.0 out of 5 average rating, 1,204 reviews'), { rating: 5, reviews: 1204 });
});

test('parsePriceAmount reads every locale separator style', () => {
  // The last separator decides: 3 trailing digits = thousands, else decimal.
  assert.equal(parsePriceAmount('$310 per night'), 310);
  assert.equal(parsePriceAmount('$1,240 for 4 nights'), 1240);
  assert.equal(parsePriceAmount('€1.234 total'), 1234, 'EU thousands dot must not read as a decimal');
  assert.equal(parsePriceAmount('$1,240.50'), 1240.5);
  assert.equal(parsePriceAmount('€1.234,56'), 1234.56);
  assert.equal(parsePriceAmount('1\u00a0234 €'), 1234, 'non-breaking space as a group separator');
  assert.equal(parsePriceAmount('Price unavailable'), null);
});

test('findCoords rejects a 0,0 placeholder and out-of-range values', () => {
  assert.equal(findCoords({ coordinate: { latitude: 0, longitude: 0 } }), null);
  assert.equal(findCoords({ c: { latitude: 999, longitude: 5 } }), null);
  assert.deepEqual(findCoords({ a: { b: { lat: 1.5, lng: -2.5 } } }), { lat: 1.5, lng: -2.5 });
});

test('findPhotos picks up image URLs only, and de-duplicates', () => {
  const p = findPhotos({
    a: 'https://a0.muscache.com/im/pictures/x.jpg?aki=1',
    b: { c: 'https://a0.muscache.com/im/pictures/x.jpg?aki=1' },
    d: 'https://example.com/page.html',
    e: 'not a url',
  });
  assert.deepEqual(p, ['https://a0.muscache.com/im/pictures/x.jpg?aki=1']);
});

test('normalizeListing gathers amenity groups and falls back to a derived url', () => {
  const out = normalizeListing('777', {
    seeAllAmenitiesGroups: { Bathroom: 'Hair dryer', 'Not included': 'Dryer, Hot water' },
    details: [{ id: 'TITLE_DEFAULT', title: 'Sunny studio' }],
    location: { coordinate: { latitude: 10, longitude: 20 } },
  });
  assert.equal(out.id, '777');
  assert.equal(out.url, 'https://www.airbnb.com/rooms/777');
  assert.equal(out.title, 'Sunny studio');
  assert.equal(out.amenities.Bathroom, 'Hair dryer');
  assert.equal(out.amenities['Not included'], 'Dryer, Hot water');
  assert.equal(out.lat, 10);
});

test('normalizeListing rethrows an error payload', () => {
  assert.throws(() => normalizeListing('1', { error: 'listing not found' }), /listing not found/);
});

/* ------------------------------------------------------------ price detail */

/**
 * The hosted payload spells the whole price out: "4 nights x $221.35 USD: $885.38
 * USD, Taxes: $136.34 USD, Total: $1,021.72 USD", so none of this is arithmetic we
 * have to invent. The card has always shown the accessibility label, which is the
 * TOTAL ("$1,022 USD total"); the nightly rate a traveller compares stays on, and the
 * tax share they get caught out by, were both sitting one field away unread.
 */
test('the price breakdown is read out of priceDetails rather than recomputed', () => {
  const p = parsePriceDetails('4 nights x $221.35 USD: $885.38 USD, Taxes: $136.34 USD, Total: $1,021.72 USD');
  assert.equal(p.nights, 4);
  assert.equal(p.nightly, 221.35);
  assert.equal(p.taxes, 136.34);
  assert.equal(p.total, 1021.72);
  assert.equal(p.currency, 'USD');
});

test('a stay quoted without taxes still yields a nightly rate and a total', () => {
  const p = parsePriceDetails('3 nights x $100.00 USD: $300.00 USD, Total: $300.00 USD');
  assert.equal(p.nights, 3);
  assert.equal(p.nightly, 100);
  assert.equal(p.taxes, null);
  assert.equal(p.total, 300);
});

test('a single night is not mis-read as plural-only', () => {
  const p = parsePriceDetails('1 night x $89.46 USD: $89.46 USD, Total: $95.00 USD');
  assert.equal(p.nights, 1);
  assert.equal(p.nightly, 89.46);
});

/**
 * European grouping. The existing amount parser already knows that the LAST separator
 * decides; the breakdown must not quietly reintroduce the bug it was written to fix.
 */
test('a European-formatted breakdown is not read as a fraction of a euro', () => {
  const p = parsePriceDetails('4 nights x 221,35 EUR: 885,38 EUR, Total: 1.021,72 EUR');
  assert.equal(p.nightly, 221.35);
  assert.equal(p.total, 1021.72);
  assert.equal(p.currency, 'EUR');
});

test('an unparseable breakdown yields nulls, never a wrong number', () => {
  for (const junk of ['', null, undefined, 'Price on application', 'Total: ']) {
    const p = parsePriceDetails(junk);
    assert.equal(p.nightly, null, String(junk));
    assert.equal(p.total, null, String(junk));
    assert.equal(p.nights, null, String(junk));
  }
});

test('a search result carries the breakdown alongside the label it already had', () => {
  const out = normalizeSearch({
    searchResults: [{
      id: '1',
      structuredDisplayPrice: {
        primaryLine: { accessibilityLabel: '$1,022 USD total' },
        explanationData: { priceDetails: '4 nights x $221.35 USD: $885.38 USD, Taxes: $136.34 USD, Total: $1,021.72 USD' },
      },
    }],
  }, null);
  const r = out.results[0];
  // The label and the sortable amount are untouched. The place-detail panel, the
  // restore cache and the client's sort all read them.
  assert.equal(r.priceLabel, '$1,022 USD total');
  assert.equal(r.pricePerNight, 221.35);
  assert.equal(r.priceNights, 4);
  assert.equal(r.priceTotal, 1021.72);
  assert.equal(r.priceTaxes, 136.34);
  assert.equal(r.priceCurrency, 'USD');
});
