/** The Phases 2-4 review fixes for the ask mechanism:
 *  C1 a click or a typed field the bot has not seen labelled is asked about (at least as a Send), the
 *     classes the owner approved travel with the dispatched page, and the browser re-reads the control
 *     at the moment it acts and refuses a risky one nobody approved;
 *  I2 Always allow for send, post and delete is for one site, not every site;
 *  I3 the old permission plus "run without asking" is no longer Always allow;
 *  M8 Always allow on one ask never grants another origin.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import * as wf from '../shared/workflow.js';
import * as agent from '../src/agent.js';
import {SqliteStore} from '../src/sqlite-store.js';
import {scopeOf, setGrant, grantFor, verdict, decide, createAsk, answerAsk, sweepGrants} from '../shared/asks.js';
import * as bb from '../shared/bot-browser.js';
const {browserNeeds, validateBrowserRequest, recordBrowserRequests} = bb;
const riskOf = label => bb.riskOf(label);
import {dispatchBrowserRequest} from '../src/bot-browser.js';
import {captureWithBrowser, findBrowser} from '../agent/browser.mjs';
import {runBrowserTask} from '../agent/shared-browser.mjs';

const NOW = '2026-11-11T10:00:00.000Z';
const SHOP = 'https://shop.example';
const state = () => wf.migrate({
  settings: {}, runs: [], tasks: [], events: [], groupMessages: {}, groupRuns: [],
  groups: [{id: 'home', name: 'Home', bots: [{id: 'a', name: 'Atlas', instructions: 'lead'}, {id: 'b', name: 'Shopper', instructions: 'shop'}]}],
});
const shopper = s => s.groups[0].bots.find(b => b.id === 'b');
const block = body => `On it.\n\`\`\`browser\n${JSON.stringify(body)}\n\`\`\``;
const mk = (() => { let n = 0; return () => `fc-${++n}`; })();

test('C1: with Always allow for the shop, a click by selector or by an index the bot never saw still asks', () => {
  const s = state();
  setGrant(s, 'b', 'browser.use', SHOP, 'always', NOW, {log: false});
  for (const step of [{op: 'click', selector: '#place-order'}, {op: 'click', index: 7}, {op: 'type', selector: '#card', text: '4242'}]) {
    const request = validateBrowserRequest({url: `${SHOP}/cart`, steps: [step]});
    const decision = decide(s, shopper(s), browserNeeds(request));
    assert.equal(decision.verdict, 'ask', `${JSON.stringify(step)} must not be allowed by the page grant alone`);
    assert.equal(decision.need.action, 'send', 'an unlabelled control is at least a Send');
  }
  // A control the bot was shown with a harmless label is still just the page.
  const seen = validateBrowserRequest({url: `${SHOP}/cart`, steps: [{op: 'click', index: 2}]});
  assert.equal(decide(s, shopper(s), browserNeeds(seen, new Map([[2, 'Next page']]))).verdict, 'allow');
  // And one shown as a payment is a payment.
  assert.equal(decide(s, shopper(s), browserNeeds(seen, new Map([[2, 'Place order']]))).need.action, 'spend');
});

test('C1: the risk words, as one classifier the browser reuses', () => {
  assert.deepEqual(riskOf('Place order'), ['spend']);
  assert.deepEqual(riskOf('Send message'), ['send']);
  assert.deepEqual(riskOf('Delete account'), ['delete']);
  assert.deepEqual(riskOf('Publish'), ['post']);
  assert.deepEqual(riskOf('Next page'), []);
});

test('C1: a request records the classes it was asked about, and the bot cannot write them', () => {
  const s = state();
  setGrant(s, 'b', 'browser.use', SHOP, 'always', NOW, {log: false});
  const out = recordBrowserRequests(s, {bot: shopper(s), groupId: 'home', chatKey: 'b', makeId: mk, now: NOW,
    output: block({url: `${SHOP}/cart`, steps: [{op: 'click', selector: '#go'}], approved: ['spend', 'send', 'post', 'delete']})});
  const [record] = out.records;
  assert.deepEqual(record.approved, [`send@${SHOP}`], 'only what the owner is asked about, never what the reply claims');
  assert.equal(out.asks.length, 1);
  const plain = recordBrowserRequests(s, {bot: shopper(s), groupId: 'home', chatKey: 'b', makeId: mk, now: NOW, output: block({url: `${SHOP}/about`, approved: ['spend']})});
  assert.deepEqual(plain.records[0].approved, [], 'a plain read approves no risky click');
});

async function harness() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fail-closed-'));
  const store = await new SqliteStore(path.join(dir, 'state.db'), path.join(dir, 'state.json')).init();
  store.run("INSERT INTO workspaces (id,name,created_at) VALUES ('default','Primary workspace',?)", new Date().toISOString());
  agent.attachVault(store, path.join(dir, 'state.json'));
  return {dir, store};
}

test('C1: the approved classes travel on the dispatched task, to the server browser and to the device', async () => {
  const {dir, store} = await harness();
  try {
    const pending = id => ({id, botId: 'b', botName: 'Shopper', groupId: 'home', chatKey: 'b', url: `${SHOP}/cart`, steps: [{op: 'click', selector: '#go'}], kind: 'browser.action', approved: ['send'], depth: 0, status: 'pending', agentTaskIds: [], result: null, error: null, createdAt: NOW, updatedAt: NOW});
    await store.update(s => { Object.assign(s, state()); s.browserRequests = [pending('here'), pending('there')]; });
    const ran = [];
    const here = {mode: 'auto', available: () => true, run: async request => { ran.push(request); return {title: 'Cart'}; }, close: async () => {}};
    await dispatchBrowserRequest(store, 'here', {runtime: here});
    for (let i = 0; i < 50 && !ran.length; i++) await new Promise(r => setTimeout(r, 10));
    assert.deepEqual(ran[0].approved, ['send'], 'the server browser is told what was approved');
    const {code} = agent.createPairing(store, 'default', {});
    const device = agent.redeemPairing(store, {code, name: 'Laptop', permissions: ['browser.action']});
    await dispatchBrowserRequest(store, 'there', {runtime: {mode: 'agent', available: () => false}});
    const [task] = agent.claimAgentTasks(store, device.agentId);
    assert.deepEqual(JSON.parse(task.payload).approved, ['send'], 'the device is told what was approved');
  } finally { await fs.rm(dir, {recursive: true, force: true}); }
});

test('C1: the device passes the approved classes to the browser, and none when the task carries none', async () => {
  const seen = [];
  const shared = {run: async (botId, opts) => { seen.push(opts.approved); return {}; }};
  const env = {AGENT_BROWSER: '1'};
  await runBrowserTask({kind: 'browser.action', payload: {url: `${SHOP}/`, steps: [{op: 'click', index: 1}], approved: ['send']}}, {shared, allow: ['shop.example'], env});
  await runBrowserTask({kind: 'browser.action', payload: {url: `${SHOP}/`, steps: [{op: 'click', index: 1}], approved: 'spend'}}, {shared, allow: ['shop.example'], env});
  assert.deepEqual(seen, [['send'], []]);
});

const browser = process.env.CI ? null : findBrowser();
test('C1: at the click the browser re-reads the control and refuses a risky one nobody approved', {skip: !browser && 'no browser installed', timeout: 60000}, async () => {
  const server = http.createServer((req, res) => res.writeHead(200, {'Content-Type': 'text/html'}).end(
    `<title>Cart</title><button id="go" aria-label="Checkout">Continue</button><button id="send">Send</button><button id="next">Next</button><p id="out"></p>` +
    `<script>for(const b of document.querySelectorAll('button'))b.addEventListener('click',()=>{document.getElementById('out').textContent+=b.id+';';});</script>`));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const host = `127.0.0.1:${server.address().port}`, permit = h => h !== 'localhost';
  const steps = [{op: 'click', selector: '#go'}, {op: 'click', selector: '#send'}, {op: 'click', selector: '#next'}, {op: 'read', selector: '#out'}];
  try {
    const page = await captureWithBrowser(`http://${host}/`, {allow: [host], binary: browser, permit, steps, approved: [`send@http://${host}`]});
    const [pay, send, next, read] = page.actions;
    assert.equal(pay.ok, false, 'a control whose aria-label says Checkout is a payment');
    assert.match(pay.reason, /payment/);
    assert.match(pay.reason, /Checkout/);
    assert.equal(send.ok, true, 'Send was approved');
    assert.equal(next.ok, true);
    assert.equal(read.text, 'send;next;', 'the refused click never reached the page');
    const none = await captureWithBrowser(`http://${host}/`, {allow: [host], binary: browser, permit, steps: [{op: 'click', selector: '#send'}, {op: 'read', selector: '#out'}]});
    assert.equal(none.actions[0].ok, false, 'with nothing approved a Send is refused too');
    assert.equal(none.actions[1].text, '');
  } finally { server.close(); }
});

test('I2: Always allow for send, post and delete is for the site it was asked on', () => {
  assert.equal(scopeOf({action: 'send', target: 'https://Mail.Example.com/compose'}), 'https://mail.example.com');
  assert.equal(scopeOf({action: 'post', target: 'https://blog.example/new'}), 'https://blog.example');
  assert.equal(scopeOf({action: 'delete', target: 'not a url'}), '');
  const s = state();
  const ask = createAsk(s, {botId: 'b', chatKey: 'b', action: 'send', target: `${SHOP}/contact`, now: NOW, makeId: mk});
  answerAsk(s, ask.id, 'always', NOW);
  assert.equal(grantFor(s, 'b', 'send', SHOP), 'always');
  assert.equal(verdict(s, shopper(s), 'send', `${SHOP}/other`).verdict, 'allow');
  assert.equal(verdict(s, shopper(s), 'send', 'https://bank.example/transfer').verdict, 'ask', 'another site asks again');
  assert.throws(() => setGrant(s, 'b', 'delete', '', 'always', NOW), e => e.status === 400, 'a send, post or delete grant names its site');
});

test('I2: a stored send, post or delete grant with no site is dropped on load', () => {
  const s = state();
  s.grants = [
    {botId: 'b', action: 'send', scope: '', choice: 'always', at: NOW},
    {botId: 'b', action: 'post', scope: '', choice: 'deny', at: NOW},
    {botId: 'b', action: 'send', scope: SHOP, choice: 'always', at: NOW},
    {botId: 'b', action: 'spend', scope: '', choice: 'deny', at: NOW},
  ];
  sweepGrants(s);
  assert.deepEqual(s.grants.map(g => `${g.action}@${g.scope}`), [`send@${SHOP}`, 'spend@']);
  assert.equal(wf.migrate({...state(), grants: [{botId: 'b', action: 'delete', scope: '', choice: 'always', at: NOW}]}).grants.length, 0, 'migrate sweeps them');
});

test('I3: the old permission with "run without asking" is Ask each time, not Always allow', () => {
  const s = state();
  const legacy = {...shopper(s), permissions: ['browser.use'], settings: {browserApproval: 'auto'}};
  assert.equal(verdict(s, legacy, 'browser.use', SHOP).verdict, 'ask');
  setGrant(s, 'b', 'browser.use', SHOP, 'always', NOW, {log: false});
  assert.equal(verdict(s, legacy, 'browser.use', SHOP).verdict, 'allow', 'an explicit grant still allows');
});

test('M8: Always allow on one ask covers only its own site', () => {
  const s = state();
  const request = validateBrowserRequest({url: `${SHOP}/cart`, steps: [{op: 'click', selector: '#go'}, {op: 'navigate', url: 'https://bank.example/'}]});
  const decision = decide(s, shopper(s), browserNeeds(request));
  assert.equal(decision.need.action, 'send');
  assert.deepEqual(decision.implies, [{action: 'browser.use', scope: SHOP}], 'the other origin is not implied');
  // A stored ask that carries another origin (made before this fix) grants it no more.
  const ask = createAsk(s, {botId: 'b', chatKey: 'b', action: 'send', target: `${SHOP}/cart`, implies: [{action: 'browser.use', scope: SHOP}, {action: 'browser.use', scope: 'https://bank.example'}], now: NOW, makeId: mk});
  answerAsk(s, ask.id, 'always', NOW);
  assert.equal(grantFor(s, 'b', 'browser.use', SHOP), 'always');
  assert.equal(grantFor(s, 'b', 'browser.use', 'https://bank.example'), null);
});

test('C1: a task payload cannot carry its own approvals; only the dispatch argument can', async () => {
  const {dir, store} = await harness();
  try {
    const {code} = agent.createPairing(store, 'default', {});
    const device = agent.redeemPairing(store, {code, name: 'Laptop', permissions: ['browser.action']});
    const {task} = agent.enqueueAgentTask(store, device.agentId, {kind: 'browser.action', payload: {url: `${SHOP}/`, steps: [{op: 'click', index: 1}], approved: ['spend']}, idempotencyKey: 'k1', createdBy: 'job'});
    assert.equal(JSON.parse(store.get('SELECT payload FROM agent_tasks WHERE id=?', task.id).payload).approved, undefined, 'absent, which the device reads as nothing approved');
  } finally { await fs.rm(dir, {recursive: true, force: true}); }
});
