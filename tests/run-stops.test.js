/** A run with no limits still ends. When the rounds the owner set run out, the bot answers with what it has; when
 * nothing new comes back three rounds in a row (pages that fail, or pages it already has), the run stops and the
 * owner is told why. The model is scripted, the browser is a fake, and the run loop is the real one. */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {resumeBrowserRun, queueGroupRun} from '../src/coordination.js';
import {BACKSTOP} from '../shared/limits.js';
import {setBrowserResultHooks} from '../src/bot-browser.js';
import {browserRuntime} from '../src/browser-runtime.js';
import {company, model, ask} from './run-fixture.js';
import {setGrant, scopeOf} from '../shared/asks.js';

const fence = url => `Looking.\n\`\`\`browser\n${JSON.stringify({url})}\n\`\`\``;
const until = async (check, note) => {
  for (let i = 0; i < 500; i++) { const value = check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error(`timed out waiting for ${note}`);
};
const opened = [];
const realRun = browserRuntime.run, realAvailable = browserRuntime.available;
const fakeBrowser = (t, run) => {
  opened.length = 0;
  browserRuntime.available = () => true;
  browserRuntime.run = async request => { opened.push(request.url); return run(request); };
  t.after(() => { browserRuntime.available = realAvailable; browserRuntime.run = realRun; });
};
const wire = executor => setBrowserResultHooks({continueRun: async () => {}, resumeBrowser: (store, request, options) => resumeBrowserRun(store, request, {...options, executor})});
const runOf = (store, id) => store.read().groupRuns.find(r => r.id === id);
const ended = (store, id) => ['completed', 'failed'].includes(runOf(store, id)?.status);
const notices = store => { const sent = []; store.notify = async n => { sent.push(n); }; return sent; };

test('when the owner\'s rounds run out, the bot answers with what it read instead of stopping mid-way', async t => {
  fakeBrowser(t, async request => ({title: 'Page', finalUrl: request.url, text: `Listing at ${request.url}`}));
  const {store, ids} = await company(t);
  await store.update(s => { s.limits = {rounds: 1}; });
  const ai = model({Mailroom: e => (e.note ? `Shortlist from what I read: ${e.note.length > 0 ? 'one listing' : ''}` : e.page ? fence('https://jobs.example/two') : fence('https://jobs.example/one'))});
  wire(ai.executor);
  const run = await ask(store, {message: 'find jobs', to: ids.mail, executor: ai.executor});
  await until(() => ended(store, run.id), 'the run');
  assert.equal(runOf(store, run.id).status, 'completed');
  assert.deepEqual(opened, ['https://jobs.example/one']);
  assert.match(runOf(store, run.id).lastOutput, /Shortlist from what I read/);
});

test('asking again and again for pages it already has stops the run after three rounds and tells the owner', async t => {
  fakeBrowser(t, async request => ({title: 'Page', finalUrl: request.url, text: 'Same page'}));
  const {store, ids} = await company(t);
  const sent = notices(store);
  const ai = model({Mailroom: () => fence('https://jobs.example/same')});
  wire(ai.executor);
  const run = await ask(store, {message: 'find jobs', to: ids.mail, executor: ai.executor});
  await until(() => ended(store, run.id), 'the run');
  const done = runOf(store, run.id);
  assert.equal(done.status, 'failed');
  assert.match(done.error, /kept asking for pages it already had/);
  assert.equal(opened.length, 1, 'the page was opened once');
  await until(() => sent.length, 'the notice');
  assert.equal(sent[0].title, 'A task stopped');
  assert.match(sent[0].body, /Mailroom/);
});

test('pages that keep failing give the bot a turn to try another, then stop the run after three and tell the owner', async t => {
  fakeBrowser(t, async () => { throw new Error('The page did not finish loading within 25s.'); });
  const {store, ids} = await company(t);
  const sent = notices(store);
  let n = 0;
  const ai = model({Mailroom: () => fence(`https://jobs.example/${++n}`)});
  wire(ai.executor);
  const run = await ask(store, {message: 'find jobs', to: ids.mail, executor: ai.executor});
  await until(() => ended(store, run.id), 'the run');
  const done = runOf(store, run.id);
  assert.equal(done.status, 'failed');
  assert.match(done.error, /3 times in a row/);
  assert.match(done.error, /did not finish loading/);
  assert.equal(opened.length, 3, 'it tried three different pages');
  await until(() => sent.length, 'the notice');
  assert.equal(sent[0].title, 'A task stopped');
});

test('an owner\'s step limit bounds a queued run; with none, the run has the backstop', async t => {
  const server = http.createServer((request, response) => {
    request.resume(); request.on('end', () => { response.writeHead(200, {'content-type': 'application/json'}); response.end(JSON.stringify({choices: [{message: {content: 'ok'}}]})); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  Object.assign(process.env, {AI_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`, AI_API_KEY: 'test-key', AI_MODEL: 'test-model', AI_API_STYLE: 'chat'});
  const {store, ids} = await company(t);
  const free = await queueGroupRun(store, {groupId: 'home', message: 'Sort my inbox', directBotId: ids.mail, chatKey: ids.mail, anyway: true});
  await until(() => ended(store, free.runId), 'the first run');
  assert.equal(runOf(store, free.runId).maxSteps, BACKSTOP.steps);
  await store.update(s => { s.limits = {steps: 3}; });
  const tight = await queueGroupRun(store, {groupId: 'home', message: 'Sort it again', directBotId: ids.mail, chatKey: ids.mail, anyway: true});
  await until(() => ended(store, tight.runId), 'the second run');
  assert.equal(runOf(store, tight.runId).maxSteps, 3);
});

test('a bot that asks again for a page the run already read is handed that page, not refused', async t => {
  fakeBrowser(t, async request => ({title: 'Page', finalUrl: request.url, text: 'Acme intern, stipend 30k'}));
  const {store, ids} = await company(t);
  let turns = 0;
  const ai = model({Mailroom: e => (++turns === 1 ? fence('https://jobs.example/same') : turns === 2 ? fence('https://jobs.example/same') : `Answer: ${/stipend 30k/.test(e.page || '') && /https:\/\/jobs\.example\/same/.test(e.page || '') ? 'got it' : 'missing'}`)});
  wire(ai.executor);
  const run = await ask(store, {message: 'find jobs', to: ids.mail, executor: ai.executor});
  await until(() => ended(store, run.id), 'the run');
  assert.equal(runOf(store, run.id).status, 'completed');
  assert.equal(opened.length, 1, 'the page was opened once');
  assert.match(runOf(store, run.id).lastOutput, /Answer: got it/);
});

test('a reply whose page request opens nothing (a repeat) never shows its raw browser block in the chat', async t => {
  fakeBrowser(t, async request => ({title: 'Page', finalUrl: request.url, text: 'Same page'}));
  const {store, ids} = await company(t);
  // The model's whole reply is the block, with no words around it.
  const ai = model({Mailroom: () => fence('https://jobs.example/same').replace('Looking.\n', '')});
  wire(ai.executor);
  const run = await ask(store, {message: 'find jobs', to: ids.mail, executor: ai.executor});
  await until(() => ended(store, run.id), 'the run');
  const lines = Object.values(store.read().chats || {}).flat().concat(Object.values(store.read().groupMessages || {}).flat());
  assert.ok(lines.length > 0);
  assert.deepEqual(lines.filter(m => /```browser/.test(m.text || '')).map(m => m.text), []);
});

test('a bot that only searches, round after round, is told to open the results or answer', async t => {
  fakeBrowser(t, async request => ({title: 'Results', finalUrl: request.url, text: 'Some results', links: [{text: 'Acme intern posting', url: 'https://jobs.example/1'}]}));
  const {store, ids} = await company(t);
  let n = 0, nudged = '';
  const ai = model({Mailroom: e => { if (e.note) { nudged = e.note; return 'Here is what I found.'; } return fence(`https://www.bing.com/search?q=intern+${++n}`); }});
  wire(ai.executor);
  const run = await ask(store, {message: 'find jobs', to: ids.mail, executor: ai.executor});
  await until(() => ended(store, run.id), 'the run');
  assert.match(nudged, /searched 3 times/);
  assert.equal(opened.length, 3);
});

test('a bot handed back a page it already had is told so, and answers from it', async t => {
  fakeBrowser(t, async request => ({title: 'Page', finalUrl: request.url, text: 'Acme intern, stipend 30k'}));
  const {store, ids} = await company(t);
  let told = '';
  const ai = model({Mailroom: e => { if (e.note) { told = e.note; return 'Acme pays 30k.'; } return fence('https://jobs.example/same'); }});
  wire(ai.executor);
  const run = await ask(store, {message: 'find jobs', to: ids.mail, executor: ai.executor});
  await until(() => ended(store, run.id), 'the run');
  assert.equal(runOf(store, run.id).status, 'completed');
  assert.match(told, /already/);
  assert.match(told, /Links|answer/);
});

test('a reply that only fetched pages is a working step, not an answer, so the chat can leave it out', async t => {
  fakeBrowser(t, async request => ({title: 'Page', finalUrl: request.url, text: 'Acme intern'}));
  const {store, ids} = await company(t);
  const ai = model({Mailroom: e => (e.page ? 'Acme is hiring.' : fence('https://jobs.example/one'))});
  wire(ai.executor);
  const run = await ask(store, {message: 'find jobs', to: ids.mail, executor: ai.executor});
  await until(() => ended(store, run.id), 'the run');
  const bots = (store.read().chats[ids.mail] || []).filter(m => m.role === 'bot');
  assert.deepEqual(bots.map(m => [m.text, Boolean(m.step)]), [['Looking.', true], ['Acme is hiring.', false]]);
});

test('a bot that keeps opening pages is told, after many, to answer with what it has', async t => {
  fakeBrowser(t, async request => ({title: 'Page', finalUrl: request.url, text: 'Some text', links: []}));
  const {store, ids} = await company(t);
  let n = 0, nudged = '';
  // Search, then open a page, then search again: never three searches in a row, so only the page count can stop it.
  const ai = model({Mailroom: e => { if (/opened \d+ pages/.test(e.note || '')) { nudged = e.note; return 'Here is what I found.'; } n++; return fence(n % 2 ? `https://www.bing.com/search?q=intern+${n}` : `https://jobs.example/${n}`); }});
  wire(ai.executor);
  const run = await ask(store, {message: 'find jobs', to: ids.mail, executor: ai.executor});
  await until(() => ended(store, run.id), 'the run');
  assert.match(nudged, /opened 15 pages/);
  assert.equal(opened.length, 15);
  assert.equal(runOf(store, run.id).status, 'completed');
});

test('a bot stuck on pages it already has gets one last turn to answer, and the run completes when it does', async t => {
  fakeBrowser(t, async request => ({title: 'Page', finalUrl: request.url, text: 'Flipkart: 19,989'}));
  const {store, ids} = await company(t);
  let told = '';
  let seen = '';
  const ai = model({Mailroom: e => { if (/Stop opening pages/.test(e.note || '')) { told = e.note; seen = e.page || ''; return 'Lowest price: 19,989 on Flipkart.'; } return fence('https://jobs.example/same'); }});
  wire(ai.executor);
  const run = await ask(store, {message: 'find the price', to: ids.mail, executor: ai.executor});
  await until(() => ended(store, run.id), 'the run');
  const done = runOf(store, run.id);
  assert.equal(done.status, 'completed');
  assert.match(done.lastOutput, /19,989/);
  assert.match(told, /answer the owner now/i);
  // The last turn carries what the run read, so the bot can answer from it.
  assert.match(seen, /Flipkart: 19,989/);
  assert.equal(opened.length, 1);
});

test('a reply that only promises to open a page, with no browser block, is asked once to send it', async t => {
  fakeBrowser(t, async request => ({title: 'Booking', finalUrl: request.url, text: 'Table for 2 at 8 PM: Book now'}));
  const {store, ids} = await company(t);
  let turns = 0, nudge = '';
  const ai = model({Mailroom: e => {
    turns += 1;
    if (turns === 1) return "I'll open the booking page for Lazeez Affaire and check tonight's 8 PM table for 2.";
    if (turns === 2) { nudge = e.note || ''; return fence('https://book.example/lazeez'); }
    return 'The 8 PM table for 2 is open; the next step is the Book now button.';
  }});
  wire(ai.executor);
  const run = await ask(store, {message: 'book a table', to: ids.mail, executor: ai.executor});
  await until(() => ended(store, run.id), 'the run');
  assert.match(nudge, /no browser block/i);
  assert.equal(opened.length, 1);
  assert.match(runOf(store, run.id).lastOutput, /8 PM table for 2 is open/);
});

test('a bot that keeps promising without a block is asked only once, then its reply stands', async t => {
  fakeBrowser(t, async () => ({title: 'x', text: 'x'}));
  const {store, ids} = await company(t);
  let turns = 0;
  const ai = model({Mailroom: () => { turns += 1; return "I'll check that page for you."; }});
  wire(ai.executor);
  const run = await ask(store, {message: 'check it', to: ids.mail, executor: ai.executor});
  await until(() => ended(store, run.id), 'the run');
  assert.equal(runOf(store, run.id).status, 'completed');
  assert.equal(turns, 2);
});

test('a browser block the app refuses is handed back with the reason, and the bot sends a fixed one', async t => {
  fakeBrowser(t, async request => ({title: 'Order', finalUrl: request.url, text: 'Order received'}));
  const {store, ids} = await company(t);
  let turns = 0, note = '';
  const ai = model({Mailroom: e => {
    turns += 1;
    if (turns === 1) return '```browser\n{"url":"https://forms.example/order","steps":[{"op":"click"}]}\n```';
    if (turns === 2) { note = e.note || ''; return fence('https://forms.example/order'); }
    return 'The order form is open.';
  }});
  wire(ai.executor);
  const run = await ask(store, {message: 'order it', to: ids.mail, executor: ai.executor});
  await until(() => ended(store, run.id), 'the run');
  assert.match(note, /refused/i);
  assert.match(note, /needs an index/);
  assert.match(runOf(store, run.id).lastOutput, /order form is open/);
});

test('a bot that submits a form a second time is told it already went through, and the device runs it once', async t => {
  fakeBrowser(t, async request => ({title: 'Order received', finalUrl: 'https://forms.example/done', text: 'Order received for Test Owner'}));
  const {store, ids} = await company(t);
  await store.update(s => { setGrant(s, ids.mail, 'send', scopeOf({action: 'send', target: 'https://forms.example/order'}), 'always'); });
  const submit = '```browser\n{"url":"https://forms.example/order","steps":[{"op":"click","selector":"button[type=submit]"}]}\n```';
  let turns = 0, note = '';
  const ai = model({Mailroom: e => {
    turns += 1;
    if (turns <= 2) return submit;
    note = e.note || '';
    return 'Your order was received.';
  }});
  wire(ai.executor);
  const run = await ask(store, {message: 'order it', to: ids.mail, executor: ai.executor});
  await until(() => ended(store, run.id), 'the run');
  assert.equal(opened.length, 1, 'the form was submitted once');
  assert.match(note, /already submitted/i);
});

// Found by the real-model sweep: "post on X and tell me the top HN story" read HN, then x.com refused the browser
// (net::ERR_HTTP_RESPONSE_CODE_FAILURE) round after round, and the run failed with the HN answer hidden.
test('a site that refuses twice is not opened again, and a run that read something answers before it stops', async t => {
  fakeBrowser(t, async request => {
    if (request.url.includes('refuses.example')) throw new Error('The page could not be opened: net::ERR_HTTP_RESPONSE_CODE_FAILURE.');
    return {title: 'News', finalUrl: request.url, text: 'Top story: Jane Street tutor'};
  });
  const {store, ids} = await company(t);
  let n = 0;
  const ai = model({Mailroom: e => (e.note && /Stop opening pages/.test(e.note) ? 'Top story is the Jane Street tutor; refuses.example would not open.'
    : n++ === 0 ? fence('https://news.example/') : fence(`https://refuses.example/${n}`))});
  wire(ai.executor);
  const run = await ask(store, {message: 'news and the other site', to: ids.mail, executor: ai.executor});
  await until(() => ended(store, run.id), 'the run');
  const done = runOf(store, run.id);
  assert.equal(done.status, 'completed', done.error);
  assert.match(done.lastOutput, /Jane Street/);
  assert.ok(opened.filter(u => u.includes('refuses.example')).length <= 2, `refused site opened ${opened.length} times`);
});
