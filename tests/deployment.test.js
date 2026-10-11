import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

const root = path.resolve(import.meta.dirname, '..');

async function harness() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-tls-'));
  const port = await new Promise((resolve, reject) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); s.on('error', reject); });
  // A throwaway self-signed pair, exactly like a single-host private install.
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem'), '-days', '2', '-nodes', '-subj', '/CN=localhost'], {stdio: 'ignore'});
  return {dir, port};
}

test('TLS_CERT and TLS_KEY together serve HTTPS with Secure session cookies', {timeout: 40000}, async () => {
  const {dir, port} = await harness();
  // Self-signed certificate: the test client accepts it explicitly rather than
  // weakening anything global outside this test.
  const previousReject = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  const base = `https://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: root,
    env: {...process.env, AGENT_SKIP_DOTENV: '1', AI_API_KEY: '', OPENAI_API_KEY: '', AI_BASE_URL: '', DASHBOARD_PASSWORD: 'tls-password-1234', HOST: '127.0.0.1', PORT: String(port), DATA_FILE: path.join(dir, 'state.json'), TLS_CERT: path.join(dir, 'cert.pem'), TLS_KEY: path.join(dir, 'key.pem'), NODE_TLS_REJECT_UNAUTHORIZED: '0'},
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', b => output += b.toString());
  child.stderr.on('data', b => output += b.toString());
  const wait = async () => { for (let i = 0; i < 120; i++) { if (child.exitCode !== null) return false; try { if ((await fetch(base + '/api/health')).ok) return true; } catch {} await new Promise(r => setTimeout(r, 70)); } return false; };
  try {
    assert.equal(await wait(), true, output);
    assert.match(output, /serving HTTPS/);
    const login = await fetch(base + '/api/login', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({password: 'tls-password-1234'})});
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie');
    assert.match(cookie, /HttpOnly/, 'The session cookie stays HttpOnly.');
    assert.match(cookie, /Secure/, 'Behind TLS the cookie is marked Secure.');
    // The browser still needs an in-memory process check: plain HTTP is refused
    // by the TLS listener, which is the point of terminating TLS here.
    await assert.rejects(() => fetch(`http://127.0.0.1:${port}/api/health`));
  } finally {
    if (previousReject === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previousReject;
    child.kill('SIGINT');
    await new Promise(r => child.once('exit', r));
    await fs.rm(dir, {recursive: true, force: true});
  }
});

test('a half-configured TLS pair fails fast instead of silently serving plaintext', {timeout: 20000}, async () => {
  const {dir, port} = await harness();
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: root,
    env: {...process.env, AGENT_SKIP_DOTENV: '1', DASHBOARD_PASSWORD: 'x', HOST: '127.0.0.1', PORT: String(port + 1), DATA_FILE: path.join(dir, 'state.json'), TLS_CERT: path.join(dir, 'cert.pem')},
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', b => output += b.toString());
  child.stderr.on('data', b => output += b.toString());
  await new Promise(resolve => child.once('exit', resolve));
  assert.match(output, /TLS_CERT and TLS_KEY must be set together/);
  assert.notEqual(child.exitCode, 0);
  await fs.rm(dir, {recursive: true, force: true});
});
