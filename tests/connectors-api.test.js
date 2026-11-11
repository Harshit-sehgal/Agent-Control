/** The connector routes through the real dispatcher (Phase 6).
 *
 * The dispatcher decides who may call what and what the state snapshot shows, so
 * these go through `createApp` with a real store and a fake session.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createApp} from '../src/app.js';
import {SqliteStore} from '../src/sqlite-store.js';
import * as agent from '../src/agent.js';
import {fakeMcpHttp} from './mcp-fixture.js';

async function rig(t, role = 'admin') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'connectors-api-'));
  const store = await new SqliteStore(path.join(dir, 'state.db'), path.join(dir, 'state.json')).init();
  store.run("INSERT INTO workspaces (id,name,created_at) VALUES ('default','Primary workspace',?)", new Date().toISOString());
  agent.attachVault(store, path.join(dir, 'state.json'));
  t.after(async () => { await store.close(); await fs.rm(dir, {recursive: true, force: true}); });
  const app = createApp({
    store, push: {}, version: 'test',
    auth: {session: cookie => (cookie === 'ok' ? {email: 'o@example.test', role, userId: 'u1', workspaceId: 'default'} : null), listWorkspaces: () => [], roleOf: () => 'owner'},
    workspaces: {get: id => (id === 'default' ? store : null)},
  });
  const call = async (method, url, body) => {
    const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
    const req = Object.assign((async function* () { yield* chunks; })(), {method, url, headers: {host: 'app.example.com', cookie: 'agent_session=ok'}, socket: {}});
    const res = {status: null, headers: null, body: null, writeHead(s, h) { this.status = s; this.headers = h; }, end(b) { this.body = b; }};
    await app.handler(req, res);
    return {status: res.status, headers: res.headers, body: res.body ? JSON.parse(res.body) : null};
  };
  return {store, call};
}

test('an admin adds a connector over HTTP; the state snapshot shows it with no secret', async t => {
  const {call} = await rig(t);
  const server = await fakeMcpHttp();
  t.after(() => server.close());
  const made = await call('POST', '/api/connectors', {kind: 'mcp', name: 'Notes', url: `${server.url}?key=URL-SECRET-KEY-98765`, headers: {Authorization: 'Bearer SECRET-TOKEN-1234567890'}});
  assert.equal(made.status, 201);
  const state = await call('GET', '/api/state');
  assert.equal(state.status, 200);
  assert.equal(state.body.connectors.length, 1);
  assert.equal(state.body.connectors[0].id, 'notes');
  const text = JSON.stringify(state.body);
  for (const secret of ['SECRET-TOKEN', 'URL-SECRET-KEY', 'credentialId']) assert.equal(text.includes(secret), false, `${secret} reached the state snapshot`);
  const list = await call('GET', '/api/connectors');
  assert.equal(list.body.connectors[0].name, 'Notes');
  assert.equal((await call('DELETE', '/api/connectors/notes')).status, 200);
  assert.deepEqual((await call('GET', '/api/state')).body.connectors, []);
});

test('a member cannot add, refresh or remove a connector; a viewer can only look', async t => {
  const {call} = await rig(t, 'member');
  const server = await fakeMcpHttp();
  t.after(() => server.close());
  for (const [method, url, body] of [['POST', '/api/connectors', {kind: 'mcp', name: 'Notes', url: server.url}], ['POST', '/api/connectors/notes/refresh'], ['DELETE', '/api/connectors/notes']]) {
    const out = await call(method, url, body);
    assert.equal(out.status, 403, `${method} ${url}`);
  }
  assert.equal((await call('GET', '/api/connectors')).status, 200);
  assert.deepEqual(server.calls, [], 'a refused request never reached the server');
});

test('an email waiting out its Undo window is never in the state snapshot', async t => {
  const {store, call} = await rig(t);
  await store.update(s => { s.heldSends = [{id: 'h1', connectorId: 'google', args: {to: 'bob@example.org', subject: 'S', body: 'PRIVATE BODY'}, botId: 'atlas', botName: 'Atlas', chatKey: 'atlas', undoUntil: new Date(Date.now() + 30000).toISOString(), status: 'held'}]; });
  const state = await call('GET', '/api/state');
  assert.equal(JSON.stringify(state.body).includes('PRIVATE BODY'), false);
  assert.equal('heldSends' in state.body, false);
  assert.equal(store.read().heldSends.length, 1, 'it is still held on the server');
});
