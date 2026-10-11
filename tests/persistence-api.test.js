import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const {port} = s.address(); s.close(() => resolve(port)); }); s.on('error', reject); });

/** One data directory that outlives the process, so a test can restart the server on it. */
async function installation() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-persist-')), port = await freePort(), base = `http://127.0.0.1:${port}`;
  const env = {...process.env, AGENT_SKIP_DOTENV: '1', AI_API_KEY: '', OPENAI_API_KEY: '', AI_BASE_URL: '', OPENAI_BASE_URL: '', DASHBOARD_PASSWORD: 'test-password-1234', HOST: '127.0.0.1', PORT: String(port), DATA_FILE: path.join(dir, 'state.json')};
  let child = null;
  const send = async (method, url, body, cookie) => {
    const r = await fetch(base + url, {method, headers: {'Content-Type': 'application/json', ...(cookie ? {Cookie: cookie} : {})}, body: body === undefined ? undefined : JSON.stringify(body)});
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
  const login = async () => (await send('POST', '/api/login', {password: 'test-password-1234'})).cookie.split(';')[0];
  return {send, start, stop, login, async remove() { await stop(); await fs.rm(dir, {recursive: true, force: true}); }};
}

test('drafts, reminders and conversations survive a restart and stay editable', {timeout: 30000}, async () => {
  const t = await installation();
  try {
    await t.start();
    let cookie = await t.login();
    const candidate = (await t.send('POST', '/api/candidates', {url: 'https://x.com/test/status/901', text: 'Queues make retries boring, and boring is the goal.', author: 'Tester', topic: 'AI'}, cookie)).body;
    const draft = (await t.send('POST', `/api/candidates/${candidate.id}/process`, {}, cookie)).body;
    assert.equal((await t.send('POST', `/api/drafts/${draft.id}/approve`, {}, cookie)).status, 200);
    assert.equal((await t.send('POST', '/api/schedules', {label: 'Check drafts', kind: 'interval', intervalMinutes: 60}, cookie)).status, 201);
    assert.equal((await t.send('POST', '/api/chats/writer/messages', {id: 'k1', role: 'user', text: 'make it shorter'}, cookie)).status, 200);
    const before = (await t.send('GET', '/api/state', undefined, cookie)).body;

    await t.stop(); await t.start(); cookie = await t.login();
    const after = (await t.send('GET', '/api/state', undefined, cookie)).body;
    assert.deepEqual(after.drafts, before.drafts, 'A draft must read back exactly as it was stored.');
    assert.deepEqual(after.candidates, before.candidates);
    assert.equal(after.tasks.filter(x => x.kind === 'reminder').length, 1, 'A reminder must survive a restart.');
    assert.deepEqual(after.chats.writer.map(m => m.text), ['make it shorter']);
    // The first write after a restart used to fail on every installation that held a draft.
    const edited = await t.send('PATCH', `/api/drafts/${draft.id}`, {text: 'Edited after the restart.'}, cookie);
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.equal((await t.send('GET', '/api/state', undefined, cookie)).body.drafts[0].text, 'Edited after the restart.');
  } finally { await t.remove(); }
});

test('conversation history is validated, deduplicated, role-gated and clearable', {timeout: 30000}, async () => {
  const t = await installation();
  try {
    await t.start();
    const cookie = await t.login();
    assert.equal((await t.send('POST', '/api/chats/writer/messages', {role: 'user', text: 'hi'})).status, 401);
    assert.equal((await t.send('POST', '/api/chats/nobody/messages', {role: 'user', text: 'hi'}, cookie)).status, 404);
    assert.equal((await t.send('POST', '/api/chats/writer/messages', {role: 'root', text: 'hi'}, cookie)).status, 400);
    const batch = {messages: [{id: 'a', role: 'user', text: 'one'}, {id: 'b', role: 'bot', text: 'two', senderName: 'Writer'}]};
    assert.deepEqual((await t.send('POST', '/api/chats/team-x-engage/messages', batch, cookie)).body, {ok: true, added: 2});
    assert.deepEqual((await t.send('POST', '/api/chats/team-x-engage/messages', batch, cookie)).body, {ok: true, added: 0});
    assert.equal((await t.send('GET', '/api/state', undefined, cookie)).body.chats['team-x-engage'].length, 2);

    // A viewer can read the workspace but cannot write or clear history.
    const email = 'viewer@example.com', password = 'viewer-password-1234';
    assert.equal((await t.send('POST', '/api/users', {email, password, role: 'viewer'}, cookie)).status, 201);
    const viewer = (await t.send('POST', '/api/login', {email, password})).cookie.split(';')[0];
    assert.equal((await t.send('GET', '/api/state', undefined, viewer)).body.chats['team-x-engage'].length, 2);
    assert.equal((await t.send('POST', '/api/chats/team-x-engage/messages', {role: 'user', text: 'hi'}, viewer)).status, 403);
    assert.equal((await t.send('DELETE', '/api/chats/team-x-engage', undefined, viewer)).status, 403);

    assert.deepEqual((await t.send('DELETE', '/api/chats/team-x-engage', undefined, cookie)).body, {ok: true, removed: 2});
    assert.equal((await t.send('GET', '/api/state', undefined, cookie)).body.chats['team-x-engage'], undefined);
  } finally { await t.remove(); }
});
