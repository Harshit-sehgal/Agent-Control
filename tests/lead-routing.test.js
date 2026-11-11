/** Leads route work to their team and report back; the primary runs threads.
 *
 * A lead is the primary bot or any bot with reports. It sees its team by name
 * and job, hands each part out with @Name, and speaks once more after the team
 * has answered. The model is scripted and the loop is the real one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as wf from '../shared/workflow.js';
import {createThread} from '../shared/threads.js';
import {createRun, rosterFor, MAX_HANDOFFS} from '../shared/coordination.js';
import {runGroup, summonableGuests} from '../src/coordination.js';
import {simulateGroup} from '../shared/group-simulator.js';
import {company, model, ask} from './run-fixture.js';

const names = steps => steps.map(s => s.botId);

test('Atlas sees every bot by name and job and hands work out by @mention', async t => {
  const {store, ids} = await company(t);
  const ai = model({Atlas: 'I will split this. @Planner book it, @Scholar check the clinic.'});
  const run = await ask(store, {message: 'Book a dentist visit', to: 'atlas', executor: ai.executor});
  const [first] = ai.of('Atlas');
  assert.deepEqual(first.team.map(b => b.name).sort(), ['Mailroom', 'Ops lead', 'Planner', 'Scholar', 'Scribe']);
  assert.equal(first.team.find(b => b.name === 'Planner').job, 'Plans the owner\'s week and books appointments.');
  assert.match(first.restrictions.join('\n'), /You lead this team/);
  assert.match(first.restrictions.join('\n'), /offer to create a bot/);
  assert.deepEqual(run.recipients.slice(0, 3), [ids.atlas, ids.plan, ids.scholar]);
  assert.equal(run.status, 'completed');
  assert.deepEqual(ai.of('Planner')[0].previous, {from: 'atlas', output: 'I will split this. @Planner book it, @Scholar check the clinic.'});
  assert.deepEqual(ai.of('Scholar')[0].previous.from, 'atlas', 'every teammate gets the lead\'s assignment, not the teammate before it');
  assert.equal(ai.of('Mailroom').length, 0, 'bots outside the plan never see the message');
});

test('a manager hands work only to its own team', async t => {
  const {store, ids} = await company(t);
  const ai = model({'Ops lead': 'Mailroom, please draft it. @Mailroom @Scholar @Atlas'});
  const run = await ask(store, {message: 'Reply to the landlord', to: ids.ops, executor: ai.executor});
  assert.deepEqual(ai.of('Ops lead')[0].team.map(b => b.name).sort(), ['Mailroom', 'Planner']);
  assert.deepEqual(run.recipients, [ids.ops, ids.mail, ids.ops], 'Scholar and Atlas are not on its team');
  assert.equal(ai.of('Scholar').length, 0);
});

test('after the team replies the lead speaks once more with their answers', async t => {
  const {store, ids} = await company(t);
  const ai = model({
    Atlas: (env, n) => (n === 0 ? 'Splitting up: @Planner @Scholar' : 'Here is the result. Maybe @Mailroom should follow up.'),
    Planner: 'Booked Tuesday 10:00.',
    Scholar: 'The clinic is open on Tuesdays.',
  });
  const run = await ask(store, {message: 'Book a dentist visit', to: 'atlas', executor: ai.executor});
  assert.deepEqual(run.recipients, [ids.atlas, ids.plan, ids.scholar, ids.atlas]);
  assert.equal(run.closeAt, 3);
  assert.deepEqual(names(run.trace), [ids.atlas, ids.plan, ids.scholar, ids.atlas]);
  const [, closing] = ai.of('Atlas');
  assert.equal(closing.previous.output, 'Planner: Booked Tuesday 10:00.\n\nScholar: The clinic is open on Tuesdays.');
  assert.equal(closing.previous.from, ids.scholar);
  assert.deepEqual(closing.team, [], 'the closing step hands nothing out');
  assert.match(closing.restrictions.join('\n'), /Do not hand work out again/);
  assert.equal(ai.of('Mailroom').length, 0, 'a mention in the closing reply adds no one');
  assert.equal(run.status, 'completed');
  const chat = store.read().chats.atlas.filter(m => m.role === 'bot');
  assert.deepEqual(chat.map(m => m.senderName), ['Atlas', 'Planner', 'Scholar', 'Atlas']);
  assert.match(chat.at(-1).text, /Here is the result/);
});

test('a lead that hands nothing out does not speak twice', async t => {
  const {store, ids} = await company(t);
  const ai = model({Atlas: 'Good morning. Nothing for the team here.'});
  const run = await ask(store, {message: 'Hello', to: 'atlas', executor: ai.executor});
  assert.deepEqual(run.recipients, [ids.atlas]);
  assert.equal(run.closeAt, undefined);
});

test('the closing step always fits under the step cap', async t => {
  const {store, ids} = await company(t);
  const ai = model({Atlas: (env, n) => (n === 0 ? '@Ops lead @Mailroom @Planner @Scholar @Scribe all of you' : 'Done.')});
  const run = await ask(store, {message: 'Everything at once', to: 'atlas', executor: ai.executor});
  assert.equal(run.recipients.length, MAX_HANDOFFS);
  assert.equal(run.recipients.at(-1), ids.atlas);
  assert.equal(run.recipients.filter(id => id === ids.atlas).length, 2);
  assert.equal(run.status, 'completed');
});

test('a deleted bot named by the lead is skipped', async t => {
  const {store, ids} = await company(t);
  // Planner is deleted while Atlas is still writing its reply.
  const ai = model({Atlas: 'Hand it to @Planner and @Scholar.'});
  const gone = ai.executor;
  ai.executor = async (bot, input) => {
    if (bot.name === 'Atlas' && !ai.of('Atlas').length) await store.update(s => wf.removeBot(s, 'home', ids.plan));
    return gone(bot, input);
  };
  const run = await ask(store, {message: 'Plan and check', to: 'atlas', executor: ai.executor});
  assert.equal(run.status, 'completed', 'the run does not crash: ' + run.error);
  assert.deepEqual(run.recipients, [ids.atlas, ids.scholar, ids.atlas], 'Planner is skipped, Scholar still runs');
  assert.equal(ai.of('Planner').length, 0);
});

test('a plain bot has no one to hand work to in a thread, only leads hand out', async t => {
  const {store, ids} = await company(t);
  let runId;
  await store.update(s => {
    const thread = createThread(s, {title: 'Facts', makeId: () => 'x9'});
    s.groups.push(thread);
    const run = createRun({group: thread, message: 'Check a fact', guests: summonableGuests(s.groups, thread.id, {includeOff: true}), makeId: () => 'r-x9'});
    s.groupRuns.unshift(run); runId = run.id;
  });
  const ai = model({Atlas: (env, n) => (n === 0 ? 'Over to @Scholar' : 'Result.'), Scholar: 'Checked. @Scribe please write it up.'});
  await runGroup(store, runId, ai.executor);
  const run = store.read().groupRuns.find(r => r.id === runId);
  assert.deepEqual(run.recipients, [ids.atlas, ids.scholar, ids.atlas]);
  assert.deepEqual(ai.of('Scholar')[0].team, []);
  assert.equal(ai.of('Scribe').length, 0);
});

test('rosterFor gives a lead its team and a plain bot the group', async t => {
  const {store, ids} = await company(t);
  const state = store.read(), home = state.groups.find(g => g.id === 'home');
  const bot = id => home.bots.find(b => b.id === id);
  const reach = home.bots;
  assert.deepEqual(rosterFor(state, bot(ids.ops), reach).map(b => b.name).sort(), ['Mailroom', 'Planner']);
  assert.equal(rosterFor(state, bot(ids.atlas), reach).length, 5);
  assert.equal(rosterFor(state, bot(ids.scholar), reach).length, reach.length, 'a plain bot keeps the group roster');
  assert.deepEqual(rosterFor(state, bot(ids.scholar), reach, {thread: true}), []);
});

test('the Pages engine routes through the same rules: roster, closing step, cap', async () => {
  // The offline bots cannot write a hand-off, but their reply echoes the request,
  // so a thread whose first line names a teammate hands work out as a model would.
  const state = wf.migrate({version: 1, settings: {}, groups: [{id: 'home', name: 'Home', bots: [{id: 'atlas', name: 'Atlas', type: 'custom', instructions: 'Primary.', settings: {lead: true}}]}], runs: [], tasks: [], events: []});
  const scout = wf.addBot(state, 'home', {name: 'Scout', instructions: 'Looks things up.'});
  const quiet = wf.addBot(state, 'home', {name: 'Quiet', instructions: 'Stays out of it.'});
  const thread = createThread(state, {title: 'Look it up', makeId: () => 'p1'});
  state.groups.push(thread);
  const emitted = [];
  let n = 0;
  const run = await simulateGroup({group: thread, message: 'Please ask @Scout to look this up', guests: summonableGuests(state.groups, thread.id, {includeOff: true}), state, api: async () => {}, makeId: () => `m-${++n}`, emit: e => emitted.push(e)});
  assert.deepEqual(run.recipients, ['atlas', scout.id, 'atlas']);
  assert.equal(run.closeAt, 2);
  assert.equal(run.status, 'completed');
  assert.deepEqual(names(run.trace), ['atlas', scout.id, 'atlas']);
  assert.ok(!run.recipients.includes(quiet.id));
  assert.match(run.trace[1].output, /Previous handoff: Atlas received/, 'a teammate is handed the lead\'s assignment');
  assert.match(run.trace[2].output, /Previous handoff: Scout: Scout received/, 'the closing step is handed the teammate\'s answer');
  assert.deepEqual(thread.settings.members, [scout.id]);
});

test('a Pages lead that names no one does not speak twice', async () => {
  const state = wf.migrate({version: 1, settings: {}, groups: [{id: 'home', name: 'Home', bots: [{id: 'atlas', name: 'Atlas', type: 'custom', instructions: 'Primary.', settings: {lead: true}}]}], runs: [], tasks: [], events: []});
  wf.addBot(state, 'home', {name: 'Scout', instructions: 'Looks things up.'});
  const home = state.groups[0];
  const run = await simulateGroup({group: home, message: 'hello', directBotId: 'atlas', guests: [], state, api: async () => {}, makeId: () => 'q1', emit: () => {}, chatKey: 'atlas'});
  assert.deepEqual(run.recipients, ['atlas'], 'a lead that names no one hands nothing out');
  assert.equal(run.closeAt, undefined);
});

test('engine parity: the served loop and the Pages simulator make the same lead decisions', async t => {
  const {store, ids} = await company(t);
  const echo = async (bot, input) => `${bot.name} received the task. Task: ${JSON.parse(input).objective}`;
  const message = 'Please ask @Scholar and @Planner to look this up';
  let runId;
  await store.update(s => {
    const thread = createThread(s, {title: 'Parity', makeId: () => 'par'});
    s.groups.push(thread);
    const run = createRun({group: thread, message, guests: summonableGuests(s.groups, thread.id, {includeOff: true}), makeId: () => 'r-par'});
    s.groupRuns.unshift(run); runId = run.id;
  });
  await runGroup(store, runId, echo);
  const served = store.read().groupRuns.find(r => r.id === runId);

  const state = structuredClone(store.read());
  state.groups = state.groups.filter(g => g.id !== 'th-par');
  const thread = createThread(state, {title: 'Parity', makeId: () => 'par'});
  state.groups.push(thread);
  const local = await simulateGroup({group: thread, message, guests: summonableGuests(state.groups, thread.id, {includeOff: true}), state, api: async () => {}, makeId: () => 'r-par', emit: () => {}});
  assert.deepEqual(local.recipients, served.recipients);
  assert.equal(local.closeAt, served.closeAt);
  assert.deepEqual(names(local.trace), names(served.trace));
  assert.deepEqual(local.recipients, [ids.atlas, ids.scholar, ids.plan, ids.atlas]);
});
