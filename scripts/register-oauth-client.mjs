#!/usr/bin/env node
/**
 * One-off: register this TREK instance as an OAuth client of the OpenBnB MCP server.
 *
 * OpenBnB implements RFC 7591 Dynamic Client Registration, so no account, no
 * dashboard and no support ticket is needed — the endpoint mints a client id and
 * secret for the redirect URI you give it. TREK's OAuth broker requires a
 * confidential client (it always sends a client_secret), so we register with
 * `client_secret_post` rather than a public PKCE client.
 *
 * Usage:
 *   node scripts/register-oauth-client.mjs https://trek.example.com
 */

const PLUGIN_ID = 'airbnb-mcp';
const DEFAULT_ISSUER = 'https://mcp.openbnb.ai';

function die(msg) {
  console.error(`\n  Error: ${msg}\n`);
  process.exit(1);
}

const appUrl = process.argv[2];
const issuer = (process.argv[3] || DEFAULT_ISSUER).replace(/\/+$/, '');

if (!appUrl || appUrl === '--help' || appUrl === '-h') {
  console.log(`
  Register this TREK instance with OpenBnB.

    node scripts/register-oauth-client.mjs <your-trek-url> [issuer]

  Example:
    node scripts/register-oauth-client.mjs https://trek.example.com

  <your-trek-url> must be exactly your server's APP_URL — the public base URL
  your users reach TREK on, INCLUDING any path if TREK is hosted under one
  (https://example.com/trek). The redirect URI is derived from it and OpenBnB
  only redirects to the URI registered here, so a mismatch breaks sign-in.
`);
  process.exit(appUrl ? 0 : 1);
}

let base;
try {
  base = new URL(appUrl);
} catch {
  die(`"${appUrl}" is not a valid URL.`);
}
if (base.protocol !== 'https:' && base.hostname !== 'localhost' && base.hostname !== '127.0.0.1') {
  die('TREK must be reachable over https (or be localhost) for the OAuth redirect to work.');
}

// TREK builds the redirect as `${getAppUrl()}/api/plugin-oauth/<id>/callback`, and
// getAppUrl() is APP_URL with trailing slashes stripped — PATH INCLUDED. Using the
// origin here would silently drop a subpath (https://example.com/trek), and OAuth
// compares redirect URIs exactly, so the mismatch would only surface as a failed
// sign-in much later. Mirror getAppUrl() precisely instead.
const appBase = appUrl.replace(/\/+$/, '');
const redirectUri = `${appBase}/api/plugin-oauth/${PLUGIN_ID}/callback`;

// Discover the endpoints rather than hardcoding them, so a moved endpoint or a
// self-hosted compatible server keeps working.
const discoveryUrl = `${issuer}/.well-known/oauth-authorization-server`;
console.log(`\n  Discovering ${discoveryUrl} ...`);

let meta;
try {
  const res = await fetch(discoveryUrl, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) die(`discovery returned ${res.status}`);
  meta = await res.json();
} catch (err) {
  die(`could not reach the authorization server: ${err.message}`);
}

if (!meta.registration_endpoint) {
  die('this server does not advertise a registration endpoint — register a client by hand.');
}
const registrationUrl = new URL(meta.registration_endpoint, `${issuer}/`).toString();

console.log(`  Registering redirect URI:\n    ${redirectUri}\n`);

let client;
try {
  const res = await fetch(registrationUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: `TREK (${base.hostname})`,
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'client_secret_post',
    }),
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  if (res.status !== 200 && res.status !== 201) die(`registration returned ${res.status}: ${text.slice(0, 400)}`);
  client = JSON.parse(text);
} catch (err) {
  die(`registration failed: ${err.message}`);
}

if (!client.client_secret) {
  die(
    'the server issued a PUBLIC client with no secret. TREK\'s OAuth broker requires a ' +
      'confidential client — re-run against a server that supports client_secret_post.',
  );
}

console.log(`  Registered.

  Paste these into TREK → Admin → Plugins → Airbnb via OpenBnB → Settings:

    OAuth authorize URL   ${meta.authorization_endpoint}
    OAuth token URL       ${meta.token_endpoint}
    OAuth scopes          (leave blank)
    OAuth client id       ${client.client_id}
    OAuth client secret   ${client.client_secret}

  Keep the secret out of version control. Each traveller then connects their own
  OpenBnB account under Settings -> Plugins -> Airbnb via OpenBnB -> Connect.
`);
