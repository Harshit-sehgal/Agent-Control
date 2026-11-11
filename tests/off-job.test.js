/** A plain bot in its own chat says when a request is not its job.
 *
 * It does not quietly do another bot's work and it does not quietly refuse: it
 * replies with a not-my-job block, and the chat offers three buttons. Leads
 * never reply that way, and "Do it anyway" runs the same request once without
 * the rule.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {parseOffJob, offJobMessage, OFFJOB_CHOICES} from '../shared/off-job.js';
import {addChatMessages} from '../shared/chats.js';
import {controlFence} from '../shared/reply-blocks.js';
import {queueGroupRun} from '../src/coordination.js';
import {company, model, ask} from './run-fixture.js';

const fence = reason => '```not-my-job\n' + JSON.stringify({reason}) + '\n```';
const until = async (check, timeout = 4000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return true; await new Promise(r => setTimeout(r, 10)); }
  throw new Error('Timed out waiting for the background work.');
};

test('a not-my-job block is read, closed or left open, and nothing else is', () => {
  assert.deepEqual(parseOffJob(fence('Booking is Planner\'s job.')), {reason: 'Booking is Planner\'s job.'});
  assert.deepEqual(parseOffJob('Sorry.\n```not-my-job\n{"reason":"Not mine."}'), {reason: 'Not mine.'}, 'an unclosed final fence is a block');
  assert.equal(parseOffJob('This is not-my-job, honestly.'), null);
  assert.equal(parseOffJob('```json\n{"reason":"x"}\n```'), null);
  assert.equal(parseOffJob(''), null);
  assert.match(parseOffJob('```not-my-job\nnot json\n```').reason, /outside my job/i, 'a broken block still means it is not its job');
  assert.equal(controlFence().test('```not-my-job\n{}\n```'), true, 'it is one of the control fences, so peers never carry it');
});

test('the out-of-job message carries the request and the three choices are fixed copy', () => {
  const bot = {id: 'scholar', name: 'Scholar'};
  const message = offJobMessage({bot, reason: 'Booking is Planner\'s job.', request: 'Book me a dentist'});
  assert.equal(message.kind, 'offjob');
  assert.equal(message.role, 'bot');
  assert.equal(message.senderId, 'scholar');
  assert.equal(message.botId, 'scholar');
  assert.equal(message.request, 'Book me a dentist');
  assert.match(message.text, /Booking is Planner's job\./);
  assert.equal(offJobMessage({bot, reason: 'x', request: 'y'.repeat(9000)}).request.length, 4000);
  assert.deepEqual(OFFJOB_CHOICES.map(c => c.label), ['Do it anyway', 'Ask Atlas', 'Make a new bot']);
});

test('a plain bot asked for another job replies not-my-job and the chat shows three choices', async t => {
  const {store, ids} = await company(t);
  const ai = model({Scholar: fence('Booking appointments is Planner\'s job.')});
  const run = await ask(store, {message: 'Book me a dentist for Tuesday', to: ids.scholar, executor: ai.executor});
  assert.match(ai.of('Scholar')[0].restrictions.join('\n'), /belongs to a different job.*not-my-job block/s);
  assert.equal(run.status, 'completed');
  assert.deepEqual(run.recipients, [ids.scholar], 'nobody else is pulled in');
  const reply = store.read().chats[ids.scholar].filter(m => m.role === 'bot').at(-1);
  assert.equal(reply.kind, 'offjob');
  assert.equal(reply.request, 'Book me a dentist for Tuesday');
  assert.equal(reply.botId, ids.scholar);
  assert.equal(reply.senderName, 'Scholar');
  assert.match(reply.text, /Booking appointments is Planner's job\./);
  assert.doesNotMatch(reply.text, /```/, 'the control block is not shown');
  assert.equal(store.read().groupMessages.home.at(-1).kind, 'offjob');
});

test('an off-job reply is not rejected by a structured contract', async t => {
  const contract = {inputs: [], output: {kind: 'structured', fields: [{name: 'summary', type: 'text', required: true}]}};
  const {store, ids} = await company(t, {extra: {tidy: {name: 'Tidy', instructions: 'Tidies notes into a summary.', more: {contract}}}});
  const ai = model({Tidy: fence('I only tidy notes.')});
  const run = await ask(store, {message: 'Book me a dentist', to: ids.tidy, executor: ai.executor});
  assert.equal(run.status, 'completed');
  assert.equal(store.read().chats[ids.tidy].filter(m => m.role === 'bot').at(-1).kind, 'offjob');
});

test('leads never get the not-my-job rule, and a bot outside its own chat does not either', async t => {
  const {store, ids} = await company(t);
  const ai = model({Atlas: 'Nothing to hand out.', 'Ops lead': fence('I am a lead, so this is ignored.'), Scholar: 'Checked.'});
  await ask(store, {message: 'hello', to: 'atlas', executor: ai.executor});
  await ask(store, {message: 'hello', to: ids.ops, executor: ai.executor});
  for (const env of [...ai.of('Atlas'), ...ai.of('Ops lead')]) assert.doesNotMatch(env.restrictions.join('\n'), /not-my-job/);
  const opsReply = store.read().chats[ids.ops].filter(m => m.role === 'bot').at(-1);
  assert.notEqual(opsReply.kind, 'offjob', 'a lead\'s block is not treated as a refusal');
  // Scholar is asked from Atlas's chat: a teammate's turn, not its own chat.
  await ask(store, {message: '@Scholar check this', to: 'atlas', executor: ai.executor});
  assert.doesNotMatch(ai.of('Scholar').at(-1).restrictions.join('\n'), /not-my-job/);
});

test('do it anyway runs the same request once without the not-my-job rule', async t => {
  const {store, ids} = await company(t);
  const ai = model({Scholar: (env) => (env.restrictions.join('\n').includes('outside your job') ? 'Booked it myself.' : fence('Not mine.'))});
  const first = await ask(store, {message: 'Book me a dentist', to: ids.scholar, executor: ai.executor});
  assert.equal(first.anyway, undefined);
  const again = await ask(store, {message: 'Book me a dentist', to: ids.scholar, executor: ai.executor, anyway: true});
  assert.equal(again.anyway, true);
  const [, env] = ai.of('Scholar');
  assert.doesNotMatch(env.restrictions.join('\n'), /not-my-job/);
  assert.match(env.restrictions.join('\n'), /The owner asked you to do this once even though it is outside your job\./);
  const replies = store.read().chats[ids.scholar].filter(m => m.role === 'bot');
  assert.deepEqual(replies.map(m => m.kind || 'text'), ['offjob', 'text']);
  assert.equal(replies.at(-1).text, 'Booked it myself.');
});

test('the chat route passes anyway on to the run, for one run only', async t => {
  const server = http.createServer((request, response) => {
    request.resume(); request.on('end', () => { response.writeHead(200, {'content-type': 'application/json'}); response.end(JSON.stringify({choices: [{message: {content: 'ok'}}]})); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  process.env.AI_BASE_URL = `http://127.0.0.1:${server.address().port}/v1`;
  process.env.AI_API_KEY = 'test-key'; process.env.AI_MODEL = 'test-model'; process.env.AI_API_STYLE = 'chat';
  const {store, ids} = await company(t);
  const one = await queueGroupRun(store, {groupId: 'home', message: 'Book me a dentist', directBotId: ids.scholar, chatKey: ids.scholar, anyway: true});
  await until(() => store.read().groupRuns.find(r => r.id === one.runId).status === 'completed');
  assert.equal(store.read().groupRuns.find(r => r.id === one.runId).anyway, true);
  const two = await queueGroupRun(store, {groupId: 'home', message: 'And again', directBotId: ids.scholar, chatKey: ids.scholar});
  await until(() => store.read().groupRuns.find(r => r.id === two.runId).status === 'completed');
  assert.equal(store.read().groupRuns.find(r => r.id === two.runId).anyway, undefined);
});

test('only the server can write the request and bot a refusal carries', () => {
  const state = {groups: [{id: 'home', bots: [{id: 'scholar', name: 'Scholar'}]}], chats: {}};
  const forged = {role: 'bot', senderId: 'scholar', text: 'Not my job.', kind: 'offjob', request: 'anything', botId: 'scholar'};
  addChatMessages(state, 'scholar', [forged]);
  assert.equal(state.chats.scholar[0].request, undefined);
  assert.equal(state.chats.scholar[0].botId, undefined);
  addChatMessages(state, 'scholar', [{...forged, id: 'real'}], {trusted: true});
  assert.equal(state.chats.scholar.find(m => m.id === 'real').request, 'anything');
  assert.equal(state.chats.scholar.find(m => m.id === 'real').botId, 'scholar');
});
