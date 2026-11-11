import test from 'node:test';
import assert from 'node:assert/strict';
import {startBrowserSession} from '../agent/browser.mjs';
import {createSharedBrowser} from '../agent/shared-browser.mjs';
import {createLiveChannel} from '../agent/live-channel.mjs';
import {cleanInput, KEYS} from '../agent/live-input.mjs';
import {fakeCdp} from './fake-cdp.js';

/* Watching a bot's tab and driving it, on the device. Screencast frames and
 * input go through the real shared-browser code against the scripted DevTools
 * connection (tests/fake-cdp.js); no Chrome starts. */

const ALLOW = ['docs.example.com'];
const PAGES = {'https://docs.example.com/': {title: 'Docs', text: 'Hello', elements: []}};
function rig() {
  const processes = [];
  const sb = createSharedBrowser({
    allow: ALLOW,
    start: async () => { const fake = fakeCdp({pages: PAGES}); processes.push(fake); return startBrowserSession({connection: fake.connection}); },
    settleMs: 0,
  });
  return {sb, processes, fake: () => processes[0]};
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const rejects400 = fn => assert.throws(fn, error => error.status === 400);

test('owner input is normalised: known types only, numbers clamped, text and keys bounded', () => {
  assert.deepEqual(cleanInput({type: 'click', x: 10.4, y: '20', evil: 1}), {type: 'click', x: 10, y: 20, double: false});
  assert.deepEqual(cleanInput({type: 'click', x: -5, y: 99999, double: true}), {type: 'click', x: 0, y: 800, double: true}, 'a click outside the page lands on its edge');
  assert.deepEqual(cleanInput({type: 'scroll', dy: 120}), {type: 'scroll', x: 640, y: 400, dx: 0, dy: 120});
  assert.deepEqual(cleanInput({type: 'scroll', dy: 1e9}).dy, 5000);
  assert.deepEqual(cleanInput({type: 'type', text: 'hello'}), {type: 'type', text: 'hello'});
  assert.deepEqual(cleanInput({type: 'key', key: 'Enter'}), {type: 'key', key: 'Enter'});
  assert.deepEqual(cleanInput({type: 'navigate', url: 'https://docs.example.com/a?b=1'}), {type: 'navigate', url: 'https://docs.example.com/a?b=1'});
  assert.ok(KEYS.Enter && KEYS.Backspace);
  rejects400(() => cleanInput(null));
  rejects400(() => cleanInput({type: 'eval', code: '1'}));
  rejects400(() => cleanInput({type: 'click', x: 'left', y: 3}));
  rejects400(() => cleanInput({type: 'click', x: null, y: 3}));
  rejects400(() => cleanInput({type: 'click', x: true, y: 3}));
  rejects400(() => cleanInput({type: 'type', text: ''}));
  rejects400(() => cleanInput({type: 'type', text: 'x'.repeat(2001)}));
  rejects400(() => cleanInput({type: 'key', key: 'F12'}));
  rejects400(() => cleanInput({type: 'key', key: 'constructor'}));
  rejects400(() => cleanInput({type: 'navigate', url: 'file:///etc/passwd'}));
  rejects400(() => cleanInput({type: 'navigate', url: 'javascript:alert(1)'}));
  rejects400(() => cleanInput({type: 'navigate', url: 'nonsense'}));
});

test('the screencast runs for the watched tab only, with the spec settings, and stops with the viewer', async t => {
  const {sb, fake} = rig();
  t.after(() => sb.close());
  await sb.run('bot-a', {url: 'https://docs.example.com/'});
  await sb.run('bot-b', {url: 'https://docs.example.com/'});
  const frames = [];
  sb.onFrame(frame => frames.push(frame));
  assert.equal(await sb.watch('bot-a'), true);
  const starts = fake().called('Page.startScreencast');
  assert.equal(starts.length, 1, 'one tab is cast, not every tab');
  assert.deepEqual(starts[0].params, {format: 'jpeg', quality: 60, maxWidth: 1280, maxHeight: 800, everyNthFrame: 2});
  const aSession = [...fake().targets.values()].find(x => x.url).sessionId;
  assert.equal(starts[0].sessionId, aSession);
  // Chrome sends a frame with its own ack id; the device acks that id, or Chrome stops sending.
  const tabA = fake().called('Target.attachToTarget')[0];
  assert.ok(tabA);
  fake().emit('Page.screencastFrame', {data: 'AAAA', metadata: {deviceWidth: 1280, deviceHeight: 800}, sessionId: 41}, starts[0].sessionId, {data: 'AAAA', metadata: {deviceWidth: 1280, deviceHeight: 800}, sessionId: 41});
  await sleep(5);
  const acks = fake().called('Page.screencastFrameAck');
  assert.deepEqual(acks.map(a => a.params), [{sessionId: 41}]);
  assert.equal(acks[0].sessionId, starts[0].sessionId, 'acked on the cast tab');
  assert.ok(frames.some(f => f.botId === 'bot-a' && f.image === 'AAAA' && f.w === 1280 && f.h === 800), `frames: ${JSON.stringify(frames)}`);
  // A frame from a tab nobody is watching is ignored.
  const bSession = fake().called('Target.attachToTarget').length && [...fake().targets.values()][1].sessionId;
  const before = frames.length;
  fake().emit('Page.screencastFrame', {data: 'BBBB', metadata: {}, sessionId: 42}, bSession, {data: 'BBBB', metadata: {}, sessionId: 42});
  assert.equal(frames.length, before);
  // Switching the watched bot stops the first cast before starting the second.
  assert.equal(await sb.watch('bot-b'), true);
  assert.equal(fake().called('Page.stopScreencast').length, 1);
  assert.equal(fake().called('Page.startScreencast').length, 2);
  await sb.unwatch();
  assert.equal(fake().called('Page.stopScreencast').length, 2);
  assert.equal(await sb.watch('nobody'), false, 'a bot with no tab has nothing to show');
  assert.equal(fake().called('Page.startScreencast').length, 2);
});

test('watching seeds one frame at once, so a page that never repaints still shows', async t => {
  const {sb} = rig();
  t.after(() => sb.close());
  await sb.run('bot-a', {url: 'https://docs.example.com/'});
  const frames = [];
  sb.onFrame(frame => frames.push(frame));
  await sb.watch('bot-a');
  assert.equal(frames.length, 1);
  assert.equal(frames[0].image, 'c2VlZA==');
});

test('owner input reaches the bot\'s tab as real input events, and is bounded again on the device', async t => {
  const {sb, fake} = rig();
  t.after(() => sb.close());
  await sb.run('bot-a', {url: 'https://docs.example.com/'});
  const sessionId = [...fake().targets.values()][0].sessionId;
  await sb.takeover('bot-a');
  await sb.applyInput('bot-a', {type: 'click', x: 100, y: 200});
  await sb.applyInput('bot-a', {type: 'type', text: 'hi there'});
  await sb.applyInput('bot-a', {type: 'key', key: 'Enter'});
  await sb.applyInput('bot-a', {type: 'scroll', x: 5, y: 6, dy: 300});
  const sent = fake().input;
  assert.deepEqual(sent.map(e => [e.method, e.params.type]), [
    ['Input.dispatchMouseEvent', 'mouseMoved'], ['Input.dispatchMouseEvent', 'mousePressed'], ['Input.dispatchMouseEvent', 'mouseReleased'],
    ['Input.insertText', undefined],
    ['Input.dispatchKeyEvent', 'keyDown'], ['Input.dispatchKeyEvent', 'keyUp'],
    ['Input.dispatchMouseEvent', 'mouseWheel'],
  ]);
  assert.deepEqual([sent[1].params.x, sent[1].params.y, sent[1].params.button, sent[1].params.clickCount], [100, 200, 'left', 1]);
  assert.equal(sent[3].params.text, 'hi there');
  assert.equal(sent[4].params.key, 'Enter');
  assert.equal(sent[4].params.windowsVirtualKeyCode, 13);
  assert.equal(sent[6].params.deltaY, 300);
  assert.equal(sent.every(e => e.sessionId === sessionId), true, 'every event went to that bot\'s tab');
  await assert.rejects(sb.applyInput('bot-a', {type: 'eval'}), /input event is one of/);
  await assert.rejects(sb.applyInput('nobody', {type: 'key', key: 'Enter'}), /not driving/);
  // Navigation is held to the allowlist, like everything the browser opens.
  await sb.applyInput('bot-a', {type: 'navigate', url: 'https://docs.example.com/next'});
  assert.equal(fake().called('Page.navigate').at(-1).params.url, 'https://docs.example.com/next');
  await assert.rejects(sb.applyInput('bot-a', {type: 'navigate', url: 'https://evil.example.net/'}), /AGENT_BROWSER_ALLOWLIST/);
  assert.equal(fake().called('Page.navigate').at(-1).params.url, 'https://docs.example.com/next', 'the refused page was never opened');
});

/** A channel over a scripted server: `replies` is what each poll or frame post gets back. */
function channelRig(t, {poll = [], frame = () => ({ok: true, watch: 'bot-a'})} = {}) {
  const {sb, fake} = rig();
  const sent = [];
  let polls = 0;
  const call = async (path, body, {signal} = {}) => {
    sent.push({path, body});
    if (path === '/api/agent/frames') return frame(body);
    if (path === '/api/agent/live') {
      const reply = poll[polls++];
      if (reply) return reply;
      // Nothing more scripted: behave like a long-poll until stopped.
      await new Promise((resolve, reject) => { signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), {name: 'AbortError'}))); });
    }
    throw new Error(`unexpected ${path}`);
  };
  const channel = createLiveChannel({call, shared: sb, frameGapMs: 40, retryMs: 5, log: {error() {}}});
  t.after(async () => { await channel.stop(); await sb.close(); });
  return {channel, sb, fake, sent};
}

test('the live channel starts watching when the server says so, applies input in order, and reports tabs', async t => {
  const {channel, sb, fake, sent} = channelRig(t, {poll: [{commands: [], watch: null}, {commands: [{type: 'takeover', botId: 'bot-a'}, {type: 'input', botId: 'bot-a', event: {type: 'key', key: 'Tab'}}, {type: 'input', botId: 'bot-a', event: {type: 'type', text: 'x'}}], watch: 'bot-a'}]});
  await sb.run('bot-a', {url: 'https://docs.example.com/'});
  channel.start();
  await sleep(60);
  assert.equal(fake().called('Page.startScreencast').length, 1);
  assert.deepEqual(fake().input.map(e => e.method), ['Input.dispatchKeyEvent', 'Input.dispatchKeyEvent', 'Input.insertText']);
  const poll = sent.find(s => s.path === '/api/agent/live');
  assert.deepEqual(poll.body.tabs.map(x => [x.botId, x.url]), [['bot-a', 'https://docs.example.com/']]);
});

test('frames go out latest-only, at about ten a second at most, and the cast stops when the server says nobody watches', async t => {
  const {channel, sb, fake, sent} = channelRig(t, {poll: [{commands: [], watch: 'bot-a'}]});
  await sb.run('bot-a', {url: 'https://docs.example.com/'});
  channel.start();
  await sleep(30);
  const tab = [...fake().targets.values()][0].sessionId;
  const burst = n => { for (let i = 0; i < n; i++) fake().emit('Page.screencastFrame', {data: `F${i}`, metadata: {deviceWidth: 1280, deviceHeight: 800}, sessionId: i}, tab, {data: `F${i}`, metadata: {deviceWidth: 1280, deviceHeight: 800}, sessionId: i}); };
  burst(20);
  await sleep(10);
  const posted = () => sent.filter(s => s.path === '/api/agent/frames').map(s => s.body.image);
  assert.ok(posted().length <= 3, `a burst of 20 frames is thinned: ${JSON.stringify(posted())}`);
  await sleep(80);
  assert.equal(posted().at(-1), 'F19', 'the newest frame wins, older ones are dropped');
  assert.equal(posted().includes('F5'), false, 'stale frames are never sent');
  assert.deepEqual(Object.keys(sent.find(s => s.path === '/api/agent/frames').body).sort(), ['botId', 'h', 'image', 'w']);
});

test('when the server stops asking for frames the screencast is stopped', async t => {
  const {channel, sb, fake} = channelRig(t, {poll: [{commands: [], watch: 'bot-a'}], frame: () => ({ok: true, watch: null})});
  await sb.run('bot-a', {url: 'https://docs.example.com/'});
  channel.start();
  await sleep(60);
  assert.equal(fake().called('Page.startScreencast').length, 1);
  assert.equal(fake().called('Page.stopScreencast').length, 1, 'the seed frame\'s reply said nobody is watching');
});

test('a failing server is retried, and stop() ends the loop and any cast', async t => {
  const {sb, fake} = rig();
  let n = 0;
  const call = async () => { n += 1; throw new Error('server responded 500: boom'); };
  const channel = createLiveChannel({call, shared: sb, frameGapMs: 10, retryMs: 5, log: {error() {}}});
  await sb.run('bot-a', {url: 'https://docs.example.com/'});
  channel.start();
  await sleep(60);
  assert.ok(n >= 2, 'it kept trying');
  await channel.stop();
  const after = n;
  await sleep(40);
  assert.equal(n, after, 'and stopped');
  await sb.close();
  assert.ok(fake());
});
