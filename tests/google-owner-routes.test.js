/** Owner sign-in with Google, over HTTP, against a fake Google token endpoint; and a new install that makes up no
 * password. The flow's own checks are in tests/google-owner.test.js. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const {port} = s.address(); s.close(() => resolve(port)); }); s.on('error', reject); });
const OWNER = {OWNER_EMAIL: 'me@example.com', GOOGLE_CLIENT_ID: 'client-1.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'shh'};

async function launch(env = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-owner-')), port = await freePort(), base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['src/server.js'], {cwd: root, env: {...process.env, AGENT_SKIP_DOTENV: '1', AI_API_KEY: '', OPENAI_API_KEY: '', AI_BASE_URL: '', OPENAI_BASE_URL: '',
    DASHBOARD_PASSWORD: '', OWNER_EMAIL: '', GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', PUBLIC_ORIGIN: '', PUBLIC_BASE_URL: '', LOCAL_AGENT: '0',
    HOST: '127.0.0.1', PORT: String(port), DATA_FILE: path.join(dir, 'state.json'), ...env}});
  let output = '';
  child.stdout.on('data', b => { output += b; });
  child.stderr.on('data', b => { output += b; });
  for (let i = 0; i < 90; i++) {
    if (child.exitCode !== null) break;
    try { if ((await fetch(`${base}/api/health`)).ok) return {base, output: () => output, async stop() { child.kill('SIGINT'); await new Promise(r => child.once('exit', r)); await fs.rm(dir, {recursive: true, force: true}); }}; } catch { /* starting */ }
    await new Promise(r => setTimeout(r, 70));
  }
  child.kill();
  throw new Error(`Server did not start: ${output}`);
}

/** A stand-in for Google's token endpoint that answers with an id_token for `email` and the nonce it is told. */
async function fakeGoogle() {
  const port = await freePort();
  const state = {email: 'me@example.com', nonce: ''};
  const b64 = v => Buffer.from(JSON.stringify(v)).toString('base64url');
  const server = http.createServer((req, res) => {
    const claims = {iss: 'https://accounts.google.com', aud: OWNER.GOOGLE_CLIENT_ID, exp: Math.floor(Date.now() / 1000) + 600, nonce: state.nonce, email: state.email, email_verified: true};
    res.writeHead(200, {'content-type': 'application/json'});
    res.end(JSON.stringify({id_token: `${b64({alg: 'RS256'})}.${b64(claims)}.sig`}));
  });
  await new Promise(r => server.listen(port, '127.0.0.1', r));
  return {url: `http://127.0.0.1:${port}/token`, state, close: () => new Promise(r => server.close(r))};
}

const methods = async t => (await fetch(`${t.base}/api/auth/methods`)).json();

test('a new install makes up no password and offers no Google until it is set up', {timeout: 30000}, async () => {
  const t = await launch();
  try {
    assert.deepEqual(await methods(t), {password: true, google: false});
    assert.doesNotMatch(t.output(), /Temporary dashboard password/);
    assert.match(t.output(), /OWNER_EMAIL/, 'the boot log says how to get in');
    for (const password of ['', 'anything-at-all', 'test-password-1234']) {
      const r = await fetch(`${t.base}/api/login`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({password})});
      assert.notEqual(r.status, 200, `the password ${JSON.stringify(password)} must not open an account that has none`);
    }
    const start = await fetch(`${t.base}/api/auth/google/start`, {redirect: 'manual'});
    assert.equal(start.status, 302);
    assert.match(start.headers.get('location'), /\?signin=google-refused$/);
  } finally { await t.stop(); }
});

test('the owner signs in with Google, can then set a password, and another account cannot', {timeout: 30000}, async () => {
  const google = await fakeGoogle();
  const t = await launch({...OWNER, GOOGLE_AUTH_URL: 'https://accounts.example.test/auth', GOOGLE_TOKEN_URL: google.url});
  const signIn = async () => {
    const start = await fetch(`${t.base}/api/auth/google/start`, {redirect: 'manual'});
    assert.equal(start.status, 302);
    const to = new URL(start.headers.get('location'));
    assert.equal(to.origin, 'https://accounts.example.test');
    assert.equal(to.searchParams.get('redirect_uri'), `${t.base}/api/auth/google/callback`);
    const flowCookie = start.headers.get('set-cookie').split(';')[0];
    assert.match(start.headers.get('set-cookie'), /HttpOnly/);
    google.state.nonce = to.searchParams.get('nonce');
    return fetch(`${t.base}/api/auth/google/callback?state=${to.searchParams.get('state')}&code=abc`, {redirect: 'manual', headers: {cookie: flowCookie}});
  };
  try {
    assert.deepEqual(await methods(t), {password: true, google: true});
    assert.match(t.output(), /Sign in with Google as me@example\.com/);

    const back = await signIn();
    assert.equal(back.status, 302);
    assert.equal(back.headers.get('location'), `${t.base}/`);
    const session = back.headers.get('set-cookie').match(/agent_session=[^;]+/)?.[0];
    assert.ok(session, 'a session cookie is set');
    const me = await (await fetch(`${t.base}/api/me`, {headers: {cookie: session}})).json();
    assert.equal(me.role, 'owner');
    assert.equal(me.hasPassword, false);

    // No password yet: one is set without a current one, and then it signs in and is asked for next time.
    const set = await fetch(`${t.base}/api/auth/password`, {method: 'POST', headers: {'content-type': 'application/json', cookie: session}, body: JSON.stringify({newPassword: 'a-new-password-1'})});
    assert.equal(set.status, 200);
    const login = await fetch(`${t.base}/api/login`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({password: 'a-new-password-1'})});
    assert.equal(login.status, 200);
    const again = await fetch(`${t.base}/api/auth/password`, {method: 'POST', headers: {'content-type': 'application/json', cookie: session}, body: JSON.stringify({newPassword: 'another-one-22'})});
    assert.equal(again.status, 401, 'once there is a password, changing it needs it');

    google.state.email = 'someone-else@example.com';
    const refused = await signIn();
    assert.equal(refused.headers.get('location'), `${t.base}/?signin=google-refused`);
    assert.equal(/agent_session=[a-f0-9]/.test(refused.headers.get('set-cookie') || ''), false);
    assert.match(t.output(), /not-owner/, 'the reason is logged for the operator');

    const forged = await fetch(`${t.base}/api/auth/google/callback?state=${'a'.repeat(64)}&code=abc`, {redirect: 'manual', headers: {cookie: `owner_google_state=${'a'.repeat(64)}`}});
    assert.equal(forged.headers.get('location'), `${t.base}/?signin=google-refused`);
  } finally { await t.stop(); await google.close(); }
});

test('an install with a password keeps it', {timeout: 30000}, async () => {
  const t = await launch({DASHBOARD_PASSWORD: 'test-password-1234'});
  try {
    const login = await fetch(`${t.base}/api/login`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({password: 'test-password-1234'})});
    assert.equal(login.status, 200);
    const session = login.headers.get('set-cookie').split(';')[0];
    assert.equal((await (await fetch(`${t.base}/api/me`, {headers: {cookie: session}})).json()).hasPassword, true);
  } finally { await t.stop(); }
});
