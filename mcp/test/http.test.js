// HTTP transport tests for mcp/src/http.js. The tools themselves are pinned in tools.test.js;
// here we pin what the transport adds on top: auth that fails closed, the stateless POST-only
// contract, and that an authorized client gets exactly the tools the stdio transport serves.
import { describe, beforeAll, afterAll, test, expect } from 'vitest'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { buildDemoState } from '../../frontend/src/lib/demoSeed.js'
import { _seedStateForTests } from '../src/state.js'
import { TOOLS } from '../src/tools.js'
import { READ_TOOLS } from '../src/edit-tools.js'
import { createJournal } from '../src/journal.js'
import { createHttpServer, MAX_BODY } from '../src/http.js'

const TOKEN = 'test-token-0123456789abcdef'
const INIT = {
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '0' } }
}

let srv = null
let base = ''

beforeAll(async () => {
  _seedStateForTests(buildDemoState())
  srv = createHttpServer({ token: TOKEN })
  await new Promise(resolve => srv.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${srv.address().port}`
})

afterAll(async () => {
  srv.closeAllConnections()
  await new Promise(resolve => srv.close(resolve))
})

// A client the way the MCP spec shapes one: JSON body, and an Accept that allows both answer forms.
function post(body, { token = TOKEN, path = '/mcp' } = {}) {
  return fetch(base + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(body)
  })
}

// Straight onto the socket, for request-targets fetch would refuse to send.
function rawRequest(text) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(srv.address().port, '127.0.0.1', () => sock.write(text))
    let data = ''
    sock.on('data', d => { data += d })
    sock.on('end', () => resolve(data))
    sock.on('error', reject)
  })
}

describe('createHttpServer', () => {
  test('refuses to build without a token — no token means no server, not an open one', () => {
    expect(() => createHttpServer({})).toThrow(/OPENGYM_MCP_TOKEN/)
    expect(() => createHttpServer({ token: '' })).toThrow(/OPENGYM_MCP_TOKEN/)
  })

  test('refuses a token too short to be a secret', () => {
    expect(() => createHttpServer({ token: 'short' })).toThrow(/OPENGYM_MCP_TOKEN/)
  })
})

describe('auth', () => {
  test('no Authorization header → 401 with a JSON-RPC error', async () => {
    const r = await post(INIT, { token: null })
    expect(r.status).toBe(401)
    expect(r.headers.get('www-authenticate')).toMatch(/^Bearer/)
    const j = await r.json()
    expect(j.error.message).toMatch(/unauthorized/)
  })

  test('wrong token → 401', async () => {
    const r = await post(INIT, { token: TOKEN + 'x' })
    expect(r.status).toBe(401)
  })

  test('a non-Bearer scheme carrying the right secret → 401', async () => {
    const r = await fetch(base + '/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Basic ${TOKEN}` },
      body: JSON.stringify(INIT)
    })
    expect(r.status).toBe(401)
  })

  test('the health check answers without a token and says nothing about the data', async () => {
    const r = await fetch(base + '/healthz')
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ ok: true })
  })

  test('any other path → 404, before auth is even consulted', async () => {
    const r = await post(INIT, { path: '/elsewhere', token: null })
    expect(r.status).toBe(404)
  })

  test('a spelling that only normalises to /mcp is not /mcp, token or no token', async () => {
    // Over the raw socket: fetch would normalise /./mcp itself before it ever left the client.
    const body = JSON.stringify(INIT)
    for (const p of ['//mcp', '/./mcp', '/mcp/', '/%6dcp']) {
      const reply = await rawRequest(
        `POST ${p} HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${TOKEN}\r\nContent-Type: application/json\r\n` +
        `Accept: application/json, text/event-stream\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`
      )
      expect(reply, p).toMatch(/^HTTP\/1\.1 404/)
    }
  })

  test('a request-target that is not a path gets an answer, and the server stays up', async () => {
    // Once a pre-auth crash: `new URL()` threw on these outside any try, and the process died.
    for (const target of ['//a:b/', 'http://a:b/']) {
      const reply = await rawRequest(`GET ${target} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`)
      expect(reply, target).toMatch(/^HTTP\/1\.1 404/)
    }
    const r = await fetch(base + '/healthz')
    expect(r.status).toBe(200)
  })

  test('auth comes before the body: malformed JSON without a token → 401, not 400', async () => {
    const r = await fetch(base + '/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: '{not json'
    })
    expect(r.status).toBe(401)
  })

  test('GET /mcp with a valid token → 405: stateless, so there is no stream to open', async () => {
    const r = await fetch(base + '/mcp', { headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'text/event-stream' } })
    expect(r.status).toBe(405)
    expect(r.headers.get('allow')).toBe('POST')
  })
})

describe('MCP over HTTP', () => {
  test('initialize answers with the openGym server info, as plain JSON', async () => {
    const r = await post(INIT)
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toMatch(/application\/json/)
    const j = await r.json()
    expect(j.id).toBe(1)
    expect(j.result.serverInfo.name).toBe('opengym')
  })

  test('tools/list serves every tool the stdio transport does — and no write tool without a writer', async () => {
    const r = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    expect(r.status).toBe(200)
    const j = await r.json()
    const names = j.result.tools.map(t => t.name).sort()
    expect(names).toEqual([...TOOLS, ...READ_TOOLS].map(t => t.name).sort())
    expect(names).not.toContain('log_bodyweight')
  })

  test('with a writer, the write tools are listed too', async () => {
    const stub = { journal: createJournal({ dir: null }), read: async () => ({}), commit: async () => ({}) }
    const w = createHttpServer({ token: TOKEN, writer: stub })
    await new Promise(resolve => w.listen(0, '127.0.0.1', resolve))
    try {
      const r = await fetch(`http://127.0.0.1:${w.address().port}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list' })
      })
      const names = (await r.json()).result.tools.map(t => t.name)
      for (const n of ['log_bodyweight', 'set_week_plan', 'set_day_override', 'update_settings', 'undo_last_change', 'create_routine', 'update_routine', 'delete_routine', 'reorder_routines']) expect(names).toContain(n)
    } finally {
      w.closeAllConnections()
      await new Promise(resolve => w.close(resolve))
    }
  })

  test('tools/call runs the tool against the profile state', async () => {
    const r = await post({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_bodyweight', arguments: {} } })
    expect(r.status).toBe(200)
    const j = await r.json()
    expect(j.result.isError).toBeFalsy()
    const data = JSON.parse(j.result.content[0].text)
    expect(data.unit).toBe('kg')
    expect(data.count).toBeGreaterThan(0)
    expect(data.latest).toHaveProperty('weight')
  })

  test('malformed JSON with a token → 400 with a JSON-RPC parse error', async () => {
    const r = await fetch(base + '/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${TOKEN}` },
      body: '{not json'
    })
    expect(r.status).toBe(400)
    expect((await r.json()).error.code).toBe(-32700)
  })

  test('a body declared past the cap → 413, without reading it', async () => {
    const r = await post({ jsonrpc: '2.0', id: 5, method: 'tools/list', params: { pad: 'x'.repeat(MAX_BODY) } })
    expect(r.status).toBe(413)
  })

  test('a chunked body that grows past the cap → 413, without buffering it', async () => {
    const status = await new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port: srv.address().port, path: '/mcp', method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${TOKEN}` }
      }, res => { res.resume(); resolve(res.statusCode) })
      req.on('error', reject)
      const chunk = Buffer.alloc(64 * 1024, 0x20)
      for (let i = 0; i < 20; i++) req.write(chunk)   // 1.25 MiB, no Content-Length: chunked
      req.end()
    })
    expect(status).toBe(413)
  })

  test('a tool that fails comes back as an MCP tool error, not a transport error', async () => {
    const r = await post({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'get_routine', arguments: { routine_id: 'no-such-routine' } } })
    expect(r.status).toBe(200)
    const j = await r.json()
    expect(j.result.isError).toBe(true)
    expect(j.result.content[0].text).toMatch(/^ENOENT: /)
  })
})

describe('node src/http.js', () => {
  const HTTP_JS = fileURLToPath(new URL('../src/http.js', import.meta.url))
  // The parent's environment minus anything openGym, so each case sets exactly what it tests.
  const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('OPENGYM_')))
  // A start that wrongly got as far as listening is caught by the timeout: status is then null.
  const start = env => spawnSync(process.execPath, [HTTP_JS], {
    env: { ...baseEnv, OPENGYM_DATA: os.tmpdir(), OPENGYM_MCP_PORT: '0', ...env },
    encoding: 'utf8',
    timeout: 10000
  })

  test('exits non-zero without a token, instead of serving without one', () => {
    const r = start({ OPENGYM_UID: 'someone' })
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/OPENGYM_MCP_TOKEN/)
  })

  test('exits non-zero without OPENGYM_UID, even with a token', () => {
    const r = start({ OPENGYM_MCP_TOKEN: TOKEN })
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/OPENGYM_UID/)
  })
})
