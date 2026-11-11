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

async function launch(extra = {}) {
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
      ...extra,
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

/** One request helper, so a second scenario does not grow a second dialect. */
function client(base) {
  return async (method, url, body, cookie, headers = {}) => {
    const r = await fetch(base + url, {
      method,
      headers: {'Content-Type': 'application/json', ...headers, ...(cookie ? {Cookie: cookie} : {})},
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    let value = null;
    try { value = JSON.parse(text); } catch { value = text; }
    return {status: r.status, body: value, setCookie: r.headers.get('set-cookie'), headers: r.headers};
  };
}

test('one authenticated request cannot reach a prototype key, a phantom setting, a lockout, a typo role, or an unusable source', {timeout: 40000}, async () => {
  const t = await launch();
  try {
    const send = client(t.base);

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

  } finally {
    await t.stop();
  }
});

test('a wrong verb, a non-scalar id and a wrong-typed credential are client mistakes, not server faults', {timeout: 40000}, async () => {
  const t = await launch();
  try {
    const send = client(t.base);
    const login = await send('POST', '/api/login', {password: PASSWORD});
    assert.equal(login.status, 200);
    const cookie = String(login.setCookie).split(';')[0];

    // A path that exists under another verb says so, and names the verbs it does
    // take. It used to answer 404 "Unknown endpoint." for `POST /api/state`.
    const wrongVerb = await send('POST', '/api/state', {}, cookie);
    assert.equal(wrongVerb.status, 405);
    assert.match(String(wrongVerb.body?.error || ''), /method not allowed/i);
    assert.match(String(wrongVerb.headers.get('allow') || ''), /GET/);

    // An id that is an object used to be bound into SQL: better-sqlite3 throws a
    // TypeError with no status, which the dispatcher reported as a 500 and
    // logged as a server fault.
    const pref = await send('PATCH', '/api/notification-prefs', {webhook: true, webhookCredentialId: {a: 1}}, cookie);
    assert.ok(pref.status < 500, `a wrong-typed credential must not be a 500, got ${pref.status}`);
    assert.equal(pref.status, 400, 'webhook on with no usable credential is still a bad request');

    const read = await send('POST', '/api/notifications/read', {ids: [{}, null, 7]}, cookie);
    assert.equal(read.status, 200, `object ids must be ignored, not bound into SQL: ${JSON.stringify(read.body)}`);
  } finally {
    await t.stop();
  }
});

test('the limiter can be switched off for a test install, and stays on by default', {timeout: 60000}, async () => {
  // A tunnel puts every client behind one address, so a test install's owner
  // can lock themselves out with a handful of typos. `AUTH_RATE_LIMIT=off` is
  // that escape hatch; it must not change the default, which this file's other
  // test pins.
  const t = await launch({AUTH_RATE_LIMIT: 'off'});
  try {
    const send = client(t.base);
    for (let i = 0; i < 40; i++) {
      const res = await send('POST', '/api/login', {password: 'wrong-password'});
      assert.equal(res.status, 401, `guess ${i + 1} must be a plain refusal, got ${res.status}`);
    }
    const good = await send('POST', '/api/login', {password: PASSWORD});
    assert.equal(good.status, 200, 'the right password still works after all those guesses');
  } finally {
    await t.stop();
  }
});

test('guesses at the owner account are counted against that account, not just the guesser', {timeout: 60000}, async () => {
  // Behind a trusted proxy every request has its own client address, so the
  // per-IP buckets never fill. What stops a password spray here is the account
  // bucket - and it only works if it is keyed on the account the request is
  // *about*: `auth.login` falls back to the bootstrapped owner when the body has
  // no email, so keying on the raw body meant every one of these guesses was
  // counted per address and the owner mailbox was never protected.
  const t = await launch({TRUST_PROXY: '1'});
  try {
    const send = client(t.base);
    const from = ip => ({'X-Forwarded-For': ip});
    let refused = 0;
    for (let i = 0; i < 32; i++) {
      const res = await send('POST', '/api/login', {password: 'wrong-password'}, undefined, from(`10.1.0.${i}`));
      assert.equal(res.status, 401, `guess ${i + 1} should be a normal refusal, got ${res.status}`);
      refused += 1;
    }
    assert.equal(refused, 32);
    // The next guess, from yet another address and spelled the way an attacker
    // would spell the same mailbox, is refused by the account bucket.
    const locked = await send('POST', '/api/login', {email: 'OWNER@localhost ', password: 'wrong-password'}, undefined, from('10.2.0.1'));
    assert.equal(locked.status, 429, `the account bucket must have filled: ${JSON.stringify(locked.body)}`);
    // And the owner cannot sign in either until the window passes: the honest
    // cost of the bucket, pinned so it stays a deliberate trade instead of a
    // surprise. A password reset is the way out.
    const owner = await send('POST', '/api/login', {password: PASSWORD}, undefined, from('10.2.0.2'));
    assert.equal(owner.status, 429);
  } finally {
    await t.stop();
  }
});
