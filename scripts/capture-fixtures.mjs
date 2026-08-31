#!/usr/bin/env node
/**
 * Capture REAL responses from the hosted OpenBnB MCP server, for testing.
 *
 * The normalisers in server/normalize.js were written against the open-source
 * server's allow-schema. The hosted endpoint is a superset, so the shapes it
 * actually returns are an assumption until something checks them. This script
 * signs you in, calls both tools, and writes the raw payloads to
 * test/fixtures/hosted-*.json so the normalisers can be tested against reality.
 *
 * Your access token stays in this process. It is never printed and never written
 * to disk — only the listing data (which is public) is saved.
 *
 *   node scripts/capture-fixtures.mjs "Paris, France" 2026-10-10 2026-10-14
 */
import { createServer } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';

const ISSUER = 'https://mcp.openbnb.ai';
const MCP_URL = `${ISSUER}/mcp`;
const PORT = 8765;
const REDIRECT = `http://127.0.0.1:${PORT}/callback`;
const PROTOCOL_VERSION = '2025-06-18';

const location = process.argv[2] || 'Paris, France';
const checkin = process.argv[3] || null;
const checkout = process.argv[4] || null;

const b64url = (b) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const die = (m) => { console.error(`\n  Error: ${m}\n`); process.exit(1); };

console.log('\n  Discovering the authorization server…');
const meta = await (await fetch(`${ISSUER}/.well-known/oauth-authorization-server`)).json();

console.log('  Registering a throwaway client for this capture…');
const reg = await (await fetch(new URL(meta.registration_endpoint, `${ISSUER}/`), {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    client_name: 'TREK airbnb-mcp fixture capture (local, throwaway)',
    redirect_uris: [REDIRECT],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'client_secret_post',
  }),
})).json();
if (!reg.client_id) die('registration failed');

const verifier = b64url(randomBytes(32));
const challenge = b64url(createHash('sha256').update(verifier).digest());
const state = b64url(randomBytes(16));

const authorize = new URL(meta.authorization_endpoint);
authorize.searchParams.set('response_type', 'code');
authorize.searchParams.set('client_id', reg.client_id);
authorize.searchParams.set('redirect_uri', REDIRECT);
authorize.searchParams.set('state', state);
authorize.searchParams.set('code_challenge', challenge);
authorize.searchParams.set('code_challenge_method', 'S256');

/** Wait for the browser to come back with ?code=… */
const code = await new Promise((resolve, reject) => {
  const server = createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    if (url.pathname !== '/callback') { res.writeHead(404).end(); return; }
    const got = url.searchParams.get('code');
    const err = url.searchParams.get('error');
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><meta charset="utf-8"><body style="font:16px system-ui;padding:3rem">
      <h2>${got ? 'Signed in — you can close this tab.' : 'Sign-in failed'}</h2>
      <p style="color:#666">${got ? 'Fixture capture is running in your terminal.' : err || ''}</p>`);
    server.close();
    if (url.searchParams.get('state') !== state) return reject(new Error('state mismatch'));
    got ? resolve(got) : reject(new Error(err || 'no code returned'));
  });
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`\n  Opening your browser to sign in to OpenBnB.`);
    console.log(`  If it does not open, paste this into a browser:\n\n  ${authorize}\n`);
    spawn('open', [authorize.toString()], { stdio: 'ignore', detached: true }).unref();
  });
  setTimeout(() => { server.close(); reject(new Error('timed out waiting for sign-in')); }, 5 * 60 * 1000);
});

console.log('  Exchanging the code for a token…');
const tok = await (await fetch(meta.token_endpoint, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    grant_type: 'authorization_code', code, redirect_uri: REDIRECT,
    code_verifier: verifier, client_id: reg.client_id, client_secret: reg.client_secret,
  }),
})).json();
if (!tok.access_token) die(`token exchange failed: ${JSON.stringify(tok).slice(0, 300)}`);
console.log('  Got a token (not printed, not saved).');

// --- talk to the MCP server ----------------------------------------------------
let sessionId = null;
let id = 0;
async function rpc(method, params, notify = false) {
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    authorization: `Bearer ${tok.access_token}`,
    'mcp-protocol-version': PROTOCOL_VERSION,
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;
  const res = await fetch(MCP_URL, {
    method: 'POST', headers,
    body: JSON.stringify(notify ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id: ++id, method, params }),
  });
  const sid = res.headers.get('mcp-session-id');
  if (sid) sessionId = sid;
  if (notify) return null;
  const text = await res.text();
  if (!res.ok) die(`${method} → HTTP ${res.status}: ${text.slice(0, 300)}`);
  if ((res.headers.get('content-type') || '').includes('text/event-stream')) {
    let last = null;
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      try { const m = JSON.parse(line.slice(5).trim()); if ('id' in m) last = m; } catch {}
    }
    if (!last) die(`${method}: no JSON-RPC frame`);
    return last;
  }
  return JSON.parse(text);
}

console.log('  Connecting to the MCP server…');
const init = await rpc('initialize', {
  protocolVersion: PROTOCOL_VERSION, capabilities: {},
  clientInfo: { name: 'trek-airbnb-mcp-capture', version: '1.0.0' },
});
await rpc('notifications/initialized', {}, true);

const tools = await rpc('tools/list', {});
const toolNames = (tools.result?.tools || []).map((t) => t.name);
console.log(`  Tools offered: ${toolNames.join(', ')}`);

const searchArgs = { location, adults: 2 };
if (checkin) searchArgs.checkin = checkin;
if (checkout) searchArgs.checkout = checkout;
console.log(`  Searching: ${JSON.stringify(searchArgs)}`);
const search = await rpc('tools/call', { name: 'airbnb_search', arguments: searchArgs });

/** Tool results carry content blocks; pull the JSON back out. */
function payloadOf(r) {
  const res = r.result;
  if (res?.structuredContent) return res.structuredContent;
  const text = (res?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  try { return JSON.parse(text); } catch { return { text }; }
}
const searchPayload = payloadOf(search);
const first = (searchPayload.searchResults || [])[0];
console.log(`  Got ${(searchPayload.searchResults || []).length} results.`);

// The hosted server names this `airbnb_listing`; the open-source one
// `airbnb_listing_details`. Ask, rather than guess — guessing wrong is exactly
// what produced a fixture containing "-32602 Tool not found".
const listingTool = ['airbnb_listing', 'airbnb_listing_details'].find((n) => toolNames.includes(n));
let listingPayload = null;
if (first?.id && listingTool) {
  console.log(`  Fetching details for listing ${first.id} via ${listingTool}…`);
  listingPayload = payloadOf(await rpc('tools/call', {
    name: listingTool, arguments: { id: String(first.id), ...(checkin ? { checkin } : {}), ...(checkout ? { checkout } : {}) },
  }));
  if (listingPayload && typeof listingPayload.text === 'string' && /error/i.test(listingPayload.text)) {
    console.error(`  ! ${listingTool} failed: ${listingPayload.text}`);
    listingPayload = null;
  }
} else if (!listingTool) {
  console.error(`  ! no listing tool offered; got: ${toolNames.join(', ')}`);
}

mkdirSync('test/fixtures', { recursive: true });
writeFileSync('test/fixtures/hosted-tools.json', JSON.stringify({ serverInfo: init.result?.serverInfo, tools: tools.result?.tools }, null, 2));
writeFileSync('test/fixtures/hosted-search.json', JSON.stringify(searchPayload, null, 2));
if (listingPayload) writeFileSync('test/fixtures/hosted-listing.json', JSON.stringify(listingPayload, null, 2));

console.log(`
  Wrote:
    test/fixtures/hosted-tools.json
    test/fixtures/hosted-search.json${listingPayload ? '\n    test/fixtures/hosted-listing.json' : ''}

  These contain public listing data only — no token, no account details.
  Hand them back to Claude and the normalisers can be checked against reality.
`);
