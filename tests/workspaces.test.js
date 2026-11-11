import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {workspaceDbPath} from '../src/workspaces.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const {port} = s.address(); s.close(() => resolve(port)); }); s.on('error', reject); });

async function installation() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-ws-')), port = await freePort(), base = `http://127.0.0.1:${port}`;
  const env = {...process.env, AGENT_SKIP_DOTENV: '1', AI_API_KEY: '', OPENAI_API_KEY: '', AI_BASE_URL: '', OPENAI_BASE_URL: '', DASHBOARD_PASSWORD: 'test-password-1234', HOST: '127.0.0.1', PORT: String(port), DATA_FILE: path.join(dir, 'state.json')};
  let child = null;
  const send = async (method, url, body, cookie, headers = {}) => {
    const r = await fetch(base + url, {method, headers: {'Content-Type': 'application/json', ...(cookie ? {Cookie: cookie} : {}), ...headers}, body: body === undefined ? undefined : JSON.stringify(body)});
    return {status: r.status, body: await r.json(), cookie: r.headers.get('set-cookie')};
  };
  async function start() {
    child = spawn(process.execPath, ['src/server.js'], {cwd: root, env, stdio: 'ignore'});
    for (let i = 0; i < 90; i++) {
      try { if ((await fetch(base + '/api/health')).ok) return; } catch { /* Not listening yet. */ }
      await new Promise(r => setTimeout(r, 70));
    }
    throw new Error('Server did not start.');
  }
  async function stop() { if (!child) return; child.kill('SIGINT'); await new Promise(resolve => child.once('exit', resolve)); child = null; }
  const login = async (email, password = 'test-password-1234') => (await send('POST', '/api/login', {email, password})).cookie.split(';')[0];
  return {dir, send, start, stop, login, async remove() { await stop(); await fs.rm(dir, {recursive: true, force: true}); }};
}
// Per-workspace data marker: a uniquely named group (the seed ships its own).
const addGroup = (t, name, cookie) => t.send('POST', '/api/groups', {name}, cookie);
const named = (state, name) => state.groups.filter(g => g.name === name).map(g => g.name);

test('a second workspace has its own data and members', {timeout: 40000}, async () => {
  const t = await installation();
  try {
    await t.start();
    const owner = await t.login();
    assert.equal((await addGroup(t, 'Group one', owner)).status, 201);
    const first = (await t.send('GET', '/api/state', undefined, owner)).body;
    assert.deepEqual(first.workspaces.map(w => [w.name, w.role, w.current]), [['Primary workspace', 'owner', true]]);

    const created = await t.send('POST', '/api/workspaces', {name: '  Client   work '}, owner);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.name, 'Client work');
    assert.equal((await t.send('POST', '/api/workspaces', {name: ''}, owner)).status, 400);
    assert.equal((await t.send('POST', '/api/workspaces/switch', {id: created.body.id}, owner)).status, 200);

    // Nothing from the first workspace is visible in the new one.
    const second = (await t.send('GET', '/api/state', undefined, owner)).body;
    assert.deepEqual(named(second, 'Group one'), []);
    assert.equal(second.workspaces.find(w => w.current).name, 'Client work');
    assert.equal((await addGroup(t, 'Group two', owner)).status, 201);
    assert.equal((await t.send('POST', '/api/chats/atlas/messages', {id: 'm1', role: 'user', text: 'only in client work'}, owner)).status, 200);

    {
      const here = (await t.send('GET', '/api/state', undefined, owner)).body;
      assert.deepEqual(named(here, 'Group two'), ['Group two']);
      assert.deepEqual(named(here, 'Group one'), []);
    }

    // A member invited here cannot see, or switch to, the first workspace.
    assert.equal((await t.send('POST', '/api/users', {email: 'guest@example.com', password: 'guest-password-1', role: 'admin'}, owner)).status, 201);
    const guest = await t.login('guest@example.com', 'guest-password-1');
    const guestState = (await t.send('GET', '/api/state', undefined, guest)).body;
    assert.deepEqual(guestState.workspaces.map(w => w.name), ['Client work']);
    assert.deepEqual(named(guestState, 'Group two'), ['Group two']);
    assert.equal(guestState.canCreateWorkspace, false);
    assert.equal((await t.send('POST', '/api/workspaces/switch', {id: 'default'}, guest)).status, 404);
    assert.equal((await t.send('POST', '/api/workspaces', {name: 'Mine'}, guest)).status, 403);
    assert.deepEqual((await t.send('GET', '/api/users', undefined, guest)).body.users.map(u => u.email).sort(), ['guest@example.com', 'owner@localhost']);
    // An admin here is not an owner here: renaming and deleting stay with the owner.
    assert.equal((await t.send('PATCH', '/api/workspaces/current', {name: 'Taken over'}, guest)).status, 403);
    assert.equal((await t.send('DELETE', '/api/workspaces/current', {confirm: 'Client work'}, guest)).status, 403);

    // Back in the first workspace, the owner sees only its own data and members.
    assert.equal((await t.send('POST', '/api/workspaces/switch', {id: 'default'}, owner)).status, 200);
    const back = (await t.send('GET', '/api/state', undefined, owner)).body;
    assert.deepEqual(named(back, 'Group one'), ['Group one']);
    assert.deepEqual(named(back, 'Group two'), []);
    assert.equal(back.chats.atlas, undefined);
    assert.deepEqual((await t.send('GET', '/api/users', undefined, owner)).body.users.map(u => u.email), ['owner@localhost']);
    // An account that belongs elsewhere cannot be changed from this workspace.
    const guestId = (await t.send('GET', '/api/users', undefined, guest)).body.users.find(u => u.email === 'guest@example.com').id;
    assert.equal((await t.send('PATCH', `/api/users/${guestId}`, {disabled: true}, owner)).status, 404);
    assert.equal((await t.send('DELETE', '/api/workspaces/current', {confirm: 'Primary workspace'}, owner)).status, 409);

    // Both workspaces survive a restart, each with its own data.
    await t.stop(); await t.start();
    const again = await t.login();
    const primaryAgain = (await t.send('GET', '/api/state', undefined, again)).body;
    assert.deepEqual(named(primaryAgain, 'Group one'), ['Group one']);
    assert.deepEqual(named(primaryAgain, 'Group two'), []);
    await t.send('POST', '/api/workspaces/switch', {id: created.body.id}, again);
    const reread = (await t.send('GET', '/api/state', undefined, again)).body;
    assert.deepEqual(named(reread, 'Group two'), ['Group two']);
    assert.deepEqual(named(reread, 'Group one'), []);
    assert.deepEqual(reread.chats.atlas.map(m => m.text), ['only in client work']);

    // Deleting needs the typed name, removes the file and ends the guest's access.
    const guestAgain = await t.login('guest@example.com', 'guest-password-1');
    assert.equal((await t.send('GET', '/api/state', undefined, guestAgain)).status, 200);
    assert.equal((await t.send('PATCH', '/api/workspaces/current', {name: 'Client work 2'}, again)).status, 200);
    assert.equal((await t.send('DELETE', '/api/workspaces/current', {confirm: 'Client work'}, again)).status, 400);
    assert.equal((await t.send('DELETE', '/api/workspaces/current', {confirm: 'Client work 2'}, again)).status, 200);
    await assert.rejects(fs.stat(workspaceDbPath(path.join(t.dir, 'state.db'), created.body.id)));
    assert.equal((await t.send('GET', '/api/state', undefined, again)).body.workspaces.length, 1, 'The owner lands back in the first workspace.');
    assert.equal((await t.send('GET', '/api/state', undefined, guestAgain)).status, 401, 'An account in no workspace has no session.');
    assert.equal((await t.send('POST', '/api/login', {email: 'guest@example.com', password: 'guest-password-1'})).status, 403);
  } finally { await t.remove(); }
});

test('a workspace database path cannot be steered outside the data directory', () => {
  assert.equal(workspaceDbPath('/data/state.db', 'abc-123'), '/data/state.ws-abc-123.db');
  for (const bad of ['../x', 'a/b', '', 'A', 'x.db']) assert.throws(() => workspaceDbPath('/data/state.db', bad));
});

test('a failed background task is pushed to the devices of its workspace, and a failed push raises nothing', {timeout: 40000}, async () => {
  const t = await installation();
  try {
    await t.start();
    const owner = await t.login();
    const info = (await t.send('GET', '/api/push', undefined, owner)).body;
    assert.equal(Buffer.from(info.publicKey, 'base64url').length, 65);
    // A real-looking subscription whose endpoint is on this machine: the server
    // must queue a delivery for it and then refuse to call it.
    // A real P-256 key (the stored point is now validated), with an endpoint on
    // this machine so the server queues a delivery and then refuses to call it.
    const ecdh = crypto.createECDH('prime256v1');
    const keys = {p256dh: ecdh.generateKeys().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url')};
    assert.equal((await t.send('POST', '/api/push/subscriptions', {endpoint: 'https://127.0.0.1:9/push', keys}, owner)).status, 201);
    assert.equal((await t.send('POST', '/api/push/subscriptions', {endpoint: 'http://push.example.com/x', keys}, owner)).status, 400);
    assert.equal((await t.send('POST', '/api/push/subscriptions', {endpoint: 'https://127.0.0.1:9/push', keys})).status, 401);
    assert.deepEqual((await t.send('GET', '/api/push', undefined, owner)).body.endpoints, ['https://127.0.0.1:9/push']);
    assert.match((await t.send('POST', '/api/push/test', {}, owner)).body.results[0], /^failed: Refusing to reach 127\.0\.0\.1/);
    // A browser cannot queue a push itself.
    assert.equal((await t.send('POST', '/api/tasks', {kind: 'notification', payload: {channel: 'push', target: 'x', title: 'spoof'}}, owner)).status, 403);

    // An agent job no paired device can run fails permanently on its first
    // attempt, which raises the 'A background task failed' notification.
    assert.equal((await t.send('POST', '/api/tasks', {kind: 'agent-job', payload: {action: 'no.such.permission'}}, owner)).status, 201);
    let pushes = [];
    for (let i = 0; i < 80 && !pushes.some(p => p.lastError); i++) {
      await new Promise(r => setTimeout(r, 250));
      pushes = (await t.send('GET', '/api/state', undefined, owner)).body.tasks.filter(x => x.kind === 'notification' && x.payload.channel === 'push');
    }
    assert.equal(pushes.length, 1, 'One delivery per device, and its failure must not queue another.');
    assert.equal(pushes[0].payload.title, 'A background task failed');
    assert.match(pushes[0].payload.body, /No paired local agent holds the permission/);
    assert.match(pushes[0].lastError, /Refusing to reach 127\.0\.0\.1/);
    assert.equal((await t.send('DELETE', '/api/push/subscriptions', {endpoint: 'https://127.0.0.1:9/push'}, owner)).body.removed, 1);
  } finally { await t.remove(); }
});

test('deleting your account reaches the workspaces the request did not come from', {timeout: 40000}, async () => {
  const t = await installation();
  try {
    await t.start();
    const owner = await t.login();
    // The same person in two workspaces: one is where they sign in, the other is
    // where they paired a laptop. `selfDeleteAccount` removes every membership
    // it finds, so the device has to go too - its secret is a live credential in
    // a database this request never touched.
    assert.equal((await t.send('POST', '/api/users', {email: 'guest@example.com', password: 'guest-password-1', role: 'admin'}, owner)).status, 201);
    const client = (await t.send('POST', '/api/workspaces', {name: 'Client work'}, owner)).body;
    assert.equal((await t.send('POST', '/api/workspaces/switch', {id: client.id}, owner)).status, 200);
    assert.equal((await t.send('POST', '/api/users', {email: 'guest@example.com', role: 'admin'}, owner)).status, 201);
    assert.equal((await t.send('POST', '/api/workspaces/switch', {id: 'default'}, owner)).status, 200);
    const guestId = (await t.send('GET', '/api/users', undefined, owner)).body.users.find(u => u.email === 'guest@example.com').id;

    const guest = await t.login('guest@example.com', 'guest-password-1');
    assert.equal((await t.send('POST', '/api/workspaces/switch', {id: client.id}, guest)).status, 200);
    const paired = await t.send('POST', '/api/agents/pair', {label: 'guest laptop', permissions: ['browser.capture']}, guest);
    assert.equal(paired.status, 201, JSON.stringify(paired.body));
    const redeemed = await t.send('POST', '/api/agent/pair', {code: paired.body.code, name: 'guest laptop'}, null);
    assert.equal(redeemed.status, 201, JSON.stringify(redeemed.body));

    // The device is paired in the workspace the deletion will *not* be sent from.
    const {DatabaseSync} = await import('node:sqlite');
    const readClient = (sql, ...values) => {
      const db = new DatabaseSync(workspaceDbPath(path.join(t.dir, 'state.db'), client.id));
      try { return db.prepare(sql).get(...values); } finally { db.close(); }
    };
    assert.equal(readClient('SELECT count(*) AS n FROM agents WHERE paired_by=?', 'guest@example.com').n, 1, 'the device was paired here');

    // Back where they signed in, so the deletion is sent from the other workspace.
    assert.equal((await t.send('POST', '/api/workspaces/switch', {id: 'default'}, guest)).status, 200);
    const removed = await t.send('DELETE', '/api/account', {password: 'guest-password-1'}, guest);
    assert.equal(removed.status, 200, JSON.stringify(removed.body));

    const agent = readClient('SELECT status, revoked_at FROM agents WHERE paired_by=?', 'guest@example.com');
    assert.equal(agent.status, 'revoked', 'the device in the other workspace is revoked too');
    assert.ok(agent.revoked_at, 'and the revocation is stamped');
    assert.equal(readClient('SELECT count(*) AS n FROM notification_prefs WHERE user_id=?', guestId).n, 0);
  } finally { await t.remove(); }
});

test('a restore that names a workspace it did not carry says the workspace started empty', {timeout: 40000}, async () => {
  const t = await installation();
  try {
    await t.start();
    const owner = await t.login();
    const exported = (await t.send('GET', '/api/admin/backup', undefined, owner)).body;
    // A document that lists a workspace this installation never had, which is
    // what a backup of the first workspace looks like on a machine where the
    // other workspaces were created after that file was written. Its data is
    // not in the document - the document holds one store's tables - so the only
    // honest answer is that the workspace came back empty.
    const now = new Date().toISOString();
    exported.tables.workspaces.push({id: 'old-client', name: 'Old client', created_at: now});
    const crypto = await import('node:crypto');
    exported.checksum = crypto.createHash('sha256').update(JSON.stringify(exported.tables)).digest('hex');
    const restored = await t.send('POST', '/api/admin/restore', {...exported, force: true}, owner);
    assert.equal(restored.status, 200, JSON.stringify(restored.body).slice(0, 300));
    assert.equal(restored.body.signedOut, true, 'a primary restore ends every session');
    assert.deepEqual(restored.body.startedEmpty, ['old-client']);
    await assert.doesNotReject(fs.stat(workspaceDbPath(path.join(t.dir, 'state.db'), 'old-client')));

    // The note is in the log as well, because the response is only read once.
    const {DatabaseSync} = await import('node:sqlite');
    const db = new DatabaseSync(path.join(t.dir, 'state.db'));
    try {
      const line = db.prepare(`SELECT message FROM events WHERE type='backup' ORDER BY rowid DESC LIMIT 1`).get();
      assert.match(String(line?.message || ''), /started empty: old-client/);
    } finally { db.close(); }
  } finally { await t.remove(); }
});
