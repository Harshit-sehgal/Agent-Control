// Phase 3, Task 7: the done-when test. A keeper finds an account signed out, the phone is told once, a run that then meets
// the wall waits on the same card, the owner signs in from the phone (Take control, Password and Code, Hand back) and the
// waiting run carries on by itself with the signed-in page. Everything is real except the scripted model and the computer's
// own side: the test posts its heartbeats, claims, live polls and results as signed requests, as the device does.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {Readable} from 'node:stream';
import * as agent from '../src/agent.js';
import {createApp} from '../src/app.js';
import {browserLive} from '../src/browser-live.js';
import {executeCustomBot} from '../src/ai.js';
import {healthIssues} from '../src/health-watch.js';
import {isSigninAsk} from '../shared/asks.js';
import {BROWSER_ACCOUNTS_V1, SECRET_INPUT_V1} from '../shared/device-features.js';
import {company, ask as startRun} from './run-fixture.js';

const A = '11111111-1111-4111-8111-111111111111';
const CRM = 'https://crm.example.com/';
const wall = {finalUrl: 'https://crm.example.com/login', title: 'Sign in', text: '', elements: [{index: 1, tag: 'input', type: 'password'}]};
const reports = {finalUrl: 'https://crm.example.com/reports', title: 'Reports', text: 'Reports for Sales'};
const PASSWORD = 'test-only-password-9f3', CODE = '482913';
const until = async (check, note) => {
  for (let i = 0; i < 300; i++) { const value = check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error(`timed out waiting for ${note}`);
};

test('a keeper finds an account signed out, the phone is told, the owner signs in from it, and the waiting run carries on by itself', async t => {
  const {store, ids} = await company(t);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'signin-phone-'));
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  store.run("INSERT INTO workspaces (id,name,created_at) VALUES ('default','Primary workspace',?)", new Date().toISOString());
  agent.attachVault(store, path.join(dir, 'state.json'));
  const {code} = agent.createPairing(store, 'default', {});
  const device = agent.redeemPairing(store, {code, name: 'Desk', permissions: ['browser.capture']});
  agent.recordAgentFeatures(store, device.agentId, [BROWSER_ACCOUNTS_V1, SECRET_INPUT_V1]);
  const sent = [];
  store.notify = async event => { sent.push(event); };
  await store.update(s => {
    s.browserAccounts = [{id: A, name: 'Sales', site: 'crm.example.com', deviceId: device.agentId, storage: 'cookies'}];
    const bot = s.groups.find(g => g.id === 'home').bots.find(b => b.id === ids.scholar);
    bot.settings = {...bot.settings, browserAccount: A};
  });
  // The bot's model is a local OpenAI-style server: it asks for the page until the request carries the signed-in one,
  // then writes it up. The app resumes the run on its own, as in production, so nothing here drives the run.
  const modelCalls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      modelCalls.push(body);
      const reply = /Reports for Sales/.test(body) ? 'Read: Reports for Sales' : `One moment.\n\`\`\`browser\n${JSON.stringify({url: CRM + 'reports'})}\n\`\`\``;
      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({choices: [{message: {content: reply}}]}));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const env = {AI_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`, AI_API_KEY: 'test-key', AI_API_STYLE: 'chat', AI_MODEL: 'auto'};
  const saved = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]));
  Object.assign(process.env, env);
  t.after(() => { server.close(); for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  browserLive.close();
  const waitMs = browserLive.waitMs;
  browserLive.waitMs = 30;
  t.after(() => { browserLive.waitMs = waitMs; browserLive.close(); });
  const app = createApp({store, auth: {session: cookie => (cookie === 'owner' ? {email: 'owner@x.test', role: 'owner', workspaceId: 'default'} : null)}, workspaces: {get: () => store, holding: () => store}, push: {}, version: 't'});

  const call = async (method, url, text, headers, socket = {}) => {
    const req = Object.assign(Readable.from(text ? [Buffer.from(text)] : []), {method, url, headers: {host: '127.0.0.1:4173', ...headers}, socket: {remoteAddress: '127.0.0.1', ...socket}});
    const res = {status: null, body: null, writeHead(status) { this.status = status; return this; }, end(b) { this.body = b; }};
    await app.handler(req, res);
    return {status: res.status, body: res.body ? JSON.parse(res.body) : null};
  };
  /** The owner's phone: a session cookie. A typed secret goes over an https request (`secure`). */
  const owner = (url, body, {secure = false, headers = {}} = {}) => call('POST', url, body === undefined ? '' : JSON.stringify(body),
    {host: 'phone.example.test', origin: 'https://phone.example.test', cookie: 'agent_session=owner', ...headers}, secure ? {encrypted: true} : {remoteAddress: '203.0.113.9'});
  /** The computer: a signed request. */
  let last = 0;
  const device$ = (url, body) => {
    const text = JSON.stringify(body), timestamp = Math.max(Date.now(), last + 1);
    last = timestamp;
    return call('POST', url, text, {'x-agent-id': device.agentId, 'x-agent-ts': String(timestamp), 'x-agent-sig': agent.signRequest(device.secret, {method: 'POST', url, path: url, timestamp, body: text})});
  };
  // A beat carries what the app can do, as the device's does.
  const beat = body => device$('/api/agent/heartbeat', {features: [BROWSER_ACCOUNTS_V1, SECRET_INPUT_V1], ...body});
  const poll = () => device$('/api/agent/live', {tabs: []});
  const cards = () => (store.read().asks || []).filter(isSigninAsk);
  const notices = () => sent.filter(e => e.kind === 'signin');

  // 1. The keeper reads the account signed in, then signed out: one card in the bot's chat, one quiet push to it.
  assert.equal((await beat({accounts: [{id: A, state: 'signed-in'}]})).status, 200);
  assert.equal(cards().length, 0);
  assert.equal((await beat({accounts: [{id: A, state: 'signed-out'}]})).status, 200);
  await until(() => notices().length, 'the sign-in push');
  const [card] = cards();
  assert.equal(card.status, 'pending');
  assert.equal(card.accountId, A);
  assert.equal(card.botId, ids.scholar);
  assert.deepEqual(store.read().signinPending, {[A]: card.id});
  assert.equal(notices().length, 1);
  assert.equal(notices()[0].urgent, false);
  assert.equal(notices()[0].route, `#bot/${ids.scholar}`);
  assert.equal(store.read().chats[ids.scholar].filter(m => m.askId === card.id).length, 1);

  // 2. A run asks the bot for a page behind the sign-in. The computer claims the task and posts the wall: the page is held
  // on the same card, the run parks on it, and the owner is not told a second time.
  const run = await startRun(store, {message: 'Read the sales reports', to: ids.scholar, executor: executeCustomBot});
  const [request] = store.read().browserRequests.filter(r => r.runId === run.id);
  assert.equal(request.status, 'dispatched');
  assert.equal(request.account, A);
  const first = (await beat({})).body.tasks;
  assert.equal(first.length, 1);
  assert.equal(first[0].payload.account, A);
  assert.equal((await device$(`/api/agent/tasks/${first[0].id}/result`, {status: 'done', result: wall})).status, 200);
  await until(() => store.read().browserRequests.find(r => r.id === request.id).status === 'signin', 'the page to be held');
  assert.equal(store.read().groupRuns.find(r => r.id === run.id).status, 'awaiting_ask');
  assert.equal(cards().length, 1, 'one card per account, however many runs meet the wall');
  assert.equal(store.read().browserRequests.find(r => r.id === request.id).signinAskId, card.id);
  assert.equal(notices().length, 1, 'no second push');

  // 3. From the phone: Take control, then the address and the two typed secrets, over https. The same typing over a
  // connection that could be read is refused, and none of it reaches the store.
  await poll();
  assert.equal((await owner(`/api/browser-live/${ids.scholar}/takeover`)).status, 200);
  const heard = (await poll()).body.commands;
  assert.deepEqual(heard.map(c => c.type), ['takeover']);
  assert.equal(heard[0].account, A);
  const insecure = await owner(`/api/browser-live/${ids.scholar}/input`, {type: 'type', text: PASSWORD, secret: true});
  assert.equal(insecure.status, 403);
  for (const event of [{type: 'navigate', url: CRM}, {type: 'type', text: 'owner@example.test', secret: true}, {type: 'type', text: PASSWORD, secret: true}, {type: 'type', text: CODE, secret: true}]) {
    const typed = await owner(`/api/browser-live/${ids.scholar}/input`, event, {secure: true});
    assert.equal(typed.status, 200, JSON.stringify(typed.body));
    assert.doesNotMatch(JSON.stringify(typed.body), /test-only|482913/);
  }
  const typed = (await poll()).body.commands.map(c => c.event);
  assert.deepEqual(typed.map(e => e.type), ['navigate', 'type', 'type', 'type']);
  assert.deepEqual(typed.slice(1).map(e => e.secret), [true, true, true]);
  assert.equal(typed[0].url, CRM);
  assert.doesNotMatch(JSON.stringify(store.read()), /test-only-password|482913/);

  // 4. Hand back: the card is answered, the held page goes out again as a new task, and the run is waiting on that page.
  const back = await owner(`/api/browser-live/${ids.scholar}/handback`);
  assert.equal(back.status, 200);
  assert.deepEqual(back.body.signedIn, {resumed: 1});
  assert.equal(store.read().asks.find(a => a.id === card.id).status, 'allowed');
  assert.deepEqual(store.read().signinPending, {});
  assert.equal(store.read().groupRuns.find(r => r.id === run.id).status, 'awaiting_browser');

  // 5. The next beat claims the new task; the computer posts the signed-in page and the run finishes with it.
  const second = (await beat({})).body.tasks;
  assert.equal(second.length, 1);
  assert.notEqual(second[0].id, first[0].id);
  assert.equal((await device$(`/api/agent/tasks/${second[0].id}/result`, {status: 'done', result: reports})).status, 200);
  await until(() => store.read().groupRuns.find(r => r.id === run.id).status === 'completed', 'the run to finish');
  assert.match(modelCalls.at(-1), /Reports for Sales/);
  assert.match(store.read().chats[ids.scholar].filter(m => m.role !== 'system' && m.role !== 'user').at(-1).text, /Reports for Sales/);
  assert.equal(notices().length, 1, 'the owner was pushed once for the whole thing');

  // 6. Nothing is left waiting that the health watch would call late.
  assert.deepEqual(healthIssues({agents: [], tasks: store.read().tasks || [], now: Date.now()}), []);
});
