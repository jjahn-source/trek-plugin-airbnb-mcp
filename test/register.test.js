'use strict';
/**
 * OAuth dynamic client registration, shared by the settings-page button and the CLI.
 *
 * The two paths MUST agree on the redirect URI. OAuth compares redirect URIs exactly,
 * so a derivation that differs by a trailing slash or a dropped subpath does not fail
 * here — it fails months later, as a traveller's sign-in that never completes, with
 * nothing on screen to connect it back to the day someone registered the client.
 * That is the whole reason this logic lives in one module instead of two.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { redirectUriFor, issuerFor, registerClient, DEFAULT_ISSUER } = require('../server/register');

test('the redirect URI keeps a subpath TREK is hosted under', () => {
  assert.equal(
    redirectUriFor('https://example.com/trek'),
    'https://example.com/trek/api/plugin-oauth/airbnb-mcp/callback',
  );
});

test('trailing slashes are stripped the way TREK\'s own getAppUrl strips them', () => {
  assert.equal(
    redirectUriFor('https://trek.example.com///'),
    'https://trek.example.com/api/plugin-oauth/airbnb-mcp/callback',
  );
});

test('a plain http URL is refused, because the OAuth redirect would never work', () => {
  assert.throws(() => redirectUriFor('http://trek.example.com'), /https/i);
});

test('localhost over http is allowed, so a dev instance can register', () => {
  for (const url of ['http://localhost:3000', 'http://127.0.0.1:8080']) {
    assert.match(redirectUriFor(url), /^http:\/\/(localhost:3000|127\.0\.0\.1:8080)\/api\/plugin-oauth\//);
  }
});

test('junk is refused with a message naming the field rather than a URL parser error', () => {
  assert.throws(() => redirectUriFor('not a url'), /TREK/i);
  assert.throws(() => redirectUriFor(''), /TREK/i);
});

/**
 * A self-hosted OpenBnB registers against ITSELF, not against the hosted service —
 * otherwise an operator running their own server would be handed credentials for
 * somebody else's.
 */
test('the issuer follows the configured MCP endpoint', () => {
  assert.equal(issuerFor('https://openbnb.internal.example/mcp'), 'https://openbnb.internal.example');
  assert.equal(issuerFor('https://mcp.openbnb.ai/mcp'), 'https://mcp.openbnb.ai');
});

test('a blank or unusable MCP endpoint falls back to the hosted issuer', () => {
  for (const bad of ['', null, undefined, 'nonsense', 'http://insecure.example/mcp']) {
    assert.equal(issuerFor(bad), DEFAULT_ISSUER);
  }
});

/** Discovery then registration, with the network scripted. */
function scriptedFetch(steps) {
  const calls = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({
        url: String(url),
        method: (init && init.method) || 'GET',
        body: init && init.body ? JSON.parse(init.body) : null,
      });
      const step = steps[String(url)];
      if (!step) throw new Error(`unscripted fetch: ${url}`);
      return {
        ok: step.status >= 200 && step.status < 300,
        status: step.status,
        text: async () => JSON.stringify(step.body),
        json: async () => step.body,
      };
    },
  };
}

const META = {
  authorization_endpoint: 'https://mcp.openbnb.ai/authorize',
  token_endpoint: 'https://mcp.openbnb.ai/token',
  registration_endpoint: 'https://mcp.openbnb.ai/register',
};

test('registers a confidential client and returns everything the admin must paste', async () => {
  const net = scriptedFetch({
    'https://mcp.openbnb.ai/.well-known/oauth-authorization-server': { status: 200, body: META },
    'https://mcp.openbnb.ai/register': { status: 201, body: { client_id: 'cid-123', client_secret: 'sec-456' } },
  });

  const out = await registerClient({ appUrl: 'https://trek.example.com', fetchImpl: net.fetch });

  assert.equal(out.clientId, 'cid-123');
  assert.equal(out.clientSecret, 'sec-456');
  assert.equal(out.authorizeUrl, META.authorization_endpoint);
  assert.equal(out.tokenUrl, META.token_endpoint);
  assert.equal(out.redirectUri, 'https://trek.example.com/api/plugin-oauth/airbnb-mcp/callback');

  // TREK's broker always sends a client_secret, so a PKCE-only public client is useless
  // here — the registration has to ask for a confidential one explicitly.
  const reg = net.calls.find((c) => c.method === 'POST');
  assert.equal(reg.body.token_endpoint_auth_method, 'client_secret_post');
  assert.deepEqual(reg.body.redirect_uris, ['https://trek.example.com/api/plugin-oauth/airbnb-mcp/callback']);
});

test('a server that issues a PUBLIC client is refused rather than half-configuring TREK', async () => {
  const net = scriptedFetch({
    'https://mcp.openbnb.ai/.well-known/oauth-authorization-server': { status: 200, body: META },
    'https://mcp.openbnb.ai/register': { status: 201, body: { client_id: 'cid-123' } },
  });
  await assert.rejects(
    () => registerClient({ appUrl: 'https://trek.example.com', fetchImpl: net.fetch }),
    /secret/i,
  );
});

test('a server that does not advertise registration says so, and does not POST anyway', async () => {
  const net = scriptedFetch({
    'https://mcp.openbnb.ai/.well-known/oauth-authorization-server': {
      status: 200,
      body: { authorization_endpoint: META.authorization_endpoint, token_endpoint: META.token_endpoint },
    },
  });
  await assert.rejects(
    () => registerClient({ appUrl: 'https://trek.example.com', fetchImpl: net.fetch }),
    /registration/i,
  );
  assert.equal(net.calls.filter((c) => c.method === 'POST').length, 0);
});

test('an unreachable discovery endpoint reports the failure, not a stack trace', async () => {
  const net = scriptedFetch({
    'https://mcp.openbnb.ai/.well-known/oauth-authorization-server': { status: 404, body: {} },
  });
  await assert.rejects(
    () => registerClient({ appUrl: 'https://trek.example.com', fetchImpl: net.fetch }),
    /404|discover/i,
  );
});

test('a relative registration_endpoint is resolved against the issuer', async () => {
  const net = scriptedFetch({
    'https://mcp.openbnb.ai/.well-known/oauth-authorization-server': {
      status: 200,
      body: { ...META, registration_endpoint: '/oauth/register' },
    },
    'https://mcp.openbnb.ai/oauth/register': { status: 200, body: { client_id: 'c', client_secret: 's' } },
  });
  const out = await registerClient({ appUrl: 'https://trek.example.com', fetchImpl: net.fetch });
  assert.equal(out.clientId, 'c');
});
