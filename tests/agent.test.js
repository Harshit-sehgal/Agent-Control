import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import net from 'node:net';
import * as agent from '../src/agent.js';
import {SqliteStore} from '../src/sqlite-store.js';

async function harness() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-proto-'));
  const store = await new SqliteStore(path.join(dir, 'state.db'), path.join(dir, 'state.json')).init();
  store.run("INSERT INTO workspaces (id,name,created_at) VALUES ('default','Primary workspace',?)", new Date().toISOString());
  // Attaching the vault generates a keyfile inside the (temporary) data dir,
  // exactly like the server does at boot.
  agent.attachVault(store, path.join(dir, 'state.json'));
  return {dir, store};
}
const sha256 = value => crypto.createHash('sha256').update(String(value)).digest('hex');

test('pairing codes are hashed, single-use and expiring', async () => {
  const {store, dir} = await harness();
  const {code, expiresAt} = agent.createPairing(store, 'default', {label: 'Laptop', createdBy: 'owner@localhost'});
  assert.ok(Date.parse(expiresAt) > Date.now());
  // The code is stored only as a hash; the same database read cannot redeem it twice.
  const row = store.get('SELECT * FROM pairing_codes');
  assert.notEqual(row.code_hash, code);
  const first = agent.redeemPairing(store, {code, name: 'Laptop agent', permissions: ['http.check']});
  assert.deepEqual(first.permissions, ['http.check']);
  assert.match(first.secret, /^[A-Za-z0-9_-]{20,}$/);
  assert.throws(() => agent.redeemPairing(store, {code, name: 'Again'}), /already been used/);
  assert.throws(() => agent.redeemPairing(store, {code: 'WRONGCODE', name: 'x'}), /not valid/);
  // Expiry is enforced even for a valid code.
  const {code: lateCode} = agent.createPairing(store, 'default', {});
  store.run('UPDATE pairing_codes SET expires_at=? WHERE code_hash=?', new Date(Date.now() - 1000).toISOString(), sha256(lateCode));
  assert.throws(() => agent.redeemPairing(store, {code: lateCode, name: 'Late'}), /expired/);
  await fs.rm(dir, {recursive: true, force: true});
});

test('signed requests reject tampering, stale clocks, replays and revoked agents', async () => {
  const {store, dir} = await harness();
  const {code} = agent.createPairing(store, 'default', {});
  const {agentId, secret} = agent.redeemPairing(store, {code, name: 'Device'});
  const path = '/api/agent/heartbeat';
  const body = '{"version":"1"}';
  const ts = Date.now();
  const good = agent.signRequest(secret, {method: 'POST', path, timestamp: ts, body});
  const device = agent.verifyAgentRequest(store, {'x-agent-id': agentId, 'x-agent-ts': String(ts), 'x-agent-sig': good}, 'POST', path, body);
  assert.equal(device.id, agentId);
  // Tampered body fails.
  assert.throws(() => agent.verifyAgentRequest(store, {'x-agent-id': agentId, 'x-agent-ts': String(ts), 'x-agent-sig': good}, 'POST', path, '{"version":"2"}'), /does not match/);
  // A signature for a different path fails.
  assert.throws(() => agent.verifyAgentRequest(store, {'x-agent-id': agentId, 'x-agent-ts': String(ts), 'x-agent-sig': good}, 'POST', '/api/agent/heartline', body), /does not match/);
  // Stale clock fails.
  const old = Date.now() - 10 * 60000;
  const stale = agent.signRequest(secret, {method: 'POST', path, timestamp: old, body});
  assert.throws(() => agent.verifyAgentRequest(store, {'x-agent-id': agentId, 'x-agent-ts': String(old), 'x-agent-sig': stale}, 'POST', path, body), /outside the accepted window/);
  // Replaying the good request fails.
  assert.throws(() => agent.verifyAgentRequest(store, {'x-agent-id': agentId, 'x-agent-ts': String(ts), 'x-agent-sig': good}, 'POST', path, body), /already used/);
  // Missing headers fail.
  assert.throws(() => agent.verifyAgentRequest(store, {}, 'POST', path, body), /missing its signature headers/);
  // Revocation fails even with a correct signature.
  const fresh = agent.signRequest(secret, {method: 'POST', path, timestamp: Date.now(), body});
  agent.revokeAgent(store, agentId);
  assert.throws(() => agent.verifyAgentRequest(store, {'x-agent-id': agentId, 'x-agent-ts': String(Date.now()), 'x-agent-sig': fresh}, 'POST', path, body), /revoked/);
  await fs.rm(dir, {recursive: true, force: true});
});

test('agent task leasing, duplicate results and disconnect recovery', async () => {
  const {store, dir} = await harness();
  const {code} = agent.createPairing(store, 'default', {});
  const {agentId} = agent.redeemPairing(store, {code, name: 'Device', permissions: ['http.check']});
  const {task} = agent.enqueueAgentTask(store, agentId, {kind: 'http.check', payload: {url: 'https://example.com'}});
  const claimed = agent.claimAgentTasks(store, agentId);
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].id, task.id);
  // A second claim while leased returns nothing (no duplicate delivery).
  assert.equal(agent.claimAgentTasks(store, agentId).length, 0);
  // A completed task cannot be completed twice.
  assert.deepEqual(agent.completeAgentTask(store, agentId, task.id, {status: 'done', result: {ok: true}}), {ok: true, status: 'done'});
  assert.throws(() => agent.completeAgentTask(store, agentId, task.id, {status: 'done', result: {ok: true}}), /already completed/);
  // Failures retry while attempts remain, then fail permanently.
  const {task: flaky} = agent.enqueueAgentTask(store, agentId, {kind: 'http.check', payload: {url: 'https://x'}});
  agent.claimAgentTasks(store, agentId);
  assert.equal(agent.completeAgentTask(store, agentId, flaky.id, {status: 'failed', error: 'network down'}).status, 'queued', 'Attempt 1 of 3 retries.');
  agent.claimAgentTasks(store, agentId);
  assert.equal(agent.completeAgentTask(store, agentId, flaky.id, {status: 'failed', error: 'network down'}).status, 'queued', 'Attempt 2 of 3 retries.');
  agent.claimAgentTasks(store, agentId);
  assert.equal(agent.completeAgentTask(store, agentId, flaky.id, {status: 'failed', error: 'network down'}).status, 'failed', 'Attempt 3 of 3 fails permanently.');
  assert.match(store.get('SELECT * FROM agent_tasks WHERE id=?', flaky.id).error, /network down/);
  // A task left running by a disconnected agent is re-armed, not lost.
  const {task: orphan} = agent.enqueueAgentTask(store, agentId, {kind: 'http.check', payload: {url: 'https://y'}});
  const [claimedOrphan] = agent.claimAgentTasks(store, agentId);
  assert.equal(claimedOrphan.id, orphan.id);
  // The disconnect is observable as an expired lease, which is what recovery keys off.
  store.run('UPDATE agent_tasks SET lease_until=? WHERE id=?', new Date(Date.now() - 1000).toISOString(), orphan.id);
  assert.equal(agent.recoverAgentTasks(store), 1);
  const reClaimed = agent.claimAgentTasks(store, agentId);
  assert.equal(reClaimed.find(t => t.id === orphan.id).attempts, 2, 'The retried task counts its attempts.');
  // Idempotency prevents the same intent being enqueued twice.
  const a = agent.enqueueAgentTask(store, agentId, {kind: 'http.check', payload: {url: 'https://z'}, idempotencyKey: 'click-1'});
  const b = agent.enqueueAgentTask(store, agentId, {kind: 'http.check', payload: {url: 'https://z'}, idempotencyKey: 'click-1'});
  assert.equal(a.duplicate, false);
  assert.equal(b.duplicate, true);
  assert.equal(b.task.id, a.task.id);
  // Unknown kinds are refused, and permissions gate enqueueing.
  assert.throws(() => agent.enqueueAgentTask(store, agentId, {kind: 'shell.exec', payload: {}}), /Unknown agent task kind/);
  const {code: code2} = agent.createPairing(store, 'default', {});
  const plain = agent.redeemPairing(store, {code: code2, name: 'Plain', permissions: []});
  assert.throws(() => agent.enqueueAgentTask(store, plain.agentId, {kind: 'http.check', payload: {url: 'https://example.com'}, permission: 'http.check'}), /does not hold/);
  await fs.rm(dir, {recursive: true, force: true});
});

test('the enqueue itself enforces the browser rule, so no caller can skip it', async () => {
  const {store, dir} = await harness();
  try {
    const {code} = agent.createPairing(store, 'default', {});
    const {agentId} = agent.redeemPairing(store, {code, name: 'Device', permissions: ['browser.action', 'browser.capture']});
    // A click on X is refused here, not only at the route: the scheduler reaches
    // this function directly and used to forward whatever a job carried.
    assert.throws(() => agent.enqueueAgentTask(store, agentId, {kind: 'browser.action', payload: {url: 'https://x.com/home', steps: [{op: 'click', selector: '[data-testid=tweetButton]'}]}}), /never click or type there/);
    // The step count and the url scheme are the same rule, checked in one place.
    assert.throws(() => agent.enqueueAgentTask(store, agentId, {kind: 'browser.action', payload: {url: 'https://example.com', steps: Array.from({length: 26}, () => ({op: 'read', selector: 'main'}))}}), /at most/);
    assert.throws(() => agent.enqueueAgentTask(store, agentId, {kind: 'browser.capture', payload: {url: 'file:///etc/passwd'}}), /public http\(s\) url/);
    // A payload that describes a capture cannot be queued as an action.
    assert.throws(() => agent.enqueueAgentTask(store, agentId, {kind: 'browser.action', payload: {url: 'https://example.com'}}), /describes a browser.capture/);
    // What survives is the canonical shape, not the caller's extra fields.
    const {task} = agent.enqueueAgentTask(store, agentId, {kind: 'browser.action', payload: {url: 'https://example.com', steps: [{op: 'read', selector: 'main'}], sneaky: true}});
    assert.deepEqual(Object.keys(JSON.parse(task.payload)).sort(), ['steps', 'url']);
  } finally { await fs.rm(dir, {recursive: true, force: true}); }
});

test('browser actions are not retried, and failing a task drops queued work', async () => {
  const {store, dir} = await harness();
  const {code} = agent.createPairing(store, 'default', {});
  const {agentId} = agent.redeemPairing(store, {code, name: 'Device', permissions: ['browser.action', 'http.check']});
  const {task} = agent.enqueueAgentTask(store, agentId, {kind: 'browser.action', payload: {url: 'https://example.com', steps: [{op: 'click', selector: 'button'}]}});
  assert.equal(task.max_attempts, 1);
  agent.claimAgentTasks(store, agentId);
  assert.equal(agent.completeAgentTask(store, agentId, task.id, {status: 'failed', error: 'deadline'}).status, 'failed');
  const {task: orphan} = agent.enqueueAgentTask(store, agentId, {kind: 'browser.action', payload: {url: 'https://example.com', steps: [{op: 'read', selector: 'main'}]}});
  agent.claimAgentTasks(store, agentId);
  store.run('UPDATE agent_tasks SET lease_until=? WHERE id=?', new Date(Date.now() - 1000).toISOString(), orphan.id);
  assert.equal(agent.recoverAgentTasks(store), 1);
  assert.equal(store.get('SELECT status FROM agent_tasks WHERE id=?', orphan.id).status, 'failed');
  const {task: held} = agent.enqueueAgentTask(store, agentId, {kind: 'http.check', payload: {url: 'https://example.com'}});
  agent.failAgentTasks(store, [held.id], 'Browser request was denied.');
  assert.equal(store.get('SELECT status FROM agent_tasks WHERE id=?', held.id).status, 'failed');
  assert.equal(agent.claimAgentTasks(store, agentId).length, 0);
  await fs.rm(dir, {recursive: true, force: true});
});

test('a live device renews its running leases so a slow task is not run twice', async () => {
  const {store, dir} = await harness();
  try {
    const {code} = agent.createPairing(store, 'default', {});
    const {agentId} = agent.redeemPairing(store, {code, name: 'Device', permissions: ['http.check']});
    const {code: other} = agent.createPairing(store, 'default', {});
    const second = agent.redeemPairing(store, {code: other, name: 'Other', permissions: ['http.check']});
    const t0 = Date.now();
    const {task: slow} = agent.enqueueAgentTask(store, agentId, {kind: 'http.check', payload: {url: 'https://example.com'}});
    const {task: queued} = agent.enqueueAgentTask(store, agentId, {kind: 'http.check', payload: {url: 'https://example.org'}});
    const {task: foreign} = agent.enqueueAgentTask(store, second.agentId, {kind: 'http.check', payload: {url: 'https://example.net'}});
    // One task at a time on this device, like its serial queue.
    agent.claimAgentTasks(store, agentId, {leaseMs: 1000, limit: 1, nowMs: t0});
    // The other device holds a long lease and is not heartbeating in this test.
    agent.claimAgentTasks(store, second.agentId, {leaseMs: 60000, nowMs: t0});
    // Not queued work, not another device's lease: only this device's running task.
    assert.equal(agent.renewAgentTaskLeases(store, agentId, {leaseMs: 1000, nowMs: t0 + 900}), 1);
    // The heartbeat arrives after the original lease would have lapsed; the task
    // is still executing, so recovery must leave it alone.
    assert.equal(agent.recoverAgentTasks(store, t0 + 1500), 0, 'a renewed lease is not a disconnect');
    assert.equal(store.get('SELECT status FROM agent_tasks WHERE id=?', slow.id).status, 'running');
    assert.equal(store.get('SELECT status FROM agent_tasks WHERE id=?', queued.id).status, 'queued');
    // Without the renewal the same moment re-arms it (the bug this fixes).
    store.run('UPDATE agent_tasks SET lease_until=? WHERE id=?', new Date(t0 + 1000).toISOString(), slow.id);
    assert.equal(agent.recoverAgentTasks(store, t0 + 1500), 1);
    assert.equal(store.get('SELECT status FROM agent_tasks WHERE id=?', slow.id).status, 'queued');
    assert.equal(store.get('SELECT status FROM agent_tasks WHERE id=?', foreign.id).status, 'running', 'the other device keeps its lease');
  } finally { await fs.rm(dir, {recursive: true, force: true}); }
});

test('a live device keeps its task through a lapsed lease, and a superseded result is fenced', async () => {
  const {store, dir} = await harness();
  try {
    const {code} = agent.createPairing(store, 'default', {});
    const {agentId} = agent.redeemPairing(store, {code, name: 'Device', permissions: ['browser.action', 'browser.capture']});
    const t0 = Date.now();
    // A click that outlives its lease: 25 steps at up to 15s each is minutes.
    const {task: click} = agent.enqueueAgentTask(store, agentId, {kind: 'browser.action', payload: {url: 'https://example.com', steps: [{op: 'click', selector: 'button'}]}});
    const [claimedClick] = agent.claimAgentTasks(store, agentId, {leaseMs: 1000, nowMs: t0});
    assert.equal(claimedClick.attempts, 1);
    // The device is still working: it was seen a minute ago, and the lease has
    // lapsed because that heartbeat did not renew it (the loop was blocked).
    agent.touchAgent(store, agentId);
    store.run('UPDATE agent_tasks SET lease_until=? WHERE id=?', new Date(t0).toISOString(), click.id);
    assert.equal(agent.recoverAgentTasks(store, t0 + 60000), 0, 'a device seen inside the lease window is not a disconnect');
    assert.equal(store.get('SELECT status FROM agent_tasks WHERE id=?', click.id).status, 'running',
      'a click that landed is not reported as "The agent disconnected" while the device is alive');
    // The honest result then lands, for the attempt it was claimed with.
    assert.deepEqual(agent.completeAgentTask(store, agentId, click.id, {status: 'done', result: {clicked: true}, attempts: claimedClick.attempts}), {ok: true, status: 'done'});

    // A capture is the same: re-queueing it would read the page a second time.
    const {task: read} = agent.enqueueAgentTask(store, agentId, {kind: 'browser.capture', payload: {url: 'https://example.com'}});
    agent.claimAgentTasks(store, agentId, {leaseMs: 1000, nowMs: t0});
    agent.touchAgent(store, agentId);
    store.run('UPDATE agent_tasks SET lease_until=? WHERE id=?', new Date(t0).toISOString(), read.id);
    assert.equal(agent.recoverAgentTasks(store, t0 + 60000), 0, 'a capture a live device is running is not re-armed as duplicate work');
    assert.equal(agent.claimAgentTasks(store, agentId, {nowMs: t0 + 60000}).length, 0, 'so it cannot be delivered a second time either');
    assert.equal(agent.completeAgentTask(store, agentId, read.id, {status: 'done', result: {title: 'Docs'}, attempts: 1}).status, 'done');

    // A device that has not been seen for ten minutes is gone: that lease is a
    // real disconnect, and a browser action still fails instead of retrying.
    const {task: abandoned} = agent.enqueueAgentTask(store, agentId, {kind: 'browser.action', payload: {url: 'https://example.com', steps: [{op: 'read', selector: 'main'}]}});
    agent.claimAgentTasks(store, agentId, {leaseMs: 1000, nowMs: t0});
    store.run('UPDATE agent_tasks SET lease_until=? WHERE id=?', new Date(t0).toISOString(), abandoned.id);
    assert.equal(agent.recoverAgentTasks(store, t0 + 600000), 1);
    assert.equal(store.get('SELECT status FROM agent_tasks WHERE id=?', abandoned.id).status, 'failed');

    // Fencing: a task recovered and claimed again runs as attempt 2, and the
    // first attempt's late result must not overwrite the run in progress.
    const {task: late} = agent.enqueueAgentTask(store, agentId, {kind: 'browser.capture', payload: {url: 'https://example.com/late'}});
    const [firstAttempt] = agent.claimAgentTasks(store, agentId, {leaseMs: 1000, nowMs: t0});
    assert.equal(firstAttempt.attempts, 1);
    store.run('UPDATE agent_tasks SET lease_until=? WHERE id=?', new Date(t0).toISOString(), late.id);
    assert.equal(agent.recoverAgentTasks(store, t0 + 600000), 1);
    const [secondAttempt] = agent.claimAgentTasks(store, agentId, {nowMs: t0 + 600000});
    assert.equal(secondAttempt.attempts, 2);
    assert.throws(
      () => agent.completeAgentTask(store, agentId, late.id, {status: 'done', result: {title: 'stale'}, attempts: firstAttempt.attempts}),
      error => error.status === 409 && /earlier attempt/.test(error.message),
      'a result for a superseded attempt is refused, not silently accepted');
    const running = store.get('SELECT status, attempts, result FROM agent_tasks WHERE id=?', late.id);
    assert.deepEqual([running.status, running.attempts], ['running', 2], 'the newer attempt is untouched by the stale result');
    assert.equal(running.result, null);
    // The attempt that is actually running completes normally.
    assert.equal(agent.completeAgentTask(store, agentId, late.id, {status: 'done', result: {title: 'fresh'}, attempts: secondAttempt.attempts}).status, 'done');
    assert.deepEqual(JSON.parse(store.get('SELECT result FROM agent_tasks WHERE id=?', late.id).result), {title: 'fresh'});
  } finally { await fs.rm(dir, {recursive: true, force: true}); }
});

test('the HTTP protocol pairs, dispatches and collects results end to end', {timeout: 40000}, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-http-'));
  const port = await new Promise((resolve, reject) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); s.on('error', reject); });
  const base = `http://127.0.0.1:${port}`;
  // A local endpoint for the agent to check, so no external network is needed.
  const target = http.createServer((req, res) => res.end('agent target ok'));
  await new Promise(r => target.listen(0, '127.0.0.1', r));
  const targetUrl = `http://127.0.0.1:${target.address().port}/`;
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: {...process.env, AGENT_SKIP_DOTENV: '1', AI_API_KEY: '', OPENAI_API_KEY: '', AI_BASE_URL: '', DASHBOARD_PASSWORD: 'test-password-1234', HOST: '127.0.0.1', PORT: String(port), DATA_FILE: path.join(dir, 'state.json')},
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', b => output += b.toString());
  child.stderr.on('data', b => output += b.toString());
  const wait = async () => { for (let i = 0; i < 120; i++) { if (child.exitCode !== null) return false; try { if ((await fetch(base + '/api/health')).ok) return true; } catch {} await new Promise(r => setTimeout(r, 70)); } return false; };
  const send = async (method, url, body, cookie) => {
    const res = await fetch(base + url, {method, headers: {'Content-Type': 'application/json', ...(cookie ? {Cookie: cookie} : {})}, body: body === undefined ? undefined : JSON.stringify(body)});
    const value = await res.json().catch(() => null);
    return {status: res.status, body: value, cookie: res.headers.get('set-cookie')};
  };
  try {
    assert.equal(await wait(), true);
    const owner = (await send('POST', '/api/login', {password: 'test-password-1234'})).cookie.split(';')[0];
    const admin = send; // alias for readability
    // Pairing code creation needs admin; member/owner passes.
    const pairing = await admin('POST', '/api/agents/pair', {label: 'Test laptop'}, owner);
    assert.equal(pairing.status, 201);
    assert.match(pairing.body.code, /^[A-Z0-9]{10}$/);
    // An unsigned pairing attempt fails.
    assert.equal((await send('POST', '/api/agent/pair', {code: 'AAAAAAAAAA', name: 'x'})).status, 401);
    // Redeem it the way the agent device does (this request is intentionally unsigned).
    const paired = await send('POST', '/api/agent/pair', {code: pairing.body.code, name: 'Test laptop', permissions: ['http.check']});
    assert.equal(paired.status, 201);
    const {agentId, secret} = paired.body;
    const agentCall = async (requestPath, body) => {
      const timestamp = Date.now();
      const raw = JSON.stringify(body);
      const signature = agent.signRequest(secret, {method: 'POST', path: requestPath, timestamp, body: raw});
      const res = await fetch(base + requestPath, {method: 'POST', headers: {'Content-Type': 'application/json', 'X-Agent-Id': agentId, 'X-Agent-Ts': String(timestamp), 'X-Agent-Sig': signature}, body: raw});
      const value = await res.json().catch(() => null);
      return {status: res.status, body: value};
    };
    // An unsigned heartbeat is refused, a signed one is accepted.
    const bare = await fetch(base + '/api/agent/heartbeat', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{}'});
    assert.equal(bare.status, 401);
    const beat = await agentCall('/api/agent/heartbeat', {version: '1', os: 'linux'});
    assert.equal(beat.status, 200);
    assert.deepEqual(beat.body.tasks, []);
    assert.ok(Array.isArray(beat.body.agent.permissions));
    // Enqueue work for the agent; the heartbeat delivers it.
    const queued = await admin('POST', `/api/agents/${agentId}/tasks`, {kind: 'http.check', payload: {url: targetUrl}, idempotencyKey: 'check-1'}, owner);
    assert.equal(queued.status, 201);
    const dupe = await admin('POST', `/api/agents/${agentId}/tasks`, {kind: 'http.check', payload: {url: targetUrl}, idempotencyKey: 'check-1'}, owner);
    assert.equal(dupe.status, 200);
    assert.equal(dupe.body.duplicate, true);
    const delivered = await agentCall('/api/agent/heartbeat', {version: '1'});
    assert.equal(delivered.body.tasks.length, 1);
    const task = delivered.body.tasks[0];
    assert.equal(task.kind, 'http.check');
    // Execute the way the agent process would, then report the result.
    const started = Date.now();
    const probe = await fetch(task.payload.url);
    assert.equal(probe.status, 200);
    const result = {url: task.payload.url, httpStatus: probe.status, ok: true, latencyMs: Date.now() - started, checkedAt: new Date().toISOString()};
    const reported = await agentCall(`/api/agent/tasks/${task.id}/result`, {status: 'done', result});
    assert.equal(reported.status, 200);
    // Duplicate delivery of the same result is rejected, never double-applied.
    const again = await agentCall(`/api/agent/tasks/${task.id}/result`, {status: 'done', result});
    assert.equal(again.status, 409);
    // The dashboard lists the agent as recently online.
    const list = await admin('GET', '/api/agents', undefined, owner);
    assert.equal(list.body.agents[0].id, agentId);
    assert.equal(list.body.agents[0].status, 'online');
    assert.deepEqual(list.body.agents[0].permissions, ['http.check']);
    // A revoked agent can no longer heartbeat.
    assert.equal((await admin('DELETE', `/api/agents/${agentId}`, undefined, owner)).status, 200);
    const afterRevoke = await agentCall('/api/agent/heartbeat', {version: '1'});
    assert.equal(afterRevoke.status, 403);
  } finally {
    child.kill('SIGINT');
    await new Promise(r => child.once('exit', r));
    target.close();
    await fs.rm(dir, {recursive: true, force: true});
  }
});

test('a pairing code carries the admin scope, and the device can only narrow it', async () => {
  const {store, dir} = await harness();
  try {
    // The admin issues a read-only code; the device asks for more and gets only
    // the intersection, never the extra permission.
    const {code} = agent.createPairing(store, 'default', {permissions: ['http.check']});
    const widened = agent.redeemPairing(store, {code, name: 'Device', permissions: ['http.check', 'browser.action']});
    assert.deepEqual(widened.permissions, ['http.check']);
    // A device may also take a subset of what the admin allowed.
    const {code: open} = agent.createPairing(store, 'default', {permissions: ['http.check', 'browser.action']});
    const narrowed = agent.redeemPairing(store, {code: open, name: 'Device2', permissions: ['http.check']});
    assert.deepEqual(narrowed.permissions, ['http.check']);
    // Issuing a code with an unknown permission stores nothing usable.
    const {code: bogus} = agent.createPairing(store, 'default', {permissions: ['publish.post']});
    assert.deepEqual(agent.redeemPairing(store, {code: bogus, name: 'Device3'}).permissions, []);
  } finally { await fs.rm(dir, {recursive: true, force: true}); }
});
