import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';

/* The real server and the real agent process, with no browser on the device.
 * That is the path a device takes when Chrome is not installed: the live line
 * must still work (the owner is told the device is there), nothing must crash,
 * and the agent must stop at once when asked, not after a long poll ends. */

test('a real agent opens its live line, serves the owner a status, and stops promptly', {timeout: 60000}, async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'live-browser-e2e-'));
  const port = await new Promise((resolve, reject) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); s.on('error', reject); });
  const base = `http://127.0.0.1:${port}`, root = path.resolve(import.meta.dirname, '..');
  const server = spawn(process.execPath, ['src/server.js'], {cwd: root, env: {...process.env, AGENT_SKIP_DOTENV: '1', AI_API_KEY: '', OPENAI_API_KEY: '', AI_BASE_URL: '', DASHBOARD_PASSWORD: 'test-password-1234', HOST: '127.0.0.1', PORT: String(port), DATA_FILE: path.join(dir, 'state.json')}, stdio: ['ignore', 'pipe', 'pipe']});
  let worker = null, workerLog = '';
  const send = async (method, url, body, cookie) => {
    const res = await fetch(base + url, {method, headers: {'Content-Type': 'application/json', ...(cookie ? {Cookie: cookie} : {})}, body: body === undefined ? undefined : JSON.stringify(body)});
    return {status: res.status, body: await res.json().catch(() => null), cookie: res.headers.get('set-cookie')};
  };
  const until = async (probe, what) => { for (let i = 0; i < 150; i++) { const value = await probe(); if (value) return value; await new Promise(r => setTimeout(r, 100)); } assert.fail(`timed out waiting for ${what}`); };
  try {
    await until(async () => { try { return (await fetch(base + '/api/health')).ok; } catch { return false; } }, 'the server');
    const owner = (await send('POST', '/api/login', {password: 'test-password-1234'})).cookie.split(';')[0];
    const bot = (await send('GET', '/api/state', undefined, owner)).body.groups.find(g => g.id === 'home').bots[0].id;
    assert.equal((await send('GET', `/api/browser-live/${bot}`, undefined, owner)).body.agent, false, 'no device yet');
    const {body: pairing} = await send('POST', '/api/agents/pair', {label: 'Laptop', permissions: ['browser.capture', 'browser.action']}, owner);
    const config = path.join(dir, 'agent.config.json');
    const env = {...process.env, AGENT_SKIP_DOTENV: '1', AGENT_CONFIG: config, AGENT_POLL_MS: '2000', AGENT_BROWSER: '1', AGENT_BROWSER_ALLOWLIST: '*', AGENT_BROWSER_PATH: path.join(dir, 'no-such-chrome')};
    const paired = await new Promise(resolve => { const c = spawn(process.execPath, ['agent/agent.mjs', 'pair', '--server', base, '--code', pairing.code], {cwd: root, env, stdio: 'ignore'}); c.on('exit', resolve); });
    assert.equal(paired, 0);
    fs.writeFileSync(config, JSON.stringify({...JSON.parse(fs.readFileSync(config, 'utf8')), pollIntervalMs: 2000}));
    worker = spawn(process.execPath, ['agent/agent.mjs', 'run'], {cwd: root, env, stdio: ['ignore', 'pipe', 'pipe']});
    worker.stdout.on('data', b => { workerLog += b; });
    worker.stderr.on('data', b => { workerLog += b; });
    const seen = await until(async () => { const v = (await send('GET', `/api/browser-live/${bot}`, undefined, owner)).body; return v?.agent ? v : null; }, 'the device\'s live line');
    assert.equal(seen.changed, false, 'no browser, so no frame');
    // Input while the owner is not driving is refused, over the real server too.
    assert.equal((await send('POST', `/api/browser-live/${bot}/input`, {type: 'click', x: 1, y: 2}, owner)).status, 409);
    assert.equal((await send('GET', `/api/browser-live/${bot}`)).status, 401);
    // The owner takes over, but the device has no browser: the owner is told why, and holds nothing.
    assert.deepEqual((await send('POST', `/api/browser-live/${bot}/takeover`, undefined, owner)).body, {botId: bot, state: 'driving'});
    const failed = await until(async () => { const v = (await send('GET', `/api/browser-live/${bot}`, undefined, owner)).body; return v?.notice ? v : null; }, 'the takeover failure');
    assert.match(failed.notice, /could not be started/);
    const listed = (await send('GET', '/api/browser-live', undefined, owner)).body.find(e => e.botId === bot);
    assert.deepEqual([listed.state, listed.live], ['idle', true]);
    // Stop: the long poll is aborted, so the agent is gone in moments.
    const exited = new Promise(resolve => worker.once('exit', resolve));
    const started = Date.now();
    worker.kill('SIGTERM');
    await exited;
    assert.ok(Date.now() - started < 8000, `the agent stopped in ${Date.now() - started} ms`);
    assert.match(workerLog, /agent: stopped\./);
    assert.doesNotMatch(workerLog, /live view failed/, 'a healthy live line logs no failure');
    worker = null;
  } finally {
    if (worker) { worker.kill('SIGKILL'); await new Promise(r => worker.once('exit', r)); }
    server.kill('SIGINT');
    await new Promise(r => server.once('exit', r));
    await fsp.rm(dir, {recursive: true, force: true});
  }
});
