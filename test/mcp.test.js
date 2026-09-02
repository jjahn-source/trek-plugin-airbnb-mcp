'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { McpClient, McpError, extractToolPayload, parseBody } = require('../server/mcp');

/** Build a fetch stub that records requests and replays canned responses. */
function stubFetch(responses) {
  const calls = [];
  const queue = [...responses];
  const impl = async (url, init) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
    const next = queue.shift();
    if (!next) throw new Error('stubFetch: no response queued');
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      headers: { get: (k) => (next.headers || {})[k.toLowerCase()] ?? null },
      text: async () => next.body ?? '',
    };
  };
  impl.calls = calls;
  return impl;
}

const JSON_CT = { 'content-type': 'application/json' };
const SSE_CT = { 'content-type': 'text/event-stream' };

test('parseBody reads plain JSON', () => {
  assert.deepEqual(parseBody('application/json', '{"id":1,"result":{"ok":true}}'), { id: 1, result: { ok: true } });
});

test('parseBody takes the JSON-RPC frame out of an SSE stream, ignoring notifications', () => {
  const sse = [
    'event: message',
    'data: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}',
    '',
    'event: message',
    'data: {"jsonrpc":"2.0","id":2,"result":{"content":[]}}',
    '',
  ].join('\n');
  assert.deepEqual(parseBody('text/event-stream', sse), { jsonrpc: '2.0', id: 2, result: { content: [] } });
});

test('parseBody survives a malformed frame ahead of the real one', () => {
  const sse = 'data: not-json\ndata: {"id":7,"result":{"ok":1}}\n';
  assert.deepEqual(parseBody('text/event-stream', sse), { id: 7, result: { ok: 1 } });
});

test('parseBody throws when a stream carries no JSON-RPC response', () => {
  assert.throws(() => parseBody('text/event-stream', 'data: {"method":"x"}\n'), /no JSON-RPC frame/);
});

test('connect captures the session id and sends the initialized notification', async () => {
  const fetchImpl = stubFetch([
    { status: 200, headers: { ...JSON_CT, 'mcp-session-id': 'sess-123' }, body: '{"id":1,"result":{"protocolVersion":"2025-06-18"}}' },
    { status: 202, headers: {}, body: '' },
    { status: 200, headers: JSON_CT, body: '{"id":2,"result":{"tools":[{"name":"airbnb_search"},{"name":"airbnb_listing"}]}}' },
  ]);
  const c = new McpClient({ url: 'https://mcp.test/mcp', token: 'tok', fetchImpl });
  await c.connect();

  assert.equal(c.sessionId, 'sess-123');
  assert.equal(fetchImpl.calls.length, 3, 'initialize, initialized, tools/list');
  assert.deepEqual([...c.tools].sort(), ['airbnb_listing', 'airbnb_search']);
  assert.equal(fetchImpl.calls[0].body.method, 'initialize');
  assert.equal(fetchImpl.calls[0].init.headers.authorization, 'Bearer tok');
  // The notification must carry the session and have no id (it is not a request).
  assert.equal(fetchImpl.calls[1].body.method, 'notifications/initialized');
  assert.equal(fetchImpl.calls[1].body.id, undefined);
  assert.equal(fetchImpl.calls[1].init.headers['mcp-session-id'], 'sess-123');
});

test('a 401 surfaces as an UNAUTHORIZED McpError so the route can prompt a reconnect', async () => {
  const fetchImpl = stubFetch([{ status: 401, headers: JSON_CT, body: '{"error":"invalid_token"}' }]);
  const c = new McpClient({ url: 'https://mcp.test/mcp', token: 'stale', fetchImpl });
  await assert.rejects(() => c.connect(), (err) => err instanceof McpError && err.code === 'UNAUTHORIZED');
});

test('a JSON-RPC error becomes a throw, not a silent empty result', async () => {
  const fetchImpl = stubFetch([
    { status: 200, headers: JSON_CT, body: '{"id":1,"result":{}}' },
    { status: 202, headers: {}, body: '' },
    { status: 200, headers: JSON_CT, body: '{"id":2,"result":{"tools":[{"name":"airbnb_search"},{"name":"airbnb_listing"}]}}' },
    { status: 200, headers: JSON_CT, body: '{"id":3,"error":{"code":-32602,"message":"bad args"}}' },
  ]);
  const c = new McpClient({ url: 'https://mcp.test/mcp', token: 't', fetchImpl });
  await c.connect();
  await assert.rejects(() => c.callTool('airbnb_search', {}), /bad args/);
});

test('extractToolPayload prefers structuredContent', () => {
  assert.deepEqual(extractToolPayload({ structuredContent: { a: 1 }, content: [] }), { a: 1 });
});

test('extractToolPayload parses JSON out of a text block', () => {
  const r = extractToolPayload({ content: [{ type: 'text', text: '{"searchResults":[]}' }] });
  assert.deepEqual(r, { searchResults: [] });
});

test('extractToolPayload turns isError into a throw carrying the message', () => {
  assert.throws(
    () => extractToolPayload({ isError: true, content: [{ type: 'text', text: 'robots.txt disallowed' }] }),
    /robots\.txt disallowed/,
  );
});

test('extractToolPayload returns non-JSON text rather than guessing', () => {
  assert.deepEqual(extractToolPayload({ content: [{ type: 'text', text: 'plain words' }] }), { text: 'plain words' });
});

test('close() terminates the session with a DELETE carrying the session id', async () => {
  const fetchImpl = stubFetch([
    { status: 200, headers: { ...JSON_CT, 'mcp-session-id': 'sess-9' }, body: '{"id":1,"result":{}}' },
    { status: 202, headers: {}, body: '' },
    { status: 200, headers: JSON_CT, body: '{"id":2,"result":{"tools":[{"name":"airbnb_search"},{"name":"airbnb_listing"}]}}' },
    { status: 200, headers: {}, body: '' },
  ]);
  const c = new McpClient({ url: 'https://mcp.test/mcp', token: 'tok', fetchImpl });
  await c.connect();
  await c.close();

  const del = fetchImpl.calls[3];
  assert.equal(del.init.method, 'DELETE');
  assert.equal(del.init.headers['mcp-session-id'], 'sess-9');
  assert.equal(del.init.headers.authorization, 'Bearer tok');
  assert.equal(c.sessionId, null, 'the client forgets the session it gave back');
});

test('close() is a no-op when no session was ever established', async () => {
  const fetchImpl = stubFetch([]);
  const c = new McpClient({ url: 'https://mcp.test/mcp', token: 't', fetchImpl });
  await c.close();
  assert.equal(fetchImpl.calls.length, 0);
});

test('close() never throws, even when the server refuses termination', async () => {
  const fetchImpl = stubFetch([
    { status: 200, headers: { ...JSON_CT, 'mcp-session-id': 's' }, body: '{"id":1,"result":{}}' },
    { status: 202, headers: {}, body: '' },
    { status: 200, headers: JSON_CT, body: '{"id":2,"result":{"tools":[{"name":"airbnb_search"},{"name":"airbnb_listing"}]}}' },
  ]);
  const c = new McpClient({ url: 'https://mcp.test/mcp', token: 't', fetchImpl });
  await c.connect();
  // No response queued, so the stub throws, like a server that answers 405, or none at all.
  await c.close();
  assert.equal(c.sessionId, null);
});

/**
 * A gateway in front of the MCP endpoint answers a 502 with an HTML error page and a
 * non-SSE content type. The SSE branch already tolerates a frame that will not parse;
 * the plain-JSON branch threw a bare SyntaxError, which is not an McpError, so it
 * sailed past friendlyError() and put "Unexpected token '<'" on a traveller's screen.
 */
test('parseBody turns a non-JSON body into an McpError, not a raw SyntaxError', () => {
  const html = '<!doctype html><html><body>502 Bad Gateway</body></html>';
  assert.throws(
    () => parseBody('text/html', html),
    (err) => {
      assert.ok(err instanceof McpError, `expected McpError, got ${err.name}`);
      assert.doesNotMatch(err.message, /Unexpected token/, 'the parser error must not be the message');
      return true;
    },
  );
});
