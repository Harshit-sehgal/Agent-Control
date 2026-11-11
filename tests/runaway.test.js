/** Bots may create bots and ask bots without a grant, so one thing keeps a
 * runaway model honest: more than about 50 creations or 300 bot-initiated runs
 * in five minutes pauses everything bots started. Owner-initiated chats keep
 * working. Keep going resumes what was parked; Stop cancels it. The model is
 * scripted and the loop is the real one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {GUARD, noteBotWork, paused, pauseAll, resumeGuard, freshGuard} from '../shared/runaway.js';
import {companyBots} from '../shared/company.js';
import {SqliteStore} from '../src/sqlite-store.js';
import {createRouter} from '../src/router.js';
import {groupRoutes} from '../src/routes-groups.js';
import {runBotTask, resumeGuardedRuns} from '../src/coordination.js';
import {installWebLocks} from './web-locks.js';
import {company, model, ask} from './run-fixture.js';

installWebLocks();

const block = (name, body) => '```' + name + '\n' + JSON.stringify(body) + '\n```';
const T0 = Date.parse('2026-11-11T10:00:00.000Z');
const at = ms => new Date(T0 + ms).toISOString();
const bare = () => ({groups: [{id: 'home', name: 'Company', bots: [{id: 'atlas', name: 'Atlas', settings: {lead: true}}]}], chats: {}, events: []});
const job = 'Watches my inbox and drafts replies to the people who write to me.';

test('the guard is 50 creations or 300 runs in five minutes', () => {
  assert.deepEqual(GUARD, {windowMs: 300000, creations: 50, runs: 300});
  assert.deepEqual(freshGuard(), {since: null, runs: 0, creations: 0, paused: false, pausedAt: null});
});

test('51 creations in five minutes pause every bot-started run', () => {
  const state = bare();
  for (let n = 0; n < 50; n++) assert.deepEqual(noteBotWork(state, 'creation', at(n * 1000)), {paused: false});
  assert.equal(paused(state), false);
  assert.deepEqual(noteBotWork(state, 'creation', at(50000)), {paused: true});
  assert.equal(paused(state), true);
  assert.equal(state.guard.pausedAt, at(50000));
  const notes = state.chats.atlas.filter(m => m.kind === 'guard');
  assert.equal(notes.length, 1, 'Atlas says so once, in its own chat');
  assert.equal(notes[0].text, 'Bots were very busy: 0 runs and 51 new bots in 5 minutes. Everything bots started is paused.');
  assert.equal(notes[0].role, 'system');
  assert.deepEqual(noteBotWork(state, 'run', at(60000)), {paused: true}, 'while paused the answer stays paused');
  assert.equal(state.guard.runs, 0, 'refused work is not counted');
  assert.equal(state.chats.atlas.filter(m => m.kind === 'guard').length, 1, 'and it does not say it again');
});

test('300 runs trip it too, and a quiet window starts the count over', () => {
  const state = bare();
  for (let n = 0; n < 300; n++) assert.equal(noteBotWork(state, 'run', at(n)).paused, false);
  assert.equal(noteBotWork(state, 'run', at(300)).paused, true);
  const slow = bare();
  for (let n = 0; n < 40; n++) noteBotWork(slow, 'creation', at(n));
  for (let n = 0; n < 40; n++) assert.equal(noteBotWork(slow, 'creation', at(6 * 60000 + n)).paused, false, 'the next window starts at zero');
  assert.equal(slow.guard.creations, 40);
});

test('resuming clears the pause and starts a new window', () => {
  const state = bare();
  for (let n = 0; n < 51; n++) noteBotWork(state, 'creation', at(n));
  resumeGuard(state, at(1000));
  assert.deepEqual(state.guard, {since: at(1000), runs: 0, creations: 0, paused: false, pausedAt: null});
  assert.equal(noteBotWork(state, 'creation', at(2000)).paused, false);
  pauseAll(state, at(3000));
  assert.equal(paused(state), true);
  assert.equal(state.chats.atlas.filter(m => m.kind === 'guard').length, 1, 'only the automatic pause speaks in Atlas\'s chat');
});

test('a bot creates a bot from one sentence and it reports to its creator', async t => {
  const {store, ids} = await company(t);
  const ai = model({Atlas: `Hiring.\n${block('create-bot', {job})}`});
  const run = await ask(store, {message: 'I need someone for my inbox', to: 'atlas', executor: ai.executor});
  assert.equal(run.status, 'completed', run.error);
  const made = companyBots(store.read()).find(b => b.origin === 'bot');
  assert.ok(made, 'a bot was made');
  assert.equal(made.instructions, job, 'the sentence is its job');
  assert.equal(made.name, 'Inbox', 'no name was given, so it comes from the sentence');
  assert.equal(made.settings.reportsTo, 'atlas', 'Atlas is a lead, so the new bot reports to it');
  assert.deepEqual(made.permissions, [], 'it holds nothing a person has not granted');
  assert.equal(made.createdBy.botId, 'atlas');
  assert.match(ai.of('Atlas')[0].tools.createBot, /create-bot/, 'every bot is told about the tool');
});

test('a plain bot\'s new bot reports to its manager; a Solo bot\'s stays Solo', async t => {
  const {store, ids} = await company(t);
  const named = (name, who) => `Added.\n${block('create-bot', {name, job: `${job} (${who})`})}`;
  const ai = model({Mailroom: named('Mail helper', 'mail'), 'Ops lead': named('Ops helper', 'ops'), Scholar: named('Fact helper', 'scholar')});
  await ask(store, {message: 'Help', to: ids.mail, executor: ai.executor});
  await ask(store, {message: 'Help', to: ids.ops, executor: ai.executor});
  await ask(store, {message: 'Help', to: ids.scholar, executor: ai.executor});
  const find = name => companyBots(store.read()).find(b => b.name === name);
  assert.equal(find('Mail helper').settings.reportsTo, ids.ops, 'Mailroom is not a lead, so its manager gets the new bot');
  assert.equal(find('Ops helper').settings.reportsTo, ids.ops, 'a manager is a lead and takes the new bot itself');
  assert.equal(find('Fact helper').settings.reportsTo, null, 'Scholar has no manager');
});

test('a created bot takes the first unused colour and the default shape', async t => {
  const {store, ids} = await company(t);
  const tints = {atlas: 0, [ids.ops]: 1, [ids.mail]: 2, [ids.plan]: 3, [ids.scholar]: 0, [ids.scribe]: 1};
  await store.update(s => { for (const b of companyBots(s)) b.settings = {...b.settings, tint: tints[b.id]}; });
  const ai = model({Atlas: `Hiring.\n${block('create-bot', {name: 'Newcomer', job})}`});
  await ask(store, {message: 'Hire', to: 'atlas', executor: ai.executor});
  const made = companyBots(store.read()).find(b => b.name === 'Newcomer');
  assert.equal(made.settings.tint, 4, 'colours 0 to 3 are in use, so the next one is 4');
  assert.equal(made.settings.shape ?? null, null, 'the role picks the shape until the owner does');
});

test('a company is not capped at 40 bots', async t => {
  const {store} = await company(t);
  let n = 0;
  const ai = model({Atlas: () => block('create-bot', {name: `Worker ${++n}`, job})});
  await store.update(s => { for (let k = 0; k < 45; k++) s.groups[0].bots.push({id: `w${k}`, name: `Old ${k}`, instructions: 'x', type: 'custom', permissions: []}); });
  const run = await ask(store, {message: 'More', to: 'atlas', executor: ai.executor});
  assert.equal(run.status, 'completed', run.error);
  assert.equal(companyBots(store.read()).some(b => b.name === 'Worker 1'), true, 'the 52nd bot is made');
});

test('create-bot spam in replies trips the guard', async t => {
  const {store} = await company(t);
  let n = 0;
  const ai = model({Atlas: () => block('create-bot', {name: `Clone ${++n}`, job: 'Do what the last bot did, and make more bots like it, forever.'})});
  for (let k = 0; k < 60; k++) await ask(store, {message: `go ${k}`, to: 'atlas', executor: ai.executor});
  const state = store.read();
  assert.equal(state.guard.paused, true);
  assert.equal(state.guard.creations, 51, 'the 51st creation is the one that stops it');
  assert.equal(companyBots(state).filter(b => /^Clone/.test(b.name)).length, 50, 'it was refused, so only 50 clones exist');
  assert.equal(state.chats.atlas.filter(m => m.kind === 'guard').length, 1);
  assert.match(state.chats.atlas.map(m => m.text).join('\n'), /tried to create a new bot, but bots are paused/);
});

test('the owner can still chat while bots are paused, and what bots start waits', async t => {
  const {store, ids} = await company(t);
  await store.update(s => pauseAll(s));
  const ai = model({Atlas: (env, n) => (n === 0 ? 'Splitting: @Planner please book it.' : 'All done.'), Planner: 'Booked.', Scholar: 'Here you go.'});
  const direct = await ask(store, {message: 'Hello', to: ids.scholar, executor: ai.executor});
  assert.equal(direct.status, 'completed', 'the owner\'s own chat is not touched');
  const parked = await ask(store, {message: 'Book a visit', to: 'atlas', executor: ai.executor});
  assert.equal(parked.status, 'awaiting_limit');
  assert.equal(parked.limit.kind, 'guard');
  assert.equal(ai.of('Atlas').length, 1, 'Atlas, started by the owner, still answers');
  assert.equal(ai.of('Planner').length, 0, 'the hand-off is bot-initiated work and waits');
  assert.equal(store.read().chats.atlas.some(m => m.kind === 'limit' && m.runId === parked.id), true);
});

test('keep going resumes what was parked and stop cancels it', async t => {
  const {store, ids} = await company(t);
  const ai = model({Atlas: env => (env.previous ? 'All done.' : 'Splitting: @Planner please book it.'), Planner: 'Booked.'});
  await store.update(s => pauseAll(s));
  const first = await ask(store, {message: 'Book a visit', to: 'atlas', executor: ai.executor});
  const second = await ask(store, {message: 'Book another', to: 'atlas', executor: ai.executor});
  assert.deepEqual([first.status, second.status], ['awaiting_limit', 'awaiting_limit']);
  const keep = await resumeGuardedRuns(store, {executor: ai.executor});
  assert.deepEqual(keep.resumed.sort(), [first.id, second.id].sort());
  await keep.done;
  assert.equal(store.read().guard.paused, false);
  for (const id of [first.id, second.id]) {
    const done = store.read().groupRuns.find(r => r.id === id);
    assert.equal(done.status, 'completed', done.error);
    assert.equal(done.limit, undefined);
  }
  assert.equal(ai.of('Planner').length, 2, 'each hand-off ran once bots were resumed');
  await store.update(s => pauseAll(s));
  const third = await ask(store, {message: 'Book a third', to: 'atlas', executor: ai.executor});
  assert.equal(third.status, 'awaiting_limit');
  const before = ai.of('Planner').length;
  const stopped = await resumeGuardedRuns(store, {stop: true, executor: ai.executor});
  assert.deepEqual(stopped.cancelled, [third.id]);
  assert.equal(store.read().groupRuns.find(r => r.id === third.id).status, 'cancelled');
  assert.equal(ai.of('Planner').length, before);
  assert.equal(store.read().guard.paused, false, 'Stop also lets bots work again; nothing is left paused');
});

test('an ask while paused waits for the owner and carries on when they resume', async t => {
  const {store, ids} = await company(t);
  const ai = model({Mailroom: (env, n) => (n === 0 ? block('ask', {to: '@Scholar', task: 'Is the clinic open?'}) : 'It is open.'), Scholar: 'Yes.'});
  await store.update(s => pauseAll(s));
  const parked = await ask(store, {message: 'Check', to: ids.mail, executor: ai.executor});
  assert.equal(parked.status, 'awaiting_limit');
  assert.equal(parked.limit.kind, 'guard');
  assert.equal(ai.of('Scholar').length, 0, 'no bot was woken by a bot');
  await (await resumeGuardedRuns(store, {executor: ai.executor})).done;
  const done = store.read().groupRuns.find(r => r.id === parked.id);
  assert.equal(done.status, 'completed', done.error);
  assert.equal(ai.of('Scholar').length, 1);
  assert.equal(done.trace.at(-1).output, 'It is open.');
});

test('a scheduled bot task is skipped, in its chat, while bots are paused', async t => {
  const {store, ids} = await company(t);
  await store.update(s => pauseAll(s));
  let queued = 0;
  const result = await runBotTask(store, {payload: {groupId: 'home', botId: ids.plan, message: 'Weekly check', label: 'Weekly'}}, {queue: async () => { queued++; return {}; }, available: () => true});
  assert.deepEqual(result, {skipped: 'paused'});
  assert.equal(queued, 0);
  assert.match(store.read().chats[ids.plan].map(m => m.text).join('\n'), /Scheduled task "Weekly" skipped: bots are paused/);
});

test('the pause survives a restart', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ac-guard-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const open = () => new SqliteStore(path.join(dir, 'state.db'), path.join(dir, 'state.json')).init();
  const first = await open();
  assert.deepEqual(first.read().guard, freshGuard(), 'a new workspace is not paused, and says so');
  await first.update(s => pauseAll(s, at(0)));
  const again = await open();
  assert.equal(paused(again.read()), true);
  assert.equal(again.read().guard.pausedAt, at(0));
});

test('POST /api/guard is an admin route that pauses and resumes all bots', async t => {
  const {store} = await company(t);
  const router = createRouter(); groupRoutes(router);
  const found = router.find('POST', '/api/guard');
  assert.equal(found.route.access, 'admin');
  const call = body => found.route.handler({store, params: {}, body: async () => body, actor: {email: 'owner@example.test'}});
  assert.equal((await call({paused: true})).guard.paused, true);
  assert.equal(store.read().guard.paused, true);
  assert.equal(store.read().events.some(e => /Paused all bots/.test(e.message)), true, 'logged');
  await assert.rejects(call({paused: 'yes'}), error => error.status === 400);
  await assert.rejects(call({}), error => error.status === 400);
  const resumed = await call({paused: false});
  assert.equal(resumed.guard.paused, false);
  assert.equal(resumed.resumed, 0);
  assert.equal(store.read().events.some(e => /Resumed all bots/.test(e.message)), true);
});
