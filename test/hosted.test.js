'use strict';
/**
 * Tests against REAL responses captured from the hosted OpenBnB MCP server
 * (scripts/capture-fixtures.mjs). Every other test in this suite encodes an
 * assumption about the payload shape; these are the only ones that check the
 * assumption itself.
 *
 * They exist because a full green suite once hid five shape bugs at the same time:
 * the details tool had the wrong name, pagination was never extracted, and badges,
 * the content lines and photos were all silently dropped.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeSearch, nextCursor } = require('../server/normalize');

const search = require('./fixtures/hosted-search.json');
const tools = require('./fixtures/hosted-tools.json');

const toolNames = (tools.tools || []).map((t) => t.name);

test('the hosted server still offers the tools this plugin calls', () => {
  assert.ok(toolNames.includes('airbnb_search'), 'airbnb_search must exist');
  // The plugin asks for `airbnb_listing` first and falls back to the open-source
  // name. If this ever fails, the details view is calling a tool that is not there.
  assert.ok(
    toolNames.includes('airbnb_listing') || toolNames.includes('airbnb_listing_details'),
    `no listing tool among: ${toolNames.join(', ')}`,
  );
});

test('every real result normalises to something renderable', () => {
  const out = normalizeSearch(search, null);
  assert.equal(out.results.length, search.searchResults.length);

  for (const r of out.results) {
    assert.ok(r.id, 'id');
    assert.match(r.url, /^https:\/\/www\.airbnb\.com\/rooms\//, 'url');
    assert.ok(r.name && !/^Listing \d+$/.test(r.name), `real name, got ${r.name}`);
    assert.ok(r.priceLabel, `price label for ${r.id}`);
    assert.ok(Number.isFinite(r.priceAmount), `sortable price for ${r.id}`);
    assert.ok(Number.isFinite(r.lat) && Number.isFinite(r.lng), `coordinates for ${r.id}`);
    assert.ok(r.photos.length > 0, `photos for ${r.id}`);
  }
});

test('the fields that were silently dropped are populated', () => {
  const out = normalizeSearch(search, null);
  // Each of these was null for EVERY listing before the shapes were checked.
  assert.ok(out.results.some((r) => r.badge), 'at least one badge');
  assert.ok(out.results.every((r) => r.subtitle), 'every listing has a subtitle');

  // `area` is asserted as an invariant of the transform, not as a property of this
  // sample: a listing whose source lines are genuinely empty (one in this capture)
  // SHOULD come back null. Counting how many happen to be filled would just
  // over-fit whatever Paris looked like on the day.
  out.results.forEach((r, i) => {
    const sc = search.searchResults[i].structuredContent || {};
    const hasSource = !!((sc.mapSecondaryLine || '').trim() || (sc.secondaryLine || '').trim());
    assert.equal(!!r.area, hasSource, `area for #${i} should follow whether the server sent one`);
  });
});

test('an unrated listing reads as New rather than zero', () => {
  const out = normalizeSearch(search, null);
  const unrated = out.results.filter((r) => r.rating === null);
  for (const r of unrated) {
    assert.match(r.ratingLabel || '', /new/i);
    assert.equal(r.reviews, null, 'no invented review count');
  }
});

test('pagination steps through the real cursor list', () => {
  const cursors = search.paginationInfo.pageCursors;
  assert.ok(Array.isArray(cursors) && cursors.length > 1, 'fixture has multiple pages');

  const page1 = normalizeSearch(search, null);
  assert.equal(page1.cursor, cursors[1], 'first page points at the second');

  const page2 = normalizeSearch(search, cursors[1]);
  assert.equal(page2.cursor, cursors[2], 'and the second at the third');

  const last = normalizeSearch(search, cursors[cursors.length - 1]);
  assert.equal(last.cursor, null, 'the final page ends paging');
});

test('a cursor the server never issued stops paging instead of looping', () => {
  assert.equal(nextCursor(search.paginationInfo, 'not-a-real-cursor'), null);
});

test('real photo URLs are on a host the plugin is allowed to proxy', () => {
  const out = normalizeSearch(search, null);
  const hosts = new Set(out.results.flatMap((r) => r.photos).map((u) => new URL(u).hostname));
  for (const h of hosts) {
    const allowed = /(^|\.)muscache\.com$/i.test(h) || h === 'mcp.openbnb.ai';
    assert.ok(allowed, `photo host ${h} would be refused by the photo proxy`);
  }
});

// --- listing details -----------------------------------------------------------

const { normalizeListing } = require('../server/normalize');
const listing = require('./fixtures/hosted-listing.json');

test('a real listing normalises to a populated detail record', () => {
  const d = normalizeListing('735957503382296080', listing);

  assert.ok(d.title, 'title');
  assert.match(d.url, /^https:\/\/www\.airbnb\.com\/rooms\//);
  assert.ok(d.url.includes('check_in='), 'keeps the dated listingUrl, not a rebuilt one');
  assert.ok(d.location, 'location line');
  assert.ok(Number.isFinite(d.lat) && Number.isFinite(d.lng), 'coordinates');
});

test('the description is rendered as text, not raw HTML', () => {
  const d = normalizeListing('1', listing);
  assert.ok(d.description && d.description.length > 80, 'a real description');
  assert.ok(!/<br|<\/?p>|&amp;|&#39;/i.test(d.description), `markup leaked: ${d.description.slice(0, 120)}`);
  assert.ok(d.description.includes('\n'), '<br /> became a real line break');
});

test('amenity groups flatten from the array shape the server actually sends', () => {
  const d = normalizeListing('1', listing);
  const groups = Object.keys(d.amenities);
  assert.ok(groups.length >= 3, `expected several groups, got ${groups.join(', ')}`);
  for (const [name, value] of Object.entries(d.amenities)) {
    assert.equal(typeof value, 'string', `${name} should flatten to a string`);
    assert.ok(value.length, `${name} should not be empty`);
  }
  // Airbnb lists what is deliberately absent as its own group; it must survive.
  assert.ok(groups.includes('Not included'), `"Not included" missing from ${groups.join(', ')}`);
});

test('highlights flatten from the array of objects the server sends', () => {
  const d = normalizeListing('1', listing);
  assert.ok(typeof d.highlights === 'string' && d.highlights.length, 'highlights as text');
  assert.ok(!d.highlights.includes('[object'), 'not a stringified object');
});

test('a section the listing genuinely lacks stays null rather than inventing text', () => {
  // POLICIES_DEFAULT comes back with only an id for this listing.
  assert.equal(normalizeListing('1', listing).houseRules, null);
});
