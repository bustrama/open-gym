// The stdio entry point, end to end: spawned the way an LLM client spawns it, walked through the
// handshake. Pins index.js now that the tool registration it used to do lives in server.js.
import { test, expect } from 'vitest'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { TOOLS } from '../src/tools.js'
import { READ_TOOLS } from '../src/edit-tools.js'

const INDEX_JS = fileURLToPath(new URL('../src/index.js', import.meta.url))

test('stdio: initialize, then tools/list serves every tool', async () => {
  // An empty data dir and a named profile with nothing synced yet: the server still starts and
  // lists its tools, which is the fail-soft start index.js promises.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opengym-mcp-'))
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('OPENGYM_')))
  const child = spawn(process.execPath, [INDEX_JS], {
    env: { ...env, OPENGYM_DATA: dir, OPENGYM_UID: 'stdio-test' },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  try {
    const reply = await new Promise((resolve, reject) => {
      let buf = ''
      child.stdout.on('data', d => {
        buf += d
        for (const line of buf.split('\n')) {
          try { const m = JSON.parse(line); if (m.id === 2) resolve(m) } catch { /* partial line */ }
        }
      })
      child.on('error', reject)
      child.on('exit', code => reject(new Error(`stdio server exited early (${code})`)))
      const send = m => child.stdin.write(JSON.stringify(m) + '\n')
      send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '0' } } })
      send({ jsonrpc: '2.0', method: 'notifications/initialized' })
      send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    })
    // A read-only server: the read tools and nothing that writes.
    expect(reply.result.tools.map(t => t.name).sort()).toEqual([...TOOLS, ...READ_TOOLS].map(t => t.name).sort())
  } finally {
    child.kill()
    fs.rmSync(dir, { recursive: true, force: true })
  }
}, 15000)
