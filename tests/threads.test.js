/** Threads: a new chat every time, always run by the primary bot.
 *
 * The server and the Pages engine are driven through the same routes, and the
 * model is a throwaway local HTTP provider, so no network and no real AI.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {initialState} from '../shared/core.js';
import * as wf from '../shared/workflow.js';
import {createThread, isThread, threadsOf, titleFrom, noteMember} from '../shared/threads.js';
import {createRun, summonableGuests} from '../shared/coordination.js';
import {SqliteStore} from '../src/sqlite-store.js';
import {createRouter} from '../src/router.js';
import {groupRoutes} from '../src/routes-groups.js';
import {queueGroupRun, runGroup, coordinationState} from '../src/coordination.js';
import {installWebLocks} from './web-locks.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
installWebLocks();
let storage = {getItem: () => null, setItem: () => {}};
globalThis.window = globalThis.window || {};
Object.defineProperty(globalThis, 'localStorage', {configurable: true, get: () => storage, set: value => { storage = value; }});
await import(path.join(root, 'shared/local-api.js'));

const until = async (check, timeout = 4000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for the background work.');
};

/** A local model that answers every call with the next reply (the last repeats). */
async function provider(replies) {
  const bodies = [];
  const server = http.createServer((request, response) => {
    let raw = '';
    request.on('data', chunk => { raw += chunk; });
    request.on('end', () => {
      bodies.push(raw);
      const content = replies.length > 1 ? replies.shift() : replies[0];
      response.writeHead(200, {'content-type': 'application/json'});
      response.end(JSON.stringify({choices: [{message: {content}}]}));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  process.env.AI_BASE_URL = `http://127.0.0.1:${server.address().port}/v1`;
  process.env.AI_API_KEY = 'test-key';
  process.env.AI_MODEL = 'test-model';
  process.env.AI_API_STYLE = 'chat';
  return {bodies, close: () => new Promise(resolve => server.close(resolve))};
}

/** A workspace with Atlas and one plain bot, Scholar. */
async function workspace(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'ac-threads-'));
  const store = await new SqliteStore(path.join(dir, 'state.db'), path.join(dir, 'state.json')).init();
  t.after(() => rm(dir, {recursive: true, force: true}));
  await store.update(s => {
    wf.addBot(s, 'home', {name: 'Scholar', instructions: 'Checks facts and finds sources.'});
    coordinationState(s);
  });
  return store;
}
const botId = (store, name) => store.read().groups.find(g => g.id === 'home').bots.find(b => b.name === name).id;
const router = () => { const r = createRouter(); groupRoutes(r); return r; };
const startThread = async (store, message) => (await router().find('POST', '/api/threads').route.handler({store, params: {}, body: async () => ({message}), actor: {email: 'owner@example.test'}})).body;

test('a thread title is a short name for the first message, like a chat app names it', () => {
  assert.equal(titleFrom('Plan my week\nand book the dentist'), 'Plan my week');
  assert.equal(titleFrom('   \n  Hello there  '), 'Hello there');
  // The ask, without the politeness around it, cut before the second clause and kept to a few words.
  assert.equal(titleFrom('Please look into the quarterly numbers and tell me which suppliers got more expensive this year'), 'Look into the quarterly numbers');
  assert.equal(titleFrom('Plan a 3-day trip to Jaipur under 15k and find a hotel'), 'Plan a 3-day trip to Jaipur');
  assert.equal(titleFrom('can you find me 5 remote internships posted this week, with links?'), 'Find me 5 remote internships');
  assert.equal(titleFrom('What is the weather in Delhi today?'), 'Weather in Delhi today');
  assert.equal(titleFrom('x'.repeat(100)).length, 40, 'one long word is cut hard');
  assert.equal(titleFrom('  \n '), '');
  const thread = createThread({groups: [{id: 'home', bots: [{id: 'atlas', settings: {lead: true}}]}]}, {title: titleFrom('Plan my week\nmore'), now: '2026-11-11T10:00:00.000Z', makeId: () => 'abc'});
  assert.equal(thread.name, 'Plan my week');
  assert.equal(createThread({groups: [{id: 'home', bots: [{id: 'atlas', settings: {lead: true}}]}]}, {makeId: () => 'abd'}).name, 'New thread');
});

test('a thread is a group record with no bots whose owner is the primary', () => {
  const state = wf.migrate(initialState());
  const thread = createThread(state, {title: 'Trip', now: '2026-11-11T10:00:00.000Z', makeId: () => 'abc'});
  assert.equal(thread.id, 'th-abc');
  assert.deepEqual(thread.bots, []);
  assert.equal(thread.description, '');
  assert.deepEqual(thread.settings, {kind: 'thread', ownerId: 'atlas', members: []});
  assert.ok(isThread(thread));
  assert.equal(isThread(state.groups[0]), false);
  noteMember(thread, 'scout'); noteMember(thread, 'scout'); noteMember(thread, 'mail');
  assert.deepEqual(thread.settings.members, ['scout', 'mail']);
});

test('threadsOf lists only threads, newest activity first', () => {
  const state = wf.migrate(initialState());
  const old = createThread(state, {title: 'Old', now: '2026-11-01T00:00:00.000Z', makeId: () => 'old'});
  const fresh = createThread(state, {title: 'Fresh', now: '2026-11-02T00:00:00.000Z', makeId: () => 'new'});
  state.groups.push(old, fresh);
  assert.deepEqual(threadsOf(state).map(g => g.id), ['th-new', 'th-old']);
  state.chats = {'team-th-old': [{id: 'm', role: 'user', text: 'again', at: '2026-11-05T00:00:00.000Z'}]};
  assert.deepEqual(threadsOf(state).map(g => g.id), ['th-old', 'th-new'], 'a message moves the thread up');
});

test('starting a thread creates a new chat run by Atlas', async t => {
  const model = await provider(['On it. Here is the plan.']);
  t.after(model.close);
  const store = await workspace(t);
  const {thread, run} = await startThread(store, 'Plan my week\nI have a dentist visit on Tuesday.');
  assert.match(thread.id, /^th-/);
  assert.equal(thread.name, 'Plan my week');
  assert.deepEqual(thread.settings, {...thread.settings, kind: 'thread', ownerId: 'atlas'});
  assert.deepEqual(thread.bots, []);
  assert.ok(run.runId);
  const stored = () => store.read().groupRuns.find(r => r.id === run.runId);
  assert.deepEqual(stored().recipients, ['atlas']);
  assert.equal(stored().chatKey, `team-${thread.id}`);
  await until(() => stored().status === 'completed');
  const chat = store.read().chats[`team-${thread.id}`];
  assert.deepEqual(chat.filter(m => m.role !== 'system').map(m => [m.role, m.senderName || null]), [['user', null], ['bot', 'Atlas']]);
  assert.match(chat[0].text, /^Plan my week/, 'the owner\'s first line is in the thread');
  assert.equal(store.read().chats.atlas, undefined, 'it did not touch Atlas\'s own chat');
  assert.ok(store.read().groups.some(g => g.id === thread.id), 'the thread is stored');
});

test('a refused start leaves no empty thread behind', async t => {
  for (const name of ['AI_BASE_URL', 'AI_API_KEY', 'AI_MODEL', 'AI_API_STYLE']) delete process.env[name];
  const store = await workspace(t);
  const before = store.read().groups.length;
  await assert.rejects(() => startThread(store, 'hello'), error => error.status === 422);
  assert.equal(store.read().groups.length, before);
  await assert.rejects(() => startThread(store, '   '), error => error.status === 400);
});

test('a follow-up in a thread goes to Atlas again, even with an @mention', async t => {
  const model = await provider(['First answer.', 'Second answer.']);
  t.after(model.close);
  const store = await workspace(t);
  const scholar = botId(store, 'Scholar');
  const {thread, run} = await startThread(store, 'Look into this');
  await until(() => store.read().groupRuns.find(r => r.id === run.runId).status === 'completed');
  const again = await queueGroupRun(store, {groupId: thread.id, message: '@Scholar what do you think?', directBotId: scholar, chatKey: scholar});
  const second = () => store.read().groupRuns.find(r => r.id === again.runId);
  assert.deepEqual(second().recipients, ['atlas']);
  assert.equal(second().chatKey, `team-${thread.id}`);
  assert.equal(second().mode, 'thread');
  await until(() => second().status === 'completed');
  assert.deepEqual(second().trace.map(step => step.botId), ['atlas']);
});

test('a thread never reuses a bot chat', async t => {
  const store = await workspace(t);
  const scholar = botId(store, 'Scholar');
  const state = store.read();
  const thread = createThread(state, {title: 'T', makeId: () => 'x1'});
  state.groups.push(thread);
  const guests = summonableGuests(state.groups, thread.id, {includeOff: true});
  const run = createRun({group: thread, message: 'go', directBotId: scholar, chatKey: 'atlas', guests, makeId: randomUUID});
  assert.equal(run.chatKey, `team-${thread.id}`);
  assert.deepEqual(run.recipients, ['atlas']);
  assert.deepEqual(run.guestIds, ['atlas']);
});

test('bots Atlas hands work to become thread members', async t => {
  const store = await workspace(t);
  const scholar = botId(store, 'Scholar');
  let runId;
  await store.update(s => {
    const thread = createThread(s, {title: 'Facts', makeId: () => 'x2'});
    s.groups.push(thread);
    const guests = summonableGuests(s.groups, thread.id, {includeOff: true});
    const run = createRun({group: thread, message: 'Check a fact', guests, makeId: randomUUID});
    s.groupRuns.unshift(run); runId = run.id;
  });
  const seen = [];
  await runGroup(store, runId, async (bot, input) => { seen.push(bot.name); return bot.name === 'Atlas' ? 'Handing this to @Scholar.' : 'It is true.'; });
  const state = store.read();
  assert.equal(state.groupRuns.find(r => r.id === runId).status, 'completed');
  assert.deepEqual(state.groups.find(g => g.id === 'th-x2').settings.members, [scholar]);
  assert.ok(seen.includes('Scholar'));
  assert.equal(state.groups.find(g => g.id === 'th-x2').bots.length, 0, 'members are listed, not moved into the thread');
  assert.equal(state.chats.atlas, undefined);
  assert.equal(state.chats[scholar], undefined, 'Scholar\'s own chat stays untouched');
});

test('two bot chats can run at once', async t => {
  const model = await provider(['ok']);
  t.after(model.close);
  const store = await workspace(t);
  const scholar = botId(store, 'Scholar');
  // Atlas's chat is busy: a run is waiting on the owner there.
  await store.update(s => {
    s.groupRuns.unshift({id: 'busy-1', groupId: 'home', chatKey: 'atlas', status: 'awaiting_checkpoint', input: 'x', mode: 'direct', recipients: ['atlas'], trace: [], createdAt: new Date().toISOString()});
  });
  const other = await queueGroupRun(store, {groupId: 'home', message: 'hello', directBotId: scholar, chatKey: scholar});
  assert.ok(other.runId, 'another bot\'s chat is not blocked');
  await assert.rejects(queueGroupRun(store, {groupId: 'home', message: 'again', directBotId: 'atlas', chatKey: 'atlas'}), error => error.status === 409 && /already active/.test(error.message));
  await until(() => store.read().groupRuns.find(r => r.id === other.runId).status === 'completed');
});

test('one run at a time per thread', async t => {
  const model = await provider(['ok']);
  t.after(model.close);
  const store = await workspace(t);
  await store.update(s => {
    const thread = createThread(s, {title: 'Busy', makeId: () => 'x3'});
    s.groups.push(thread);
    s.groupRuns.unshift({id: 'busy-2', groupId: thread.id, chatKey: `team-${thread.id}`, status: 'running', input: 'x', mode: 'direct', recipients: ['atlas'], trace: [], createdAt: new Date().toISOString()});
  });
  await assert.rejects(queueGroupRun(store, {groupId: 'th-x3', message: 'more'}), error => error.status === 409);
});

test('the Pages engine starts a thread and answers follow-ups through the same routes', async () => {
  const map = new Map();
  storage = {map, getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, String(value))};
  const request = globalThis.window.AGENT_LOCAL_API;
  const bot = await request('/api/groups/home/bots', 'POST', {name: 'Scout', instructions: 'Look things up.'});
  const started = await request('/api/threads', 'POST', {message: 'Plan my week\nplease'});
  assert.equal(started.thread.name, 'Plan my week');
  assert.deepEqual(started.thread.settings, {...started.thread.settings, kind: 'thread', ownerId: 'atlas'});
  const state = await request('/api/state');
  const run = state.groupRuns.find(r => r.id === started.run.runId);
  assert.equal(run.recipients[0], 'atlas');
  assert.equal(run.chatKey, `team-${started.thread.id}`);
  assert.equal(run.status, 'completed');
  const chat = state.chats[`team-${started.thread.id}`];
  assert.equal(chat[0].role, 'user');
  assert.ok(chat.some(m => m.role === 'bot' && m.senderName === 'Atlas'));
  assert.equal(state.chats.atlas, undefined);
  // An @mention and a direct bot in a thread are ignored for routing.
  const again = await request(`/api/groups/${started.thread.id}/chat`, 'POST', {message: '@Scout help', directBotId: bot.id, chatKey: bot.id});
  const after = (await request('/api/state')).groupRuns.find(r => r.id === again.runId);
  assert.equal(after.recipients[0], 'atlas');
  assert.equal(after.chatKey, `team-${started.thread.id}`);
});

test('the Pages engine runs two bot chats at once', async () => {
  const map = new Map();
  storage = {map, getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, String(value))};
  const request = globalThis.window.AGENT_LOCAL_API;
  const bot = await request('/api/groups/home/bots', 'POST', {name: 'Scout', instructions: 'Look things up.'});
  const saved = JSON.parse(map.get('agent-control-ghpages-v1'));
  saved.groupRuns.unshift({id: 'busy-3', groupId: 'home', chatKey: 'atlas', status: 'awaiting_checkpoint', input: 'x', mode: 'direct', recipients: ['atlas'], trace: [], createdAt: new Date().toISOString()});
  map.set('agent-control-ghpages-v1', JSON.stringify(saved));
  const other = await request('/api/groups/home/chat', 'POST', {message: 'hi', directBotId: bot.id, chatKey: bot.id});
  assert.ok(other.runId);
  await assert.rejects(request('/api/groups/home/chat', 'POST', {message: 'hi', directBotId: 'atlas', chatKey: 'atlas'}), /already active/);
});
