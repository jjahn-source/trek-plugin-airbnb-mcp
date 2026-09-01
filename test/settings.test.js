'use strict';
/**
 * The instance-settings surface: the manifest fields a TREK builds its settings form
 * from, and the "Test connection" button that form renders.
 *
 * The manifest half is not busywork. A settings form is DERIVED from the manifest, so
 * a field that reads fine in a JSON file can still render as an empty box with no clue
 * what to type — and nothing else in this repo would catch that, because no plugin code
 * ever reads those fields.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMockHost } = require('trek-plugin-sdk/testing');
const plugin = require('../server/index.js');
const manifest = require('../trek-plugin.json');

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

const ACTION_KEYS = (manifest.actions || []).map((a) => a.key);

function host(opts = {}) {
  return createMockHost({
    grants: GRANTS,
    config: OAUTH_CONFIG,
    actingUserId: 42,
    oauthAccessToken: null,
    // Mirror production: the host refuses an action key the manifest never declared,
    // so a handler that only works because the mock is lenient is not a passing test.
    declaredActions: ACTION_KEYS,
    ...opts,
  });
}

/** A scripted MCP server for one test. Returns the requests it received. */
function withMcp(t, { failStatus = 0, tools = ['airbnb_search', 'airbnb_listing'] } = {}) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const body = init && init.body ? JSON.parse(init.body) : null;
    calls.push({ url, method: body && body.method });
    const json = (status, obj) => ({
      ok: status >= 200 && status < 300,
      status,
      headers: {
        get: (k) =>
          k.toLowerCase() === 'content-type' ? 'application/json'
            : k.toLowerCase() === 'mcp-session-id' ? 's1'
              : null,
      },
      text: async () => JSON.stringify(obj),
      arrayBuffer: async () => new ArrayBuffer(0),
    });
    if (failStatus) return json(failStatus, { error: 'invalid_token' });
    if (body && body.method === 'initialize') return json(200, { id: body.id, result: {} });
    if (body && body.method === 'notifications/initialized') return json(202, {});
    if (body && body.method === 'tools/list') {
      return json(200, { id: body.id, result: { tools: tools.map((name) => ({ name })) } });
    }
    return json(500, {});
  };
  t.after(() => { globalThis.fetch = original; });
  return calls;
}

// ---------------------------------------------------------------------------
// Manifest -> settings form
// ---------------------------------------------------------------------------

test('every setting is instance-scoped, labelled and hinted', () => {
  assert.ok(manifest.settings.length > 0);
  for (const s of manifest.settings) {
    assert.equal(s.scope, 'instance', `${s.key} must be an instance setting`);
    assert.ok(s.label, `${s.key} needs a label — the form has no other name for it`);
    assert.ok(s.hint, `${s.key} needs a hint — the form renders it as the helper text`);
  }
});

test('no setting relies on a manifest "default" to be usable', () => {
  // The SDK's ManifestSettingField has no `default`, so a form built from the manifest
  // renders these fields EMPTY however the JSON reads. Anything optional must therefore
  // work when saved blank, and anything required must show the admin what to type.
  // `default` silently doing nothing is exactly the trap this guards against.
  for (const s of manifest.settings) {
    assert.equal(s.default, undefined, `${s.key} must not depend on an unsupported "default"`);
    if (!s.secret) {
      assert.ok(s.placeholder, `${s.key} needs a placeholder — the only value hint an empty field gets`);
    }
  }
});

test('the four OAuth broker settings are required and the rest are optional', () => {
  // The broker reads these four out of stored config; every other setting has a
  // code-side fallback, so marking it required would block setup for nothing.
  const required = manifest.settings.filter((s) => s.required).map((s) => s.key);
  assert.deepEqual(required, [
    'oauth_authorize_url', 'oauth_token_url', 'oauth_client_id', 'oauth_client_secret',
  ]);
  assert.equal(manifest.settings.find((s) => s.key === 'oauth_client_secret').secret, true);
});

test('every declared action has a handler and every handler is declared', () => {
  assert.deepEqual(Object.keys(plugin.actions || {}).sort(), ACTION_KEYS.slice().sort());
});

// ---------------------------------------------------------------------------
// "Test connection"
// ---------------------------------------------------------------------------

test('test_connection names the empty fields by their form label', async () => {
  const h = host({ config: {} });
  const res = await h.run(plugin).action('test_connection');
  assert.equal(res.ok, false);
  assert.match(res.message, /OAuth authorize URL, OAuth token URL, OAuth client id and OAuth client secret/);
});

test('test_connection names only the fields still empty', async () => {
  const h = host({
    config: {
      oauth_authorize_url: 'https://mcp.openbnb.ai/authorize',
      oauth_token_url: 'https://mcp.openbnb.ai/token',
    },
  });
  const res = await h.run(plugin).action('test_connection');
  assert.equal(res.ok, false);
  assert.match(res.message, /OAuth client id and OAuth client secret/);
  assert.doesNotMatch(res.message, /authorize URL/);
});

test('test_connection reports how far it got when nobody has connected an account yet', async () => {
  const h = host({ oauthAccessToken: null });
  const res = await h.run(plugin).action('test_connection');
  // Complete settings with no connected user is a legitimate mid-setup state, not a
  // failure — but it must not claim the credentials themselves were verified.
  assert.equal(res.ok, true);
  assert.match(res.message, /Connect your own OpenBnB account/);
});

test('test_connection rejects an MCP endpoint override that is not usable https', async () => {
  const h = host({
    config: Object.assign({}, OAUTH_CONFIG, { mcp_url: 'http://mcp.openbnb.ai/mcp' }),
    oauthAccessToken: 'tok',
  });
  const res = await h.run(plugin).action('test_connection');
  // Searches fall back silently here so one admin typo cannot block every traveller.
  // A test that did the same would report success against an endpoint nobody configured.
  assert.equal(res.ok, false);
  assert.match(res.message, /not a usable https URL/);
});

test('test_connection accepts a valid https endpoint that URL parsing would rewrite', async (t) => {
  const calls = withMcp(t);
  // "https://host" with no path normalises to "https://host/". Deciding the override was
  // bad by comparing it against the normalised value would reject this — and reject it
  // with a message telling the admin their correct URL is unusable.
  const h = host({
    config: Object.assign({}, OAUTH_CONFIG, { mcp_url: 'https://mcp.openbnb.ai' }),
    oauthAccessToken: 'tok',
  });
  const res = await h.run(plugin).action('test_connection');
  assert.equal(res.ok, true, res.message);
  assert.ok(calls.length > 0, 'should have actually called the configured endpoint');
});

test('test_connection reaches the endpoint and confirms the search tool', async (t) => {
  const calls = withMcp(t);
  const h = host({ oauthAccessToken: 'tok' });
  const res = await h.run(plugin).action('test_connection');
  assert.equal(res.ok, true);
  assert.match(res.message, /Search is ready/);
  assert.ok(calls.some((c) => c.method === 'tools/list'), 'should have listed the tools');
});

test('test_connection fails when the endpoint offers no airbnb_search tool', async (t) => {
  withMcp(t, { tools: ['something_else'] });
  const h = host({ oauthAccessToken: 'tok' });
  const res = await h.run(plugin).action('test_connection');
  assert.equal(res.ok, false);
  assert.match(res.message, /airbnb_search/);
});

test('test_connection turns a rejected token into a reconnect instruction', async (t) => {
  withMcp(t, { failStatus: 401 });
  const h = host({ oauthAccessToken: 'stale' });
  const res = await h.run(plugin).action('test_connection');
  assert.equal(res.ok, false);
  assert.match(res.message, /Disconnect and reconnect/);
});

test('test_connection never falls back to search copy when the endpoint is unreachable', async (t) => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('getaddrinfo ENOTFOUND mcp.openbnb.ai'); };
  t.after(() => { globalThis.fetch = original; });
  const h = host({ oauthAccessToken: 'tok' });
  const res = await h.run(plugin).action('test_connection');
  assert.equal(res.ok, false);
  assert.match(res.message, /Could not reach/);
  assert.doesNotMatch(res.message, /search failed/i);
});
