import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
    server.on('error', reject);
  });
}

async function launch() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-authz-')), port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: root,
    env: {...process.env, AGENT_SKIP_DOTENV: '1', AI_API_KEY: '', OPENAI_API_KEY: '', AI_BASE_URL: '', OPENAI_BASE_URL: '', DASHBOARD_PASSWORD: 'test-password-1234', HOST: '127.0.0.1', PORT: String(port), DATA_FILE: path.join(dir, 'state.json')},
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', b => output += b.toString());
  child.stderr.on('data', b => output += b.toString());
  let live = false;
  for (let i = 0; i < 90; i++) {
    if (child.exitCode !== null) break;
    try { if ((await fetch(base + '/api/health')).ok) { live = true; break; } } catch {}
    await new Promise(r => setTimeout(r, 70));
  }
  if (!live) { child.kill(); await fs.rm(dir, {recursive: true, force: true}); throw new Error('Server did not start: ' + output); }
  return {base, async stop() { child.kill('SIGINT'); await new Promise(r => child.once('exit', r)); await fs.rm(dir, {recursive: true, force: true}); }};
}

test('the authorization matrix gates every write by role and origin', {timeout: 40000}, async () => {
  const t = await launch();
  try {
    const call = async (method, url, {body, cookie, headers} = {}) => {
      const r = await fetch(t.base + url, {
        method,
        headers: {...(body ? {'Content-Type': 'application/json'} : {}), ...(cookie ? {Cookie: cookie} : {}), ...(headers || {})},
        body: body ? JSON.stringify(body) : undefined,
      });
      return {status: r.status, body: await r.json().catch(() => null), cookie: r.headers.get('set-cookie')};
    };
    const login = async (email, password) => (await call('POST', '/api/login', {body: {email, password}})).cookie?.split(';')[0];

    const owner = await login(undefined, 'test-password-1234'); // no email: the bootstrapped owner
    assert.ok(owner, 'owner login should set a session cookie');
    for (const [email, role] of [['admin@a.test', 'admin'], ['member@a.test', 'member'], ['viewer@a.test', 'viewer']]) {
      const r = await call('POST', '/api/users', {cookie: owner, body: {email, password: 'long-enough-pass', role}});
      assert.equal(r.status, 201, `owner should create the ${role}: ${JSON.stringify(r.body)}`);
    }
    const admin = await login('admin@a.test', 'long-enough-pass');
    const member = await login('member@a.test', 'long-enough-pass');
    const viewer = await login('viewer@a.test', 'long-enough-pass');

    const settings = {topics: ['AI'], style: 'x', opinions: '', minDelay: 0, maxDelay: 1};
    const candidate = {url: 'https://x.com/a/status/1', text: 'A candidate long enough to pass validation.', author: 'Tester', topic: 'AI'};

    // Anonymous: nothing works, not even reads.
    for (const [m, u, body] of [['POST', '/api/candidates', candidate], ['PATCH', '/api/settings', settings], ['GET', '/api/state', undefined], ['GET', '/api/users', undefined], ['GET', '/api/agents', undefined]]) {
      assert.equal((await call(m, u, {body})).status, 401, `anonymous ${m} ${u} must be 401`);
    }

    // Viewer: can read, cannot mutate anything.
    assert.equal((await call('GET', '/api/state', {cookie: viewer})).status, 200);
    assert.equal((await call('POST', '/api/candidates', {cookie: viewer, body: candidate})).status, 403);
    assert.equal((await call('PATCH', '/api/settings', {cookie: viewer, body: settings})).status, 403);
    assert.equal((await call('POST', '/api/users', {cookie: viewer, body: {email: 'v@x.test', password: 'long-enough-pass', role: 'member'}})).status, 403);

    // Member: may write content, may not touch admin surfaces.
    assert.equal((await call('POST', '/api/candidates', {cookie: member, body: candidate})).status, 201);
    assert.equal((await call('PATCH', '/api/settings', {cookie: member, body: settings})).status, 403);
    assert.equal((await call('POST', '/api/users', {cookie: member, body: {email: 'm@x.test', password: 'long-enough-pass', role: 'member'}})).status, 403);

    // Admin: admin surfaces allowed.
    assert.equal((await call('PATCH', '/api/settings', {cookie: admin, body: settings})).status, 200);
    assert.equal((await call('GET', '/api/users', {cookie: admin})).status, 200);
    // But an admin cannot mint an equal-or-higher role.
    assert.equal((await call('POST', '/api/users', {cookie: admin, body: {email: 'o@x.test', password: 'long-enough-pass', role: 'owner'}})).status, 403);

    // Cross-origin writes are refused even with a valid session (CSRF defence).
    assert.equal((await call('POST', '/api/candidates', {cookie: admin, body: candidate, headers: {Origin: 'https://evil.example'}})).status, 403);
    // The same-origin write still succeeds.
    assert.equal((await call('POST', '/api/candidates', {cookie: admin, body: {url: 'https://x.com/a/status/2', text: 'Another candidate long enough.', author: 'Tester'}, headers: {Origin: t.base}})).status, 201);
  } finally {
    await t.stop();
  }
});
