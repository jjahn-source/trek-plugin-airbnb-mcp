'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const c = require('../server/commute');
const { createMockHost } = require('trek-plugin-sdk/testing');
const plugin = require('../server/index.js');

test('coordString rejects the coordinates that are not real places', () => {
  assert.equal(c.coordString(48.8875, 2.3029), '48.887500,2.302900');
  assert.equal(c.coordString(0, 0), null, 'the null-island placeholder');
  assert.equal(c.coordString(91, 5), null, 'out of range latitude');
  assert.equal(c.coordString('abc', 2), null);
  assert.equal(c.coordString(null, null), null);
  assert.equal(c.coordString(null, 2), null, 'a missing latitude must not become zero');
  assert.equal(c.coordString(48.8, ''), null, 'a blank longitude must not become zero');
  assert.equal(c.coordString(false, 2), null, 'non-coordinate primitives are rejected');
});

test('destinations skip places that cannot be routed to, and are capped', () => {
  const places = [
    { id: 1, name: 'Louvre', lat: 48.86, lng: 2.33 },
    { id: 2, name: 'No coordinates yet' },
    { id: 3, name: 'Null island', lat: 0, lng: 0 },
    ...Array.from({ length: 20 }, (_, i) => ({ id: 100 + i, name: `P${i}`, lat: 48.8 + i / 100, lng: 2.3 })),
  ];
  const picked = c.pickDestinations(places);
  assert.equal(picked.length, c.MAX_DESTINATIONS, 'capped to stay inside the matrix element limit');
  assert.equal(picked[0].name, 'Louvre');
  assert.ok(!picked.some((d) => d.id === 2 || d.id === 3), 'unroutable places dropped');
});

test('origins are capped and keep their listing id', () => {
  const listings = Array.from({ length: 30 }, (_, i) => ({ id: `L${i}`, lat: 48.8, lng: 2.3 }));
  const picked = c.pickOrigins(listings);
  assert.equal(picked.length, c.MAX_ORIGINS);
  assert.equal(picked[0].id, 'L0');
  assert.equal(c.pickOrigins([{ id: 'x' }]).length, 0, 'a listing with no coordinates is not an origin');
});

test('normalizeMatrix maps Google rows/elements back onto listing and place ids', () => {
  const origins = [{ id: 'L1' }, { id: 'L2' }];
  const destinations = [{ id: 10, name: 'Louvre' }, { id: 11, name: 'Gare du Nord' }];
  const payload = {
    rows: [
      { elements: [
        { status: 'OK', duration: { text: '14 mins', value: 840 }, distance: { text: '3.2 km' } },
        { status: 'OK', duration: { text: '9 mins', value: 540 }, distance: { text: '2.0 km' } },
      ] },
      { elements: [
        { status: 'ZERO_RESULTS' },
        { status: 'OK', duration: { text: '1 hour 5 mins', value: 3900 }, distance: { text: '20 km' } },
      ] },
    ],
  };
  const out = c.normalizeMatrix(payload, origins, destinations);

  assert.deepEqual(out.L1.map((l) => [l.name, l.label, l.seconds]), [
    ['Louvre', '14 min', 840],
    ['Gare du Nord', '9 min', 540],
  ]);
  assert.equal(out.L2.length, 1, 'an unroutable pair is dropped, not rendered as zero');
  assert.equal(out.L2[0].name, 'Gare du Nord');
  assert.equal(out.L2[0].placeId, 11);
});

test('normalizeMatrix survives a payload that is missing everything', () => {
  const origins = [{ id: 'L1' }];
  const dests = [{ id: 1, name: 'X' }];
  assert.deepEqual(c.normalizeMatrix(null, origins, dests), {});
  assert.deepEqual(c.normalizeMatrix({}, origins, dests), {});
  assert.deepEqual(c.normalizeMatrix({ rows: [{}] }, origins, dests), {});
  assert.deepEqual(c.normalizeMatrix({ rows: [{ elements: [{ status: 'OK' }] }] }, origins, dests), {},
    'an OK element with no duration yields nothing rather than a blank label');
});

test('a duration with only seconds still gets a readable label', () => {
  assert.equal(c.durationLabel({ duration: { value: 540 } }), '9 min');
  assert.equal(c.durationLabel({ duration: { value: 3900 } }), '1 hr 5 min');
  assert.equal(c.durationLabel({ duration: { value: 7200 } }), '2 hr');
  assert.equal(c.durationLabel({ duration: { value: null } }), null);
  assert.equal(c.durationLabel({ duration_seconds: '' }), null);
  assert.equal(c.durationLabel({ duration: false }), null);
  assert.equal(c.durationLabel({}), null);
});

test('an unknown travel mode falls back to transit rather than being passed through', () => {
  assert.equal(c.normalizeMode('walking'), 'walking');
  assert.equal(c.normalizeMode('teleport'), 'transit');
  assert.equal(c.normalizeMode(undefined), 'transit');
});

// --- the route ---------------------------------------------------------------

const GRANTS = ['db:own', 'db:meta', 'db:read:trips', 'db:write:places', 'db:write:accommodations',
  'oauth:client', 'http:outbound:mcp.openbnb.ai', 'http:outbound:*.muscache.com', 'hook:place-detail-provider'];

function mcpStub(t, toolResult) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const b = JSON.parse(init.body);
    const json = (status, obj) => ({
      ok: status >= 200 && status < 300, status,
      headers: { get: (k) => (k.toLowerCase() === 'content-type' ? 'application/json' : null) },
      text: async () => JSON.stringify(obj),
    });
    if (b.method === 'initialize') return json(200, { id: b.id, result: {} });
    if (b.method === 'notifications/initialized') return json(202, {});
    if (b.method === 'tools/list') return json(200, { id: b.id, result: { tools: [{ name: 'maps_distance_matrix' }] } });
    calls.push(b.params);
    return json(200, { id: b.id, result: { content: [{ type: 'text', text: JSON.stringify(toolResult) }] } });
  };
  t.after(() => { globalThis.fetch = original; });
  return calls;
}

function host(places, token = 'tok') {
  return createMockHost({
    grants: GRANTS,
    config: { oauth_authorize_url: 'a', oauth_token_url: 'b', oauth_client_id: 'c', oauth_client_secret: 'd' },
    actingUserId: 42,
    oauthAccessToken: token,
    trips: { 7: { members: [42], data: { id: 7 }, places } },
  });
}
const body = (r) => JSON.parse(r.body);

test('/commute measures every listing against the trip in one matrix call', async (t) => {
  const calls = mcpStub(t, {
    rows: [{ elements: [{ status: 'OK', duration: { text: '14 mins', value: 840 } }] },
           { elements: [{ status: 'OK', duration: { text: '25 mins', value: 1500 } }] }],
  });
  const h = host([{ id: 10, name: 'Louvre', lat: 48.86, lng: 2.33 }]);
  const res = await h.run(plugin).route({ method: 'POST', path: '/commute' }, {
    body: { tripId: 7, mode: 'walking', listings: [{ id: 'L1', lat: 48.88, lng: 2.30 }, { id: 'L2', lat: 48.90, lng: 2.40 }] },
  });

  assert.equal(res.status, 200);
  assert.equal(calls.length, 1, 'one call for the whole page, not one per listing');
  assert.equal(calls[0].name, 'maps_distance_matrix');
  assert.deepEqual(calls[0].arguments.origins, ['48.880000,2.300000', '48.900000,2.400000']);
  assert.deepEqual(calls[0].arguments.destinations, ['48.860000,2.330000']);
  assert.equal(calls[0].arguments.mode, 'walking');

  const out = body(res);
  assert.equal(out.times.L1[0].label, '14 min');
  assert.equal(out.times.L2[0].label, '25 min');
  assert.deepEqual(out.destinations, [{ placeId: 10, name: 'Louvre' }]);
});

test('a trip with nothing pinned yet explains itself instead of failing', async (t) => {
  const calls = mcpStub(t, {});
  const h = host([{ id: 1, name: 'Somewhere', lat: null, lng: null }]);
  const res = await h.run(plugin).route({ method: 'POST', path: '/commute' }, {
    body: { tripId: 7, listings: [{ id: 'L1', lat: 48.88, lng: 2.3 }] },
  });
  assert.equal(res.status, 200);
  assert.match(body(res).reason, /no places/i);
  assert.equal(calls.length, 0, 'nothing to measure means no egress');
});

test('/commute needs a tripId, and never calls out without listings', async (t) => {
  const calls = mcpStub(t, {});
  const h = host([{ id: 10, name: 'Louvre', lat: 48.86, lng: 2.33 }]);
  const driver = h.run(plugin);

  assert.equal((await driver.route({ method: 'POST', path: '/commute' }, { body: { listings: [] } })).status, 400);
  const res = await driver.route({ method: 'POST', path: '/commute' }, { body: { tripId: 7, listings: [] } });
  assert.equal(res.status, 200);
  assert.match(body(res).reason, /coordinates/i);
  assert.equal(calls.length, 0);
});
