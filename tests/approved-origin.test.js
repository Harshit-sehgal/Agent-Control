/** PR 5 review fixes:
 *  A  a browser action is approved for the origin it runs on, not the request URL: a request that navigates
 *     from site A to site B and then clicks Send is decided against B's send grant, `approved` names the
 *     origin, and the browser checks the class against `location.origin` at the click;
 *  B  an allowed connector call is bound to the connector the owner was asked about: a connector removed and
 *     replaced under the same name, or reconnected to another account, while the ask waits runs nothing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import * as wf from '../shared/workflow.js';
import {setGrant} from '../shared/asks.js';
import {recordBrowserRequests} from '../shared/bot-browser.js';
import {captureWithBrowser, findBrowser} from '../agent/browser.mjs';
import {answerAskFlow} from '../src/ask-runs.js';
import {addMcpConnector, removeConnector} from '../src/connectors.js';
import {company, model, ask} from './run-fixture.js';
import {fakeMcpHttp} from './mcp-fixture.js';

const NOW = '2026-11-11T10:00:00.000Z';
const A = 'https://a.example', B = 'https://b.example';
const state = () => wf.migrate({
  settings: {}, runs: [], tasks: [], events: [], groupMessages: {}, groupRuns: [],
  groups: [{id: 'home', name: 'Home', bots: [{id: 'a', name: 'Atlas', instructions: 'lead'}, {id: 'b', name: 'Shopper', instructions: 'shop'}]}],
});
const shopper = s => s.groups[0].bots.find(b => b.id === 'b');
const block = body => `On it.\n\`\`\`browser\n${JSON.stringify(body)}\n\`\`\``;
const mk = (() => { let n = 0; return () => `ao-${++n}`; })();
const hop = {url: `${A}/start`, steps: [{op: 'navigate', url: `${B}/inbox`}, {op: 'click', selector: '#send'}]};

test('A: a Send after navigating to another site is decided by that site\'s grant: a Deny there refuses', () => {
  const s = state();
  for (const origin of [A, B]) setGrant(s, 'b', 'browser.use', origin, 'always', NOW, {log: false});
  setGrant(s, 'b', 'send', A, 'always', NOW, {log: false});
  setGrant(s, 'b', 'send', B, 'deny', NOW, {log: false});
  const out = recordBrowserRequests(s, {bot: shopper(s), groupId: 'home', chatKey: 'b', makeId: mk, now: NOW, output: block(hop)});
  assert.deepEqual(out.records, [], 'nothing is dispatched: Send is Deny on b.example');
  assert.deepEqual(out.asks, []);
  assert.match(out.lines.map(l => l.text).join('\n'), /Deny/);
});

test('A: a Send on another site asks about that site, and is approved only for it', () => {
  const s = state();
  for (const origin of [A, B]) setGrant(s, 'b', 'browser.use', origin, 'always', NOW, {log: false});
  setGrant(s, 'b', 'send', A, 'always', NOW, {log: false});
  const out = recordBrowserRequests(s, {bot: shopper(s), groupId: 'home', chatKey: 'b', makeId: mk, now: NOW, output: block(hop)});
  const [record] = out.records, [card] = out.asks;
  assert.equal(card.action, 'send');
  assert.equal(card.grantScope, B, 'the ask is about b.example, where the Send happens');
  assert.match(card.detail, /b\.example/);
  assert.deepEqual(record.approved, [`send@${B}`], 'approved names the origin it is for');
});

const browser = process.env.CI ? null : findBrowser();
test('A: at the click the browser refuses a Send approved for another origin', {skip: !browser && 'no browser installed', timeout: 60000}, async () => {
  const html = `<title>Mail</title><button id="send">Send</button><p id="out"></p><script>send.onclick=()=>out.textContent+='sent;'</script>`;
  const servers = [http.createServer((req, res) => res.writeHead(200, {'Content-Type': 'text/html'}).end(html)), http.createServer((req, res) => res.writeHead(200, {'Content-Type': 'text/html'}).end(html))];
  for (const server of servers) await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const [hostA, hostB] = servers.map(server => `127.0.0.1:${server.address().port}`), permit = h => h !== 'localhost';
  try {
    const steps = [{op: 'click', selector: '#send'}, {op: 'navigate', url: `http://${hostB}/`}, {op: 'click', selector: '#send'}, {op: 'read', selector: '#out'}];
    const page = await captureWithBrowser(`http://${hostA}/`, {allow: [hostA, hostB], binary: browser, permit, steps, approved: [`send@http://${hostA}`]});
    const [onA, , onB, read] = page.actions;
    assert.equal(onA.ok, true, 'Send was approved on the first origin');
    assert.equal(onB.ok, false, 'the same Send on the second origin was not approved');
    assert.match(onB.reason, /send nobody approved/);
    assert.equal(read.text, '', 'the refused click never reached the second page');
  } finally { for (const server of servers) server.close(); }
});

// --- B ------------------------------------------------------------------------------------------------------

const fence = (tool, args = {}, use = 'notes') => `One moment.\n\`\`\`connector\n${JSON.stringify({use, tool, args})}\n\`\`\``;
const until = async (check, note) => {
  for (let i = 0; i < 300; i++) { const value = check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error(`timed out waiting for ${note}`);
};
const runOf = (store, id) => store.read().groupRuns.find(r => r.id === id);
const toolCalls = server => server.calls.filter(c => c.message?.method === 'tools/call');
const OWNER = {actor: 'owner@example.test'};
const using = (tool, args) => model({Mailroom: envelope => (envelope.connectorResult || envelope.declined ? `Report: ${envelope.connectorResult || ''} ${envelope.declined || ''}`.trim() : fence(tool, args))});

async function rig(t) {
  const {store, ids} = await company(t);
  store.vaultKey = crypto.randomBytes(32);
  store.run("INSERT INTO workspaces (id,name,created_at) VALUES ('default','Primary workspace',?)", new Date().toISOString());
  const first = await fakeMcpHttp(), second = await fakeMcpHttp();
  t.after(() => { first.close(); second.close(); });
  await addMcpConnector(store, 'default', {kind: 'mcp', name: 'Notes', url: first.url});
  first.calls.length = 0;
  return {store, ids, first, second};
}

test('B: a connector replaced under the same name while its ask waits: Allow runs nothing on the replacement', async t => {
  const {store, ids, first, second} = await rig(t);
  const ai = using('search_notes', {query: 'rent'});
  const run = await ask(store, {message: 'Find the rent note', to: ids.mail, executor: ai.executor});
  const [card] = store.read().asks;
  await removeConnector(store, 'default', 'notes');
  const replacement = await addMcpConnector(store, 'default', {kind: 'mcp', name: 'Notes', url: second.url});
  assert.equal(replacement.id, 'notes', 'the replacement has the id the pending call names');
  second.calls.length = 0;
  await answerAskFlow(store, card.id, 'allow', {...OWNER, executor: ai.executor});
  await until(() => runOf(store, run.id).status === 'completed', 'the run to finish');
  assert.deepEqual(toolCalls(second), [], 'nothing reached the replacement server');
  assert.deepEqual(toolCalls(first), []);
  assert.match(ai.of('Mailroom')[1].connectorResult, /The connector changed after you were asked; ask again/);
});

test('B: a connector reconnected to another account while its ask waits: Allow runs nothing', async t => {
  const {store, ids, first} = await rig(t);
  const ai = using('search_notes', {query: 'rent'});
  const run = await ask(store, {message: 'Find the rent note', to: ids.mail, executor: ai.executor});
  const [card] = store.read().asks;
  await store.update(s => { s.connectors[0].account = 'someone-else.example'; });
  await answerAskFlow(store, card.id, 'allow', {...OWNER, executor: ai.executor});
  await until(() => runOf(store, run.id).status === 'completed', 'the run to finish');
  assert.deepEqual(toolCalls(first), [], 'nothing was sent for the other account');
  assert.match(ai.of('Mailroom')[1].connectorResult, /The connector changed after you were asked; ask again/);
});
