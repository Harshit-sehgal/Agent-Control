import test from 'node:test';
import assert from 'node:assert/strict';
import {startBrowserSession} from '../agent/browser.mjs';
import {createSharedBrowser} from '../agent/shared-browser.mjs';
import {createLiveChannel} from '../agent/live-channel.mjs';
import {fakeCdp} from './fake-cdp.js';

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
    if (expression === 'location.href' || expression.startsWith('(function(){var els=') || expression.startsWith('JSON.stringify')) return undefined;
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
