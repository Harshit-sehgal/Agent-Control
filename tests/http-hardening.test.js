/** HTTP-level checks for the hardening that lives in the request path.
 *
 * Each of these was a real hole reachable with one authenticated request, and
 * each is fixed in a module the unit tests call directly — so this file boots a
 * real server and proves the fix survives the router, the JSON body parser and
 * the role checks, which is where the earlier "fixed" versions fell over:
 *
 *  1. `POST /api/memory/rules {"model":"__proto__"}` wrote onto `Object.prototype`
 *     (`rulebooks['__proto__']` *is* the prototype), changing behaviour everywhere.
 *  2. `PATCH /api/ai {"temperature":0.2}` answered 200 and saved nothing, so a
 *     typo looked applied.
 *  3. The last owner could demote themselves and leave a workspace nobody could
 *     administer again.
 *  4. `POST /api/users {"role":"superuser"}` silently created a member.
 *  5. Evidence marked "do not reuse" was counted and then ignored by the approval
 *     gate, so a draft resting on it could be scheduled.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PASSWORD = 'test-password-1234';

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

async function launch() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-http-'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: root,
    env: {
      ...process.env,
      AGENT_SKIP_DOTENV: '1',
      // Hermetic: no ambient AI provider, so the template draft path is used.
      AI_API_KEY: '', OPENAI_API_KEY: '', AI_BASE_URL: '', OPENAI_BASE_URL: '',
      DASHBOARD_PASSWORD: PASSWORD, HOST: '127.0.0.1', PORT: String(port),
      DATA_FILE: path.join(dir, 'state.json'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', b => (output += b.toString()));
  child.stderr.on('data', b => (output += b.toString()));
  let live = false;
  for (let i = 0; i < 90; i++) {
    if (child.exitCode !== null) break;
    try {
      if ((await fetch(base + '/api/health')).ok) { live = true; break; }
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 70));
  }
  if (!live) {
    child.kill();
    await fs.rm(dir, {recursive: true, force: true});
    throw new Error('Server did not start: ' + output);
  }
  return {
    base, child, dir,
    async stop() {
      child.kill('SIGINT');
      await new Promise(resolve => child.once('exit', resolve));
      await fs.rm(dir, {recursive: true, force: true});
    },
  };
}

test('one authenticated request cannot reach a prototype key, a phantom setting, a lockout, a typo role, or an unusable source', {timeout: 40000}, async () => {
  const t = await launch();
  try {
    const send = async (method, url, body, cookie, headers = {}) => {
      const r = await fetch(t.base + url, {
        method,
        headers: {'Content-Type': 'application/json', ...headers, ...(cookie ? {Cookie: cookie} : {})},
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await r.text();
      let value = null;
      try { value = JSON.parse(text); } catch { value = text; }
      return {status: r.status, body: value, setCookie: r.headers.get('set-cookie')};
    };

    const login = await send('POST', '/api/login', {password: PASSWORD});
    assert.equal(login.status, 200, 'the bootstrap owner must be able to sign in');
    const cookie = String(login.setCookie).split(';')[0];
    const state = (await send('GET', '/api/state', undefined, cookie)).body;

    // 1. Prototype keys are refused over HTTP, and nothing leaked onto Object.prototype.
    for (const model of ['__proto__', 'constructor', 'prototype']) {
      const res = await send('POST', '/api/memory/rules', {model, text: 'remember this durable rule', label: 'x'}, cookie);
      assert.equal(res.status, 400, `${model} must be refused with a 400, got ${res.status}`);
      assert.match(String(res.body?.error || ''), /reserved/i);
    }
    assert.equal(({}).rules, undefined, 'Object.prototype must be untouched');
    const good = await send('POST', '/api/memory/rules', {model: 'env:model-a', text: 'keep replies short'}, cookie);
    assert.equal(good.status, 201, 'an ordinary model key still stores a rule');
    const rules = (await send('GET', '/api/memory', undefined, cookie)).body;
    assert.equal(rules.rulebooks.length, 1);

    // 2. A setting the route does not own is reported, not silently dropped.
    const stray = await send('PATCH', '/api/ai', {temperature: 0.2}, cookie);
    assert.equal(stray.status, 400);
    assert.match(String(stray.body?.error || ''), /Unknown AI setting/);
    // A real default still saves.
    assert.equal((await send('PATCH', '/api/ai', {providerId: null, model: 'gpt-4.1-mini'}, cookie)).status, 200);

    // 3. The last owner cannot demote themselves over HTTP either.
    const users = (await send('GET', '/api/users', undefined, cookie)).body.users;
    const owner = users.find(u => u.role === 'owner');
    assert.ok(owner, 'the bootstrap account is an owner');
    const demote = await send('PATCH', `/api/users/${owner.id}`, {role: 'admin'}, cookie);
    assert.equal(demote.status, 409);
    assert.match(String(demote.body?.error || ''), /last owner/i);
    const still = (await send('GET', '/api/users', undefined, cookie)).body.users.find(u => u.id === owner.id);
    assert.equal(still.role, 'owner', 'a refused demotion must not change the role');

    // 4. An unknown role in an invite is an error, not a silent downgrade.
    const badRole = await send('POST', '/api/users', {email: 'typo@example.test', password: 'typo-password-1', role: 'superuser'}, cookie);
    assert.equal(badRole.status, 400);
    assert.match(String(badRole.body?.error || ''), /Unknown role/);
    assert.equal((await send('GET', '/api/users', undefined, cookie)).body.users.length, users.length, 'no account was created');

    // 5. Material marked "do not reuse" blocks approval instead of being ignored.
    const captured = await send('POST', '/api/capture', {
      url: 'https://x.com/test/status/9001',
      text: 'How can robotics models become more reliable in practice?',
      author: 'Tester', topic: 'robotics',
    }, undefined, {'X-Capture-Token': state.captureToken, Origin: 'chrome-extension://example'});
    assert.equal(captured.status, 201);
    const processed = await send('POST', `/api/candidates/${captured.body.candidate.id}/process`, {}, cookie);
    assert.equal(processed.status, 201);
    const draftId = processed.body.id;
    const added = await send('POST', `/api/drafts/${draftId}/evidence`, {
      kind: 'claim', claim: 'A source that must not be reused.', confidence: 0.6, reuse: 'none',
    }, cookie);
    assert.equal(added.status, 201);
    assert.equal(added.body.verification, 'unverified', 'new evidence starts unverified');
    const blocked = await send('POST', `/api/drafts/${draftId}/approve`, {minDelay: 0, maxDelay: 0}, cookie);
    assert.equal(blocked.status, 409);
    assert.match(String(blocked.body?.error || ''), /do not reuse/i);
    // Changing the policy to something usable unblocks the same draft.
    const id = added.body.id;
    const fixed = await send('PATCH', `/api/evidence/${id}`, {reuse: 'internal'}, cookie);
    if (fixed.status !== 200) {
      // No PATCH route for evidence: drop and re-add under a usable policy.
      assert.equal((await send('DELETE', `/api/evidence/${id}`, undefined, cookie)).status, 200);
      const readded = await send('POST', `/api/drafts/${draftId}/evidence`, {
        kind: 'claim', claim: 'A source that may be used internally.', confidence: 0.6, reuse: 'internal',
      }, cookie);
      assert.equal(readded.status, 201);
    }
    const allowed = await send('POST', `/api/drafts/${draftId}/approve`, {minDelay: 0, maxDelay: 0}, cookie);
    assert.equal(allowed.status, 200, `approval should succeed once the reuse policy allows it: ${JSON.stringify(allowed.body)}`);
  } finally {
    await t.stop();
  }
});
