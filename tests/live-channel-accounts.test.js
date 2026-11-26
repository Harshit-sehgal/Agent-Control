import test from 'node:test';
import assert from 'node:assert/strict';
import {startBrowserSession} from '../agent/browser.mjs';
import {createSharedBrowser} from '../agent/shared-browser.mjs';
import {createLiveChannel} from '../agent/live-channel.mjs';
import {fakeCdp} from './fake-cdp.js';

/* The device's live line names a tab by (account, bot). One bot on two accounts has two tabs, and an owner's
 * takeover, input, watch and frames for one never reach the other. Against the scripted DevTools connection. */

const A = '0a1b2c3d-0000-4000-8000-00000000000a';
const B = '0a1b2c3d-0000-4000-8000-00000000000b';
const URL_ = 'https://docs.example.com/';
const PAGES = {[URL_]: {title: 'Docs', text: 'Hello', elements: []}};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const memJars = () => ({load: () => null, save() {}, wipe() {}, ids: () => [], retain: () => []});

/** A shared browser with `scout` signed in as account A and as account B (two tabs), and a channel over scripted replies. */
async function rig(t, {poll = [], frame = () => ({ok: true, watch: 'scout', watchAccount: A})} = {}) {
  const processes = [];
  const sb = createSharedBrowser({
    allow: ['docs.example.com'], settleMs: 0, jars: memJars(),
    start: async () => { const fake = fakeCdp({pages: PAGES}); processes.push(fake); return startBrowserSession({connection: fake.connection}); },
  });
  await sb.run('scout', {url: URL_, account: A});
  await sb.run('scout', {url: URL_, account: B});
  const fake = processes[0], [ctxA, ctxB] = fake.contexts();
  const session = ctx => [...fake.targets.values()].find(x => x.browserContextId === ctx).sessionId;
  const sent = [];
  let polls = 0;
  const call = async (path, body, {signal} = {}) => {
    sent.push({path, body});
    if (path === '/api/agent/frames') return frame(body);
    if (path === '/api/agent/live') {
      const reply = poll[polls++];
      if (reply) return reply;
      await new Promise((resolve, reject) => { signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), {name: 'AbortError'}))); });
    }
    throw new Error(`unexpected ${path}`);
  };
  const channel = createLiveChannel({call, shared: sb, frameGapMs: 10, retryMs: 5, log: {error() {}}});
  t.after(async () => { await channel.stop(); await sb.close(); });
  return {channel, sb, fake, sent, sessionA: session(ctxA), sessionB: session(ctxB)};
}
const key = {type: 'key', key: 'Tab'};

test('the report names each tab\'s account, so one bot on two accounts is two tabs', async t => {
  const {channel, sent} = await rig(t, {poll: [{commands: [], watch: null}]});
  channel.start();
  await sleep(40);
  const poll = sent.find(s => s.path === '/api/agent/live');
  assert.deepEqual(poll.body.tabs.map(x => [x.botId, x.account, x.url]).sort(), [['scout', A, URL_], ['scout', B, URL_]].sort());
});

test('a takeover with an account holds that account\'s tab, and its input lands there', async t => {
  const {channel, sb, fake, sessionA, sessionB} = await rig(t, {poll: [{commands: [{type: 'takeover', botId: 'scout', account: B}, {type: 'input', botId: 'scout', account: B, event: key}], watch: null}]});
  channel.start();
  await sleep(60);
  assert.equal(sb.owner(), 'scout');
  assert.equal(sb.status().find(s => s.account === B).state, 'driving');
  assert.equal(sb.status().find(s => s.account === A).state, 'idle');
  assert.ok(fake.input.length > 0);
  assert.equal(fake.input.every(e => e.sessionId === sessionB), true, 'every event went to account B\'s tab');
  assert.equal(fake.input.some(e => e.sessionId === sessionA), false);
});

test('input that names the other account of the same bot is refused: it never reaches the held tab', async t => {
  const {channel, sb, fake} = await rig(t, {poll: [{commands: [{type: 'takeover', botId: 'scout', account: A}, {type: 'input', botId: 'scout', account: B, event: key}, {type: 'input', botId: 'scout', event: key}], watch: null}]});
  channel.start();
  await sleep(60);
  assert.equal(sb.owner(), 'scout', 'the owner still holds account A\'s tab');
  assert.deepEqual(fake.input, [], 'input for account B, or for no account, drove nothing');
});

test('a handback is always honoured, whatever account it names: the server has already let go, so the device must too', async t => {
  for (const named of [B, null]) {
    const {channel, sb} = await rig(t, {poll: [{commands: [{type: 'takeover', botId: 'scout', account: A}, {type: 'handback', botId: 'scout', ...(named ? {account: named} : {})}], watch: null}]});
    channel.start();
    await sleep(60);
    assert.equal(sb.owner(), null, `released by a handback naming ${named}`);
    await channel.stop();
  }
});

test('a handback for the held account releases it', async t => {
  const {channel, sb} = await rig(t, {poll: [{commands: [{type: 'takeover', botId: 'scout', account: A}, {type: 'handback', botId: 'scout', account: A}], watch: null}]});
  channel.start();
  await sleep(60);
  assert.equal(sb.owner(), null);
});

test('the cast follows watch and watchAccount: only that account\'s tab is cast, and its frames carry the account', async t => {
  const {channel, fake, sent, sessionA, sessionB} = await rig(t, {poll: [{commands: [], watch: 'scout', watchAccount: B}], frame: () => ({ok: true, watch: 'scout', watchAccount: B})});
  channel.start();
  await sleep(60);
  const starts = fake.called('Page.startScreencast');
  assert.equal(starts.length, 1);
  assert.equal(starts[0].sessionId, sessionB, 'account B\'s tab, not A\'s');
  const frames = sent.filter(s => s.path === '/api/agent/frames');
  assert.ok(frames.length >= 1);
  assert.equal(frames.every(f => f.body.botId === 'scout' && f.body.account === B), true);
  assert.equal(starts.some(s => s.sessionId === sessionA), false);
});

test('a frame of the same bot on another account is not sent', async t => {
  const {channel, fake, sent, sessionA, sessionB} = await rig(t, {poll: [{commands: [], watch: 'scout', watchAccount: A}], frame: () => ({ok: true, watch: 'scout', watchAccount: A})});
  channel.start();
  await sleep(60);
  const before = sent.filter(s => s.path === '/api/agent/frames').length;
  assert.ok(before >= 1);
  // Chrome sends a frame for B's tab: it is not the cast one, so nothing is sent.
  fake.emit('Page.screencastFrame', {data: 'BBBB', metadata: {}, sessionId: 77}, sessionB, {data: 'BBBB', metadata: {}, sessionId: 77});
  await sleep(40);
  assert.equal(sent.filter(s => s.path === '/api/agent/frames').some(s => s.body.image === 'BBBB'), false);
  fake.emit('Page.screencastFrame', {data: 'AAAA', metadata: {}, sessionId: 78}, sessionA, {data: 'AAAA', metadata: {}, sessionId: 78});
  await sleep(40);
  assert.equal(sent.filter(s => s.path === '/api/agent/frames').some(s => s.body.image === 'AAAA' && s.body.account === A), true);
});

test('the sink matches (account, bot): a frame for the same bot on another account is dropped even if it reaches the channel', async t => {
  let sink, watched = [];
  const shared = {
    onFrame: fn => { sink = fn; }, watch: async (botId, account) => { watched.push([botId, account]); return true; }, unwatch: async () => {},
    refresh: async () => {}, status: () => [], owner: () => null, takeover: async () => {}, handback: async () => {}, applyInput: async () => {},
  };
  const sent = [];
  const call = async (path, body, {signal} = {}) => {
    sent.push({path, body});
    if (path === '/api/agent/frames') return {ok: true, watch: 'scout', watchAccount: A};
    if (sent.filter(s => s.path === '/api/agent/live').length === 1) return {commands: [], watch: 'scout', watchAccount: A};
    await new Promise((resolve, reject) => { signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), {name: 'AbortError'}))); });
  };
  const channel = createLiveChannel({call, shared, frameGapMs: 5, retryMs: 5, log: {error() {}}});
  t.after(() => channel.stop());
  channel.start();
  await sleep(30);
  assert.deepEqual(watched, [['scout', A]]);
  sink({botId: 'scout', account: B, image: 'BBBB', w: 1, h: 1});
  sink({botId: 'scout', account: null, image: 'NONE', w: 1, h: 1});
  await sleep(30);
  assert.deepEqual(sent.filter(s => s.path === '/api/agent/frames'), []);
  sink({botId: 'scout', account: A, image: 'AAAA', w: 1, h: 1});
  await sleep(30);
  assert.deepEqual(sent.filter(s => s.path === '/api/agent/frames').map(s => [s.body.account, s.body.image]), [[A, 'AAAA']]);
});

test('with no account anything is as before: the default profile\'s tab, and frames with no account field', async t => {
  let sink; const watched = [];
  const shared = {
    onFrame: fn => { sink = fn; }, watch: async (botId, account) => { watched.push([botId, account]); return true; }, unwatch: async () => {},
    refresh: async () => {}, status: () => [], owner: () => null, takeover: async () => {}, handback: async () => {}, applyInput: async () => {},
  };
  const sent = [];
  const call = async (path, body, {signal} = {}) => {
    sent.push({path, body});
    if (path === '/api/agent/frames') return {ok: true, watch: 'atlas'};
    if (sent.filter(s => s.path === '/api/agent/live').length === 1) return {commands: [], watch: 'atlas'};
    await new Promise((resolve, reject) => { signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), {name: 'AbortError'}))); });
  };
  const channel = createLiveChannel({call, shared, frameGapMs: 5, retryMs: 5, log: {error() {}}});
  t.after(() => channel.stop());
  channel.start();
  await sleep(30);
  assert.deepEqual(watched, [['atlas', null]]);
  sink({botId: 'atlas', account: null, image: 'AAAA', w: 1, h: 1});
  await sleep(30);
  assert.deepEqual(Object.keys(sent.find(s => s.path === '/api/agent/frames').body).sort(), ['botId', 'h', 'image', 'w']);
});
