/** A stdio MCP server runs inside the paired local agent (Phase 6, Task 1).
 *
 * The server's command is configured on the agent's machine only: the server
 * side names it ("files") and never sends a command. The agent spawns it fresh
 * for each call, speaks the same JSON-RPC as the HTTP client, kills it when it
 * is slow or talks too much, and never sends its stderr or environment back.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as agent from '../src/agent.js';
import {SqliteStore} from '../src/sqlite-store.js';
import {runMcpTask} from '../agent/mcp-stdio.mjs';
import {mcpList, mcpCall} from '../src/mcp-client.js';
import {STDIO_SERVER} from './mcp-fixture.js';

const servers = (env = {}, extra = {}) => ({files: {command: process.execPath, args: [STDIO_SERVER], env, ...extra}});

test('mcp.call is a task kind and its own permission', async () => {
  assert.ok(agent.AGENT_ACTIONS.includes('mcp.call'));
  assert.equal(agent.permissionForKind('mcp.call'), 'mcp.call');
});

test('the agent lists and calls a configured server', async () => {
  const listed = await runMcpTask({server: 'files', op: 'list'}, servers());
  assert.equal(listed.ok, true);
  assert.deepEqual(listed.tools.map(t => [t.name, t.write]), [['read_file', false], ['write_file', true]]);
  const called = await runMcpTask({server: 'files', op: 'call', tool: 'read_file', args: {path: 'a.txt'}}, servers({FAKE_MCP_FLAG: 'from-config'}));
  assert.equal(called.ok, true);
  assert.match(called.text, /read_file\(\{"path":"a\.txt"\}\)/);
  assert.match(called.text, /env=from-config/, 'the environment is the one the owner configured on the agent');
});

test('a server that is not configured on this machine is a clear answer, not a crash; the payload cannot name a command', async () => {
  assert.deepEqual(await runMcpTask({server: 'nope', op: 'list'}, servers()), {ok: false, code: 'not-configured', message: 'No MCP server called "nope" is configured on this agent. Add it to mcpServers in the agent config.'});
  const sneaky = await runMcpTask({server: 'files', op: 'list', command: '/bin/sh', args: ['-c', 'touch /tmp/pwned']}, servers());
  assert.equal(sneaky.ok, true, 'the extra fields are ignored; only the configured command runs');
  assert.equal((await runMcpTask({server: 'files', op: 'launch'}, servers())).ok, false);
  assert.equal((await runMcpTask({server: 'files', op: 'call'}, servers())).ok, false, 'a call needs a tool');
  assert.equal((await runMcpTask({server: 'files', op: 'list'}, {})).code, 'not-configured');
  assert.equal((await runMcpTask({server: '__proto__', op: 'list'}, {})).code, 'not-configured');
});

test('a server that never answers is killed at the time limit and the next call still works', async () => {
  const started = Date.now();
  const slow = await runMcpTask({server: 'files', op: 'list', timeoutMs: 5000}, servers({FAKE_MCP_MODE: 'silent'}), {timeoutMs: 400});
  assert.equal(slow.ok, false);
  assert.equal(slow.code, 'timeout');
  assert.ok(Date.now() - started < 4000);
  assert.equal((await runMcpTask({server: 'files', op: 'list'}, servers())).ok, true);
});

test('a server that talks forever is cut at the output cap, and a huge result is cut to the result cap', async () => {
  const endless = await runMcpTask({server: 'files', op: 'list'}, servers({FAKE_MCP_MODE: 'endless'}), {timeoutMs: 20000, maxBytes: 200000});
  assert.deepEqual([endless.ok, endless.code], [false, 'output-too-large']);
  const huge = await runMcpTask({server: 'files', op: 'call', tool: 'read_file'}, servers({FAKE_MCP_MODE: 'huge'}), {maxBytes: 4 * 1024 * 1024});
  assert.equal(huge.ok, true);
  assert.ok(huge.text.length < 12100);
  assert.match(huge.text, /\[cut:/);
});

test('junk on stdout is skipped, and stderr (which can hold anything) is never returned', async () => {
  const result = await runMcpTask({server: 'files', op: 'call', tool: 'read_file', args: {}}, servers({FAKE_MCP_MODE: 'noisy', FAKE_MCP_SECRET: 'TOP-SECRET-VALUE'}));
  assert.equal(result.ok, true);
  assert.equal(JSON.stringify(result).includes('TOP-SECRET-VALUE'), false);
  const broken = await runMcpTask({server: 'files', op: 'list'}, {files: {command: '/definitely/not/a/program', args: []}});
  assert.equal(broken.ok, false);
  assert.equal(broken.code, 'cannot-start');
  assert.equal(JSON.stringify(broken).includes('/definitely'), false, 'the command line stays on the agent');
});

test('the child runs from the configured directory with a small environment, not the agent\'s', async () => {
  process.env.AGENT_TEST_SECRET = 'agent-only-secret';
  try {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-cwd-'));
    const real = await fs.realpath(dir);
    const out = await runMcpTask({server: 'files', op: 'call', tool: 'read_file', args: {}}, servers({EXPECT_CWD: real}, {cwd: real}));
    assert.match(out.text, /cwd=ok/);
    await fs.rm(dir, {recursive: true, force: true});
    const seen = await runMcpTask({server: 'files', op: 'call', tool: 'read_file', args: {}}, {files: {command: process.execPath, args: ['-e', `process.stdin.once('data',()=>{}); require('readline').createInterface({input:process.stdin}).on('line',l=>{const m=JSON.parse(l); if(m.id===undefined)return; const r=m.method==='initialize'?{protocolVersion:'2025-06-18',capabilities:{}}:{content:[{type:'text',text:String(process.env.AGENT_TEST_SECRET)}]}; console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:r}))})`]}});
    assert.equal(seen.text, 'undefined');
  } finally { delete process.env.AGENT_TEST_SECRET; }
});

async function harness(permissions = ['mcp.call']) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-mcp-'));
  const store = await new SqliteStore(path.join(dir, 'state.db'), path.join(dir, 'state.json')).init();
  store.run("INSERT INTO workspaces (id,name,created_at) VALUES ('default','Primary workspace',?)", new Date().toISOString());
  agent.attachVault(store, path.join(dir, 'state.json'));
  const {code} = agent.createPairing(store, 'default', {});
  const device = agent.redeemPairing(store, {code, name: 'Laptop', permissions});
  store.run('UPDATE agents SET last_seen_at=? WHERE id=?', new Date().toISOString(), device.agentId);
  return {dir, store, agentId: device.agentId};
}
/** What a running agent does: claim the task, run it, report. */
const answerAs = (store, agentId, config) => {
  const timer = setInterval(() => {
    for (const task of agent.claimAgentTasks(store, agentId)) {
      runMcpTask(JSON.parse(task.payload), config).then(result => agent.completeAgentTask(store, agentId, task.id, {status: 'done', result, attempts: task.attempts}));
    }
  }, 20);
  return () => clearInterval(timer);
};

test('the payload is validated and canonical: a name, an operation, bounded arguments; no command, never retried', async () => {
  const {dir, store, agentId} = await harness();
  try {
    const bad = p => assert.throws(() => agent.enqueueAgentTask(store, agentId, {kind: 'mcp.call', payload: p}), /./);
    bad({server: '', op: 'list'});
    bad({server: 'a b', op: 'list'});
    bad({server: 'x'.repeat(80), op: 'list'});
    bad({server: 'files', op: 'launch'});
    bad({server: 'files', op: 'call'});
    bad({server: 'files', op: 'call', tool: 'x y'});
    bad({server: 'files', op: 'call', tool: 'read_file', args: [1]});
    bad({server: 'files', op: 'call', tool: 'read_file', args: {a: 'x'.repeat(200000)}});
    assert.equal(store.all('SELECT id FROM agent_tasks').length, 0);
    const {task} = agent.enqueueAgentTask(store, agentId, {kind: 'mcp.call', payload: {server: 'files', op: 'call', tool: 'read_file', args: {p: 1}, command: 'rm -rf /', env: {A: '1'}}});
    assert.deepEqual(Object.keys(JSON.parse(task.payload)).sort(), ['args', 'op', 'server', 'timeoutMs', 'tool']);
    assert.equal(task.max_attempts, 1, 'a tool call may already have changed something: it is never run twice');
    const lean = agent.enqueueAgentTask(store, agentId, {kind: 'mcp.call', payload: {server: 'files', op: 'list'}}).task;
    assert.deepEqual(Object.keys(JSON.parse(lean.payload)).sort(), ['op', 'server', 'timeoutMs']);
  } finally { await fs.rm(dir, {recursive: true, force: true}); }
});

test('an agent without the permission cannot be given the task', async () => {
  const {dir, store, agentId} = await harness(['http.check']);
  try { assert.throws(() => agent.enqueueAgentTask(store, agentId, {kind: 'mcp.call', payload: {server: 'files', op: 'list'}}), /does not hold the mcp.call permission/); }
  finally { await fs.rm(dir, {recursive: true, force: true}); }
});

test('the server reaches a stdio server through the agent: list, call, and the agent\'s own refusals', async () => {
  const {dir, store, agentId} = await harness();
  const stop = answerAs(store, agentId, servers());
  try {
    const target = {transport: 'stdio', store, server: 'files'};
    const {tools} = await mcpList(target, {timeoutMs: 10000});
    assert.deepEqual(tools.map(t => t.name), ['read_file', 'write_file']);
    const out = await mcpCall(target, 'read_file', {path: 'x'}, {timeoutMs: 10000});
    assert.deepEqual([out.ok, /read_file/.test(out.text)], [true, true]);
    await assert.rejects(mcpList({transport: 'stdio', store, server: 'missing'}, {timeoutMs: 10000}), /No MCP server called "missing" is configured on this agent/);
  } finally { stop(); await store.close(); await fs.rm(dir, {recursive: true, force: true}); }
});

test('with no usable agent the call fails fast and says what to do; nothing is queued', async () => {
  const none = await harness([]);
  try {
    await assert.rejects(mcpList({transport: 'stdio', store: none.store, server: 'files'}), /not allowed to run MCP servers/);
    assert.equal(none.store.all('SELECT id FROM agent_tasks').length, 0);
    none.store.run('UPDATE agents SET permissions=? WHERE id=?', '["mcp.call"]', none.agentId);
    none.store.run('UPDATE agents SET last_seen_at=? WHERE id=?', new Date(Date.now() - 3600000).toISOString(), none.agentId);
    await assert.rejects(mcpList({transport: 'stdio', store: none.store, server: 'files'}), /agent is not running/);
    none.store.run('UPDATE agents SET revoked_at=? WHERE id=?', new Date().toISOString(), none.agentId);
    await assert.rejects(mcpList({transport: 'stdio', store: none.store, server: 'files'}), /Pair a local agent/);
  } finally { await none.store.close(); await fs.rm(none.dir, {recursive: true, force: true}); }
});

test('a call that waits too long is cancelled, so an agent waking late does not run it', async () => {
  const {dir, store} = await harness();
  try {
    await assert.rejects(mcpCall({transport: 'stdio', store, server: 'files'}, 'write_file', {}, {timeoutMs: 400}), /did not answer in time/);
    const [row] = store.all('SELECT status FROM agent_tasks');
    assert.equal(row.status, 'failed');
  } finally { await store.close(); await fs.rm(dir, {recursive: true, force: true}); }
});
