/** Any bot can ask any bot. The limits are checkpoints, not walls: a chain 6
 * bots deep, 12 messages between two bots, 60 in one task, and a question that
 * goes around three times with no new answer each stop the task and offer
 * Keep going / Keep going, don't ask again / Stop. The model is scripted and the
 * loop is the real one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {ASK_LIMITS, tallyAsk, recordAnswer, extendLimits, LIMIT_CHOICES} from '../shared/ask-limits.js';
import {canBot, BASIC_KIT} from '../shared/contracts.js';
import {BUSY_STATUSES, STOPPABLE_STATUSES, INTERRUPT_STATUSES} from '../shared/run-state.js';
import {runNote} from '../shared/coordination.js';
import {resumeGroupRun} from '../src/coordination.js';
import http from 'node:http';
import {createRouter} from '../src/router.js';
import {groupRoutes} from '../src/routes-groups.js';
import {installWebLocks} from './web-locks.js';
import {company as bare, model, ask} from './run-fixture.js';

// These checkpoints are the owner's choice now (Settings, Permissions, Limits): off by default, so each test here
// turns them on. The last test checks the default.
const company = async (t, o) => { const c = await bare(t, o); await c.store.update(s => { s.limits = {askCheckpoints: true}; }); return c; };

installWebLocks();

const block = (to, task) => '```ask\n' + JSON.stringify({to, task}) + '\n```';
const kinds = run => run.trace.filter(s => s.kind).map(s => `${s.kind}:${s.botId}>${s.to}`);

test('the limits are the ones the spec names', () => {
  assert.deepEqual(ASK_LIMITS, {depth: 6, pair: 12, total: 60, repeats: 3});
  assert.deepEqual(LIMIT_CHOICES.map(c => c.choice), ['more', 'unlimited', 'stop']);
  assert.deepEqual(LIMIT_CHOICES.map(c => c.label), ['Keep going', 'Keep going, don\'t ask again', 'Stop']);
});

test('bot.ask, bot.create and schedule.set are the basic kit: allowed whatever the list says', () => {
  const bare = {id: 'b', permissions: []};
  for (const action of ['bot.ask', 'bot.create', 'schedule.set']) assert.equal(canBot(bare, action), true, action);
  assert.deepEqual([...BASIC_KIT].sort(), ['bot.ask', 'bot.create', 'schedule.set']);
  assert.equal(canBot(bare, 'browser.use'), false, 'everything else still needs a grant');
});

test('awaiting_limit is a busy, stoppable status that a restart does not cut', () => {
  assert.ok(BUSY_STATUSES.includes('awaiting_limit'));
  assert.ok(STOPPABLE_STATUSES.includes('awaiting_limit'));
  assert.ok(!INTERRUPT_STATUSES.includes('awaiting_limit'));
});

test('tallyAsk counts a message per ask and stops at the pair, total and depth limits', () => {
  const run = {};
  for (let n = 0; n < 12; n++) assert.deepEqual(tallyAsk(run, {from: 'a', to: 'b', task: `q${n}`}), {ok: true});
  assert.deepEqual(tallyAsk(run, {from: 'a', to: 'b', task: 'q12'}), {ok: false, limit: 'pair'});
  assert.deepEqual(tallyAsk(run, {from: 'b', to: 'a', task: 'back'}), {ok: false, limit: 'pair'}, 'the pair counts both directions');
  assert.equal(run.asks.total, 12, 'a refused ask is not counted');
  assert.equal(tallyAsk(run, {from: 'a', to: 'c', task: 'other'}).ok, true, 'another pair is untouched');
  assert.deepEqual(tallyAsk({}, {from: 'a', to: 'b', task: 'deep', depth: 7}), {ok: false, limit: 'depth'});
  assert.equal(tallyAsk({}, {from: 'a', to: 'b', task: 'deep', depth: 6}).ok, true);
  const wide = {};
  for (let n = 0; n < 60; n++) assert.equal(tallyAsk(wide, {from: `a${n % 20}`, to: `b${n % 20}`, task: `q${n}`}).ok, true);
  assert.deepEqual(tallyAsk(wide, {from: 'x', to: 'y', task: 'one more'}), {ok: false, limit: 'total'});
});

test('a repeat is a loop only when the answer did not change', () => {
  const run = {};
  const same = {from: 'a', to: 'b', task: 'Is it  ready?'};
  assert.equal(tallyAsk(run, same).ok, true); recordAnswer(run, same, 'Not yet.');
  assert.equal(tallyAsk(run, {...same, task: 'is it ready?'}).ok, true, 'case and spacing do not make a new question'); recordAnswer(run, same, 'Not yet.');
  assert.deepEqual(tallyAsk(run, same), {ok: false, limit: 'loop'});
  const moving = {};
  for (const answer of ['No.', 'Maybe.', 'Yes.', 'Done.']) { assert.equal(tallyAsk(moving, same).ok, true); recordAnswer(moving, same, answer); }
});

test('extendLimits measures the next round from where this one stopped', () => {
  const run = {};
  for (let n = 0; n < 12; n++) tallyAsk(run, {from: 'a', to: 'b', task: `q${n}`});
  assert.equal(tallyAsk(run, {from: 'a', to: 'b', task: 'q12'}).limit, 'pair');
  extendLimits(run, 'pair');
  for (let n = 12; n < 24; n++) assert.equal(tallyAsk(run, {from: 'a', to: 'b', task: `q${n}`}).ok, true);
  assert.equal(tallyAsk(run, {from: 'a', to: 'b', task: 'q24'}).limit, 'pair', 'another round of the same size, no more');
  const unlimited = {unlimitedAsks: true};
  for (let n = 0; n < 100; n++) assert.equal(tallyAsk(unlimited, {from: 'a', to: 'b', task: `q${n}`}).ok, true);
});

test('a bot asks a bot on another team without any permission', async t => {
  const {store, ids} = await company(t);
  const ai = model({
    Mailroom: (env, n) => (n === 0 ? `Let me check.\n${block('@Scholar', 'Is the clinic open on Tuesdays?')}` : 'The clinic is open on Tuesdays.'),
    Scholar: 'Yes, Tuesdays 9 to 5.',
  });
  const run = await ask(store, {message: 'Is the clinic open?', to: ids.mail, executor: ai.executor});
  const mailroom = store.read().groups[0].bots.find(b => b.id === ids.mail);
  assert.deepEqual(mailroom.permissions, [], 'Mailroom holds no permission');
  assert.equal(run.status, 'completed', run.error);
  assert.equal(ai.of('Scholar').length, 1, 'Scholar is outside Mailroom\'s team and still answers');
  assert.equal(ai.of('Scholar')[0].task, 'Is the clinic open on Tuesdays?');
  assert.equal(ai.of('Mailroom')[1].peerAnswer.output, 'Yes, Tuesdays 9 to 5.');
  assert.match(ai.of('Mailroom')[0].tools.ask, /ask/, 'the ask tool is always offered');
  assert.deepEqual(ai.of('Mailroom')[0].company.map(b => b.name).sort(), ['Atlas', 'Ops lead', 'Planner', 'Scholar', 'Scribe'], 'every bot is listed by name and job');
  assert.deepEqual(kinds(run), [`ask:${ids.mail}>${ids.scholar}`, `peer:${ids.scholar}>${ids.mail}`]);
  assert.equal(run.trace.at(-1).output, 'The clinic is open on Tuesdays.');
  assert.equal(run.trace.length, 3, 'two ask entries and the step itself');
});

test('a peer answer is not written into the asked bot\'s own chat', async t => {
  const {store, ids} = await company(t);
  const ai = model({
    Mailroom: (env, n) => (n === 0 ? block('@Scholar', 'Which clinic?') : 'Found it.'),
    Scholar: 'The Elm Street clinic.',
  });
  await ask(store, {message: 'Find it', to: ids.mail, executor: ai.executor});
  const chats = store.read().chats;
  assert.equal(chats[ids.scholar], undefined, 'Scholar\'s chat is untouched');
  assert.match(chats[ids.mail].map(m => m.text).join('\n'), /Scholar answered:\n\nThe Elm Street clinic\./);
});

test('a chain stops for the owner at 6 bots deep, and Keep going lets it reach the end', async t => {
  const {store, ids} = await company(t, {extra: {x1: {name: 'Xa', instructions: 'x'}, x2: {name: 'Xb', instructions: 'x'}, x3: {name: 'Xc', instructions: 'x'}}});
  const next = {Mailroom: 'Planner', Planner: 'Scholar', Scholar: 'Scribe', Scribe: 'Xa', Xa: 'Xb', Xb: 'Xc'};
  const script = {};
  for (const [name, to] of Object.entries(next)) script[name] = env => (env.peerAnswer ? `${name} relays: ${env.peerAnswer.output}` : block(`@${to}`, `from ${name}`));
  script.Xc = 'The end of the line.';
  const ai = model(script);
  const paused = await ask(store, {message: 'Go deep', to: ids.mail, executor: ai.executor});
  assert.equal(paused.status, 'awaiting_limit');
  assert.equal(paused.limit.kind, 'depth');
  assert.equal(ai.of('Xc').length, 0, 'the seventh bot is never woken');
  assert.equal(paused.asks.total, 5);
  assert.match(runNote(paused).text, /Bots have sent 5 messages for this task\./);
  assert.equal(runNote(paused).kind, 'limit');
  assert.equal(store.read().chats[ids.mail].some(m => m.kind === 'limit' && m.runId === paused.id), true, 'the chat carries the card');
  await resumeGroupRun(store, paused.id, ai.executor, {choice: 'more'});
  const done = store.read().groupRuns.find(r => r.id === paused.id);
  assert.equal(done.status, 'completed', done.error);
  assert.equal(done.limit, undefined, 'the checkpoint is cleared once it is answered');
  assert.equal(ai.of('Xc').length, 1);
  assert.equal(done.trace.at(-1).output, 'Mailroom relays: Planner relays: Scholar relays: Scribe relays: Xa relays: Xb relays: The end of the line.');
});

const chatty = (limitOf = 30) => model({
  Mailroom: (env, n) => (n < limitOf ? block('@Scholar', `Question ${n}`) : 'All asked.'),
  Scholar: (env, n) => `Answer ${n}`,
});

test('two bots pause after 12 messages and keep going for another 12', async t => {
  const {store, ids} = await company(t);
  const ai = chatty();
  const first = await ask(store, {message: 'Ask a lot', to: ids.mail, executor: ai.executor});
  assert.equal(first.status, 'awaiting_limit');
  assert.equal(first.limit.kind, 'pair');
  assert.equal(first.asks.total, 12);
  assert.equal(ai.of('Scholar').length, 12);
  await resumeGroupRun(store, first.id, ai.executor, {choice: 'more'});
  const second = store.read().groupRuns.find(r => r.id === first.id);
  assert.equal(second.status, 'awaiting_limit');
  assert.equal(second.asks.total, 24, 'another round of the same size');
  await resumeGroupRun(store, first.id, ai.executor, {choice: 'more'});
  const last = store.read().groupRuns.find(r => r.id === first.id);
  assert.equal(last.status, 'completed', last.error);
  assert.equal(last.asks.total, 30);
});

test('keep going, don\'t ask again lifts the checkpoints for this task only', async t => {
  const {store, ids} = await company(t);
  const ai = chatty();
  const first = await ask(store, {message: 'Ask a lot', to: ids.mail, executor: ai.executor});
  assert.equal(first.status, 'awaiting_limit');
  await resumeGroupRun(store, first.id, ai.executor, {choice: 'unlimited'});
  const done = store.read().groupRuns.find(r => r.id === first.id);
  assert.equal(done.status, 'completed', done.error);
  assert.equal(done.unlimitedAsks, true);
  assert.equal(done.asks.total, 30);
  const other = await ask(store, {message: 'Ask a lot again', to: ids.mail, executor: chatty().executor});
  assert.equal(other.status, 'awaiting_limit', 'the next task keeps its checkpoints');
  assert.equal(other.unlimitedAsks, undefined);
});

test('the same question three times with the same answer is a loop', async t => {
  const {store, ids} = await company(t);
  const ai = model({Mailroom: (env, n) => (n < 5 ? block('@Scholar', 'Is it ready?') : 'Gave up.'), Scholar: 'Not yet.'});
  const run = await ask(store, {message: 'Wait for it', to: ids.mail, executor: ai.executor});
  assert.equal(run.status, 'awaiting_limit');
  assert.equal(run.limit.kind, 'loop');
  assert.equal(run.asks.total, 2, 'the third ask is the one that stops');
  const moving = model({Mailroom: (env, n) => (n < 4 ? block('@Scholar', 'Is it ready?') : 'Ready.'), Scholar: (env, n) => `Progress ${n}`});
  const fine = await ask(store, {message: 'Wait for it', to: ids.mail, executor: moving.executor});
  assert.equal(fine.status, 'completed', 'asking again and getting new answers is progress, not a loop');
});

test('stop makes the asking bot report what it has', async t => {
  const {store, ids} = await company(t);
  const ai = chatty();
  const paused = await ask(store, {message: 'Ask a lot', to: ids.mail, executor: ai.executor});
  assert.equal(paused.status, 'awaiting_limit');
  const before = ai.of('Mailroom').length;
  await resumeGroupRun(store, paused.id, (bot, input) => {
    if (bot.name === 'Mailroom' && JSON.parse(input).restrictions.some(r => /Stop here and report what you have/.test(r))) return 'Here is what I have so far.';
    return ai.executor(bot, input);
  }, {choice: 'stop'});
  const done = store.read().groupRuns.find(r => r.id === paused.id);
  assert.equal(done.status, 'completed', done.error);
  assert.equal(ai.of('Scholar').length, 12, 'no more bots are woken');
  assert.equal(done.trace.at(-1).output, 'Here is what I have so far.');
  assert.equal(ai.of('Mailroom').length, before, 'one closing step, through the test\'s own wrapper');
  assert.equal(store.read().chats[ids.mail].filter(m => m.role === 'bot').at(-1).text, 'Here is what I have so far.');
});

test('an unknown answer is refused and a stopped run cannot be continued twice', async t => {
  const {store, ids} = await company(t);
  const ai = chatty();
  const paused = await ask(store, {message: 'Ask a lot', to: ids.mail, executor: ai.executor});
  await assert.rejects(resumeGroupRun(store, paused.id, ai.executor, {choice: 'sure'}), /Choose/);
  await assert.rejects(resumeGroupRun(store, paused.id, ai.executor, {}), /Choose/);
  assert.equal(store.read().groupRuns.find(r => r.id === paused.id).status, 'awaiting_limit');
});

test('the continue route takes a choice, and a stop through it ends the task', async t => {
  const {store, ids} = await company(t);
  const paused = await ask(store, {message: 'Ask a lot', to: ids.mail, executor: chatty().executor});
  const router = createRouter(); groupRoutes(router);
  const post = (body, run = paused.id, group = 'home') => router.find('POST', `/api/groups/${group}/runs/${run}/continue`).route.handler({store, params: {group, run}, body: async () => body, actor: {email: 'owner@example.test'}});
  await assert.rejects(post({}), error => error.status === 400 && /Choose/.test(error.message));
  await assert.rejects(post({choice: 'everything'}), error => error.status === 400);
  await assert.rejects(post({choice: 'stop'}, paused.id, 'elsewhere'), error => error.status === 404, 'a run is continued under its own group');
  const server = http.createServer((request, response) => {
    request.resume();
    request.on('end', () => { response.writeHead(200, {'content-type': 'application/json'}); response.end(JSON.stringify({choices: [{message: {content: 'Wrapped up.'}}]})); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const saved = {...process.env};
  Object.assign(process.env, {AI_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`, AI_API_KEY: 'k', AI_MODEL: 'm', AI_API_STYLE: 'chat'});
  t.after(() => { process.env = saved; return new Promise(resolve => server.close(resolve)); });
  const result = await post({choice: 'stop'});
  assert.equal(result.status, 202);
  assert.equal(result.body.status, 'completed');
  assert.equal(store.read().groupRuns.find(r => r.id === paused.id).trace.at(-1).output, 'Wrapped up.');
});

test('by default nothing pauses: a chain 7 bots deep runs to the end on its own', async t => {
  const {store, ids} = await bare(t, {extra: {x1: {name: 'Xa', instructions: 'x'}, x2: {name: 'Xb', instructions: 'x'}, x3: {name: 'Xc', instructions: 'x'}}});
  const next = {Mailroom: 'Planner', Planner: 'Scholar', Scholar: 'Scribe', Scribe: 'Xa', Xa: 'Xb', Xb: 'Xc'};
  const script = {};
  for (const [name, to] of Object.entries(next)) script[name] = env => (env.peerAnswer ? `${name} relays: ${env.peerAnswer.output}` : block(`@${to}`, `from ${name}`));
  script.Xc = 'The end of the line.';
  const run = await ask(store, {message: 'Go deep', to: ids.mail, executor: model(script).executor});
  assert.equal(run.status, 'completed');
  assert.match(store.read().chats[ids.mail].map(m => m.text).join('\n'), /The end of the line/);
});
