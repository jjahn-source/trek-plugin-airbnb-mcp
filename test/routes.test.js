'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMockHost } = require('trek-plugin-sdk/testing');
const plugin = require('../server/index.js');

const GRANTS = [
  'db:own', 'db:meta', 'db:read:trips', 'db:write:places', 'db:write:accommodations',
  'oauth:client', 'http:outbound:mcp.openbnb.ai', 'http:outbound:*.muscache.com',
  'hook:place-detail-provider',
];

const OAUTH_CONFIG = {
  oauth_authorize_url: 'https://mcp.openbnb.ai/authorize',
  oauth_token_url: 'https://mcp.openbnb.ai/token',
  oauth_client_id: 'cid',
  oauth_client_secret: 'secret',
};

const SEARCH_PAYLOAD = {
  searchUrl: 'https://www.airbnb.com/s/Paris/homes',
  searchResults: [{
    id: '1001',
    url: 'https://www.airbnb.com/rooms/1001',
    demandStayListing: {
      description: { name: { localizedStringWithTranslationPreference: 'Le Marais loft' } },
      location: { coordinate: { latitude: 48.86, longitude: 2.35 } },
    },
    avgRatingA11yLabel: '4.9 out of 5 average rating, 20 reviews',
    structuredDisplayPrice: { primaryLine: { accessibilityLabel: '$900 for 3 nights' } },
  }],
  paginationInfo: { nextPageCursor: 'next-1' },
};

/** Replace global fetch with a scripted MCP server for the duration of one test. */
function withMcp(t, { toolResult, toolStatus = 200 } = {}) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const body = init && init.body ? JSON.parse(init.body) : null;
    calls.push({ url, body });
    const json = (status, obj) => ({
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (k) => (k.toLowerCase() === 'content-type' ? 'application/json' : k.toLowerCase() === 'mcp-session-id' ? 's1' : null) },
      text: async () => JSON.stringify(obj),
      arrayBuffer: async () => new ArrayBuffer(0),
    });
    if (body && body.method === 'initialize') return json(200, { id: body.id, result: {} });
    if (body && body.method === 'notifications/initialized') return json(202, {});
    if (body && body.method === 'tools/call') {
      if (toolStatus !== 200) return json(toolStatus, { error: 'invalid_token' });
      return json(200, { id: body.id, result: { content: [{ type: 'text', text: JSON.stringify(toolResult) }] } });
    }
    return json(500, {});
  };
  t.after(() => { globalThis.fetch = original; });
  return calls;
}

function host(opts = {}) {
  return createMockHost({
    grants: GRANTS,
    config: { ...OAUTH_CONFIG, ...(opts.config || {}) },
    actingUserId: 42,
    trips: {
      7: {
        members: [42],
        data: { id: 7, title: 'Paris', start_date: '2026-10-10', end_date: '2026-10-14' },
        days: [
          { id: 501, date: '2026-10-10' }, { id: 502, date: '2026-10-11' },
          { id: 503, date: '2026-10-12' }, { id: 504, date: '2026-10-13' },
          { id: 505, date: '2026-10-14' },
        ],
      },
    },
    ...opts,
  });
}

const body = (res) => JSON.parse(res.body);

test('/status reports configured-but-not-connected before the user links OpenBnB', async () => {
  const h = host({ oauthAccessToken: null });
  const res = await h.run(plugin).route({ method: 'GET', path: '/status' });
  assert.equal(res.status, 200);
  assert.deepEqual(body(res), { configured: true, connected: false, endpoint: 'https://mcp.openbnb.ai/mcp' });
});

test('/status reports not-configured when the admin has not filled the OAuth settings', async () => {
  const h = createMockHost({ grants: GRANTS, config: {}, actingUserId: 42, oauthAccessToken: null });
  const res = await h.run(plugin).route({ method: 'GET', path: '/status' });
  assert.equal(body(res).configured, false);
});

test('/defaults seeds the form from the trip dates', async () => {
  const h = host({ oauthAccessToken: 'tok' });
  const res = await h.run(plugin).route({ method: 'GET', path: '/defaults' }, { query: { tripId: '7' } });
  assert.deepEqual(body(res), { checkin: '2026-10-10', checkout: '2026-10-14', location: 'Paris' });
});

test('/search refuses with a connect prompt when the user has no OpenBnB token', async (t) => {
  withMcp(t, { toolResult: SEARCH_PAYLOAD });
  const h = host({ oauthAccessToken: null });
  const res = await h.run(plugin).route({ method: 'POST', path: '/search' }, { body: { location: 'Paris', tripId: 7 } });
  assert.equal(res.status, 403);
  assert.equal(body(res).connect, true);
});

test('/search calls the MCP tool with the user token and returns normalized results', async (t) => {
  const calls = withMcp(t, { toolResult: SEARCH_PAYLOAD });
  const h = host({ oauthAccessToken: 'user-token' });
  const res = await h.run(plugin).route({
    method: 'POST', path: '/search' }, {
    body: { location: 'Paris, France', checkin: '2026-10-10', checkout: '2026-10-14', adults: 2, tripId: 7 },
  });

  assert.equal(res.status, 200);
  const out = body(res);
  assert.equal(out.results.length, 1);
  assert.equal(out.results[0].name, 'Le Marais loft');
  assert.equal(out.results[0].priceAmount, 900);
  assert.equal(out.cursor, 'next-1');

  const toolCall = calls.find((c) => c.body && c.body.method === 'tools/call');
  assert.equal(toolCall.body.params.name, 'airbnb_search');
  assert.deepEqual(toolCall.body.params.arguments, {
    location: 'Paris, France', checkin: '2026-10-10', checkout: '2026-10-14', adults: 2,
  });
  assert.equal(calls[0].url, 'https://mcp.openbnb.ai/mcp');
});

test('/search rejects a blank location before any egress', async (t) => {
  const calls = withMcp(t, { toolResult: SEARCH_PAYLOAD });
  const h = host({ oauthAccessToken: 'tok' });
  const res = await h.run(plugin).route({ method: 'POST', path: '/search' }, { body: { location: '  ' } });
  assert.equal(res.status, 400);
  assert.equal(calls.length, 0, 'must not call the MCP server for an invalid request');
});

test('an expired OpenBnB token surfaces as 401 with a reconnect flag', async (t) => {
  withMcp(t, { toolStatus: 401 });
  const h = host({ oauthAccessToken: 'stale' });
  const res = await h.run(plugin).route({ method: 'POST', path: '/search' }, { body: { location: 'Paris' } });
  assert.equal(res.status, 401);
  assert.equal(body(res).reconnect, true);
});

test('a tool-level robots.txt error is reported, not rendered as zero results', async (t) => {
  withMcp(t, { toolResult: { error: "This path is disallowed by Airbnb's robots.txt" } });
  const h = host({ oauthAccessToken: 'tok' });
  const res = await h.run(plugin).route({ method: 'POST', path: '/search' }, { body: { location: 'Paris' } });
  assert.equal(res.status, 502);
  assert.match(body(res).error, /robots\.txt/);
});

test('/photo refuses a host outside Airbnb\'s image CDN', async (t) => {
  const calls = withMcp(t, {});
  const h = host({ oauthAccessToken: 'tok' });
  for (const url of ['https://evil.example.com/x.jpg', 'http://a0.muscache.com/x.jpg', 'https://notmuscache.com/x.jpg']) {
    const res = await h.run(plugin).route({ method: 'GET', path: '/photo' }, { query: { url } });
    assert.equal(res.status, 400, `${url} must be refused`);
  }
  assert.equal(calls.length, 0, 'no egress for a refused photo URL');
});

test('/add creates the place and records the booking context for the detail panel', async (t) => {
  withMcp(t, {});
  const h = host({ oauthAccessToken: 'tok' });
  const driver = h.run(plugin);
  const res = await driver.route({
    method: 'POST', path: '/add' }, {
    body: {
      tripId: 7, checkin: '2026-10-10', checkout: '2026-10-14', adults: 2,
      listing: { id: '1001', name: 'Le Marais loft', url: 'https://www.airbnb.com/rooms/1001', lat: 48.86, lng: 2.35, priceLabel: '$900 for 3 nights', rating: 4.9, reviews: 20 },
    },
  });
  assert.equal(res.status, 200);
  const rows = await driver.hook('placeDetailProvider', 'getDetails', body(res).place.id);
  const labels = rows.map((r) => r.label);
  assert.deepEqual(labels, ['Airbnb', 'Price', 'Rating']);
  assert.equal(rows[0].url, 'https://www.airbnb.com/rooms/1001');
  assert.match(rows[1].value, /\$900 for 3 nights \(2026-10-10 → 2026-10-14\)/);
});

test('the place-detail hook stays silent for a place this plugin did not add', async () => {
  const h = host({ oauthAccessToken: 'tok' });
  assert.deepEqual(await h.run(plugin).hook('placeDetailProvider', 'getDetails', 999), []);
});

test('/add rejects a request without a listing', async () => {
  const h = host({ oauthAccessToken: 'tok' });
  const res = await h.run(plugin).route({ method: 'POST', path: '/add' }, { body: { tripId: 7 } });
  assert.equal(res.status, 400);
});

test('an mcp_url override that is not https falls back to the hosted endpoint', async () => {
  const h = host({ oauthAccessToken: null, config: { mcp_url: 'http://169.254.169.254/mcp' } });
  const res = await h.run(plugin).route({ method: 'GET', path: '/status' });
  assert.equal(body(res).endpoint, 'https://mcp.openbnb.ai/mcp');
});

// --- MCP session reuse -------------------------------------------------------
// The client cache is module-level, so each test uses a DISTINCT token to get its
// own cache key. Crucially the stub is installed ONCE and then mutated: McpClient
// snapshots globalThis.fetch at construction, so a cached client would otherwise
// keep calling the stub that was live when it was built.

function mutableMcp(t) {
  const original = globalThis.fetch;
  const state = {
    inits: 0,
    toolCalls: 0,
    /** (callIndex) => { payload } | { isError, payload } | { httpStatus } */
    onTool: () => ({ payload: SEARCH_PAYLOAD }),
  };
  globalThis.fetch = async (url, init) => {
    const b = JSON.parse(init.body);
    const json = (status, obj) => ({
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (k) => (k.toLowerCase() === 'content-type' ? 'application/json' : null) },
      text: async () => JSON.stringify(obj),
    });
    if (b.method === 'initialize') { state.inits++; return json(200, { id: b.id, result: {} }); }
    if (b.method === 'notifications/initialized') return json(202, {});
    state.toolCalls++;
    const step = state.onTool(state.toolCalls);
    if (step.httpStatus) return json(step.httpStatus, { error: 'session not found' });
    return json(200, {
      id: b.id,
      result: { content: [{ type: 'text', text: JSON.stringify(step.payload) }], isError: !!step.isError },
    });
  };
  t.after(() => { globalThis.fetch = original; });
  return state;
}

test('a second search reuses the MCP session instead of re-handshaking', async (t) => {
  const mcp = mutableMcp(t);
  const driver = host({ oauthAccessToken: 'reuse-token' }).run(plugin);

  await driver.route({ method: 'POST', path: '/search' }, { body: { location: 'Paris' } });
  await driver.route({ method: 'POST', path: '/search' }, { body: { location: 'Lyon' } });

  assert.equal(mcp.inits, 1, 'the handshake should happen once, not per search');
  assert.equal(mcp.toolCalls, 2);
});

test('a dropped MCP session is re-established once and the search still succeeds', async (t) => {
  const mcp = mutableMcp(t);
  const driver = host({ oauthAccessToken: 'drop-token' }).run(plugin);

  // Call 1 primes the cache; call 2 (the cached session) 404s like an expired one.
  mcp.onTool = (n) => (n === 2 ? { httpStatus: 404 } : { payload: SEARCH_PAYLOAD });

  await driver.route({ method: 'POST', path: '/search' }, { body: { location: 'Paris' } });
  const res = await driver.route({ method: 'POST', path: '/search' }, { body: { location: 'Nice' } });

  assert.equal(res.status, 200);
  assert.equal(body(res).results.length, 1);
  assert.equal(mcp.inits, 2, 'the stale session must be replaced');
  assert.equal(mcp.toolCalls, 3, 'the failed call plus the retry');
});

test('a tool-level error on a cached session is NOT retried, so Airbnb is hit once', async (t) => {
  const mcp = mutableMcp(t);
  const driver = host({ oauthAccessToken: 'noretry-token' }).run(plugin);

  mcp.onTool = (n) => (n === 1 ? { payload: SEARCH_PAYLOAD } : { isError: true, payload: { error: 'robots.txt' } });

  await driver.route({ method: 'POST', path: '/search' }, { body: { location: 'Paris' } });
  const res = await driver.route({ method: 'POST', path: '/search' }, { body: { location: 'Paris' } });

  assert.equal(res.status, 502);
  assert.equal(mcp.toolCalls, 2, 'the failing search must make exactly one tool call');
  assert.equal(mcp.inits, 1, 'a tool error is not a session problem');
});

test('an expired token is reported, not retried against a fresh session', async (t) => {
  const mcp = mutableMcp(t);
  const driver = host({ oauthAccessToken: 'expire-token' }).run(plugin);

  mcp.onTool = (n) => (n === 1 ? { payload: SEARCH_PAYLOAD } : { httpStatus: 401 });

  await driver.route({ method: 'POST', path: '/search' }, { body: { location: 'Paris' } });
  const res = await driver.route({ method: 'POST', path: '/search' }, { body: { location: 'Nice' } });

  assert.equal(res.status, 401);
  assert.equal(body(res).reconnect, true);
  assert.equal(mcp.toolCalls, 2, 'a 401 must not be retried');
  assert.equal(mcp.inits, 1);
});

// --- error copy ---------------------------------------------------------------
// The raw upstream text is right for the log and wrong for the screen.

test('friendlyError rewrites the failures a traveller can actually act on', () => {
  const { friendlyError } = plugin;

  const robots = friendlyError("This path is disallowed by Airbnb's robots.txt to this User-agent.");
  assert.match(robots, /robots\.txt/, 'still names the cause');
  assert.match(robots, /OpenBnB MCP endpoint/, 'points at the setting that fixes it');

  assert.match(friendlyError('The operation was aborted due to timeout'), /took too long/);
  assert.match(friendlyError('OpenBnB MCP returned 429'), /rate-limiting/);
  assert.match(friendlyError('OpenBnB MCP returned 503'), /trouble right now/);
});

test('friendlyError passes through anything it does not recognise', () => {
  assert.equal(plugin.friendlyError('some upstream detail'), 'some upstream detail');
  assert.equal(plugin.friendlyError(''), 'The search failed.');
  assert.equal(plugin.friendlyError(undefined), 'The search failed.');
});

test('a search failure reaches the client as the friendly copy, not the raw text', async (t) => {
  withMcp(t, { toolResult: { error: "This path is disallowed by Airbnb's robots.txt" } });
  const h = host({ oauthAccessToken: 'friendly-token' });
  const res = await h.run(plugin).route({ method: 'POST', path: '/search' }, { body: { location: 'Paris' } });
  assert.equal(res.status, 502);
  assert.match(body(res).error, /OpenBnB MCP endpoint/, 'the actionable copy, not the bare upstream string');
});

// --- lodging blocks ------------------------------------------------------------
// A stay is somewhere you sleep, so when the dates line up with real trip days it
// becomes a day_accommodation (which also creates the partner hotel reservation),
// not just a pin on the map.

const LISTING = {
  id: '1001', name: 'Le Marais loft', url: 'https://www.airbnb.com/rooms/1001',
  lat: 48.86, lng: 2.35, priceLabel: '$900 for 3 nights', rating: 4.9, reviews: 20,
};

test('adding a stay whose dates match trip days creates a lodging block', async (t) => {
  withMcp(t, {});
  const h = host({ oauthAccessToken: 'tok' });
  const res = await h.run(plugin).route({ method: 'POST', path: '/add' }, {
    body: { tripId: 7, checkin: '2026-10-10', checkout: '2026-10-14', adults: 2, listing: LISTING },
  });

  assert.equal(res.status, 200);
  const out = body(res);
  assert.ok(out.place, 'the place is still created');
  assert.ok(out.accommodation, 'and a lodging block alongside it');
});

test('the lodging block spans the right days and leaves the times unset', async (t) => {
  withMcp(t, {});
  const calls = [];
  const h = host({ oauthAccessToken: 'tok' });
  const realCreate = h.ctx.accommodations.create.bind(h.ctx.accommodations);
  h.ctx.accommodations.create = async (tripId, input) => { calls.push({ tripId, input }); return realCreate(tripId, input); };

  await h.run(plugin).route({ method: 'POST', path: '/add' }, {
    body: { tripId: 7, checkin: '2026-10-11', checkout: '2026-10-13', listing: LISTING },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].input.start_day_id, 502, '11 Oct is day 502');
  assert.equal(calls[0].input.end_day_id, 504, '13 Oct is day 504');
  // check_in/check_out are TIMES in TREK's model; we do not know Airbnb's, so they stay unset.
  assert.equal(calls[0].input.check_in, undefined);
  assert.equal(calls[0].input.check_out, undefined);
  assert.match(calls[0].input.notes, /airbnb\.com\/rooms\/1001/);
});

test('dates outside the trip still add the place, without a lodging block', async (t) => {
  withMcp(t, {});
  const h = host({ oauthAccessToken: 'tok' });
  const res = await h.run(plugin).route({ method: 'POST', path: '/add' }, {
    body: { tripId: 7, checkin: '2027-01-01', checkout: '2027-01-05', listing: LISTING },
  });
  assert.equal(res.status, 200);
  assert.ok(body(res).place);
  assert.equal(body(res).accommodation, null);
});

test('no dates at all means no lodging block, and no wasted day lookup', async (t) => {
  withMcp(t, {});
  const h = host({ oauthAccessToken: 'tok' });
  let daysRead = 0;
  const realGetDays = h.ctx.trips.getDays.bind(h.ctx.trips);
  h.ctx.trips.getDays = async (id) => { daysRead++; return realGetDays(id); };

  const res = await h.run(plugin).route({ method: 'POST', path: '/add' }, { body: { tripId: 7, listing: LISTING } });
  assert.equal(res.status, 200);
  assert.equal(body(res).accommodation, null);
  assert.equal(daysRead, 0, 'skips the day read when there are no dates to match');
});

test('a refused accommodation write never loses the place the user just added', async (t) => {
  withMcp(t, {});
  const h = host({ oauthAccessToken: 'tok' });
  h.ctx.accommodations.create = async () => { throw new Error('PERMISSION_DENIED: day_edit'); };

  const res = await h.run(plugin).route({ method: 'POST', path: '/add' }, {
    body: { tripId: 7, checkin: '2026-10-10', checkout: '2026-10-14', listing: LISTING },
  });
  assert.equal(res.status, 200, 'the add still succeeds');
  assert.ok(body(res).place);
  assert.equal(body(res).accommodation, null);
});

// --- restore cache -------------------------------------------------------------

test('cachePayload trims results instead of slicing the JSON string', () => {
  const { cachePayload } = plugin;
  const out = {
    results: Array.from({ length: 40 }, (_, i) => ({ id: String(i), name: 'x'.repeat(500) })),
    cursor: 'c',
    searchUrl: 'https://example.com',
  };

  const full = cachePayload({ location: 'Paris' }, out, 400000);
  assert.equal(JSON.parse(full).results.length, 40, 'a normal page is cached whole');

  const trimmed = cachePayload({ location: 'Paris' }, out, 5000);
  const parsed = JSON.parse(trimmed); // the point: it must still parse
  assert.ok(trimmed.length <= 5000);
  assert.ok(parsed.results.length > 0 && parsed.results.length < 40, 'kept some results, not all');
  assert.equal(parsed.cursor, 'c', 'the cursor survives trimming');
  assert.equal(parsed.params.location, 'Paris');
});

test('cachePayload returns null rather than caching something unparseable', () => {
  const out = { results: [{ id: '1', name: 'x'.repeat(100) }], cursor: null, searchUrl: null };
  assert.equal(plugin.cachePayload({ location: 'y'.repeat(500) }, out, 50), null);
});

test('/last parses exactly what cachePayload wrote, and returns it', async () => {
  // The mock host's db.query serves canned rows keyed by SQL (it is not a real
  // SQLite), so this covers the seam that matters: the bytes cachePayload produces
  // are what /last reads back and parses.
  const out = { results: [{ id: '1001', name: 'Le Marais loft' }], cursor: 'next-1', searchUrl: 'https://x' };
  const payload = plugin.cachePayload({ location: 'Paris' }, out, 400000);

  const h = createMockHost({
    grants: GRANTS,
    config: OAUTH_CONFIG,
    actingUserId: 42,
    queryResults: { 'SELECT payload FROM last_search WHERE trip_id = ? AND user_id = ?': [{ payload }] },
  });

  const res = await h.run(plugin).route({ method: 'GET', path: '/last' }, { query: { tripId: '7' } });
  assert.equal(res.status, 200);
  const restored = body(res);
  assert.equal(restored.results.length, 1);
  assert.equal(restored.results[0].name, 'Le Marais loft');
  assert.equal(restored.cursor, 'next-1');
  assert.equal(restored.params.location, 'Paris');
});

test('/last degrades to an empty object when the stored row is unparseable', async () => {
  const h = createMockHost({
    grants: GRANTS,
    config: OAUTH_CONFIG,
    actingUserId: 42,
    queryResults: { 'SELECT payload FROM last_search WHERE trip_id = ? AND user_id = ?': [{ payload: '{"results":[{"id"' }] },
  });
  const res = await h.run(plugin).route({ method: 'GET', path: '/last' }, { query: { tripId: '7' } });
  assert.equal(res.status, 200);
  assert.deepEqual(body(res), {}, 'a corrupt row must not break the tab');
});
