import test from 'node:test';
import assert from 'node:assert/strict';
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
const post = n => ({url: `https://x.com/test/status/${n}`, text: `Post number ${n} about queues and retries.`, author: 'Tester', topic: 'AI'});

test('a second workspace has its own data, tokens and members', {timeout: 40000}, async () => {
  const t = await installation();
  try {
    await t.start();
    const owner = await t.login();
    assert.equal((await t.send('POST', '/api/candidates', post(1), owner)).status, 201);
    const first = (await t.send('GET', '/api/state', undefined, owner)).body;
    assert.deepEqual(first.workspaces.map(w => [w.name, w.role, w.current]), [['Primary workspace', 'owner', true]]);

    const created = await t.send('POST', '/api/workspaces', {name: '  Client   work '}, owner);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.name, 'Client work');
    assert.equal((await t.send('POST', '/api/workspaces', {name: ''}, owner)).status, 400);
    assert.equal((await t.send('POST', '/api/workspaces/switch', {id: created.body.id}, owner)).status, 200);

    // Nothing from the first workspace is visible in the new one.
    const second = (await t.send('GET', '/api/state', undefined, owner)).body;
    assert.equal(second.candidates.length, 0);
    assert.equal(second.workspaces.find(w => w.current).name, 'Client work');
    assert.notEqual(second.captureToken, first.captureToken, 'Each workspace has its own capture token.');
    assert.equal((await t.send('POST', '/api/candidates', post(2), owner)).status, 201);
    assert.equal((await t.send('POST', '/api/chats/writer/messages', {id: 'm1', role: 'user', text: 'only in client work'}, owner)).status, 200);

    // The extension token decides which workspace a captured post lands in.
    assert.equal((await t.send('POST', '/api/capture', post(3), null, {'X-Capture-Token': second.captureToken})).status, 201);
    assert.equal((await t.send('POST', '/api/capture', post(4), null, {'X-Capture-Token': 'nope'})).status, 401);
    assert.equal((await t.send('GET', '/api/state', undefined, owner)).body.candidates.length, 2);

    // A member invited here cannot see, or switch to, the first workspace.
    assert.equal((await t.send('POST', '/api/users', {email: 'guest@example.com', password: 'guest-password-1', role: 'admin'}, owner)).status, 201);
    const guest = await t.login('guest@example.com', 'guest-password-1');
    const guestState = (await t.send('GET', '/api/state', undefined, guest)).body;
    assert.deepEqual(guestState.workspaces.map(w => w.name), ['Client work']);
    assert.equal(guestState.candidates.length, 2);
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
    assert.deepEqual(back.candidates.map(c => c.url), ['https://x.com/test/status/1']);
    assert.equal(back.chats.writer, undefined);
    assert.deepEqual((await t.send('GET', '/api/users', undefined, owner)).body.users.map(u => u.email), ['owner@localhost']);
    // An account that belongs elsewhere cannot be changed from this workspace.
    const guestId = (await t.send('GET', '/api/users', undefined, guest)).body.users.find(u => u.email === 'guest@example.com').id;
    assert.equal((await t.send('PATCH', `/api/users/${guestId}`, {disabled: true}, owner)).status, 404);
    assert.equal((await t.send('DELETE', '/api/workspaces/current', {confirm: 'Primary workspace'}, owner)).status, 409);

    // Both workspaces survive a restart, each with its own data.
    await t.stop(); await t.start();
    const again = await t.login();
    assert.equal((await t.send('GET', '/api/state', undefined, again)).body.candidates.length, 1);
    await t.send('POST', '/api/workspaces/switch', {id: created.body.id}, again);
    const reread = (await t.send('GET', '/api/state', undefined, again)).body;
    assert.equal(reread.candidates.length, 2);
    assert.deepEqual(reread.chats.writer.map(m => m.text), ['only in client work']);

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

test('a reminder is pushed to the devices of the workspace it fired in, and a failed push raises nothing', {timeout: 40000}, async () => {
  const t = await installation();
  try {
    await t.start();
    const owner = await t.login();
    const info = (await t.send('GET', '/api/push', undefined, owner)).body;
    assert.equal(Buffer.from(info.publicKey, 'base64url').length, 65);
    // A real-looking subscription whose endpoint is on this machine: the server
    // must queue a delivery for it and then refuse to call it.
    const keys = {p256dh: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 7)]).toString('base64url'), auth: Buffer.alloc(16, 9).toString('base64url')};
    assert.equal((await t.send('POST', '/api/push/subscriptions', {endpoint: 'https://127.0.0.1:9/push', keys}, owner)).status, 201);
    assert.equal((await t.send('POST', '/api/push/subscriptions', {endpoint: 'http://push.example.com/x', keys}, owner)).status, 400);
    assert.equal((await t.send('POST', '/api/push/subscriptions', {endpoint: 'https://127.0.0.1:9/push', keys})).status, 401);
    assert.deepEqual((await t.send('GET', '/api/push', undefined, owner)).body.endpoints, ['https://127.0.0.1:9/push']);
    assert.match((await t.send('POST', '/api/push/test', {}, owner)).body.results[0], /^failed: Refusing to reach 127\.0\.0\.1/);
    // A browser cannot queue a push itself.
    assert.equal((await t.send('POST', '/api/tasks', {kind: 'notification', payload: {channel: 'push', target: 'x', title: 'spoof'}}, owner)).status, 403);

    assert.equal((await t.send('POST', '/api/schedules', {label: 'Check drafts', kind: 'once', nextAt: new Date(Date.now() + 1500).toISOString()}, owner)).status, 201);
    let pushes = [];
    for (let i = 0; i < 80 && !pushes.some(p => p.lastError); i++) {
      await new Promise(r => setTimeout(r, 250));
      pushes = (await t.send('GET', '/api/state', undefined, owner)).body.tasks.filter(x => x.kind === 'notification' && x.payload.channel === 'push');
    }
    assert.equal(pushes.length, 1, 'One delivery per device, and its failure must not queue another.');
    assert.equal(pushes[0].payload.title, 'Check drafts');
    assert.match(pushes[0].lastError, /Refusing to reach 127\.0\.0\.1/);
    assert.equal((await t.send('DELETE', '/api/push/subscriptions', {endpoint: 'https://127.0.0.1:9/push'}, owner)).body.removed, 1);
  } finally { await t.remove(); }
});
