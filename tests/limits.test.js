/** Limits on how far bots go per message are the owner's choice. By default there are none: only a safety
 * backstop far above normal work. A run that keeps failing, or keeps asking for what it already has, stops and
 * says why. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {BACKSTOP, FAIL_STREAK, limitsOf, pagesCap, roundsCap, stepsCap, setLimits, limitWords} from '../shared/limits.js';

const state = () => ({groups: [], activity: []});

test('no limits by default: each cap is the backstop', () => {
  const s = state();
  assert.deepEqual(limitsOf(s), {pages: null, rounds: null, steps: null, askCheckpoints: false});
  assert.equal(pagesCap(s), BACKSTOP.pages);
  assert.equal(roundsCap(s), BACKSTOP.rounds);
  assert.equal(stepsCap(s), BACKSTOP.steps);
  assert.ok(BACKSTOP.pages >= 8 && BACKSTOP.rounds >= 25 && BACKSTOP.steps >= 30, 'far above normal work');
  assert.equal(FAIL_STREAK, 3);
});

test('the owner sets a limit, clears it with null, and a bad value is refused', () => {
  const s = state();
  setLimits(s, {pages: 2, rounds: 4, steps: 6, askCheckpoints: true});
  assert.deepEqual(limitsOf(s), {pages: 2, rounds: 4, steps: 6, askCheckpoints: true});
  assert.equal(pagesCap(s), 2);
  assert.match(s.activity.at(-1).text, /limits/i);
  setLimits(s, {rounds: null});
  assert.equal(roundsCap(s), BACKSTOP.rounds);
  assert.equal(limitsOf(s).pages, 2, 'fields not sent are kept');
  for (const bad of [{pages: 0}, {pages: 99}, {rounds: 1.5}, {steps: 'x'}, {askCheckpoints: 'yes'}, {nope: 1}]) assert.throws(() => setLimits(s, bad), /./, JSON.stringify(bad));
});

test('a stored value past the backstop reads as the backstop', () => {
  assert.equal(pagesCap({limits: {pages: 500}}), BACKSTOP.pages);
  assert.equal(limitsOf({limits: {pages: 'junk'}}).pages, null);
});

test('limit words for Settings', () => {
  assert.equal(limitWords(null), 'No limit');
  assert.equal(limitWords(3), '3');
});

test('a bot is told its budget for this message: pages per reply, rounds and steps used against the limits', async () => {
  const {runBudget} = await import('../shared/limits.js');
  const s = {limits: {pages: 3, rounds: 4}, browserRequests: [{runId: 'r1'}, {runId: 'r1'}, {runId: 'other'}]};
  const budget = runBudget(s, {id: 'r1', browserDepth: 2, connectorDepth: 1, currentStep: 1, maxSteps: 5});
  assert.equal(budget.pagesPerReply, 3);
  assert.deepEqual(budget.pageRounds, {used: 2, of: 4});
  assert.deepEqual(budget.connectorRounds, {used: 1, of: 4});
  assert.deepEqual(budget.steps, {used: 1, of: 5});
  assert.equal(budget.pagesOpened, 2);
  assert.match(budget.note, /plan/i);
  // The last-call marker never reads as more rounds than the limit.
  assert.equal(runBudget({}, {id: 'x', browserDepth: 1e6}).pageRounds.used, BACKSTOP.rounds);
});

test('the envelope each bot gets carries that budget', async t => {
  const {company, model, ask} = await import('./run-fixture.js');
  const {store, ids} = await company(t);
  const ai = model({Scholar: 'Done.'});
  await ask(store, {message: 'Summarise the paper', to: ids.scholar, executor: ai.executor});
  const [envelope] = ai.of('Scholar');
  assert.equal(envelope.budget.steps.used, 0);
  assert.ok(envelope.budget.steps.of >= 1);
  assert.equal(envelope.budget.pagesPerReply, BACKSTOP.pages);
});
