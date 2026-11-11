/** The Phases 5-6 review fixes:
 *  C1 the device classifies the control a click lands on (the clickable ancestor, its form's submit, a checkout page),
 *     not only the node the selector named;
 *  C2 a Gmail ask card lists every recipient, flags the ones outside the account's domain, carries the full body,
 *     and is bound to the arguments it showed;
 *  I3 Always allow is per connector tool, so a draft grant never covers a send;
 *  I4 driving the shared browser is an admin's, and the generic task route cannot queue mcp.call or model.run;
 *  I5 connector and AI provider secrets are never revealed through the reveal route;
 *  I6 a connector call is claimed before it runs, and one found mid-run after a restart is never retried;
 *  I7 a device skips an mcp.call or model.run past the deadline the server set.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import * as wf from '../shared/workflow.js';
import * as agent from '../src/agent.js';
import * as credentials from '../src/credentials.js';
import {SqliteStore} from '../src/sqlite-store.js';
import {loadMasterKey} from '../src/vault.js';
import {captureWithBrowser, findBrowser} from '../agent/browser.mjs';
import * as report from '../agent/report-result.mjs';
import * as connectors from '../shared/connectors.js';
const {GOOGLE_ACTIONS, connectorNeeds, recordConnectorCalls} = connectors;
const argsHash = value => connectors.argsHash(value);
import * as bb from '../shared/bot-browser.js';
import {answerAsk, decide, verdict, setGrant, sweepGrants, grantFor} from '../shared/asks.js';
import {askCard, grantWhat} from '../shared/ui-asks.js';
import {createRouter} from '../src/router.js';
import {accountRoutes} from '../src/routes-account.js';
import {liveRoutes} from '../src/routes-live.js';
import {runConnectorCalls} from '../src/connector-runs.js';
import {addMcpConnector} from '../src/connectors.js';
import {mcpCall} from '../src/mcp-client.js';
import {runOnAgent} from '../src/cli-model.js';
import {createRun} from '../shared/coordination.js';
import {company} from './run-fixture.js';
import {fakeMcpHttp} from './mcp-fixture.js';

const NOW = '2026-11-11T10:00:00.000Z';
const ACCOUNT = 'owner@example.test';
const google = () => ({id: 'google', kind: 'google', name: 'Google', account: ACCOUNT, status: 'ready', actions: GOOGLE_ACTIONS});
const state = () => wf.migrate({
  settings: {}, runs: [], tasks: [], events: [], groupMessages: {}, groupRuns: [], connectors: [google()],
  groups: [{id: 'home', name: 'Home', bots: [{id: 'a', name: 'Atlas', instructions: 'lead'}, {id: 'm', name: 'Mailroom', instructions: 'mail'}]}],
});
const mailroom = s => s.groups[0].bots.find(b => b.id === 'm');
const fence = (tool, args, use = 'google') => `Here.\n\`\`\`connector\n${JSON.stringify({use, tool, args})}\n\`\`\``;
const mk = (() => { let n = 0; return () => `p56-${++n}`; })();

// --- C1 -------------------------------------------------------------------------------------------------

const browser = process.env.CI ? null : findBrowser();
test('C1: a click on a child with no text, on a control inside a payment form, or on a checkout page is a payment nobody approved', {skip: !browser && 'no browser installed', timeout: 60000}, async () => {
  const page = `<title>Cart</title>
    <button id="pay"><span id="icon"></span>Pay now</button>
    <form><input id="agree" type="checkbox"><button type="submit">Place order</button></form>
    <button id="next"><span id="next-icon"></span>Next</button><p id="out"></p>
    <script>document.addEventListener('click',e=>{const b=e.target.closest('button,input');if(b)document.getElementById('out').textContent+=(b.id||b.type)+';';});document.querySelector('form').addEventListener('submit',e=>e.preventDefault());</script>`;
  const server = http.createServer((req, res) => res.writeHead(200, {'Content-Type': 'text/html'}).end(req.url.startsWith('/checkout') ? `<button id="go">Continue</button><p id="out"></p><script>go.onclick=()=>out.textContent+='go;'</script>` : page));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const host = `127.0.0.1:${server.address().port}`, permit = h => h !== 'localhost';
  try {
    const steps = [{op: 'click', selector: '#icon'}, {op: 'click', selector: '#agree'}, {op: 'click', selector: '#next-icon'}, {op: 'read', selector: '#out'}];
    const cart = await captureWithBrowser(`http://${host}/`, {allow: [host], binary: browser, permit, steps, approved: ['send']});
    const [icon, agree, next, read] = cart.actions;
    assert.equal(icon.ok, false, 'the icon inside Pay now is the Pay now button');
    assert.equal(icon.risk, 'spend');
    assert.equal(agree.ok, false, 'a control in a form whose submit is Place order is a payment');
    assert.equal(agree.risk, 'spend');
    assert.equal(next.ok, true, 'an icon inside Next is harmless');
    assert.equal(read.text, 'next;', 'no refused click reached the page');
    const checkout = await captureWithBrowser(`http://${host}/checkout`, {allow: [host], binary: browser, permit, steps: [{op: 'click', selector: '#go'}, {op: 'read', selector: '#out'}], approved: ['send']});
    assert.equal(checkout.actions[0].ok, false, 'any click on a checkout page is a payment');
    assert.match(checkout.actions[0].reason, /checkout/i);
    assert.equal(checkout.actions[1].text, '');
    const paid = await captureWithBrowser(`http://${host}/checkout`, {allow: [host], binary: browser, permit, steps: [{op: 'click', selector: '#go'}, {op: 'read', selector: '#out'}], approved: ['spend']});
    assert.equal(paid.actions[0].ok, true, 'with a payment approved the checkout click goes');
  } finally { server.close(); }
});

test('C1: the checkout path the device checks is the one the server asks about', () => {
  assert.ok(bb.CHECKOUT_PATH instanceof RegExp);
  assert.equal(bb.CHECKOUT_PATH.test('/shop/checkout'), true);
  assert.equal(bb.CHECKOUT_PATH.test('/about'), false);
});

// --- C2 -------------------------------------------------------------------------------------------------

test('C2: a Gmail send card lists every recipient, flags the ones outside the domain, and carries the full body', () => {
  const s = state();
  const body = `Hello team,\n\n${'All the details are here. '.repeat(60)}\nThe last line says wire the money.`;
  const args = {to: ['bob@example.test', 'eve@evil.example'], cc: ['carol@other.example', 'dan@example.test'], subject: 'Plan', body};
  const run = {id: 'r1'};
  const out = recordConnectorCalls(s, {bot: mailroom(s), run, chatKey: 'm', output: fence('gmail.send', args), makeId: mk, now: NOW});
  const [ask] = out.asks;
  for (const who of ['bob@example.test', 'eve@evil.example', 'carol@other.example', 'dan@example.test']) assert.ok(ask.detail.includes(who), `${who} is on the card`);
  assert.match(ask.detail, /eve@evil\.example \(outside your domain\)/);
  assert.match(ask.detail, /carol@other\.example \(outside your domain\)/);
  assert.doesNotMatch(ask.detail, /bob@example\.test \(outside/);
  assert.match(ask.detail, /cc /);
  assert.equal(ask.body, body, 'the full body is on the ask');
  const card = askCard(s, {kind: 'ask', askId: ask.id, text: 'Mailroom wants to send.'});
  assert.equal(card.body, body, 'and the card can show all of it');
  assert.equal(ask.argsHash, argsHash(args), 'the ask is bound to what it showed');
});

test('C2: the args hash is canonical: key order does not change it, a changed value does', () => {
  assert.equal(argsHash({a: 1, b: {c: 2, d: 3}}), argsHash({b: {d: 3, c: 2}, a: 1}));
  assert.notEqual(argsHash({to: 'a@x.test'}), argsHash({to: 'b@x.test'}));
});

// --- I3 -------------------------------------------------------------------------------------------------

test('I3: Always allow on a draft does not allow a send', () => {
  const s = state(), bot = mailroom(s);
  const [draft] = connectorNeeds(google(), 'gmail.draft', {to: 'a@example.test', subject: 's', body: 'b'});
  const [send] = connectorNeeds(google(), 'gmail.send', {to: 'a@example.test', subject: 's', body: 'b'});
  assert.equal(draft.action, 'connector.google.write.gmail.draft');
  assert.equal(send.action, 'connector.google.write.gmail.send');
  const out = recordConnectorCalls(s, {bot, run: {id: 'r1'}, chatKey: 'm', output: fence('gmail.draft', {to: 'a@example.test', subject: 's', body: 'b'}), makeId: mk, now: NOW});
  answerAsk(s, out.asks[0].id, 'always', NOW);
  assert.equal(decide(s, bot, [draft]).verdict, 'allow');
  assert.equal(decide(s, bot, [send]).verdict, 'ask', 'a send still asks');
  // Reads stay one grant per connector.
  assert.equal(connectorNeeds(google(), 'gmail.search', {query: 'x'})[0].action, 'connector.google.read');
});

test('I3: an old connector-wide write Always allow becomes Ask each time; an old Deny still denies every tool', () => {
  const s = state();
  s.grants = [{botId: 'm', action: 'connector.google.write', scope: ACCOUNT, choice: 'always', at: NOW}];
  sweepGrants(s);
  assert.equal(grantFor(s, 'm', 'connector.google.write', ACCOUNT), 'ask');
  assert.equal(verdict(s, mailroom(s), 'connector.google.write.gmail.send', ACCOUNT).verdict, 'ask');
  setGrant(s, 'm', 'connector.google.write', ACCOUNT, 'deny', NOW, {log: false});
  assert.equal(verdict(s, mailroom(s), 'connector.google.write.gmail.send', ACCOUNT).verdict, 'deny');
  assert.equal(grantWhat('connector.google.write.gmail.send', ACCOUNT), `Change google: gmail.send (${ACCOUNT})`);
  assert.throws(() => setGrant(s, 'm', 'connector.google.read.gmail.search', ACCOUNT, 'always', NOW), /not something a bot asks about/, 'reads take no tool');
});

// --- I4 -------------------------------------------------------------------------------------------------

const services = new Proxy(function stub() { return stub; }, {get: () => services, apply: () => services});
const routeOf = (register, method, pattern) => { const r = createRouter(); register(r, services); return r.routes.find(x => x.method === method && x.pattern === pattern); };

test('I4: taking over, handing back and typing into the shared browser need an admin', () => {
  for (const what of ['input', 'takeover', 'handback']) assert.equal(routeOf(liveRoutes, 'POST', `/api/browser-live/:botId/${what}`).access, 'admin', what);
  assert.equal(routeOf(liveRoutes, 'GET', '/api/browser-live/:botId').access, 'member', 'frames stay a member\'s');
});

test('I4: the generic task route refuses mcp.call and model.run', async () => {
  const route = routeOf(accountRoutes, 'POST', '/api/agents/:id/tasks');
  for (const kind of ['mcp.call', 'model.run']) {
    const c = {body: async () => ({kind, payload: {server: 'files', op: 'call', tool: 'x', engine: 'claude', input: 'hi'}}), params: {id: 'a1'}, store: services, actor: {email: 'm@example.test', workspaceId: 'default'}};
    await assert.rejects(route.handler(c), e => e.status === 400 && /only by the server/i.test(e.message), kind);
  }
});

// --- I5 -------------------------------------------------------------------------------------------------

test('I5: connector and AI provider secrets are never revealed', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'p56-vault-'));
  try {
    const dataFile = path.join(dir, 'state.json');
    const store = await new SqliteStore(path.join(dir, 'state.db'), dataFile).init();
    store.vaultKey = loadMasterKey(dataFile).key;
    for (const kind of ['google_client', 'google_token', 'connector_mcp', 'ai_provider', 'ai_headers']) {
      const {id} = credentials.addCredential(store, 'default', {name: kind, kind, value: 'secret'});
      assert.throws(() => credentials.revealCredential(store, 'default', id), e => e.status === 403 && /cannot be revealed/i.test(e.message), kind);
      assert.equal(credentials.revealValue(store, id), 'secret', 'the app itself still reads it');
    }
    const {id} = credentials.addCredential(store, 'default', {name: 'hook', kind: 'webhook', value: 'plain'});
    assert.equal(credentials.revealCredential(store, 'default', id).value, 'plain', 'an ordinary secret is still revealed');
  } finally { await fs.rm(dir, {recursive: true, force: true}); }
});

// --- I6 and C2 at execution ------------------------------------------------------------------------------

async function rig(t) {
  const {store, ids} = await company(t);
  store.vaultKey = crypto.randomBytes(32);
  store.run("INSERT INTO workspaces (id,name,created_at) VALUES ('default','Primary workspace',?)", new Date().toISOString());
  const server = await fakeMcpHttp();
  t.after(() => server.close());
  const notes = await addMcpConnector(store, 'default', {kind: 'mcp', name: 'Notes', url: server.url});
  server.calls.length = 0;
  const runId = await store.update(s => {
    const run = createRun({group: s.groups.find(g => g.id === 'home'), message: 'note it', directBotId: ids.mail, chatKey: ids.mail, guests: [], makeId: crypto.randomUUID});
    run.status = 'running';
    s.groupRuns.unshift(run);
    return run.id;
  });
  const call = (extra = {}) => ({id: crypto.randomUUID(), connectorId: notes.id, connectorName: 'Notes', tool: 'add_note', args: {text: 'milk'}, write: true, botId: ids.mail, botName: 'Mailroom', status: 'go', chatKey: ids.mail, ...extra});
  const lines = [];
  const say = (s, run, line) => lines.push(line);
  return {store, ids, server, runId, call, lines, say};
}
const toolCalls = server => server.calls.filter(c => c.message?.method === 'tools/call');
const runOf = (store, id) => store.read().groupRuns.find(r => r.id === id);

test('I6: a connector call is claimed as running in the store before it reaches the server, then marked done', async t => {
  const {store, server, runId, call, say} = await rig(t);
  const c = call();
  await store.update(s => { s.groupRuns.find(r => r.id === runId).connectorCalls = [c]; });
  const seen = [];
  server.calls.push = function (entry) { if (entry.message?.method === 'tools/call') seen.push(runOf(store, runId).connectorCalls[0].status); return Array.prototype.push.call(this, entry); };
  assert.equal(await runConnectorCalls(store, runId, {say}), true);
  assert.deepEqual(seen, ['running']);
  assert.equal(runOf(store, runId).connectorCalls[0].status, 'done');
});

test('I6: a call found running after a restart becomes unknown, is not retried, and the bot is told it may or may not have happened', async t => {
  const {store, server, runId, call, say, lines} = await rig(t);
  await store.update(s => { s.groupRuns.find(r => r.id === runId).connectorCalls = [call({status: 'running'})]; });
  assert.equal(await runConnectorCalls(store, runId, {say}), true);
  assert.deepEqual(toolCalls(server), [], 'it never reached the server again');
  const live = runOf(store, runId);
  assert.equal(live.connectorCalls[0].status, 'unknown');
  assert.match(live.connectorPage, /may or may not have happened/);
  assert.match(lines.map(l => l.text).join('\n'), /may or may not have happened/);
});

test('C2: a call whose arguments differ from the ones its ask showed does not run', async t => {
  const {store, server, runId, call, say, lines} = await rig(t);
  await store.update(s => {
    s.asks = [{id: 'ask-1', botId: 'x', action: 'connector.notes.write.add_note', target: '', detail: 'use Notes: add_note (text: milk)', status: 'allowed', scope: 'once', createdAt: NOW, argsHash: argsHash({text: 'milk'})}];
    s.groupRuns.find(r => r.id === runId).connectorCalls = [call({askId: 'ask-1', args: {text: 'transfer everything'}})];
  });
  assert.equal(await runConnectorCalls(store, runId, {say}), true);
  assert.deepEqual(toolCalls(server), [], 'nothing reached the server');
  assert.equal(runOf(store, runId).connectorCalls[0].status, 'failed');
  assert.match(lines.map(l => l.text).join('\n'), /changed after you were asked/);
});

// --- I7 -------------------------------------------------------------------------------------------------

async function paired(t, permissions) {
  const {store} = await company(t);
  store.run("INSERT OR IGNORE INTO workspaces (id,name,created_at) VALUES ('default','Primary workspace',?)", new Date().toISOString());
  agent.attachVault(store, store.legacyPath);
  const {code} = agent.createPairing(store, 'default', {});
  const device = agent.redeemPairing(store, {code, name: 'Laptop', permissions});
  agent.touchAgent(store, device.agentId);
  return {store, agentId: device.agentId};
}
const payloadOf = store => JSON.parse(store.get('SELECT payload FROM agent_tasks ORDER BY created_at DESC LIMIT 1').payload);

test('I7: the server puts its own deadline on an mcp.call and a model.run', async t => {
  const mcp = await paired(t, ['mcp.call']);
  const before = Date.now();
  await assert.rejects(mcpCall({transport: 'stdio', store: mcp.store, server: 'files'}, 'read_file', {}, {timeoutMs: 400, pollMs: 10}), e => e.code === 'timeout');
  const p = payloadOf(mcp.store);
  assert.ok(p.notAfter >= before + 400 && p.notAfter <= Date.now() + 400, `notAfter ${p.notAfter} is the server's own deadline`);
  const cli = await paired(t, ['model.run']);
  const start = Date.now();
  await assert.rejects(runOnAgent(cli.store, {engine: 'claude', input: 'hi', waitMs: 300, pollMs: 10}), e => e.code === 'timeout');
  const q = payloadOf(cli.store);
  assert.ok(q.notAfter >= start + 300 && q.notAfter <= Date.now() + 300, `notAfter ${q.notAfter} is the server's own deadline`);
});

test('I7: a device skips a task past its deadline and reports it failed as expired', async () => {
  const sent = [];
  const call = async (config, url, body) => { sent.push({url, body}); return {}; };
  const task = {id: 't1', kind: 'mcp.call', attempts: 1, payload: {server: 'files', op: 'call', tool: 'x', notAfter: Date.now() - 1}};
  assert.equal(await report.skipExpired(call, {}, task), true);
  assert.deepEqual(sent, [{url: '/api/agent/tasks/t1/result', body: {status: 'failed', error: 'expired', attempts: 1}}]);
  for (const live of [{...task, payload: {...task.payload, notAfter: Date.now() + 60000}}, {...task, payload: {server: 'files', op: 'list'}}, {...task, kind: 'http.check', payload: {notAfter: Date.now() - 1}}]) {
    sent.length = 0;
    assert.equal(await report.skipExpired(call, {}, live), false);
    assert.deepEqual(sent, []);
  }
});
