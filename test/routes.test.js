'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMockHost } = require('trek-plugin-sdk/testing');
const plugin = require('../server/index.js');

const GRANTS = [
  'db:own', 'db:meta', 'db:read:trips', 'db:write:places',
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
    trips: { 7: { members: [42], data: { id: 7, title: 'Paris', start_date: '2026-10-10', end_date: '2026-10-14' } } },
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
