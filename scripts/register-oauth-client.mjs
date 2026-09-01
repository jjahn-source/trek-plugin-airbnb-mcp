#!/usr/bin/env node
/**
 * Register this TREK instance as an OAuth client of the OpenBnB MCP server, from a
 * terminal.
 *
 * Most admins should not need this: the plugin's own settings page has a **Register
 * with OpenBnB** button that does exactly the same thing, and someone who installed
 * this from the registry has no repo to run a script in. This is the scripted path —
 * for provisioning, CI, or an operator who would rather watch it happen in a shell.
 *
 * Both paths call the SAME module, deliberately. OAuth compares redirect URIs exactly,
 * so two derivations differing by a trailing slash or a dropped subpath would not fail
 * here — they would fail months later, as a sign-in that never completes.
 *
 * Usage:
 *   node scripts/register-oauth-client.mjs https://trek.example.com [issuer]
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { registerClient, redirectUriFor, DEFAULT_ISSUER } = require('../server/register.js');

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

  You do not need this script at all if you can reach the plugin's settings page:
  Admin -> Plugins -> Airbnb Stays -> Instance settings has a "Register with
  OpenBnB" button that does the same thing.
`);
  process.exit(appUrl ? 0 : 1);
}

// Fail on a bad URL before touching the network, and print the URI about to be
// registered so the operator can check it against their APP_URL while it still
// costs nothing to get wrong.
let redirectUri;
try {
  redirectUri = redirectUriFor(appUrl);
} catch (err) {
  die(err.message);
}

console.log(`\n  Registering redirect URI:\n    ${redirectUri}\n`);

let out;
try {
  out = await registerClient({ appUrl, issuer });
} catch (err) {
  die(err.message);
}

console.log(`  Registered.

  Paste these into TREK -> Admin -> Plugins -> Airbnb Stays -> Instance settings
  (on an older TREK with no such menu, send them to the admin API — see the README):

    OAuth authorize URL   ${out.authorizeUrl}
    OAuth token URL       ${out.tokenUrl}
    OAuth client id       ${out.clientId}
    OAuth client secret   ${out.clientSecret}

  The form shows the two URLs as greyed-out placeholder text. That is a hint, not a
  value — type them in, or the fields save empty.

  Keep the secret out of version control. Each traveller then connects their own
  OpenBnB account under Settings -> Plugins -> Airbnb Stays -> Connect.
`);
