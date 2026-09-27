/* The subscription's server side. The browser keeps its PushSubscription through anything that
   happens here — a row pruned after a dead send, a rebuilt db.json — so the client re-sends it on
   every boot (an upsert that keeps `created`), asks /api/push/status before Settings shows "on",
   and tags it with a device id so a rest-timer alert goes to the device that started the rest.
   Real server.js in a child. */
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

function mintSession(uid) {
  const payload = `${uid}:${Date.now() + 86400000}:0`;
  return payload + '.' + crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
}
const cookie = { Cookie: `gymsid=${mintSession('u_test_1')}` };
const other = { Cookie: `gymsid=${mintSession('u_test_2')}` };
const keys = { p256dh: 'p', auth: 'a' };

const freePort = () => new Promise(r => {
  const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); });
});

async function startServer(t, subs = []) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-pushstatus-'));
  fs.writeFileSync(path.join(dataDir, 'secret'), SECRET, { mode: 0o600 });
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({
    users: [{ id: 'u_test_1', name: 'One', created: new Date().toISOString() }, { id: 'u_test_2', name: 'Two', created: new Date().toISOString() }],
    creds: [], subs, invites: []
  }));
  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: API, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, ORIGIN: 'http://localhost:8080', RP_ID: 'localhost' }
  });
  const h = { api: `http://127.0.0.1:${port}`, dataDir, log: '' };
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
const readDb = h => JSON.parse(fs.readFileSync(path.join(h.dataDir, 'db.json'), 'utf8'));
const post = (h, p, body, hdr = cookie) => fetch(`${h.api}${p}`, { method: 'POST', headers: hdr, body: JSON.stringify(body) });
const status = (h, endpoint, hdr = cookie) => fetch(`${h.api}/api/push/status?endpoint=${encodeURIComponent(endpoint)}`, { headers: hdr }).then(r => r.json());

test('status tells whether the server holds the endpoint; subscribe is an upsert that keeps created and stores the device id', async t => {
  const h = await startServer(t);
  const endpoint = 'https://push.example/one';
  assert.deepEqual(await status(h, endpoint), { subscribed: false });

  assert.equal((await post(h, '/api/push/subscribe', { subscription: { endpoint, keys }, deviceId: 'dev_aaaaaaaa' })).status, 200);
  assert.deepEqual(await status(h, endpoint), { subscribed: true, deviceId: 'dev_aaaaaaaa' });
  assert.deepEqual(await status(h, endpoint, other), { subscribed: false }, 'another account does not see it');
  const first = readDb(h).subs[0];
  assert.equal(first.deviceId, 'dev_aaaaaaaa');

  await new Promise(r => setTimeout(r, 20));
  assert.equal((await post(h, '/api/push/subscribe', { subscription: { endpoint, keys: { p256dh: 'p2', auth: 'a2' } }, deviceId: 'dev_bbbbbbbb' })).status, 200);
  const subs = readDb(h).subs;
  assert.equal(subs.length, 1, 'same endpoint sent again is one row');
  assert.equal(subs[0].created, first.created, 'created survives the re-send');
  assert.equal(subs[0].deviceId, 'dev_bbbbbbbb');
  assert.deepEqual(subs[0].keys, { p256dh: 'p2', auth: 'a2' });

  // a device id that is not a short token is dropped, not stored
  assert.equal((await post(h, '/api/push/subscribe', { subscription: { endpoint: 'https://push.example/two', keys }, deviceId: { evil: true } })).status, 200);
  assert.equal('deviceId' in readDb(h).subs.find(s => s.endpoint.endsWith('/two')), false);

  assert.equal((await fetch(`${h.api}/api/push/status?endpoint=x`)).status, 401);
});

test('a subscription the service worker rotates keeps the device id of the one it replaces', async t => {
  const mk = (userId, endpoint, deviceId) => ({ userId, endpoint, keys, deviceId, created: new Date().toISOString() });
  const h = await startServer(t, [
    mk('u_test_1', 'https://push.example/old', 'dev_phone000'),
    mk('u_test_1', 'https://push.example/desk', 'dev_desk0000'),
    mk('u_test_2', 'https://push.example/theirs', 'dev_other000'),
  ]);
  const row = endpoint => readDb(h).subs.find(s => s.endpoint === endpoint);

  // sw.js pushsubscriptionchange: no device id (a worker has no localStorage), the old endpoint instead
  assert.equal((await post(h, '/api/push/subscribe', { subscription: { endpoint: 'https://push.example/new', keys }, oldEndpoint: 'https://push.example/old' })).status, 200);
  assert.equal(row('https://push.example/new').deviceId, 'dev_phone000');
  assert.equal(row('https://push.example/old'), undefined, 'the replaced row is gone');
  assert.equal(row('https://push.example/desk').deviceId, 'dev_desk0000', 'the other device is untouched');

  // the same endpoint sent again without an id keeps the one it has
  assert.equal((await post(h, '/api/push/subscribe', { subscription: { endpoint: 'https://push.example/new', keys } })).status, 200);
  assert.equal(row('https://push.example/new').deviceId, 'dev_phone000');

  // another account's row is neither dropped nor read
  assert.equal((await post(h, '/api/push/subscribe', { subscription: { endpoint: 'https://push.example/mine', keys }, oldEndpoint: 'https://push.example/theirs' })).status, 200);
  assert.equal(row('https://push.example/theirs').deviceId, 'dev_other000');
  assert.equal('deviceId' in row('https://push.example/mine'), false);
  // status says so, and the page then registers the row again with its id (lib/push.js)
  assert.deepEqual(await status(h, 'https://push.example/mine'), { subscribed: true, deviceId: null });

  // an id sent along wins over the one carried over
  assert.equal((await post(h, '/api/push/subscribe', { subscription: { endpoint: 'https://push.example/newer', keys }, oldEndpoint: 'https://push.example/new', deviceId: 'dev_fresh000' })).status, 200);
  assert.equal(row('https://push.example/newer').deviceId, 'dev_fresh000');
  assert.equal(row('https://push.example/new'), undefined);
});

test('a rotated subscription still gets its own device\'s rest timer, and only that one', async t => {
  // localhost resolves to a loopback address, which PUSH_AGENT refuses: a send fails quietly, and
  // "push send failed" in the log is the proof that one was attempted.
  const mk = (deviceId, n) => ({ userId: 'u_test_1', endpoint: `https://localhost/${n}`, keys, deviceId, created: new Date().toISOString() });
  const h = await startServer(t, [mk('dev_phone000', 'phone-old'), mk('dev_desk0000', 'desk')]);
  assert.equal((await post(h, '/api/push/subscribe', { subscription: { endpoint: 'https://localhost/phone-new', keys }, oldEndpoint: 'https://localhost/phone-old' })).status, 200);

  assert.equal((await post(h, '/api/push/rest-timer', { seconds: 1, deviceId: 'dev_phone000' })).status, 200);
  await new Promise(r => setTimeout(r, 2500));
  assert.equal((h.log.match(/push send failed u_test_1/g) || []).length, 1, `one send, to the phone's new subscription:\n${h.log}`);
});

test('a rest timer belongs to the device that set it: another device cancelling does not silence it', async t => {
  // localhost resolves to a loopback address, which PUSH_AGENT refuses — every send fails locally
  // and quietly, and "push send failed" in the log is the proof that a send was attempted.
  const mk = (deviceId, n) => ({ userId: 'u_test_1', endpoint: `https://localhost/${n}`, keys, deviceId, created: new Date().toISOString() });
  const h = await startServer(t, [mk('dev_phone000', 'phone'), mk('dev_desk0000', 'desk')]);
  const sends = () => (h.log.match(/push send failed u_test_1/g) || []).length;

  assert.equal((await post(h, '/api/push/rest-timer', { seconds: 1, deviceId: 'dev_phone000' })).status, 200);
  assert.equal((await post(h, '/api/push/rest-timer/cancel', { deviceId: 'dev_desk0000' })).status, 200);
  await new Promise(r => setTimeout(r, 2500));
  assert.equal(sends(), 1, `the phone's alert went out, to the phone's subscription only:\n${h.log}`);

  assert.equal((await post(h, '/api/push/rest-timer', { seconds: 1, deviceId: 'dev_phone000' })).status, 200);
  assert.equal((await post(h, '/api/push/rest-timer/cancel', { deviceId: 'dev_phone000' })).status, 200);
  await new Promise(r => setTimeout(r, 2500));
  assert.equal(sends(), 1, 'cancelled by its own device: nothing more went out');

  // an older client, no device id: the account-wide behaviour it always had
  assert.equal((await post(h, '/api/push/rest-timer', { seconds: 1 })).status, 200);
  assert.equal((await post(h, '/api/push/rest-timer/cancel', {})).status, 200);
  await new Promise(r => setTimeout(r, 2500));
  assert.equal(sends(), 1, 'legacy cancel clears the legacy timer');
  assert.equal((await post(h, '/api/push/rest-timer', { seconds: 1 })).status, 200);
  await new Promise(r => setTimeout(r, 2500));
  assert.equal(sends(), 3, 'a legacy timer goes to every subscription of the account');
});
