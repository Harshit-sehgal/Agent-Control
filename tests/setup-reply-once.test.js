// Found by the real-model sweep: "I'll propose an Always allow rule…" with a setup block made a card, and then the
// "you said what you would do but sent no block" nudge ran the same bot again, so the owner read the reply twice.
// A reply that made a setup card did what it said; it ends the turn. A teammate's long answer reaches the lead whole.
import test from 'node:test';
import assert from 'node:assert/strict';
import {company, model, ask} from './run-fixture.js';
import {teamReplies} from '../shared/coordination.js';

const fence = '```';

test('a reply that proposes a setup card is said once', async t => {
  const {store} = await company(t);
  const m = model({Atlas: `I'll propose pausing all bots. Tap Apply on the card.\n${fence}setup\n{"action":"pause"}\n${fence}`});
  const run = await ask(store, {message: 'Pause all bots until I say so.', executor: m.executor});
  assert.equal(run.status, 'completed');
  assert.equal(m.of('Atlas').length, 1, 'the bot is not run again after its card');
  const said = (store.read().groupMessages.home || []).filter(x => x.runId === run.id && x.role === 'bot');
  assert.equal(said.length, 1);
});

test('a promise with no block and no card is still nudged once', async t => {
  const {store} = await company(t);
  const m = model({Atlas: (env, n) => n === 0 ? "I'll open the booking page now." : 'Here is what I found.'});
  const run = await ask(store, {message: 'Book a table.', executor: m.executor});
  assert.equal(run.status, 'queued', 'the same bot takes the step again');
  assert.equal(run.promiseNudged, true);
});

test('the lead sees a teammate answer of 1,500 characters whole', () => {
  const long = `${'milk, eggs, bread. '.repeat(75)}END`;
  const run = {trace: [{botId: 'lead', output: 'go'}, {botId: 'g', output: long}]};
  const text = teamReplies(run, 'lead', [{id: 'g', name: 'Grocery List'}]);
  assert.match(text, /END$/);
});
