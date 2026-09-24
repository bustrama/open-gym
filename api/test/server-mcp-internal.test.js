/* The MCP's internal read/write routes (/internal/mcp/state): off unless all three of
   OPENGYM_MCP_WRITE, OPENGYM_MCP_API_TOKEN and OPENGYM_UID are set; bearer-token auth; one profile,
   fixed on the server's side; and the very same compare-and-write as a device's PUT /api/data.
   Real server.js in a child, like the other server-*.test.js files. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const API = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SECRET = crypto.randomBytes(32).toString('hex');
const TOKEN = 'mcp-test-token-0123456789';
const UID = 'u_mcp_1';
const OTHER = 'u_mcp_2';

function mintSession(uid, sv = 0) {
  const payload = `${uid}:${Date.now() + 86400000}:${sv}`;
  return payload + '.' + crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
}

const freePort = () => new Promise(r => {
  const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); });
});

async function startServer(t, env = {}, users = [{ id: UID, name: 'One' }, { id: OTHER, name: 'Two' }]) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-mcp-'));
  fs.writeFileSync(path.join(dataDir, 'secret'), SECRET, { mode: 0o600 });
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({
    users: users.map(u => ({ created: new Date().toISOString(), ...u })), creds: [], subs: [], invites: []
  }));
  const port = await freePort();
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('OPENGYM_')));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: API, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...clean, PORT: String(port), DATA_DIR: dataDir, ORIGIN: 'http://localhost:8080', RP_ID: 'localhost', ...env }
  });
  const h = { api: `http://127.0.0.1:${port}`, log: '', dataDir };
  child.stdout.on('data', d => h.log += d);
  child.stderr.on('data', d => h.log += d);
  t.after(() => { child.kill('SIGKILL'); fs.rmSync(dataDir, { recursive: true, force: true }); });
  let up = false;
  for (let i = 0; i < 100 && !up; i++) {
    try { up = (await fetch(`${h.api}/api/health`)).ok; } catch { /* not up yet */ }
    if (!up) await new Promise(r => setTimeout(r, 100));
  }
  assert.ok(up, `server never came up:\n${h.log}`);
  return h;
}

const ON = { OPENGYM_MCP_WRITE: '1', OPENGYM_MCP_API_TOKEN: TOKEN, OPENGYM_UID: UID };
const bearer = (tok = TOKEN) => ({ Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' });
async function call(h, method, body, headers = bearer()) {
  const r = await fetch(`${h.api}/internal/mcp/state`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}
const stateOf = (h, uid) => {
  try { return JSON.parse(fs.readFileSync(path.join(h.dataDir, `state-${uid}.json`), 'utf8')); } catch { return null; }
};
const auditOf = h => {
  try { return fs.readFileSync(path.join(h.dataDir, 'audit.log'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; }
};

test('off by default: both routes are 404 even with the right token', async t => {
  const h = await startServer(t);
  assert.equal((await call(h, 'GET')).status, 404);
  assert.equal((await call(h, 'PUT', { state: {}, baseRev: 0 })).status, 404);
});

test('each of the three settings is required', async t => {
  for (const drop of ['OPENGYM_MCP_WRITE', 'OPENGYM_MCP_API_TOKEN', 'OPENGYM_UID']) {
    const env = { ...ON };
    delete env[drop];
    const h = await startServer(t, env);
    assert.equal((await call(h, 'GET')).status, 404, `without ${drop}`);
  }
  const h = await startServer(t, { ...ON, OPENGYM_MCP_API_TOKEN: 'too-short' });
  assert.equal((await call(h, 'GET')).status, 404, 'a token under 16 characters');
});

test('wrong or missing token → 401, and the attempt is audited', async t => {
  const h = await startServer(t, ON);
  assert.equal((await call(h, 'GET', undefined, { 'Content-Type': 'application/json' })).status, 401);
  assert.equal((await call(h, 'GET', undefined, bearer(TOKEN + 'x'))).status, 401);
  assert.equal((await call(h, 'PUT', { state: {}, baseRev: 0 }, bearer('nope-nope-nope-nope'))).status, 401);
  assert.ok(auditOf(h).some(r => r.ev === 'auth.mcp.denied' && r.ok === false));
  assert.equal(stateOf(h, UID), null, 'nothing was written');
});

test('a user session is not an MCP token', async t => {
  const h = await startServer(t, ON);
  const r = await call(h, 'GET', undefined, { Authorization: `Bearer ${mintSession(UID)}` });
  assert.equal(r.status, 401);
});

test('a disabled or missing profile → 403', async t => {
  const disabled = await startServer(t, ON, [{ id: UID, name: 'One', disabled: true }]);
  assert.equal((await call(disabled, 'GET')).status, 403);
  const missing = await startServer(t, { ...ON, OPENGYM_UID: 'nobody' });
  assert.equal((await call(missing, 'GET')).status, 403);
});

test('read, then conditional write: rev moves, `active` is stripped, 409 on a stale baseRev', async t => {
  const h = await startServer(t, ON);
  assert.deepEqual((await call(h, 'GET')).body, { state: null, rev: 0 });

  const w1 = await call(h, 'PUT', { state: { unit: 'kg', routines: [], active: { x: 1 }, _rev: 99 }, baseRev: 0, op: 'set_week_plan' });
  assert.equal(w1.status, 200);
  assert.equal(w1.body.rev, 1);
  const saved = stateOf(h, UID);
  assert.equal(saved._rev, 1, 'the server owns _rev');
  assert.equal(saved.active, undefined, 'an in-progress workout never lands on the server');

  const stale = await call(h, 'PUT', { state: { unit: 'lb' }, baseRev: 0 });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.rev, 1);
  assert.equal(stale.body.state.unit, 'kg', 'the current document comes back with the 409');
  assert.equal(stateOf(h, UID).unit, 'kg', 'and the stale write did not land');

  assert.equal((await call(h, 'GET')).body.rev, 1);
});

test('the MCP must always say which revision it read', async t => {
  const h = await startServer(t, ON);
  for (const baseRev of [undefined, null, '0', 1.5]) {
    const r = await call(h, 'PUT', { state: { unit: 'kg' }, baseRev });
    assert.equal(r.status, 400, `baseRev ${JSON.stringify(baseRev)}`);
  }
  assert.equal(stateOf(h, UID), null);
});

test('the profile comes from the server, never from the request', async t => {
  const h = await startServer(t, ON);
  const r = await call(h, 'PUT', { state: { unit: 'kg' }, baseRev: 0, uid: OTHER, user: OTHER });
  assert.equal(r.status, 200);
  assert.ok(stateOf(h, UID), 'written to OPENGYM_UID');
  assert.equal(stateOf(h, OTHER), null, 'and nowhere else');
});

test('the same revision chain as a device: each side sees the other one\'s write as a conflict', async t => {
  const h = await startServer(t, ON);
  const device = { Cookie: `gymsid=${mintSession(UID)}`, 'Content-Type': 'application/json' };
  const put = body => fetch(`${h.api}/api/data`, { method: 'PUT', headers: device, body: JSON.stringify(body) });

  assert.equal((await put({ state: { unit: 'kg', routines: [] }, baseRev: 0 })).status, 200);   // device → rev 1
  assert.equal((await call(h, 'PUT', { state: { unit: 'kg' }, baseRev: 0 })).status, 409, 'MCP read rev 0, device wrote since');
  assert.equal((await call(h, 'PUT', { state: { unit: 'kg', routines: [{ id: 'r1', name: 'A', ex: [] }] }, baseRev: 1 })).status, 200); // MCP → rev 2
  const r = await put({ state: { unit: 'kg' }, baseRev: 1 });
  assert.equal(r.status, 409, 'the device read rev 1, the MCP wrote since');
  assert.equal((await r.json()).state.routines[0].id, 'r1');
});

test('invalid documents get the same refusals as PUT /api/data', async t => {
  const h = await startServer(t, ON);
  assert.equal((await call(h, 'PUT', { state: [], baseRev: 0 })).status, 400);
  assert.equal((await call(h, 'PUT', { state: { routines: 'x' }, baseRev: 0 })).status, 400);
  assert.equal((await call(h, 'PUT', { baseRev: 0 })).status, 400);
});

test('a write is audited by tool name and revision — never with the document', async t => {
  const h = await startServer(t, ON);
  await call(h, 'PUT', { state: { unit: 'kg', bodyweight: [{ d: '2026-09-24', w: 81.5, t: 1 }] }, baseRev: 0, op: 'log_bodyweight' });
  const row = auditOf(h).find(r => r.ev === 'admin.mcp.write');
  assert.ok(row, 'admin.mcp.write recorded');
  assert.equal(row.uid, UID);
  assert.equal(row.msg, 'log_bodyweight r1');
  assert.ok(!JSON.stringify(row).includes('81.5'), 'no state content in the log');
});

// ---- what came out of the security review ----

// Straight onto the socket: fetch would normalise `..` and `\` itself before sending.
function raw(h, text) {
  const port = new URL(h.api).port;
  return new Promise((resolve, reject) => {
    const sock = net.connect(+port, '127.0.0.1', () => sock.write(text));
    let data = '';
    sock.on('data', d => { data += d; });
    sock.on('end', () => resolve(data));
    sock.on('error', reject);
  });
}

test('a path that only parses to /internal/... is refused before routing — the nginx /api/ bypass', async t => {
  const h = await startServer(t, ON);
  for (const p of ['/api/..\internal/mcp/state', '/api/../internal/mcp/state', '/api/%2e%2e/internal/mcp/state', '/api\..\internal\mcp\state']) {
    const reply = await raw(h, `GET ${p} HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${TOKEN}\r\nConnection: close\r\n\r\n`);
    assert.doesNotMatch(reply, /^HTTP\/1\.1 200/, p);
    assert.doesNotMatch(reply, /"rev"/, `${p} must not reach the route`);
  }
  // Ordinary routes are untouched by the check.
  assert.equal((await fetch(`${h.api}/api/health?x=1`)).status, 200);
});

test('anything that came through the web proxy is refused, even with the right token', async t => {
  const h = await startServer(t, ON);
  for (const hdr of [{ 'X-Real-IP': '203.0.113.9' }, { 'X-Forwarded-For': '203.0.113.9' }]) {
    const r = await call(h, 'GET', undefined, { ...bearer(), ...hdr });
    assert.equal(r.status, 404, JSON.stringify(hdr));
  }
});

test('the remote clients\' /mcp token is not the api token', async t => {
  const h = await startServer(t, { ...ON, OPENGYM_MCP_TOKEN: 'the-remote-client-token-123' });
  assert.equal((await call(h, 'GET', undefined, bearer('the-remote-client-token-123'))).status, 401);
  const off = await startServer(t, { OPENGYM_MCP_WRITE: '1', OPENGYM_MCP_TOKEN: TOKEN, OPENGYM_UID: UID });
  assert.equal((await call(off, 'GET')).status, 404, 'OPENGYM_MCP_TOKEN alone does not turn the route on');
});

test('refused tokens are audited at most once a minute — nobody can flush the log with them', async t => {
  const h = await startServer(t, ON);
  for (let i = 0; i < 5; i++) await call(h, 'GET', undefined, bearer('wrong-wrong-wrong-wrong'));
  assert.equal(auditOf(h).filter(r => r.ev === 'auth.mcp.denied').length, 1);
});

test('an `op` that is not a plain tool name is logged as "write" and cannot fail a landed write', async t => {
  const h = await startServer(t, ON);
  const r = await call(h, 'PUT', { state: { unit: 'kg' }, baseRev: 0, op: { toString: 1 } });
  assert.equal(r.status, 200);
  assert.equal(auditOf(h).find(x => x.ev === 'admin.mcp.write').msg, 'write r1');
});
