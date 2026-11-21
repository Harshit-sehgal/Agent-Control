/** Event triggers over real HTTP: the public event route works with no cookie, refuses a bad signature and an
 * oversize body, and starts nothing while the kill switch is on. The owner's routes need a session.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sign = (secret, raw) => `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`;

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => { const {port} = server.address(); server.close(() => resolve(port)); });
    server.on('error', reject);
  });
}

async function launch() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-events-http-'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: root,
    env: {...process.env, AGENT_SKIP_DOTENV: '1', AI_API_KEY: '', OPENAI_API_KEY: '', AI_BASE_URL: '', OPENAI_BASE_URL: '',
      DASHBOARD_PASSWORD: 'test-password-1234', HOST: '127.0.0.1', PORT: String(port), DATA_FILE: path.join(dir, 'state.json')},
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let live = false;
  for (let i = 0; i < 90 && child.exitCode === null; i++) {
    try { if ((await fetch(`${base}/api/health`)).ok) { live = true; break; } } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 70));
  }
  if (!live) { child.kill(); await fs.rm(dir, {recursive: true, force: true}); throw new Error('Server did not start.'); }
  return {base, child, dir, async stop() { child.kill('SIGINT'); await new Promise(resolve => child.once('exit', resolve)); await fs.rm(dir, {recursive: true, force: true}); }};
}

test('an outside event starts a run with no session, and a bad one starts nothing', {timeout: 30000}, async () => {
  const t = await launch();
  try {
    const login = await fetch(`${t.base}/api/login`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({password: 'test-password-1234'})});
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const owner = (method, url, body) => fetch(`${t.base}${url}`, {method, headers: {'Content-Type': 'application/json', Cookie: cookie}, body: body === undefined ? undefined : JSON.stringify(body)});

    const made = await owner('POST', '/api/triggers', {name: 'Deploy failures', botId: 'atlas', groupId: 'home', instruction: 'Look into the failed deploy and report the cause.'});
    assert.equal(made.status, 201);
    const {secret, path: eventPath} = await made.json();
    assert.match(eventPath, /^\/api\/events\/[^/]+\/[^/]+$/);

    const raw = JSON.stringify({status: 'failure', repo: 'shop'});
    // No cookie: the sender is not logged in, and the signature is the only proof.
    const good = await fetch(`${t.base}${eventPath}`, {method: 'POST', headers: {'Content-Type': 'application/json', 'X-Hub-Signature-256': sign(secret, raw)}, body: raw});
    assert.equal(good.status, 202);
    assert.equal((await good.json()).status, 'queued');

    const forged = await fetch(`${t.base}${eventPath}`, {method: 'POST', headers: {'Content-Type': 'application/json', 'X-Hub-Signature-256': sign('guess', raw)}, body: '{"status":"failure","n":2}'});
    assert.equal(forged.status, 401);

    const huge = 'x'.repeat(70 * 1024);
    const big = await fetch(`${t.base}${eventPath}`, {method: 'POST', headers: {'Content-Type': 'application/json', 'X-Hub-Signature-256': sign(secret, huge)}, body: huge});
    assert.equal(big.status, 413, 'a body over the cap is refused before it is read');

    const paused = await owner('POST', '/api/automation/pause-all');
    assert.equal(paused.status, 200);
    const during = '{"status":"failure","n":3}';
    const held = await fetch(`${t.base}${eventPath}`, {method: 'POST', headers: {'Content-Type': 'application/json', 'X-Hub-Signature-256': sign(secret, during)}, body: during});
    assert.equal((await held.json()).status, 'held', 'the kill switch stops an event too');

    const state = await (await owner('GET', '/api/state')).json();
    assert.equal('triggers' in state, false, 'the snapshot never carries trigger secrets ids or dedup records');
    const runs = (state.tasks || []).filter(task => task.kind === 'bot-task' && task.payload?.botId === 'atlas');
    assert.equal(runs.length, 1, 'only the first, accepted event queued a run');
    assert.match(runs[0].payload.message, /"repo":"shop"/, 'the body the sender posted is what the run is given, fenced');
  } finally {
    await t.stop();
  }
});
