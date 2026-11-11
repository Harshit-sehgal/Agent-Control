/** Connectors: adding, listing, refreshing and removing an MCP server (Phase 6, Task 1).
 *
 * The routes are driven the way the dispatcher drives them, against a real store
 * and the real vault. The MCP servers are fakes on a local port. The point of
 * most of these tests is the secret: a header, an address with a key in it, or a
 * token never comes back from a route, never reaches the state document, a log
 * or a backup, and lives encrypted in the vault.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createRouter} from '../src/router.js';
import {connectorRoutes} from '../src/routes-connectors.js';
import {SqliteStore} from '../src/sqlite-store.js';
import * as agent from '../src/agent.js';
import * as wf from '../shared/workflow.js';
import {setGrant, grantFor, createAsk} from '../shared/asks.js';
import {exportBackup} from '../src/backup.js';
import {revealValue} from '../src/credentials.js';
import {findConnector, publicConnector, slugOf} from '../shared/connectors.js';
import {fakeMcpHttp, TOOLS, STDIO_SERVER} from './mcp-fixture.js';

const SECRET = 'Bearer SECRET-TOKEN-1234567890';
const KEYED = (url) => `${url}?key=URL-SECRET-KEY-98765`;

async function rig(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'connectors-'));
  const store = await new SqliteStore(path.join(dir, 'state.db'), path.join(dir, 'state.json')).init();
  store.run("INSERT INTO workspaces (id,name,created_at) VALUES ('default','Primary workspace',?)", new Date().toISOString());
  agent.attachVault(store, path.join(dir, 'state.json'));
  t.after(async () => { await store.close(); await fs.rm(dir, {recursive: true, force: true}); });
  const router = createRouter();
  connectorRoutes(router, {});
  const actor = {userId: 'u1', role: 'admin', workspaceId: 'default', email: 'owner@localhost'};
  const call = async (method, target, body, who = actor) => {
    const found = router.find(method, target);
    assert.ok(found, `${method} ${target} is not registered`);
    const out = await found.route.handler({params: found.params, actor: who, store, req: {url: target, headers: {host: 'app.example.com'}, socket: {}}, raw: async () => '', body: async () => body});
    return out && out[Object.getOwnPropertySymbols(out)[0]] ? {status: out.status, body: out.body, headers: out.headers} : out;
  };
  const server = await fakeMcpHttp();
  t.after(() => server.close());
  return {dir, store, call, server, router};
}
const bodyOf = out => out?.body ?? out;

test('an HTTP MCP server is added: its tools are listed, the address and header go to the vault, the record holds neither', async t => {
  const {store, call, server} = await rig(t);
  const made = await call('POST', '/api/connectors', {kind: 'mcp', name: 'Notes', url: KEYED(server.url), headers: {Authorization: SECRET}});
  assert.equal(made.status, 201);
  const c = made.body;
  assert.equal(c.id, 'notes');
  assert.equal(c.kind, 'mcp');
  assert.equal(c.status, 'ready');
  assert.equal(c.transport, 'http');
  assert.equal(c.host, new URL(server.url).host, 'the host is shown; the path and key are not');
  assert.equal(c.account, new URL(server.url).host);
  assert.deepEqual(c.actions.map(a => [a.name, a.write]), [['search_notes', false], ['add_note', true], ['wipe_notes', true], ['ping', true]], 'no annotations, or a destructive hint, is a write');
  assert.ok(c.actions.every(a => typeof a.description === 'string'));
  // What was sent to the server: the owner's header, and the key in the address.
  assert.equal(server.calls[0].headers.authorization, SECRET);
  assert.match(server.calls[0].url, /key=URL-SECRET-KEY-98765/);
  // Where the secret lives.
  const state = store.read();
  const stored = JSON.stringify(state.connectors);
  for (const secret of ['SECRET-TOKEN', 'URL-SECRET-KEY']) assert.equal(stored.includes(secret), false, `${secret} is not in the connector record`);
  const credential = store.get("SELECT * FROM credentials WHERE kind='connector_mcp'");
  assert.ok(credential, 'one vault credential holds the address and headers');
  assert.equal(JSON.stringify(credential).includes('SECRET-TOKEN'), false, 'encrypted at rest');
  assert.deepEqual(JSON.parse(revealValue(store, credential.id)), {url: KEYED(server.url), headers: {Authorization: SECRET}});
});

test('GET /api/connectors lists them without any secret; the state snapshot does too', async t => {
  const {store, call, server} = await rig(t);
  await call('POST', '/api/connectors', {kind: 'mcp', name: 'Notes', url: KEYED(server.url), headers: {Authorization: SECRET}});
  const listed = bodyOf(await call('GET', '/api/connectors'));
  assert.equal(listed.connectors.length, 1);
  const text = JSON.stringify(listed);
  for (const secret of ['SECRET-TOKEN', 'URL-SECRET-KEY', 'credentialId', '/mcp']) assert.equal(text.includes(secret), false, `${secret} leaked`);
  assert.deepEqual(Object.keys(listed.connectors[0]).sort(), ['account', 'actions', 'addedAt', 'agentServer', 'checkedAt', 'host', 'id', 'kind', 'name', 'status', 'statusMessage', 'transport']);
  assert.equal(listed.google.configured, false);
  assert.equal(typeof listed.google.redirectUri, 'string');
  assert.deepEqual(publicConnector(store.read().connectors[0]), listed.connectors[0]);
});

test('a backup carries no connector secret, and no vault row', async t => {
  const {store, call, server} = await rig(t);
  await call('POST', '/api/connectors', {kind: 'mcp', name: 'Notes', url: KEYED(server.url), headers: {Authorization: SECRET}});
  const text = JSON.stringify(exportBackup(store));
  for (const secret of ['SECRET-TOKEN', 'URL-SECRET-KEY']) assert.equal(text.includes(secret), false);
  assert.equal(/connector_mcp/.test(text), false, 'credential rows are not exported');
});

test('a server that is down, refuses, or is not an address is refused and leaves nothing behind', async t => {
  const {store, call} = await rig(t);
  const refuse = await fakeMcpHttp({mode: 'refuse'});
  t.after(() => refuse.close());
  await assert.rejects(call('POST', '/api/connectors', {kind: 'mcp', name: 'Locked', url: refuse.url, headers: {Authorization: SECRET}}), error => error.status === 502 && /refused the credentials/.test(error.message) && !error.message.includes('SECRET-TOKEN'));
  await assert.rejects(call('POST', '/api/connectors', {kind: 'mcp', name: 'Dead', url: 'http://127.0.0.1:1/mcp'}), /Could not reach/);
  for (const url of ['ftp://x.example.com', 'https://u:p@x.example.com/', 'nope']) await assert.rejects(call('POST', '/api/connectors', {kind: 'mcp', name: 'Bad', url}), /./);
  assert.deepEqual(store.read().connectors || [], []);
  assert.equal(store.get("SELECT count(*) AS n FROM credentials").n, 0, 'a refused connector leaves no credential');
});

test('the body is validated: a name, exactly one of url and agentServer, a clean header set, only the mcp kind here', async t => {
  const {call, server} = await rig(t);
  const bad = (b, re) => assert.rejects(call('POST', '/api/connectors', b), re);
  await bad({kind: 'mcp', url: server.url}, /name/i);
  await bad({kind: 'mcp', name: 'x'.repeat(100), url: server.url}, /name/i);
  await bad({kind: 'mcp', name: 'Both', url: server.url, agentServer: 'files'}, /either|one of/i);
  await bad({kind: 'mcp', name: 'Neither'}, /either|one of/i);
  await bad({kind: 'mcp', name: 'S', agentServer: 'has space'}, /agent/i);
  await bad({kind: 'mcp', name: 'H', agentServer: 'files', headers: {A: 'b'}}, /headers/i);
  await bad({kind: 'mcp', name: 'H', url: server.url, headers: {'Bad Name': 'v'}}, /header name/i);
  await bad({kind: 'mcp', name: 'H', url: server.url, headers: {A: 'line\nbreak'}}, /line break/i);
  await bad({kind: 'mcp', name: 'H', url: server.url, headers: {'Content-Type': 'text/plain'}}, /managed by the app/i);
  await bad({kind: 'mcp', name: 'H', url: server.url, headers: {'Mcp-Session-Id': 'x'}}, /managed by the app/i);
  await bad({kind: 'google', name: 'G'}, /google/i);
  await bad({kind: 'ftp', name: 'F'}, /kind/i);
  await bad({kind: 'mcp', name: 'H', url: server.url, headers: Object.fromEntries(Array.from({length: 12}, (_, i) => [`H${i}`, 'v']))}, /at most/i);
});

test('names are unique, ids are route-safe, and google is reserved for Google', async t => {
  const {call, server} = await rig(t);
  const first = bodyOf(await call('POST', '/api/connectors', {kind: 'mcp', name: 'My Notes!', url: server.url}));
  assert.equal(first.id, 'my-notes');
  await assert.rejects(call('POST', '/api/connectors', {kind: 'mcp', name: 'my notes', url: server.url}), /already/i);
  const g = bodyOf(await call('POST', '/api/connectors', {kind: 'mcp', name: 'Google', url: server.url}));
  assert.notEqual(g.id, 'google');
  assert.match(g.id, /^[a-z0-9-]+$/);
  assert.equal(slugOf('  Ünï cödé / Server  '), 'n-c-d-server');
  assert.match(slugOf('???'), /^connector$/);
  const state = {connectors: [{id: 'a', name: 'A', kind: 'mcp'}, {id: 'b', name: 'Notes', kind: 'mcp'}]};
  assert.equal(findConnector(state, 'b').id, 'b');
  assert.equal(findConnector(state, ' NOTES ').id, 'b');
  assert.equal(findConnector(state, 'zzz'), null);
  assert.equal(findConnector(state, 42), null);
});

test('refresh re-lists the tools; a server that goes away turns the status to error with its own words, and back again', async t => {
  const {call} = await rig(t);
  const first = await fakeMcpHttp({tools: TOOLS.slice(0, 1)});
  t.after(() => first.close());
  const made = bodyOf(await call('POST', '/api/connectors', {kind: 'mcp', name: 'Notes', url: first.url}));
  assert.equal(made.actions.length, 1);
  // The same server now offers more.
  first.close();
  const second = await fakeMcpHttp();
  t.after(() => second.close());
  const moved = bodyOf(await call('POST', '/api/connectors', {kind: 'mcp', name: 'Other', url: second.url}));
  assert.equal(moved.actions.length, TOOLS.length);
  const down = bodyOf(await call('POST', `/api/connectors/${made.id}/refresh`));
  assert.equal(down.status, 'error');
  assert.match(down.statusMessage, /Could not reach/);
  assert.equal(down.actions.length, 1, 'the last known tools stay');
  const ok = bodyOf(await call('POST', `/api/connectors/${moved.id}/refresh`));
  assert.equal(ok.status, 'ready');
  assert.equal(ok.statusMessage, '');
  await assert.rejects(call('POST', '/api/connectors/nope/refresh'), error => error.status === 404);
});

test('removing a connector removes its vault credential and its grants, and leaves a pending ask answerable', async t => {
  const {store, call, server} = await rig(t);
  const made = bodyOf(await call('POST', '/api/connectors', {kind: 'mcp', name: 'Notes', url: server.url, headers: {Authorization: SECRET}}));
  await store.update(s => {
    const bot = wf.addBot(s, 'home', {name: 'Scribe', instructions: 'Writes.'});
    setGrant(s, bot.id, `connector.${made.id}.read`, made.account, 'always', undefined, {log: false});
    setGrant(s, bot.id, 'send', 'https://x.example', 'always', undefined, {log: false});
    createAsk(s, {botId: bot.id, action: `connector.${made.id}.write`, target: made.account, detail: 'save a note'});
  });
  const bot = store.read().groups.flatMap(g => g.bots).find(b => b.name === 'Scribe');
  assert.equal(grantFor(store.read(), bot.id, `connector.${made.id}.read`, made.account), 'always');
  assert.deepEqual(bodyOf(await call('DELETE', `/api/connectors/${made.id}`)), {ok: true});
  const after = store.read();
  assert.deepEqual(after.connectors, []);
  assert.equal(grantFor(after, bot.id, `connector.${made.id}.read`, made.account), null, 'its grants go with it');
  assert.equal(grantFor(after, bot.id, 'send', 'https://x.example'), 'always', 'other grants stay');
  assert.equal(store.get("SELECT count(*) AS n FROM credentials").n, 0, 'the secret is deleted, not left behind');
  assert.equal(after.asks[0].status, 'pending', 'an ask for it is not silently dropped');
  await assert.rejects(call('DELETE', `/api/connectors/${made.id}`), error => error.status === 404);
});

test('a stdio server is named, not commanded: only the name is stored, nothing goes to the vault', async t => {
  const {store, call} = await rig(t);
  const {code} = agent.createPairing(store, 'default', {});
  const device = agent.redeemPairing(store, {code, name: 'Laptop', permissions: ['mcp.call']});
  store.run('UPDATE agents SET last_seen_at=? WHERE id=?', new Date().toISOString(), device.agentId);
  const {runMcpTask} = await import('../agent/mcp-stdio.mjs');
  const timer = setInterval(() => { for (const task of agent.claimAgentTasks(store, device.agentId)) runMcpTask(JSON.parse(task.payload), {files: {command: process.execPath, args: [STDIO_SERVER]}}).then(result => agent.completeAgentTask(store, device.agentId, task.id, {status: 'done', result, attempts: task.attempts})); }, 20);
  try {
  const made = bodyOf(await call('POST', '/api/connectors', {kind: 'mcp', name: 'Files', agentServer: 'files'}));
  assert.equal(made.transport, 'stdio');
  assert.equal(made.agentServer, 'files');
  assert.equal(made.account, 'agent:files');
  assert.equal(made.host, null);
  assert.deepEqual(made.actions.map(a => [a.name, a.write]), [['read_file', false], ['write_file', true]]);
  assert.equal(store.get("SELECT count(*) AS n FROM credentials").n, 0);
  assert.equal(bodyOf(await call('POST', `/api/connectors/${made.id}/refresh`)).status, 'ready');
  } finally { clearInterval(timer); }
});
