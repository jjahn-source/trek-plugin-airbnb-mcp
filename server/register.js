'use strict';

/**
 * OAuth dynamic client registration against an OpenBnB-compatible server.
 *
 * Two callers, one derivation. The settings page runs this through the
 * `register_client` action, so an admin never needs a repo checkout, a Node install or
 * a terminal; `scripts/register-oauth-client.mjs` runs the same code for scripted and
 * CI installs. They MUST agree on the redirect URI, because OAuth compares redirect
 * URIs exactly — a derivation that differs by a trailing slash or a dropped subpath
 * does not fail at registration, it fails months later as a traveller's sign-in that
 * never completes, with nothing on screen tying it back to this step.
 *
 * The plugin cannot store what it learns here: `ctx.config` is read-only, and the
 * host's OAuth broker reads these values straight out of the encrypted instance
 * config. So this returns values for a human to paste, and deliberately keeps no copy
 * of the secret anywhere.
 */

const PLUGIN_ID = 'airbnb-mcp';
const DEFAULT_ISSUER = 'https://mcp.openbnb.ai';
const TIMEOUT_MS = 20000;

/** Discovery and registration are one round trip each; a slow server is not a hung one. */
function withTimeout() {
  return AbortSignal.timeout(TIMEOUT_MS);
}

/**
 * The exact URI TREK will redirect to, derived the way TREK derives it.
 *
 * TREK builds `${getAppUrl()}/api/plugin-oauth/<id>/callback`, and getAppUrl() is
 * APP_URL with trailing slashes stripped — PATH INCLUDED. Taking the URL's origin here
 * would silently drop a subpath (https://example.com/trek), which is precisely the
 * mismatch that surfaces as a broken sign-in much later.
 */
function redirectUriFor(appUrl, pluginId = PLUGIN_ID) {
  const raw = String(appUrl || '').trim();
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(
      'Set "This TREK server\'s URL" to the address your users reach TREK on, e.g. https://trek.example.com',
    );
  }
  const isLocal = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  if (parsed.protocol !== 'https:' && !isLocal) {
    throw new Error('TREK must be reachable over https (or be localhost) for the OAuth redirect to work.');
  }
  // Mirror getAppUrl() on the RAW string rather than on the parsed URL: URL parsing
  // normalises away exactly the trailing-slash detail this is trying to preserve.
  return `${raw.replace(/\/+$/, '')}/api/plugin-oauth/${pluginId}/callback`;
}

/**
 * The authorization server to register with, derived from the configured MCP endpoint.
 *
 * An operator running their own OpenBnB registers against THEIR server, not against
 * the hosted one — otherwise they would be handed credentials for somebody else's
 * service. A blank or unusable endpoint means "use the hosted service", the same
 * fallback mcpUrl() makes.
 */
function issuerFor(mcpUrl) {
  try {
    const u = new URL(String(mcpUrl || ''));
    return u.protocol === 'https:' ? u.origin : DEFAULT_ISSUER;
  } catch {
    return DEFAULT_ISSUER;
  }
}

/** RFC 8414 authorization-server metadata. */
async function discover(issuer, fetchImpl) {
  const url = `${issuer}/.well-known/oauth-authorization-server`;
  let res;
  try {
    res = await fetchImpl(url, { signal: withTimeout() });
  } catch (err) {
    throw new Error(
      `Could not reach ${issuer} to discover its OAuth endpoints — ${(err && err.message) || 'no answer'}.`,
    );
  }
  if (!res.ok) throw new Error(`Discovery at ${url} returned ${res.status}.`);
  try {
    return JSON.parse(await res.text());
  } catch {
    throw new Error(`Discovery at ${url} did not return JSON.`);
  }
}

/**
 * Register this TREK instance as a confidential OAuth client (RFC 7591).
 *
 * `fetchImpl` is injected so the unit tests can script the network without touching
 * the global; production passes nothing and gets the platform fetch.
 */
async function registerClient({ appUrl, mcpUrl, issuer, fetchImpl = globalThis.fetch }) {
  const redirectUri = redirectUriFor(appUrl);
  const base = (issuer || issuerFor(mcpUrl)).replace(/\/+$/, '');
  const meta = await discover(base, fetchImpl);

  if (!meta.registration_endpoint) {
    throw new Error(
      `${base} does not advertise a dynamic registration endpoint, so a client has to be created by hand there.`,
    );
  }
  if (!meta.authorization_endpoint || !meta.token_endpoint) {
    throw new Error(`${base} did not advertise both an authorize and a token endpoint.`);
  }
  // A server is allowed to advertise a relative endpoint; resolve before calling it.
  const registrationUrl = new URL(meta.registration_endpoint, `${base}/`).toString();

  let res;
  try {
    res = await fetchImpl(registrationUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: `TREK (${new URL(appUrl).hostname})`,
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        // TREK's broker always sends a client_secret, so a PKCE-only public client is
        // useless here — ask for a confidential one explicitly.
        token_endpoint_auth_method: 'client_secret_post',
      }),
      signal: withTimeout(),
    });
  } catch (err) {
    throw new Error(`Registration at ${registrationUrl} failed — ${(err && err.message) || 'no answer'}.`);
  }

  const text = await res.text();
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`Registration returned ${res.status}: ${text.slice(0, 300)}`);
  }
  let client;
  try {
    client = JSON.parse(text);
  } catch {
    throw new Error('Registration did not return JSON.');
  }
  if (!client.client_id) throw new Error('Registration returned no client id.');
  if (!client.client_secret) {
    throw new Error(
      'That server issued a PUBLIC client with no secret. TREK\'s OAuth broker requires a confidential client.',
    );
  }

  return {
    clientId: client.client_id,
    clientSecret: client.client_secret,
    authorizeUrl: meta.authorization_endpoint,
    tokenUrl: meta.token_endpoint,
    redirectUri,
  };
}

module.exports = { redirectUriFor, issuerFor, discover, registerClient, DEFAULT_ISSUER, PLUGIN_ID };
