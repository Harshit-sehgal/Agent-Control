import test from 'node:test';
import assert from 'node:assert/strict';
import {startBrowserSession} from '../agent/browser.mjs';
import {createSharedBrowser} from '../agent/shared-browser.mjs';
import {createLiveChannel} from '../agent/live-channel.mjs';
import {fakeCdp} from './fake-cdp.js';
import {FOCUSED_IS_SECRET_JS, TAG_FOCUSED_SECRET_JS} from '../agent/page-secrets.mjs';
import vm from 'node:vm';

/* The owner takes the browser, and hands it back. Against the scripted DevTools
 * connection (tests/fake-cdp.js): no Chrome starts. */

const ALLOW = ['docs.example.com'];
const PAGES = {'https://docs.example.com/': {title: 'Docs', text: 'Hello', elements: [{index: 1, tag: 'button', text: 'Go'}]}};
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
function holdStep(fake, nth) {
  let seen = 0, release, started;
  const began = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  fake.hook('Runtime.evaluate', async ({expression}) => {
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

test('a task that starts while the owner is driving waits, then runs whole', async t => {
  const {sb, fake} = rig();
  t.after(() => sb.close());
  await sb.takeover('bot-a');
  const waiting = sb.run('bot-b', {url: 'https://docs.example.com/', steps: [{op: 'click', index: 1}]});
  let settled = false;
  waiting.then(() => { settled = true; });
  await sleep(40);
  assert.equal(settled, false, 'bots wait while the owner holds the browser');
  assert.equal(fake().called('Page.navigate').length, 0, 'bot B opened nothing');
  await sb.handback('bot-a');
  const result = await waiting;
  assert.equal(result.tookOver, undefined);
  assert.equal(result.actions[0].ok, true, 'it was never interrupted, so its steps ran');
  assert.equal(fake().actions.length, 1);
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
