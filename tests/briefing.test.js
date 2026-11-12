import test from 'node:test';
import assert from 'node:assert/strict';
import {briefingFacts, briefingContext, briefingMessage, briefingTaskBody, briefingSchedule, BRIEFING_KEY, BRIEFING_MESSAGE} from '../shared/briefing.js';
import {enqueueTask} from '../shared/tasks.js';

// The daily briefing is an ordinary schedule on the primary bot. What it may say comes from the
// workspace at the moment it runs, so the bot reports real work and never makes any up.

const NOW = new Date('2026-11-12T08:00:00.000Z');
const hoursAgo = h => new Date(NOW.getTime() - h * 3600000).toISOString();
const state = () => ({
  groups: [
    {id: 'home', name: 'Company', bots: [{id: 'atlas', name: 'Atlas', settings: {lead: true}}, {id: 'scout', name: 'Scout'}]},
    {id: 't1', name: 'Plan the launch', settings: {kind: 'thread'}, bots: []},
  ],
  groupRuns: [
    {id: 'r1', groupId: 'home', chatKey: 'scout', input: 'Find three venues', status: 'completed', completedAt: hoursAgo(5)},
    {id: 'r2', groupId: 't1', chatKey: 'team-t1', input: 'Draft the launch post', status: 'completed', completedAt: hoursAgo(30)},
    {id: 'r3', groupId: 'home', chatKey: 'atlas', input: 'Check the stock price', status: 'failed', error: 'The model timed out.', completedAt: hoursAgo(2)},
    {id: 'r4', groupId: 't1', chatKey: 'team-t1', input: 'Book the hall', status: 'awaiting_plan', createdAt: hoursAgo(1)},
  ],
  asks: [
    {id: 'k1', botId: 'scout', action: 'send', detail: 'send the venue list to sam@example.org', status: 'pending', createdAt: hoursAgo(3)},
    {id: 'k2', botId: 'scout', action: 'post', detail: 'post it', status: 'declined', createdAt: hoursAgo(3)},
  ],
  tasks: [
    {id: 'q1', kind: 'bot-task', status: 'queued', runAt: hoursAgo(-4), payload: {botId: 'scout', groupId: 'home', message: 'Sum up the news', kind: 'interval', intervalMinutes: 1440, at: '12:00'}},
    {id: 'q2', kind: 'bot-task', status: 'cancelled', lastError: 'No model.', updatedAt: hoursAgo(6), payload: {botId: 'scout', groupId: 'home', message: 'Watch the page', kind: 'interval', intervalMinutes: 60}},
  ],
  events: [],
});

test('the facts are what the workspace holds: done in the last day, failed, waiting on the owner, coming up', () => {
  const facts = briefingFacts(state(), NOW);
  assert.deepEqual(facts.done, ['Scout: Find three venues']);
  assert.deepEqual(facts.failed, ['Atlas: Check the stock price (The model timed out.)', 'Scout: schedule "Watch the page" stopped (No model.)']);
  assert.deepEqual(facts.waiting, ['Scout wants to send the venue list to sam@example.org.', 'Plan the launch: a plan waits for your Start ("Book the hall")']);
  assert.equal(facts.upcoming.length, 1);
  assert.match(facts.upcoming[0], /^Scout: Sum up the news, every day at 12:00/);
});

test('an empty workspace says nothing happened instead of leaving room to invent', () => {
  const text = briefingContext({groups: state().groups, tasks: [], groupRuns: [], asks: []}, NOW);
  assert.match(text, /Done in the last 24 hours: none/);
  assert.match(text, /Waiting on the owner: none/);
  assert.match(text, /Coming up: none/);
  assert.match(text, /Failed: none/);
});

test('the run message is the instruction plus the facts, and stays inside a run message', () => {
  const s = state();
  s.groupRuns.push(...Array.from({length: 80}, (_, i) => ({id: `x${i}`, groupId: 'home', chatKey: 'scout', input: `Task ${i} ${'x'.repeat(200)}`, status: 'completed', completedAt: hoursAgo(1)})));
  const text = briefingMessage(BRIEFING_MESSAGE, s, NOW);
  assert.ok(text.startsWith(BRIEFING_MESSAGE));
  assert.match(text, /Use only these facts/);
  assert.match(text, /and \d+ more/);
  assert.ok(text.length <= 4000);
});

test('the briefing does not report its own earlier runs as work done', () => {
  const s = state();
  s.tasks.push({id: 'brief', kind: 'bot-task', status: 'queued', payload: {botId: 'atlas', groupId: 'home', message: BRIEFING_MESSAGE, brief: 'daily', kind: 'interval', intervalMinutes: 1440}});
  s.groupRuns.push({id: 'r9', groupId: 'home', chatKey: 'atlas', input: 'briefing', scheduleId: 'brief', status: 'completed', completedAt: hoursAgo(1)});
  assert.deepEqual(briefingFacts(s, NOW).done, ['Scout: Find three venues']);
  assert.ok(!briefingFacts(s, NOW).upcoming.some(line => line.includes('briefing')));
});

test('one tap makes a daily schedule for the primary bot at the chosen time, once per workspace', () => {
  const s = state();
  const body = briefingTaskBody(s, {at: '07:30'}, NOW);
  assert.equal(body.kind, 'bot-task');
  assert.equal(body.idempotencyKey, BRIEFING_KEY);
  assert.deepEqual({botId: body.payload.botId, groupId: body.payload.groupId, every: body.payload.intervalMinutes, at: body.payload.at, brief: body.payload.brief, label: body.payload.label},
    {botId: 'atlas', groupId: 'home', every: 1440, at: '07:30', brief: 'daily', label: 'Daily briefing'});
  const {task} = enqueueTask(s, body);
  assert.equal(task.payload.brief, 'daily', 'the queue keeps the briefing mark');
  assert.equal(briefingSchedule(s)?.id, task.id);
  assert.equal(enqueueTask(s, briefingTaskBody(s, {at: '09:00'}, NOW)).duplicate, true);
  assert.throws(() => briefingTaskBody(s, {at: 'soon'}, NOW), /time/);
});

test('the queue drops a briefing mark it does not know', () => {
  const s = state();
  const {task} = enqueueTask(s, {kind: 'bot-task', payload: {groupId: 'home', botId: 'atlas', message: 'hi', kind: 'interval', intervalMinutes: 60, brief: 'anything'}});
  assert.equal(task.payload.brief, undefined);
});
