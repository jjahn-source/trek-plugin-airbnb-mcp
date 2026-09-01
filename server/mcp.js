'use strict';

/**
 * Minimal Streamable-HTTP MCP client — just enough of the transport to call two
 * tools on the hosted OpenBnB server.
 *
 * We do not use @modelcontextprotocol/sdk on purpose: a TREK plugin ships as a
 * flat CommonJS bundle with no install step on the host, so a dependency-free
 * transport is worth more here than the SDK's generality. The protocol surface
 * we need is small and stable — initialize, notifications/initialized, tools/call.
 */

const PROTOCOL_VERSION = '2025-06-18';
const DEFAULT_TIMEOUT_MS = 20000;

/**
 * A response body is either plain JSON or an SSE stream carrying one `data:` JSON
 * frame per message. Servers pick per request, so both have to be handled: read
 * the whole body and branch on content-type.
 */
function parseBody(contentType, text) {
  if (!contentType.includes('text/event-stream')) {
    // A gateway in front of the endpoint answers a 502 with an HTML error page and a
    // non-SSE content type. A bare SyntaxError from here is not an McpError, so it
    // slips past friendlyError() and reaches the traveller as "Unexpected token '<'".
    // The SSE branch below already tolerates a frame that will not parse; so must this.
    try {
      return JSON.parse(text);
    } catch {
      throw new McpError('OpenBnB answered with something that was not JSON', 'RPC');
    }
  }
  // Take the LAST data: frame that parses as a JSON-RPC response — a stream may
  // interleave progress notifications ahead of the actual result.
  let found = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload) continue;
    try {
      const msg = JSON.parse(payload);
      if (msg && Object.hasOwn(msg, 'id')) found = msg;
    } catch {
      /* a partial or non-JSON frame is not fatal — keep scanning */
    }
  }
  if (!found) throw new Error('MCP: no JSON-RPC frame in event stream');
  return found;
}

class McpError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'McpError';
    this.code = code;
  }
}

class McpClient {
  /**
   * @param {object} opts
   * @param {string} opts.url        MCP endpoint
   * @param {string} opts.token      Bearer access token for the acting user
   * @param {typeof fetch} [opts.fetchImpl]
   * @param {number} [opts.timeoutMs]
   */
  constructor({ url, token, fetchImpl, timeoutMs }) {
    this.url = url;
    this.token = token;
    this.fetch = fetchImpl || globalThis.fetch;
    this.timeoutMs = timeoutMs || DEFAULT_TIMEOUT_MS;
    this.sessionId = null;
    this.nextId = 1;
    /** Tool names the server advertises, filled in by connect(). */
    this.tools = new Set();
  }

  /** Whether the connected server offers this tool. Empty set = we never asked. */
  hasTool(name) {
    return this.tools.size === 0 || this.tools.has(name);
  }

  /** The first of `names` the server offers, else the first name as a guess. */
  pickTool(names) {
    for (const n of names) if (this.tools.has(n)) return n;
    return names[0];
  }

  async send(method, params, { notification = false } = {}) {
    const body = notification
      ? { jsonrpc: '2.0', method, params }
      : { jsonrpc: '2.0', id: this.nextId++, method, params };

    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${this.token}`,
      'mcp-protocol-version': PROTOCOL_VERSION,
    };
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId;

    const res = await this.fetch(this.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    // The session id is minted on initialize and echoed on every later call.
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;

    if (res.status === 401 || res.status === 403) {
      throw new McpError('OpenBnB rejected the access token', 'UNAUTHORIZED');
    }
    // A notification gets 202 Accepted and an empty body.
    if (notification) return null;
    if (!res.ok) {
      throw new McpError(`OpenBnB MCP returned ${res.status}`, 'UPSTREAM');
    }

    const text = await res.text();
    const msg = parseBody(res.headers.get('content-type') || '', text);
    if (msg.error) {
      throw new McpError(msg.error.message || 'MCP error', 'RPC');
    }
    return msg.result;
  }

  /**
   * Terminate the session (MCP Streamable HTTP: DELETE with the session id).
   *
   * Without this, every evicted client abandons a live session for the server to
   * expire on its own — impolite to a shared hosted service and, over a long-lived
   * plugin process, a steady leak of them. Best-effort by design: a server that
   * does not support termination answers 405, and a failure here must never affect
   * the caller, which has already moved on to a new session.
   */
  async close() {
    if (!this.sessionId) return;
    const sessionId = this.sessionId;
    this.sessionId = null;
    try {
      await this.fetch(this.url, {
        method: 'DELETE',
        headers: {
          authorization: `Bearer ${this.token}`,
          'mcp-session-id': sessionId,
          'mcp-protocol-version': PROTOCOL_VERSION,
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      /* the session will expire on its own */
    }
  }

  async connect() {
    const result = await this.send('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'trek-airbnb-mcp', version: '1.0.0' },
    });
    // Per spec the server may not be ready for tool calls until it is told the
    // handshake completed. Failing to notify is not fatal on every server, but
    // skipping it breaks the strict ones.
    await this.send('notifications/initialized', {}, { notification: true });

    // Which tools exist differs between deployments: the hosted server offers
    // `airbnb_listing`, the open-source one `airbnb_listing_details`. Asking once
    // per session is cheaper than guessing wrong and burning a round trip on
    // "-32602 Tool not found".
    try {
      const listed = await this.send('tools/list', {});
      for (const t of (listed && listed.tools) || []) {
        if (t && typeof t.name === 'string') this.tools.add(t.name);
      }
    } catch {
      /* a server that will not list its tools still gets called with our defaults */
    }
    return result;
  }

  /** Call a tool and return its structured payload. */
  async callTool(name, args) {
    const result = await this.send('tools/call', { name, arguments: args });
    return extractToolPayload(result);
  }
}

/**
 * MCP tool results carry content blocks, not typed data. OpenBnB returns one
 * `text` block holding JSON, so parse it back; if it is not JSON we surface the
 * raw text rather than guessing, and `isError` becomes a real throw.
 */
function extractToolPayload(result) {
  if (!result || typeof result !== 'object') throw new McpError('empty tool result', 'RPC');
  if (result.structuredContent && typeof result.structuredContent === 'object') {
    return result.structuredContent;
  }
  const blocks = Array.isArray(result.content) ? result.content : [];
  const text = blocks
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim();

  if (result.isError) throw new McpError(text || 'tool reported an error', 'TOOL');
  if (!text) throw new McpError('tool returned no content', 'RPC');
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

module.exports = { McpClient, McpError, extractToolPayload, parseBody, PROTOCOL_VERSION };
