/** The server starts a local agent on its own machine, so a browser, the claude and codex CLIs and stdio MCP
 * servers work with no pairing step. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import * as agent from '../src/agent.js';
import {SqliteStore} from '../src/sqlite-store.js';
import {ensureLocalAgent, startLocalAgent, localAgentWanted} from '../src/local-agent.js';

async function harness() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'local-agent-'));
  const dataFile = path.join(dir, 'state.json');
  const store = await new SqliteStore(path.join(dir, 'state.db'), dataFile).init();
  store.run("INSERT INTO workspaces (id,name,created_at) VALUES ('default','Primary workspace',?)", new Date().toISOString());
  agent.attachVault(store, dataFile);
  return {dir, store, dataFile};
}

test('the first start pairs this computer and keeps the secret in a 0600 file beside the data', async () => {
  const {store, dataFile, dir} = await harness();
  const made = ensureLocalAgent(store, {dataFile, server: 'http://127.0.0.1:4173'});
  const file = path.join(dir, 'local-agent.json');
  assert.equal(made.configPath, file);
  const config = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(config.server, 'http://127.0.0.1:4173');
  assert.equal(config.agentId, made.agentId);
  assert.ok(config.secret.length >= 32);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  const row = store.get('SELECT * FROM agents WHERE id=?', made.agentId);
  assert.equal(row.name, 'This computer');
  assert.deepEqual(JSON.parse(row.permissions).sort(), [...agent.AGENT_ACTIONS].sort(), 'it may do everything a paired device may');
});

test('a later start reuses the same agent, and a port change only rewrites the address', async () => {
  const {store, dataFile} = await harness();
  const first = ensureLocalAgent(store, {dataFile, server: 'http://127.0.0.1:4173'});
  const again = ensureLocalAgent(store, {dataFile, server: 'http://127.0.0.1:4174'});
  assert.equal(again.agentId, first.agentId);
  assert.equal(JSON.parse(await fs.readFile(again.configPath, 'utf8')).server, 'http://127.0.0.1:4174');
  assert.equal(store.all('SELECT id FROM agents').length, 1);
});

test('an agent revoked in Settings stays revoked: no new one is paired behind the owner\'s back', async () => {
  const {store, dataFile} = await harness();
  const first = ensureLocalAgent(store, {dataFile, server: 'http://127.0.0.1:4173'});
  agent.revokeAgent(store, first.agentId);
  assert.equal(ensureLocalAgent(store, {dataFile, server: 'http://127.0.0.1:4173'}), null);
  assert.equal(store.all('SELECT id FROM agents').length, 1);
  const spawned = [];
  const handle = startLocalAgent(store, {dataFile, server: 'http://127.0.0.1:4173', env: {}, spawn: () => { spawned.push(1); return new FakeChild(); }, log: () => {}});
  assert.equal(handle, null);
  assert.equal(spawned.length, 0);
});

test('it starts for a server on this computer, and LOCAL_AGENT turns it on or off', () => {
  assert.equal(localAgentWanted({HOST: '127.0.0.1'}), true);
  assert.equal(localAgentWanted({}), true);
  assert.equal(localAgentWanted({HOST: 'localhost'}), true);
  assert.equal(localAgentWanted({HOST: '0.0.0.0'}), false, 'a shared server does not open a browser on itself unasked');
  assert.equal(localAgentWanted({HOST: '0.0.0.0', LOCAL_AGENT: '1'}), true);
  assert.equal(localAgentWanted({HOST: '127.0.0.1', LOCAL_AGENT: '0'}), false);
});

class FakeChild extends EventEmitter {
  constructor() { super(); this.stdout = new EventEmitter(); this.stderr = new EventEmitter(); this.killed = false; }
  kill() { this.killed = true; this.emit('exit', null, 'SIGTERM'); }
}

test('it runs agent.mjs with a browser and any public site, restarts after a crash, and stops with the server', async () => {
  const {store, dataFile} = await harness();
  const spawned = [];
  const spawn = (cmd, args, opts) => { const child = new FakeChild(); spawned.push({cmd, args, env: opts.env, child}); return child; };
  const handle = startLocalAgent(store, {dataFile, server: 'http://127.0.0.1:4173', env: {PATH: '/bin'}, spawn, log: () => {}, restartMs: 5});
  assert.equal(spawned.length, 1);
  const {cmd, args, env} = spawned[0];
  assert.equal(cmd, process.execPath);
  assert.match(args[0], /agent[\\/]agent\.mjs$/);
  assert.equal(args[1], 'run');
  assert.equal(env.AGENT_CONFIG, handle.configPath);
  assert.equal(env.AGENT_BROWSER, '1');
  assert.equal(env.AGENT_PARENT_PID, String(process.pid), 'the agent stops by itself when the server is gone');
  assert.equal(env.AGENT_POLL_MS, '2000', 'on loopback an Allow is picked up in seconds, not after a 15s poll');
  assert.equal(env.AGENT_BROWSER_ALLOWLIST, '*', 'every page still waits for the owner\'s ask; the egress guard still refuses private addresses');
  spawned[0].child.emit('exit', 1, null);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(spawned.length, 2, 'a crash starts it again');
  await handle.stop();
  assert.equal(spawned[1].child.killed, true);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(spawned.length, 2, 'a stop is not a crash');
});

test('an operator\'s own browser settings win over the defaults', async () => {
  const {store, dataFile} = await harness();
  const spawned = [];
  const spawn = (cmd, args, opts) => { spawned.push(opts.env); return new FakeChild(); };
  const handle = startLocalAgent(store, {dataFile, server: 'http://127.0.0.1:4173', env: {AGENT_BROWSER: '0', AGENT_BROWSER_ALLOWLIST: 'docs.example.com', AGENT_POLL_MS: '9000'}, spawn, log: () => {}});
  assert.equal(spawned[0].AGENT_BROWSER, '0');
  assert.equal(spawned[0].AGENT_BROWSER_ALLOWLIST, 'docs.example.com');
  assert.equal(spawned[0].AGENT_POLL_MS, '9000');
  await handle.stop();
});

test('the owner adds a stdio MCP server to this computer from the app: it lands in the 0600 config and the agent restarts', async () => {
  const {addLocalMcpServer, removeLocalMcpServer, localMcpServers} = await import('../src/local-agent.js');
  const {store, dataFile} = await harness();
  const spawned = [];
  const spawn = () => { const child = new FakeChild(); spawned.push(child); return child; };
  const handle = startLocalAgent(store, {dataFile, server: 'http://127.0.0.1:4173', env: {}, spawn, log: () => {}, restartMs: 5});
  const names = addLocalMcpServer({dataFile, name: 'notes', command: 'npx -y "@scope/files server" /home/me/notes'});
  assert.deepEqual(names, ['notes']);
  const config = JSON.parse(await fs.readFile(handle.configPath, 'utf8'));
  assert.deepEqual(config.mcpServers.notes, {command: 'npx', args: ['-y', '@scope/files server', '/home/me/notes']});
  assert.ok(config.secret, 'the pairing is kept');
  assert.equal((await fs.stat(handle.configPath)).mode & 0o777, 0o600);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(spawned[0].killed, true, 'the running agent is stopped so it reads the new server');
  assert.equal(spawned.length, 2, 'and started again');
  assert.deepEqual(localMcpServers({dataFile}), ['notes']);
  assert.deepEqual(removeLocalMcpServer({dataFile, name: 'notes'}), []);
  assert.throws(() => addLocalMcpServer({dataFile, name: '../x', command: 'ls'}), /letters, digits/);
  assert.throws(() => addLocalMcpServer({dataFile, name: 'x', command: '  '}), /command/i);
  assert.throws(() => addLocalMcpServer({dataFile, name: 'x', command: 'a\nb'}), /one line/);
  await handle.stop();
});

test('an app from the catalogue brings its token as env, and a ~ path means this user\'s home', async () => {
  const {addLocalMcpServer} = await import('../src/local-agent.js');
  const os = await import('node:os');
  const {store, dataFile} = await harness();
  const handle = startLocalAgent(store, {dataFile, server: 'http://127.0.0.1:4173', env: {}, spawn: () => new FakeChild(), log: () => {}, restartMs: 5});
  addLocalMcpServer({dataFile, name: 'notion', command: 'npx -y @notionhq/notion-mcp-server', env: {NOTION_TOKEN: 'ntn_x'}});
  addLocalMcpServer({dataFile, name: 'files', command: 'npx -y @modelcontextprotocol/server-filesystem ~/notes'});
  const config = JSON.parse(await fs.readFile(handle.configPath, 'utf8'));
  assert.deepEqual(config.mcpServers.notion, {command: 'npx', args: ['-y', '@notionhq/notion-mcp-server'], env: {NOTION_TOKEN: 'ntn_x'}});
  assert.equal(config.mcpServers.files.args.at(-1), `${os.homedir()}/notes`);
  assert.throws(() => addLocalMcpServer({dataFile, name: 'x', command: 'ls', env: {'bad key': 'v'}}), /variable name/);
  assert.throws(() => addLocalMcpServer({dataFile, name: 'x', command: 'ls', env: {TOKEN: 'a\nb'}}), /one line/);
  await handle.stop();
});

test('with no agent on this computer there is nothing to add a server to', async () => {
  const {addLocalMcpServer} = await import('../src/local-agent.js');
  const {dataFile} = await harness();
  assert.throws(() => addLocalMcpServer({dataFile, name: 'notes', command: 'ls'}), /not running on this computer/);
});
