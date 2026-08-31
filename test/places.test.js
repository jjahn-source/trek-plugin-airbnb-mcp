'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { placeCandidates } = require('../server/normalize');

const HOSTED = require('./fixtures/hosted-places.json');

/**
 * The destination typeahead reads `maps_search_places` / `maps_geocode`.
 *
 * The first two tests use payloads CAPTURED from the hosted OpenBnB server
 * (`maps_search_places`/`maps_geocode` for "tokyo japan", 2026-08-31) — those are the
 * contract. The rest pin the parser's tolerance for the other shapes Google-derived
 * payloads take: the hosted server has already been found to differ from the
 * open-source one in nine ways, so reading `displayName` as well as `name` costs a few
 * lines and saves a dead typeahead with no error to show for it.
 */

test('REAL hosted maps_search_places payload', () => {
  const out = placeCandidates(HOSTED.search);
  assert.deepEqual(out, [{
    label: 'Tokyo', sublabel: 'Tokyo, Japan', lat: 35.6764225, lng: 139.650027,
  }]);
});

test('REAL hosted maps_geocode payload — a single object, not a list', () => {
  const out = placeCandidates(HOSTED.geocode);
  assert.equal(out.length, 1);
  assert.equal(out[0].label, 'Tokyo, Japan');
  assert.equal(out[0].lat, 35.6764225);
  assert.equal(out[0].lng, 139.650027);
});


test('Places shape: displayName object + formattedAddress + location', () => {
  const out = placeCandidates({
    places: [{
      displayName: { text: 'Tokyo' },
      formattedAddress: 'Tokyo, Japan',
      location: { latitude: 35.6762, longitude: 139.6503 },
    }],
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].label, 'Tokyo');
  assert.equal(out[0].sublabel, 'Tokyo, Japan');
  assert.equal(out[0].lat, 35.6762);
  assert.equal(out[0].lng, 139.6503);
});

test('Places shape: bare name + snake_case address + geometry.location', () => {
  const out = placeCandidates({
    results: [{
      name: 'Shibuya',
      formatted_address: 'Shibuya City, Tokyo, Japan',
      geometry: { location: { lat: 35.6595, lng: 139.7005 } },
    }],
  });
  assert.deepEqual(out, [{
    label: 'Shibuya', sublabel: 'Shibuya City, Tokyo, Japan', lat: 35.6595, lng: 139.7005,
  }]);
});

test('Geocode shape: a single object with only an address becomes one row', () => {
  const out = placeCandidates({
    formatted_address: 'Tokyo, Japan',
    geometry: { location: { lat: 35.6762, lng: 139.6503 } },
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].label, 'Tokyo, Japan');
  // Address-only: there is no distinct name to promote, so no second line.
  assert.equal(out[0].sublabel, null);
});

test('a bare array of rows is accepted', () => {
  const out = placeCandidates([{ name: 'Kyoto', formattedAddress: 'Kyoto, Japan' }]);
  assert.equal(out[0].label, 'Kyoto');
});

test('coordinates are optional — a row without them still suggests', () => {
  const out = placeCandidates({ places: [{ name: 'Osaka' }] });
  assert.deepEqual(out, [{ label: 'Osaka', sublabel: null, lat: null, lng: null }]);
});

test('null island and out-of-range coordinates are dropped, not trusted', () => {
  const zero = placeCandidates({ places: [{ name: 'A', location: { latitude: 0, longitude: 0 } }] });
  assert.equal(zero[0].lat, null);
  const oob = placeCandidates({ places: [{ name: 'B', location: { latitude: 99, longitude: 200 } }] });
  assert.equal(oob[0].lat, null);
});

test('rows with no usable label are skipped rather than rendered blank', () => {
  const out = placeCandidates({ places: [{ location: { latitude: 1, longitude: 2 } }, { name: 'Nara' }] });
  assert.deepEqual(out.map(r => r.label), ['Nara']);
});

test('unrecognised payloads yield an empty list, never a throw', () => {
  for (const bad of [null, undefined, 42, 'text', {}, { nonsense: true }]) {
    assert.deepEqual(placeCandidates(bad), []);
  }
});
