/** A bot answers what it can in one good reply itself, and goes top-down only when the work needs another
 * bot's job: a lead does not hand out a greeting or a quick fact, and a plain bot does not refuse "thanks"
 * or "what can you do?" with a not-my-job card. The model is scripted and the loop is the real one. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {basicAsk} from '../shared/off-job.js';
import {company, model, ask} from './run-fixture.js';

test('small talk, thanks and questions about the bot itself are basic asks; real work is not', () => {
  for (const text of ['hi', 'Hello there!', 'thanks', 'Thank you so much', 'ok', 'got it 👍', 'what can you do?', 'Who are you', 'what is your job?', 'how do you work?', 'good morning'])
    assert.equal(basicAsk(text), true, text);
  for (const text of ['Book me a dentist for Tuesday', 'draft a reply to Sam', 'hi, can you research the best laptops under 1000 and compare them', 'thanks, now email Pat the plan', ''])
    assert.equal(basicAsk(text), false, text);
});

test('a lead is told to answer quick things itself and hand off only what needs a teammate', async t => {
  const {store, ids} = await company(t);
  const ai = model({Atlas: 'Paris is the capital of France.'});
  const run = await ask(store, {message: 'what is the capital of France?', to: 'atlas', executor: ai.executor});
  const rules = ai.of('Atlas')[0].restrictions.join('\n');
  assert.match(rules, /Answer yourself when one good reply/);
  assert.match(rules, /only when the work needs their job/);
  assert.deepEqual(run.recipients, [ids.atlas], 'a direct answer pulls nobody in and has no closing step');
  assert.equal(run.status, 'completed');
});

test('a plain bot answers basics itself: "thanks" carries no not-my-job rule', async t => {
  const {store, ids} = await company(t);
  const ai = model({Scholar: 'You are welcome.'});
  await ask(store, {message: 'thanks!', to: ids.scholar, executor: ai.executor});
  assert.doesNotMatch(ai.of('Scholar')[0].restrictions.join('\n'), /not-my-job block/);
});

test('real work for another job still gets the not-my-job rule, which now says what to answer anyway', async t => {
  const {store, ids} = await company(t);
  const ai = model({Scholar: 'ok'});
  await ask(store, {message: 'Book me a dentist for Tuesday', to: ids.scholar, executor: ai.executor});
  const rules = ai.of('Scholar')[0].restrictions.join('\n');
  assert.match(rules, /not-my-job block/);
  assert.match(rules, /quick and general/);
});

import {offlineReply} from '../shared/offline-bots.js';
test('the built-in replies answer basics too, and a plain bot says what it does', () => {
  const bot = {id: 's', name: 'Scholar', instructions: 'Finds and summarises research papers.'};
  assert.doesNotMatch(offlineReply({bot, request: 'what can you do?', own: true}), /not-my-job/);
  assert.match(offlineReply({bot, request: 'what can you do?', own: true}), /Finds and summarises research papers/);
  assert.doesNotMatch(offlineReply({bot, request: 'ok', own: true}), /not-my-job/);
  assert.match(offlineReply({bot, request: 'Book me a dentist', own: true}), /not-my-job/, 'real work for another job still says so');
});
