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

test('a "default" is a bonus, never the thing that makes a field usable', () => {
  // TREK is adding `default` (jubnl, on TREK-Plugins#87), so declaring one is worth it:
  // on a host that honours it the two constant OAuth URLs arrive filled in and setup is
  // two fields instead of four. But every host older than that release drops it silently
  // — `persistSettingsFields` never reads the key — so nothing may DEPEND on it. Each
  // field must still be usable with the value absent: a placeholder to show what to type,
  // and, for anything optional, a code-side fallback so blank means "use the built-in".
  for (const s of manifest.settings) {
    // A select carries its own value hints: the options ARE the legal values, so a
    // placeholder would advertise a fourth choice that does not exist.
    if (s.input_type === 'select') {
      assert.ok(Array.isArray(s.options) && s.options.length, `${s.key} is a select with no options`);
      for (const o of s.options) {
        assert.ok(o && o.value !== undefined && o.label, `${s.key} has an option missing a value or label`);
      }
    } else if (!s.secret) {
      assert.ok(s.placeholder, `${s.key} needs a placeholder — the only value hint an empty field gets`);
    }
    if (s.default !== undefined) {
      // Two places to state the same value is two places to get it wrong. Keeping them
      // equal means the greyed-out hint and the pre-filled value can never disagree.
      assert.equal(s.default, s.placeholder,
        `${s.key}: default and placeholder must not drift apart`);
    }
  }
});

test('the credentials never carry a default, however tempting the placeholder looks', () => {
  // oauth_client_id's placeholder is a FORMAT ("openbnb-xxxx…"), not a value, and the
  // secret has none at all. Defaulting either would pre-fill a field with something that
  // is not a credential, which reads as configured and fails at the token exchange.
  for (const key of ['oauth_client_id', 'oauth_client_secret']) {
    const s = manifest.settings.find((f) => f.key === key);
    assert.equal(s.default, undefined, `${key} must never be pre-filled`);
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

/* ------------------------------------------------------ register_client */

/**
 * The button that replaced "clone the repo and run a CLI".
 *
 * Setup used to be unreachable for the admin most likely to have it: someone who
 * installed this from the registry has no checkout to run `npm run register` in. The
 * same registration now happens from the settings page, one button away from the
 * fields the values go into.
 */
function withRegistrationServer(t, { meta, registration } = {}) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: (init && init.method) || 'GET' });
    const json = (status, obj) => ({
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(obj),
    });
    if (String(url).includes('/.well-known/oauth-authorization-server')) {
      return json(200, meta || {
        authorization_endpoint: 'https://mcp.openbnb.ai/authorize',
        token_endpoint: 'https://mcp.openbnb.ai/token',
        registration_endpoint: 'https://mcp.openbnb.ai/register',
      });
    }
    return json(201, registration || { client_id: 'cid-abc', client_secret: 'sec-xyz' });
  };
  t.after(() => { globalThis.fetch = original; });
  return calls;
}

test('register_client asks for the TREK URL first rather than guessing one', async () => {
  const h = host({ config: { ...OAUTH_CONFIG, trek_url: '' } });
  const res = await h.run(plugin).action('register_client');
  assert.equal(res.ok, false);
  assert.match(res.message, /This TREK server's URL/);
});

test('register_client returns the id and secret an admin has to paste', async (t) => {
  withRegistrationServer(t);
  const h = host({ config: { ...OAUTH_CONFIG, trek_url: 'https://trek.example.com' } });
  const res = await h.run(plugin).action('register_client');
  assert.equal(res.ok, true);
  assert.match(res.message, /cid-abc/);
  assert.match(res.message, /sec-xyz/);
});

/**
 * The message is bounded host-side by an amount the SDK does not specify, and the
 * secret is the one value that cannot be recovered from anywhere else on the page —
 * the two URLs are already sitting in their fields as placeholder text. So the secret
 * has to appear early enough to survive a trim.
 */
test('register_client puts the credentials before the prose', async (t) => {
  withRegistrationServer(t);
  const h = host({ config: { ...OAUTH_CONFIG, trek_url: 'https://trek.example.com' } });
  const res = await h.run(plugin).action('register_client');
  assert.ok(res.message.indexOf('sec-xyz') < 140, `secret at ${res.message.indexOf('sec-xyz')}: ${res.message}`);
});

test('register_client reports a refusal instead of throwing at the admin', async (t) => {
  withRegistrationServer(t, { registration: { client_id: 'public-only' } });
  const h = host({ config: { ...OAUTH_CONFIG, trek_url: 'https://trek.example.com' } });
  const res = await h.run(plugin).action('register_client');
  assert.equal(res.ok, false);
  assert.match(res.message, /secret/i);
});

test('register_client refuses a TREK URL that could never receive the redirect', async (t) => {
  withRegistrationServer(t);
  const h = host({ config: { ...OAUTH_CONFIG, trek_url: 'http://trek.example.com' } });
  const res = await h.run(plugin).action('register_client');
  assert.equal(res.ok, false);
  assert.match(res.message, /https/i);
});
