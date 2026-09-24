#!/usr/bin/env node
/* openGym MCP server — Streamable HTTP transport, for an LLM client on another machine (the
   stdio transport in index.js needs the client on this box). Same tools, same read-only data.

   Stateless: every POST /mcp gets a fresh server + transport, so there is no session to leak,
   expire or lose on restart. Answers are plain JSON rather than an SSE stream, which is what
   survives proxies (a Cloudflare Tunnel, nginx) that buffer text/event-stream.

   Fails closed. It refuses to start without OPENGYM_MCP_TOKEN, and without OPENGYM_UID: a remote
   client is answered for one named profile, never for whichever state file happens to exist.
   Every /mcp request must carry `Authorization: Bearer <token>`. Put an auth proxy in front as
   well (Cloudflare Access with a service token, say) — what sits behind this is a body-weight
   log and a training history, and one secret between that and the internet is one too few. */
import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { createMcpServer } from './server.js'
import { init, getUser } from './state.js'
import { writerFromEnv } from './writes.js'

const MIN_TOKEN = 16
// One JSON-RPC message — an MCP request is a few hundred bytes. nginx's /mcp block caps the same.
export const MAX_BODY = 1024 * 1024

const digest = s => crypto.createHash('sha256').update(String(s)).digest()

// Compare digests, not the strings: timingSafeEqual needs equal lengths, and hashing first
// means neither the token's length nor its content leaks through response timing.
function authorized(req, tokenDigest) {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.authorization || '')
  return !!m && crypto.timingSafeEqual(digest(m[1]), tokenDigest)
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers })
  res.end(JSON.stringify(body))
}

// Refusals shaped as JSON-RPC errors, which is what an MCP client knows how to surface.
const rpcError = (res, status, code, message, headers) =>
  send(res, status, { jsonrpc: '2.0', error: { code, message }, id: null }, headers)

// The body, capped: resolves null once it passes `limit`. Past the cap nothing more is kept, but
// the rest is still read and dropped, so the client gets its 413 rather than a reset mid-upload.
// The SDK is then handed the parsed message instead of buffering an upload of any size itself.
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', chunk => {
      size += chunk.length
      if (size <= limit) chunks.push(chunk)
    })
    req.on('end', () => resolve(size > limit ? null : Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

// `writer` is shared by every request: it holds the one-write-at-a-time chain and the undo
// history, so it lives as long as the process, not as long as a request's server.
export function createHttpServer({ token, path = '/mcp', writer = null } = {}) {
  if (!token || String(token).length < MIN_TOKEN) {
    throw new Error(`OPENGYM_MCP_TOKEN must be set to a secret of at least ${MIN_TOKEN} characters — the HTTP transport will not serve without one`)
  }
  const tokenDigest = digest(token)

  async function handle(req, res) {
    // An exact string match, no URL parsing: nothing a client puts in the request-target can
    // throw here, and no spelling that merely normalises to the path (//mcp, /./mcp) gets in.
    const pathname = (req.url || '').split('?')[0]
    // For a container healthcheck: says the process is up, and nothing else.
    if (pathname === '/healthz' && req.method === 'GET') return send(res, 200, { ok: true })
    if (pathname !== path) return send(res, 404, { error: 'not found' })
    if (!authorized(req, tokenDigest)) return rpcError(res, 401, -32001, 'unauthorized', { 'WWW-Authenticate': 'Bearer' })
    // GET would open a server-to-client stream and DELETE would end a session; a stateless
    // server has neither.
    if (req.method !== 'POST') return rpcError(res, 405, -32000, 'method not allowed — this server is stateless, POST only', { Allow: 'POST' })

    if (Number(req.headers['content-length']) > MAX_BODY) {
      req.resume()
      return rpcError(res, 413, -32600, 'request body too large')
    }
    const raw = await readBody(req, MAX_BODY)
    if (raw === null) return rpcError(res, 413, -32600, 'request body too large')
    let message
    try { message = JSON.parse(raw.toString('utf8')) } catch { return rpcError(res, 400, -32700, 'parse error') }

    const server = createMcpServer({ writer })
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    res.on('close', () => { transport.close(); server.close() })
    await server.connect(transport)
    await transport.handleRequest(req, res, message)
  }

  // Nothing thrown while handling one request may take the process down with it.
  return http.createServer((req, res) => {
    handle(req, res).catch(err => {
      console.error(`[opengym-mcp] ${err.message}`)
      if (!res.headersSent) rpcError(res, 500, -32603, 'internal error')
      else res.destroy()
    })
  })
}

// Started directly (`node src/http.js`), not imported by the tests. Both sides through realpath,
// so a start through a symlink is still recognised as one instead of exiting silently.
function isEntryPoint() {
  try {
    return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isEntryPoint()) {
  const port = +(process.env.OPENGYM_MCP_PORT || 8765)
  let server
  try {
    if (!(process.env.OPENGYM_UID || '').trim()) {
      throw new Error('OPENGYM_UID must be set — the HTTP transport answers for one named profile (its id is under "users" in data/db.json)')
    }
    server = createHttpServer({ token: process.env.OPENGYM_MCP_TOKEN, writer: writerFromEnv() })
  } catch (e) {
    console.error(`[opengym-mcp] ${e.message}`)
    process.exit(1)
  }
  // Same fail-soft start as stdio: a profile with no synced state yet is reported, and every
  // tool call retries it, so the first sync from a device is picked up without a restart.
  try {
    init()
    const u = getUser()
    console.error(`[opengym-mcp] serving profile ${u.name} (${u.id})`)
  } catch (e) {
    console.error(`[opengym-mcp] ${e.message}`)
  }
  server.listen(port, () => console.error(`[opengym-mcp] Streamable HTTP on :${port}/mcp (${process.env.OPENGYM_MCP_WRITE ? 'read + write' : 'read-only'})`))
  // PID 1 in a container gets no default signal handling; without these `docker stop` waits
  // out its timeout and then kills.
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => server.close(() => process.exit(0)))
}
