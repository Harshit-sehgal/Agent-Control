/** A real app over a real store with a fake Google behind it, and the steps of connecting Google.
 * Shared by the Google tests; `connect(r)` leaves the connector `ready`. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createApp} from '../src/app.js';
import {SqliteStore} from '../src/sqlite-store.js';
import * as agent from '../src/agent.js';
import {googleFlows} from '../src/google.js';
import {fakeGoogle, CLIENT} from './google-fixture.js';

export async function rig(t, {role = 'owner', env = {}} = {}) {
  const google = await fakeGoogle(env.fake);
  const saved = {};
  const setEnv = values => { for (const [k, v] of Object.entries(values)) { saved[k] ??= process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
  setEnv({...google.env, PUBLIC_BASE_URL: 'https://bots.example.com', PUBLIC_ORIGIN: undefined, ...env.vars});
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'google-'));
  const store = await new SqliteStore(path.join(dir, 'state.db'), path.join(dir, 'state.json')).init();
  store.run("INSERT INTO workspaces (id,name,created_at) VALUES ('default','Primary workspace',?)", new Date().toISOString());
  agent.attachVault(store, path.join(dir, 'state.json'));
  googleFlows.clear();
  t.after(async () => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await store.close(); await google.close(); await fs.rm(dir, {recursive: true, force: true});
  });
  const app = createApp({
    store, push: {}, version: 'test',
    auth: {session: cookie => (cookie === 'ok' ? {email: 'o@example.test', role, userId: 'u1', workspaceId: 'default'} : null), listWorkspaces: () => [], roleOf: () => 'owner'},
    workspaces: {get: id => (id === 'default' ? store : null)},
  });
  const call = async (method, url, {body, cookie = 'agent_session=ok', host = 'bots.example.com'} = {}) => {
    const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
    const req = Object.assign((async function* () { yield* chunks; })(), {method, url, headers: {host, ...(cookie ? {cookie} : {})}, socket: {}});
    const res = {status: null, headers: null, body: null, writeHead(s, h) { this.status = s; this.headers = h; }, end(b) { this.body = b; }};
    await app.handler(req, res);
    return {status: res.status, headers: res.headers, body: res.body ? JSON.parse(res.body) : null};
  };
  return {google, store, call, setEnv, dir};
}

export const setup = r => r.call('POST', '/api/connectors/google/setup', {body: CLIENT});
/** Start a sign-in and return what the browser would carry to the callback. */
export async function start(r) {
  const out = await r.call('GET', '/api/connectors/google/start');
  assert.equal(out.status, 302, JSON.stringify(out.body));
  const url = new URL(out.headers.Location);
  const cookie = /google_state=([^;]+)/.exec(out.headers['Set-Cookie'])?.[1];
  return {url, state: url.searchParams.get('state'), challenge: url.searchParams.get('code_challenge'), cookie, out};
}
/** The user consented: Google redirects to the callback with a code and the state. */
export const finish = (r, flow, {code, state = flow.state, cookie = flow.cookie, extra = ''} = {}) =>
  r.call('GET', `/api/connectors/google/callback?${code === null ? '' : `code=${encodeURIComponent(code ?? r.google.issueCode(flow.challenge))}&`}state=${encodeURIComponent(state)}${extra}`, {cookie: cookie ? `google_state=${cookie}` : ''});
export async function connect(r) { await setup(r); const flow = await start(r); const done = await finish(r, flow); return {flow, done}; }

