import test from 'node:test';
import assert from 'node:assert/strict';
import {startBrowserSession} from '../agent/browser.mjs';
import {createSharedBrowser} from '../agent/shared-browser.mjs';
import {createLiveChannel} from '../agent/live-channel.mjs';
import {fakeCdp} from './fake-cdp.js';
import {FOCUSED_IS_SECRET_JS, TAG_FOCUSED_SECRET_JS} from '../agent/page-secrets.mjs';
import vm from 'node:vm';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {mock} from 'node:test';

/* The owner takes the browser, and hands it back. Against the scripted DevTools
 * connection (tests/fake-cdp.js): no Chrome starts. */

const ALLOW = ['docs.example.com'];
const PAGES = {'https://docs.example.com/': {title: 'Docs', text: 'Hello', elements: [{index: 1, tag: 'button', text: 'Go'}]}};
/** Rejects with `why` when `promise` is not settled in `ms`. */
const within = (promise, ms, why) => Promise.race([promise, new Promise((_, reject) => { const id = setTimeout(() => reject(new Error(why)), ms); promise.finally(() => clearTimeout(id)).catch(() => {}); })]);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function rig(extra = {}, {start} = {}) {
  const processes = [];
  const sb = createSharedBrowser({
    allow: ALLOW, settleMs: 0, ...extra,
    start: start || (async () => { const fake = fakeCdp({pages: PAGES}); processes.push(fake); return startBrowserSession({connection: fake.connection}); }),
  });
  return {sb, processes, fake: () => processes[0]};
}
const steps = [{op: 'click', index: 1}, {op: 'click', index: 1}, {op: 'read', selector: 'main'}];
/** Hold the Nth page evaluation that is an action (not a snapshot or a read of the page) until released. */
function holdStep(fake, nth, {sessionId} = {}) {
  let seen = 0, release, started;
  const began = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  fake.hook('Runtime.evaluate', async ({expression}, sid) => {
    if (sessionId && sid !== sessionId) return undefined;
    if (expression === 'location.href' || expression.startsWith('(function(){var els=') || expression.startsWith('JSON.stringify(')) return undefined;
    if (++seen === nth) { started(); await gate; }
    return undefined;
  });
  return {began, release: () => release()};
}

test('the owner takes the browser while a bot is mid-task: the step in flight finishes once, the rest are not run, and the run waits for the hand back', async t => {
  const {sb, fake} = rig();
  t.after(() => sb.close());
  await sb.run('bot-a', {url: 'https://docs.example.com/'});
  const held = holdStep(fake(), 1);
  const task = sb.run('bot-a', {url: 'https://docs.example.com/', steps});
  let settled = false;
  task.then(() => { settled = true; }, () => { settled = true; });
  await held.began;
  await sb.takeover('bot-a');
  assert.deepEqual(sb.status().map(s => [s.botId, s.state]), [['bot-a', 'driving']]);
  held.release();
  await sleep(40);
  assert.equal(settled, false, 'the run is parked while the owner drives');
  assert.equal(fake().actions.length, 1, 'the click in flight finished, and nothing after it ran');
  // The owner works in the tab meanwhile.
  await sb.applyInput('bot-a', {type: 'type', text: 'a code'});
  assert.equal(fake().input.length, 1);
  await sb.handback('bot-a');
  const result = await task;
  assert.equal(fake().actions.length, 1, 'nothing is applied after the hand back either: the page is not the one the steps were planned for');
  assert.equal(result.tookOver, true);
  assert.deepEqual(result.actions.map(a => a.ok), [true, false, false]);
  assert.match(result.actions[1].reason, /took over the browser/);
  assert.equal(result.title, 'Docs', 'the bot gets the page as the owner left it');
  assert.equal(sb.status()[0].state, 'idle');
});

test('while the owner drives bot A, A\'s next task waits and B\'s runs whole', async t => {
  const {sb, fake} = rig({timeoutMs: 400}); // a click waits up to 15 beats for the page to move: a short deadline keeps the beat short
  t.after(() => sb.close());
  await sb.takeover('bot-a');
  const waiting = sb.run('bot-a', {url: 'https://docs.example.com/', steps: [{op: 'click', index: 1}]});
  let settled = false;
  waiting.then(() => { settled = true; });
  const other = await within(sb.run('bot-b', {url: 'https://docs.example.com/', steps: [{op: 'click', index: 1}]}), 1000, 'B waited for the takeover of A');
  assert.equal(other.tookOver, undefined);
  assert.equal(other.actions[0].ok, true, 'B was never interrupted, so its steps ran');
  await sleep(40);
  assert.equal(settled, false, 'A\'s own next task waits while the owner holds A\'s tab');
  assert.equal(fake().called('Page.navigate').length, 1, 'only B opened a page');
  await sb.handback('bot-a');
  const result = await waiting;
  assert.equal(result.tookOver, undefined);
  assert.equal(result.actions[0].ok, true);
  assert.equal(fake().actions.length, 2, 'one click for B, one for A');
});

test('a takeover of bot A\'s tab does not delay bot B', async t => {
  const {sb, fake} = rig({timeoutMs: 400}); // a click waits up to 15 beats for the page to move: a short deadline keeps the beat short
  t.after(() => sb.close());
  await sb.run('bot-a', {url: 'https://docs.example.com/'});
  await sb.run('bot-b', {url: 'https://docs.example.com/'});
  const [tabA] = [...fake().targets.values()].map(target => target.sessionId);
  const held = holdStep(fake(), 1, {sessionId: tabA});
  const a = sb.run('bot-a', {url: 'https://docs.example.com/', steps});
  await held.began;
  await sb.takeover('bot-a');
  held.release();
  const b = await within(sb.run('bot-b', {url: 'https://docs.example.com/', steps: [{op: 'click', index: 1}]}), 1000, 'B was parked by A\'s takeover');
  assert.equal(b.tookOver, undefined);
  assert.equal(b.actions[0].ok, true);
  await sb.handback('bot-a');
  assert.equal((await a).tookOver, true);
});

test('the owner\'s input to bot A waits only for A\'s own step, never for bot B\'s', async t => {
  const {sb, fake} = rig({timeoutMs: 400}); // a click waits up to 15 beats for the page to move: a short deadline keeps the beat short
  t.after(() => sb.close());
  await sb.run('bot-a', {url: 'https://docs.example.com/'});
  await sb.run('bot-b', {url: 'https://docs.example.com/'});
  const tabB = [...fake().targets.values()].map(target => target.sessionId)[1];
  const held = holdStep(fake(), 1, {sessionId: tabB});
  const b = sb.run('bot-b', {url: 'https://docs.example.com/', steps});
  await held.began;
  await sb.takeover('bot-a');
  await within(sb.applyInput('bot-a', {type: 'key', key: 'Enter'}), 1000, 'input waited on B');
  assert.equal(fake().input.length, 2, 'the key went in while B\'s step was still in flight');
  held.release();
  await sb.handback('bot-a');
  const result = await b;
  assert.equal(result.tookOver, undefined, 'B never saw the takeover of A');
  assert.equal(result.actions.every(x => x.ok), true);
});

test('secret typing into A while B runs keeps its order, and each tab is scrubbed only by its own memory', async t => {
  const secret = 'hunter2-secret';
  const pages = {
    'https://docs.example.com/': {title: 'Docs', text: 'Hello', elements: [{index: 1, tag: 'button', text: 'Go'}]},
    'https://echo.example.com/': {title: 'Echo', text: `you said ${secret}`, elements: [{index: 1, tag: 'button', text: 'Go'}]},
  };
  const made = [];
  const {sb} = rig({allow: ['docs.example.com', 'echo.example.com'], timeoutMs: 400}, {start: async () => { const f = fakeCdp({pages}); made.push(f); return startBrowserSession({connection: f.connection}); }});
  t.after(() => sb.close());
  const fake = () => made[0];
  await sb.run('bot-a', {url: 'https://docs.example.com/'});
  await sb.run('bot-b', {url: 'https://docs.example.com/'});
  const [tabA, tabB] = [...fake().targets.values()].map(target => target.sessionId);
  const held = holdStep(fake(), 1, {sessionId: tabB});
  const b = sb.run('bot-b', {url: 'https://echo.example.com/', steps: [{op: 'click', index: 1}]});
  await held.began;
  await sb.takeover('bot-a');
  await within(sb.applyInput('bot-a', {type: 'type', text: secret, secret: true}), 1000, 'secret typing waited on B');
  const onA = fake().calls.filter(c => c.sessionId === tabA && (c.method === 'Input.insertText' || [FOCUSED_IS_SECRET_JS, TAG_FOCUSED_SECRET_JS].includes(c.params?.expression)));
  assert.deepEqual(onA.map(c => (c.method === 'Input.insertText' ? 'insert' : c.params.expression === FOCUSED_IS_SECRET_JS ? 'ask' : 'tag')), ['ask', 'tag', 'insert']);
  assert.equal(fake().calls.filter(c => c.sessionId === tabB && (c.method === 'Input.insertText' || isTag(c))).length, 0, 'nothing of it reached B\'s tab');
  held.release();
  const rb = await b;
  assert.ok(JSON.stringify(rb).includes(secret), 'B\'s result is not scrubbed of what the owner typed into A\'s tab');
  await sb.handback('bot-a');
  assert.deepEqual(fake().cleared.map(c => c.sessionId), [tabA], 'A\'s secret fields were emptied once, and only A\'s');
  const again = await sb.run('bot-a', {url: 'https://echo.example.com/'});
  assert.ok(!JSON.stringify(again).includes(secret) && JSON.stringify(again).includes('[hidden]'), 'A\'s own capture of a page echoing it says [hidden]');
});

test('owner input waits for the action in flight, and is refused unless the owner holds that bot\'s tab', async t => {
  const {sb, fake} = rig();
  t.after(() => sb.close());
  await assert.rejects(sb.applyInput('bot-a', {type: 'key', key: 'Enter'}), /not driving/);
  await sb.run('bot-a', {url: 'https://docs.example.com/'});
  const held = holdStep(fake(), 1);
  const task = sb.run('bot-a', {url: 'https://docs.example.com/', steps});
  await held.began;
  await sb.takeover('bot-a');
  const typed = sb.applyInput('bot-a', {type: 'type', text: 'x'});
  await sleep(30);
  assert.equal(fake().input.length, 0, 'not while the bot\'s click is still being applied');
  held.release();
  await typed;
  assert.equal(fake().input.length, 1);
  assert.equal(fake().actions.length, 1);
  await assert.rejects(sb.applyInput('bot-b', {type: 'key', key: 'Enter'}), /not driving/, 'another bot\'s tab is not the one the owner holds');
  await sb.handback('bot-a');
  await task;
});

test('the owner holds one tab at a time, a hand back is idempotent, and a hand back by someone else is ignored', async t => {
  const {sb} = rig();
  t.after(() => sb.close());
  await sb.takeover('bot-a');
  await sb.takeover('bot-a');
  await assert.rejects(sb.takeover('bot-b'), error => error.status === 409 && /already driving/.test(error.message));
  await sb.handback('bot-b');
  assert.equal(sb.owner(), 'bot-a');
  await sb.handback('bot-a');
  await sb.handback('bot-a');
  assert.equal(sb.owner(), null);
});

test('the load deadline does not run while the run is parked', async t => {
  const {sb, fake} = rig({timeoutMs: 80});
  t.after(() => sb.close());
  await sb.run('bot-a', {url: 'https://docs.example.com/'});
  const held = holdStep(fake(), 1);
  const task = sb.run('bot-a', {url: 'https://docs.example.com/', steps});
  await held.began;
  await sb.takeover('bot-a');
  held.release();
  await sleep(200);
  await sb.handback('bot-a');
  assert.equal((await task).tookOver, true, 'parked for longer than the deadline, and still answered');
});

test('a takeover the owner forgets ends by itself, and the parked run resumes', async t => {
  const {sb} = rig({idleMs: 60});
  t.after(() => sb.close());
  await sb.takeover('bot-a');
  assert.equal(sb.owner(), 'bot-a');
  await sleep(40);
  await sb.applyInput('bot-a', {type: 'key', key: 'Tab'});
  await sleep(40);
  assert.equal(sb.owner(), 'bot-a', 'input keeps it alive');
  await sleep(90);
  assert.equal(sb.owner(), null, 'and silence ends it');
  assert.equal(sb.status()[0].state, 'idle');
});

test('a takeover on a device whose browser will not start fails clearly and holds nothing', async t => {
  const {sb} = rig({}, {start: async () => { throw new Error('No Chrome, Chromium or Edge was found on this device.'); }});
  t.after(() => sb.close());
  await assert.rejects(sb.takeover('bot-a'), /No Chrome/);
  assert.equal(sb.owner(), null);
  const next = sb.run('bot-a', {url: 'https://docs.example.com/'});
  await assert.rejects(next, /No Chrome/, 'and the lock is free for the next task');
});

test('the status says which bot is browsing and which the owner drives', async t => {
  const {sb, fake} = rig();
  t.after(() => sb.close());
  await sb.run('bot-a', {url: 'https://docs.example.com/'});
  await sb.run('bot-b', {url: 'https://docs.example.com/'});
  const held = holdStep(fake(), 1);
  const task = sb.run('bot-a', {url: 'https://docs.example.com/', steps});
  await held.began;
  const states = () => Object.fromEntries(sb.status().map(s => [s.botId, s.state]));
  assert.deepEqual(states(), {'bot-a': 'browsing', 'bot-b': 'idle'});
  await sb.takeover('bot-b');
  assert.deepEqual(states(), {'bot-a': 'browsing', 'bot-b': 'driving'});
  held.release();
  await sleep(30);
  await sb.handback('bot-b');
  await task;
  assert.deepEqual(states(), {'bot-a': 'idle', 'bot-b': 'idle'});
});

test('the live channel carries takeover and hand back, reports who is driven, and says why a takeover failed', async t => {
  const {sb, fake} = rig();
  const sent = [];
  let polls = 0;
  const script = [
    {commands: [{type: 'takeover', botId: 'bot-a'}], watch: null},
    {commands: [{type: 'handback', botId: 'bot-a'}], watch: null},
  ];
  const call = async (path, body, {signal} = {}) => {
    sent.push({path, body});
    const reply = script[polls++];
    if (reply) return reply;
    await new Promise((resolve, reject) => { signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), {name: 'AbortError'}))); });
  };
  const channel = createLiveChannel({call, shared: sb, frameGapMs: 20, retryMs: 5, log: {error() {}}});
  t.after(async () => { await channel.stop(); await sb.close(); });
  channel.start();
  await sleep(60);
  assert.ok(fake(), 'the takeover opened the browser');
  const polled = sent.filter(s => s.path === '/api/agent/live').map(s => s.body.owner);
  assert.deepEqual(polled, [null, 'bot-a', null], 'the poll after each command says who the owner holds');
});

test('when a takeover cannot start, the next poll names the bot and the reason', async t => {
  const {sb} = rig({}, {start: async () => { throw new Error('No Chrome, Chromium or Edge was found on this device.'); }});
  const sent = [];
  let polls = 0;
  const call = async (path, body, {signal} = {}) => {
    sent.push(body);
    if (polls++ === 0) return {commands: [{type: 'takeover', botId: 'bot-a'}], watch: null};
    if (polls === 2) return {commands: [], watch: null};
    await new Promise((resolve, reject) => { signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), {name: 'AbortError'}))); });
  };
  const channel = createLiveChannel({call, shared: sb, frameGapMs: 20, retryMs: 5, log: {error() {}}});
  t.after(async () => { await channel.stop(); await sb.close(); });
  channel.start();
  await sleep(60);
  assert.equal(sent[1].failed?.botId, 'bot-a');
  assert.match(sent[1].failed.message, /No Chrome/);
  assert.equal(sent[2].failed, undefined, 'reported once');
});

test('by default a takeover has no clock: the person keeps the browser until they hand back', async () => {
  const src = await import('node:fs/promises').then(fs => fs.readFile(new URL('../agent/shared-browser.mjs', import.meta.url), 'utf8'));
  assert.match(src, /AGENT_TAKEOVER_IDLE_MS\) \|\| 0\}/);
  assert.match(src, /if \(!idleMs\) return;/);
});

/** The evaluations that tag the focused field, in the order the device sent them. */
const isTag = c => c.method === 'Runtime.evaluate' && c.params.expression === TAG_FOCUSED_SECRET_JS;
const tagCalls = fake => fake.calls.filter(isTag);

test('text the owner marks secret goes into a field that is tagged for the page first', async t => {
  const {sb, fake} = rig();
  t.after(() => sb.close());
  await sb.run('bot-a', {url: 'https://docs.example.com/'});
  await sb.takeover('bot-a');
  await sb.applyInput('bot-a', {type: 'type', text: '482913', secret: true});
  assert.equal(fake().input.length, 1);
  assert.equal(fake().input[0].params.text, '482913');
  const tags = tagCalls(fake());
  assert.equal(tags.length, 1, 'one tag');
  assert.ok(fake().calls.indexOf(tags[0]) < fake().calls.findIndex(c => c.method === 'Input.insertText'), 'tagged while focus is certain, before the text can move it');
  assert.equal(tags[0].params.expression, TAG_FOCUSED_SECRET_JS);
  assert.equal(fake().actions.length, 0, 'the tag is not a bot step');
});

test('a plain type event into a field the page says is secret is tagged too, and into any other is not', async t => {
  const {sb, fake} = rig();
  t.after(() => sb.close());
  await sb.run('bot-a', {url: 'https://docs.example.com/'});
  await sb.takeover('bot-a');
  await sb.applyInput('bot-a', {type: 'type', text: 'hello'});
  assert.equal(tagCalls(fake()).length, 0, 'an ordinary field is left alone');
  const asked = fake().calls.filter(c => c.method === 'Runtime.evaluate' && c.params.expression === FOCUSED_IS_SECRET_JS);
  assert.equal(asked.length, 1, 'the focused field was asked about, once');
  assert.ok(fake().calls.indexOf(asked[0]) < fake().calls.findIndex(c => c.method === 'Input.insertText'), 'before the text went in');
  assert.match(asked[0].params.expression, /function isSecretField/, 'the whole bundle travels with the question');
  fake().focusSecret = true;
  await sb.applyInput('bot-a', {type: 'type', text: 'hunter2'});
  assert.equal(tagCalls(fake()).length, 1, 'a password field is tagged though the event was not marked');
});

test('a key press and a click are not asked about, and nothing the owner typed is in an error or a log line', async t => {
  const {sb, fake} = rig();
  t.after(() => sb.close());
  await sb.run('bot-a', {url: 'https://docs.example.com/'});
  await sb.takeover('bot-a');
  await sb.applyInput('bot-a', {type: 'key', key: 'Enter'});
  await sb.applyInput('bot-a', {type: 'click', x: 5, y: 5});
  assert.equal(fake().calls.filter(c => c.method === 'Runtime.evaluate' && c.params.expression === FOCUSED_IS_SECRET_JS).length, 0);
  // Every way a type can fail: the check, the insert and the tag all throw with the text in the browser's own message.
  const seen = [], spy = (...args) => seen.push(args.join(' ')), keep = {error: console.error, warn: console.warn, log: console.log};
  Object.assign(console, {error: spy, warn: spy, log: spy});
  t.after(() => Object.assign(console, keep));
  const text = 'hunter22-482913';
  for (const method of ['Runtime.evaluate', 'Input.insertText']) {
    fake().hook(method, async ({expression}) => {
      if (method === 'Runtime.evaluate' && expression !== FOCUSED_IS_SECRET_JS && expression !== TAG_FOCUSED_SECRET_JS) return undefined;
      throw new Error(`CDP failed on ${text}`);
    });
    await assert.rejects(() => sb.applyInput('bot-a', {type: 'type', text, secret: true}), e => !String(e.message).includes(text) && !String(e.stack).includes(text), method);
    fake().hook(method, async () => undefined);
  }
  assert.ok(!seen.join('\n').includes(text), 'nothing was logged with the text');
  await assert.rejects(() => sb.applyInput('bot-a', {type: 'type', text: text.repeat(300), secret: true}), e => !e.message.includes(text));
});

test('a focus question the page could not answer counts as secret, and a tag that fails stops the typing', async t => {
  const {sb, fake} = rig();
  t.after(() => sb.close());
  await sb.run('bot-a', {url: 'https://docs.example.com/'});
  await sb.takeover('bot-a');
  fake().focusSecret = 'throws';
  await sb.applyInput('bot-a', {type: 'type', text: 'hello'});
  assert.equal(tagCalls(fake()).length, 1, 'a page expression that threw (exceptionDetails, no value) is not an answer of "no"');
  assert.equal(fake().input.length, 1);
  fake().hook('Runtime.evaluate', async ({expression}) => { if (expression === TAG_FOCUSED_SECRET_JS) throw new Error('boom 482913'); });
  await assert.rejects(() => sb.applyInput('bot-a', {type: 'type', text: '482913', secret: true}), e => !e.message.includes('482913'));
  assert.equal(fake().input.length, 1, 'the text was not typed into a field that could not be hidden');
  // The page's own expression threw: CDP answers with exceptionDetails and raises nothing.
  fake().hook('Runtime.evaluate', async ({expression}) => (expression === TAG_FOCUSED_SECRET_JS ? {result: {}, exceptionDetails: {text: 'Uncaught'}} : undefined));
  await assert.rejects(() => sb.applyInput('bot-a', {type: 'type', text: '482913', secret: true}), e => !e.message.includes('482913'));
  assert.equal(fake().input.length, 1, 'a tag that threw in the page also stops the typing');
});

test('the tag expression tags only a text-entry form field, never the page body, the root, a wrapper or a button', () => {
  const run = active => {
    const mark = tagName => ({tagName, type: '', isContentEditable: false, setAttribute(name, value) { (this.set ||= []).push([name, value]); }});
    const els = {
      body: mark('BODY'), root: mark('HTML'), field: mark('INPUT'), area: mark('TEXTAREA'), main: mark('MAIN'), div: mark('DIV'),
      submit: {...mark('INPUT'), type: 'submit'}, checkbox: {...mark('INPUT'), type: 'checkbox'}, editable: {...mark('DIV'), isContentEditable: true},
    };
    const doc = {body: els.body, documentElement: els.root, activeElement: active in els ? els[active] : (active === 'none' ? null : undefined)};
    const answer = vm.runInNewContext(TAG_FOCUSED_SECRET_JS, {document: doc});
    return [answer, Object.values(els).filter(e => (e.set || []).length).length, (els[active]?.set || []).length];
  };
  assert.deepEqual(run('field'), [true, 1, 1], 'a focused field is tagged');
  assert.deepEqual(run('area'), [true, 1, 1]);
  assert.deepEqual(run('editable'), [true, 1, 1]);
  for (const what of ['body', 'root', 'none', 'undef', 'main', 'div', 'submit', 'checkbox']) assert.deepEqual(run(what), [false, 0, 0], `${what} is not tagged, and the answer says so`);
});

test('a secret type with a wrapper focused, not a field, types nothing and says what to do without naming the text', async t => {
  const {sb, fake} = rig();
  t.after(() => sb.close());
  await sb.run('bot-a', {url: 'https://docs.example.com/'});
  await sb.takeover('bot-a');
  // What the real expression answers when a <main tabindex=-1> has the focus.
  fake().hook('Runtime.evaluate', async ({expression}) => (expression === TAG_FOCUSED_SECRET_JS ? {result: {value: false}} : undefined));
  const text = 'hunter22-482913';
  await assert.rejects(() => sb.applyInput('bot-a', {type: 'type', text, secret: true}), e => e.message === 'Tap the field you want to type into first.' && !String(e.stack).includes(text));
  assert.equal(fake().input.length, 0, 'no Input.insertText was sent');
  // A page expression that threw is a different failure, with the generic wording.
  fake().hook('Runtime.evaluate', async ({expression}) => (expression === TAG_FOCUSED_SECRET_JS ? {result: {}, exceptionDetails: {text: 'Uncaught'}} : undefined));
  await assert.rejects(() => sb.applyInput('bot-a', {type: 'type', text, secret: true}), e => e.message === 'The browser could not mark that field secret.');
  assert.equal(fake().input.length, 0);
});

test('what a model is handed is the address, title and links with secrets hidden; the real address only decides', async t => {
  const pages = {'https://docs.example.com/': {title: 'Hi [hidden]', shown: 'https://docs.example.com/?code=[hidden]', text: 'Hello', links: [{text: 'Reset [hidden]', url: 'https://docs.example.com/r?c=[hidden]'}], elements: []}};
  const {sb} = rig({}, {start: async () => startBrowserSession({connection: fakeCdp({pages}).connection})});
  t.after(() => sb.close());
  const result = await sb.run('bot-a', {url: 'https://docs.example.com/'});
  assert.equal(result.finalUrl, 'https://docs.example.com/?code=[hidden]');
  assert.equal(result.title, 'Hi [hidden]');
  assert.deepEqual(result.links, pages['https://docs.example.com/'].links);
  assert.equal(sb.status()[0].url, 'https://docs.example.com/?code=[hidden]', 'the address remembered from the capture is the hidden one');
});

/* What the owner typed in secret is remembered per tab and scrubbed from every result. A page that echoes it is a
 * page of the fake connection whose title, address, text, links, controls and read all say the typed text. */
const URL_A = 'https://docs.example.com/';
const echoing = text => ({
  title: `Welcome ${text.toUpperCase()}`, shown: `${URL_A}?pw=${encodeURIComponent(text)}&u=${text}`, text: `Signed in? code ${text}.`,
  links: [{text: `Reset ${text}`, url: `${URL_A}r?c=${text}`}], elements: [{index: 1, tag: 'input', type: 'text', text: `Code ${text}`}], read: `again ${text.toLowerCase()}`,
});
function rigWith(pages, extra = {}) {
  const processes = [];
  const sb = createSharedBrowser({allow: ALLOW, settleMs: 0, ...extra, start: async () => { const fake = fakeCdp({pages}); processes.push(fake); return startBrowserSession({connection: fake.connection}); }});
  return {sb, fake: () => processes[0]};
}
const noText = (value, text) => { assert.ok(!JSON.stringify(value).toLowerCase().includes(text.toLowerCase()), 'the typed text is in a result'); };

test('a secret the owner typed is hidden from the next capture, action result and status, in any letter case', async t => {
  const pages = {[URL_A]: {title: 'Docs', text: 'Hello', elements: []}};
  const {sb, fake} = rigWith(pages);
  t.after(() => sb.close());
  await sb.run('bot-a', {url: URL_A});
  await sb.takeover('bot-a');
  await sb.applyInput('bot-a', {type: 'type', text: 'hunter22', secret: true});
  await sb.handback('bot-a');
  pages[URL_A] = echoing('Hunter22');
  const capture = await sb.run('bot-a', {url: URL_A});
  noText(capture, 'hunter22');
  assert.equal(capture.finalUrl, `${URL_A}?pw=[hidden]&u=[hidden]`);
  assert.equal(capture.title, 'Welcome [hidden]');
  assert.deepEqual(capture.links, [{text: 'Reset [hidden]', url: `${URL_A}r?c=[hidden]`}]);
  assert.equal(capture.elements[0].text, 'Code [hidden]');
  const acted = await sb.run('bot-a', {url: URL_A, steps: [{op: 'read', selector: 'main'}]});
  noText(acted, 'hunter22');
  assert.equal(acted.actions[0].text, 'again [hidden]');
  // The status is what Chrome says now, which a click may have moved.
  [...fake().targets.values()][0].url = `${URL_A}?pw=Hunter22`;
  [...fake().targets.values()][0].title = 'Hello HUNTER22';
  await sb.refresh();
  noText(sb.status(), 'hunter22');
  assert.deepEqual(sb.status().map(x => [x.url, x.title]), [[`${URL_A}?pw=[hidden]`, 'Hello [hidden]']]);
});

test('a plain type into a field the page says is secret is remembered, and a plain type into any other is not', async t => {
  const pages = {[URL_A]: {title: 'Docs', text: 'Hello', elements: []}};
  const {sb, fake} = rigWith(pages);
  t.after(() => sb.close());
  await sb.run('bot-a', {url: URL_A});
  await sb.takeover('bot-a');
  await sb.applyInput('bot-a', {type: 'type', text: 'red shoes'});
  fake().focusSecret = true;
  await sb.applyInput('bot-a', {type: 'type', text: 'hunter22'});
  fake().focusSecret = false;
  await sb.handback('bot-a');
  pages[URL_A] = {...echoing('hunter22'), text: 'you typed red shoes and hunter22'};
  const result = await sb.run('bot-a', {url: URL_A});
  assert.equal(result.text, 'you typed red shoes and [hidden]', 'the search words stay, the password does not');
  // A page whose own check threw counts as secret, so what was typed is remembered as well.
  fake().focusSecret = 'throws';
  await sb.takeover('bot-a');
  await sb.applyInput('bot-a', {type: 'type', text: 'unsure-value'});
  await sb.handback('bot-a');
  pages[URL_A] = {title: 'Docs', text: 'it says unsure-value', elements: []};
  assert.equal((await sb.run('bot-a', {url: URL_A})).text, 'it says [hidden]');
});

test('each tab has its own memory, and a tab the browser dropped takes its memory with it', async t => {
  const pages = {[URL_A]: {title: 'Docs', text: 'Hello', elements: []}};
  const {sb, fake} = rigWith(pages);
  t.after(() => sb.close());
  await sb.run('bot-a', {url: URL_A});
  await sb.run('bot-b', {url: URL_A});
  await sb.takeover('bot-a');
  await sb.applyInput('bot-a', {type: 'type', text: 'hunter22', secret: true});
  await sb.handback('bot-a');
  pages[URL_A] = {title: 'Docs', text: 'echo hunter22', elements: []};
  assert.equal((await sb.run('bot-a', {url: URL_A})).text, 'echo [hidden]');
  assert.equal((await sb.run('bot-b', {url: URL_A})).text, 'echo hunter22', 'bot b\'s tab never had it typed');
  // The browser no longer has bot a's tab: the next task gets a new one, and the old memory is gone with the old tab.
  const [first] = [...fake().targets.keys()];
  fake().targets.delete(first);
  assert.equal((await sb.run('bot-a', {url: URL_A})).text, 'echo hunter22');
});

test('the memory is never written anywhere: no log line, no file write, and the text goes to the page only as typing', async t => {
  const pages = {[URL_A]: {title: 'Docs', text: 'Hello', elements: []}};
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-typed-'));
  t.after(() => fs.rmSync(profile, {recursive: true, force: true}));
  const {sb, fake} = rigWith(pages, {profile});
  const written = [], seen = [];
  const keep = {...console};
  const spy = (...args) => { seen.push(args.join(' ')); };
  Object.assign(console, {log: spy, info: spy, warn: spy, error: spy, debug: spy});
  const stdout = mock.method(process.stdout, 'write', (chunk) => { seen.push(String(chunk)); return true; });
  const stderr = mock.method(process.stderr, 'write', (chunk) => { seen.push(String(chunk)); return true; });
  const sinks = ['writeFileSync', 'appendFileSync', 'writeSync'].map(name => mock.method(fs, name, (...args) => { written.push(args.map(String).join(' ')); }));
  const asyncSinks = ['writeFile', 'appendFile'].map(name => mock.method(fs.promises, name, async (...args) => { written.push(args.map(String).join(' ')); }));
  try {
    await sb.run('bot-a', {url: URL_A});
    await sb.takeover('bot-a');
    await sb.applyInput('bot-a', {type: 'type', text: 'hunter22-unique', secret: true});
    await sb.applyInput('bot-a', {type: 'key', key: 'Enter'});
    await sb.handback('bot-a');
    pages[URL_A] = echoing('hunter22-unique');
    await sb.run('bot-a', {url: URL_A});
    await sb.close();
  } finally {
    Object.assign(console, keep);
    for (const m of [stdout, stderr, ...sinks, ...asyncSinks]) m.mock.restore();
  }
  assert.ok(!seen.join('\n').toLowerCase().includes('hunter22-unique'), 'a log line carried the text');
  assert.ok(!written.join('\n').toLowerCase().includes('hunter22-unique'), 'a file write carried the text');
  const sent = fake().calls.filter(c => JSON.stringify(c.params).includes('hunter22-unique')).map(c => c.method);
  assert.deepEqual(sent, ['Input.insertText'], 'the page is told the text once, as typing, and nothing else carries it');
});

test('the page\'s secret fields are emptied when the owner hands back, and at no other moment, and only if a secret was typed', async t => {
  const pages = {[URL_A]: {title: 'Docs', text: 'Hello', elements: []}};
  const {sb, fake} = rigWith(pages);
  t.after(() => sb.close());
  await sb.run('bot-a', {url: URL_A});
  await sb.takeover('bot-a');
  await sb.applyInput('bot-a', {type: 'click', x: 5, y: 5});
  await sb.applyInput('bot-a', {type: 'key', key: 'Enter'});
  await sb.handback('bot-a');
  assert.deepEqual(fake().cleared, [], 'nothing was typed in secret, so there is nothing to empty');
  await sb.takeover('bot-a');
  await sb.applyInput('bot-a', {type: 'type', text: 'hunter22', secret: true});
  await sb.applyInput('bot-a', {type: 'key', key: 'Tab'});
  await sb.applyInput('bot-a', {type: 'click', x: 5, y: 5});
  await sb.applyInput('bot-a', {type: 'key', key: 'Enter'});
  await sb.applyInput('bot-a', {type: 'scroll', dy: 10});
  assert.deepEqual(fake().cleared, [], 'a click or Enter is not a hand back: a slow or captcha submit may not have read the password yet');
  assert.equal(fake().actions.length, 0, 'no page script ran for it');
  const before = fake().calls.length;
  await sb.handback('bot-a');
  assert.deepEqual(fake().cleared.map(c => c.when), ['handback']);
  assert.ok(fake().calls.slice(before).some(c => c.method === 'Runtime.evaluate'), 'asked while the owner still held the tab');
  assert.equal(sb.owner(), null);
});

test('a tab keeps the most recent 50 typed strings: the oldest is forgotten, the newest still hidden', async t => {
  const pages = {[URL_A]: {title: 'Docs', text: 'Hello', elements: []}};
  const {sb} = rigWith(pages);
  t.after(() => sb.close());
  await sb.run('bot-a', {url: URL_A});
  await sb.takeover('bot-a');
  for (let i = 0; i < 52; i++) await sb.applyInput('bot-a', {type: 'type', text: `secret-${String(i).padStart(2, '0')}`, secret: true});
  await sb.handback('bot-a');
  pages[URL_A] = {title: 'Docs', text: 'echo secret-00 secret-01 secret-02 secret-51', elements: []};
  assert.equal((await sb.run('bot-a', {url: URL_A})).text, 'echo secret-00 secret-01 [hidden] [hidden]');
});

test('a takeover that ends on its own empties the secret fields too', async t => {
  const {sb, fake} = rigWith({[URL_A]: {title: 'Docs', text: 'Hello', elements: []}}, {idleMs: 40});
  t.after(() => sb.close());
  await sb.run('bot-a', {url: URL_A});
  await sb.takeover('bot-a');
  await sb.applyInput('bot-a', {type: 'type', text: 'hunter22', secret: true});
  await sleep(120);
  assert.equal(sb.owner(), null);
  assert.deepEqual(fake().cleared.map(c => c.when), ['handback']);
});

test('a clear that fails is said in fixed words and never stops the hand back', async t => {
  const {sb, fake} = rigWith({[URL_A]: {title: 'Docs', text: 'Hello', elements: []}});
  const seen = [], keep = {...console};
  Object.assign(console, {error: (...args) => seen.push(args.join(' ')), log: (...args) => seen.push(args.join(' ')), warn: (...args) => seen.push(args.join(' '))});
  t.after(() => { Object.assign(console, keep); return sb.close(); });
  const text = 'hunter22-482913';
  await sb.run('bot-a', {url: URL_A});
  await sb.takeover('bot-a');
  await sb.applyInput('bot-a', {type: 'type', text, secret: true});
  const failing = expression => expression.includes('querySelectorAll') && expression.includes('clearSecrets');
  // The browser refuses the command, and then the page's own expression throws.
  fake().hook('Runtime.evaluate', async ({expression}) => { if (failing(expression)) throw new Error(`boom ${text}`); });
  await sb.handback('bot-a');
  assert.equal(sb.owner(), null, 'handed back all the same');
  await sb.takeover('bot-a');
  fake().hook('Runtime.evaluate', async ({expression}) => (failing(expression) ? {result: {}, exceptionDetails: {text: `Uncaught ${text}`}} : undefined));
  await sb.handback('bot-a');
  assert.equal(sb.owner(), null);
  assert.deepEqual(seen, ['agent: could not empty the secret fields on the page.', 'agent: could not empty the secret fields on the page.']);
});

test('a clear the page never answers is let go after a moment, and the owner is handed back anyway', {timeout: 8000}, async t => {
  const {sb, fake} = rigWith({[URL_A]: {title: 'Docs', text: 'Hello', elements: []}});
  const keep = console.error;
  console.error = () => {};
  t.after(() => { console.error = keep; return sb.close(); });
  await sb.run('bot-a', {url: URL_A});
  await sb.takeover('bot-a');
  await sb.applyInput('bot-a', {type: 'type', text: 'hunter22', secret: true});
  fake().hook('Runtime.evaluate', ({expression}) => (expression.includes('clearSecrets') ? new Promise(() => {}) : undefined));
  const started = Date.now();
  await sb.handback('bot-a');
  assert.equal(sb.owner(), null);
  assert.ok(Date.now() - started < 4000);
});

test('a capture that fails says nothing the owner typed, and a plain read taken instead is scrubbed through the same tab', async t => {
  const pages = {[URL_A]: {title: 'Docs', text: 'Hello', elements: []}};
  const {sb, fake} = rigWith(pages);
  t.after(() => sb.close());
  await sb.run('bot-a', {url: URL_A});
  await sb.takeover('bot-a');
  await sb.applyInput('bot-a', {type: 'type', text: 'hunter22', secret: true});
  await sb.handback('bot-a');
  // The page sent the browser to an address nobody allowed, with the echo in it, and the navigation failed.
  fake().hook('Page.navigate', async (params, sessionId) => {
    fake().emit('Fetch.requestPaused', {requestId: 'r1', request: {url: 'https://evil.example.net/?pw=HUNTER22'}, resourceType: 'Document'}, sessionId);
    return {errorText: 'net::ERR_BLOCKED_BY_CLIENT'};
  });
  await assert.rejects(() => sb.run('bot-a', {url: URL_A}), error => /The page was not opened/.test(error.message) && !/hunter22/i.test(`${error.message}${error.stack}`) && /\[hidden\]/.test(error.message));
  assert.equal(JSON.stringify(sb.scrub('bot-a', {text: 'plain read: Hunter22'})), '{"text":"plain read: [hidden]"}');
  assert.equal(sb.scrub('other-bot', {text: 'hunter22'}).text, 'hunter22', 'another bot\'s tab has its own memory');
});

test('the plain-read fallback in agent.mjs goes through the tab\'s memory, for the bot\'s own tab and for a task with no bot', async () => {
  // `execute` is not importable (agent.mjs runs its command on load), so the wiring is pinned in its source and the
  // behaviour in `scrub`, which is what that line calls.
  const source = fs.readFileSync(new URL('../agent/agent.mjs', import.meta.url), 'utf8');
  assert.match(source, /return shared\(\)\.scrub\(task\.payload\?\.botId, \{\.\.\.plain, readBy: 'plain'\}\);/);
  const pages = {[URL_A]: {title: 'Docs', text: 'Hello', elements: []}};
  const {sb} = rigWith(pages);
  try {
    // A task that names no bot runs on the shared tab.
    await sb.run(undefined, {url: URL_A});
    await sb.takeover('shared');
    await sb.applyInput('shared', {type: 'type', text: 'hunter22', secret: true});
    await sb.handback('shared');
    const plain = {url: URL_A, finalUrl: `${URL_A}?pw=hunter22`, title: 'Echo HUNTER22', text: 'you typed hunter22', links: [{text: 'x', url: `${URL_A}?c=hunter22`}], readBy: 'plain'};
    const out = sb.scrub(undefined, plain);
    assert.equal(JSON.stringify(out).toLowerCase().includes('hunter22'), false);
    assert.equal(out.text, 'you typed [hidden]');
    assert.equal(out.readBy, 'plain');
  } finally { await sb.close(); }
});
