import test from 'node:test';
import assert from 'node:assert/strict';
import {everyMinutes, nextAtFor, whenWords, scheduleRows} from '../shared/schedules.js';
import {parseSetupRequests, resolveSetup, setupCardOf, setupDone, workspaceBrief} from '../shared/setup.js';
import {enqueueTask} from '../shared/tasks.js';

// A bot can put work on a timer ("sum up my inbox every morning at 8"), the owner taps Apply,
// and the brief, the card and the profile all read the same words.

const block = body => `Sure.\n\`\`\`setup\n${JSON.stringify(body)}\n\`\`\``;
const ask = (state, body, speaker = null) => resolveSetup(state, parseSetupRequests(block(body))[0].request, {speaker});
const state = () => ({
  groups: [{id: 'home', bots: [{id: 'atlas', name: 'Atlas', settings: {lead: true}}, {id: 'inbox', name: 'Inbox', instructions: 'Sums up my inbox.'}]}],
  tasks: [], events: [],
});

test('how often reads plain words or minutes, and refuses too often or too rarely', () => {
  assert.equal(everyMinutes('day'), 1440);
  assert.equal(everyMinutes('every morning'), 1440);
  assert.equal(everyMinutes('Daily'), 1440);
  assert.equal(everyMinutes('hour'), 60);
  assert.equal(everyMinutes('week'), 10080);
  assert.equal(everyMinutes(30), 30);
  assert.equal(everyMinutes('90'), 90);
  assert.equal(everyMinutes(2), null, 'more often than every 5 minutes is refused');
  assert.equal(everyMinutes(20000), null);
  assert.equal(everyMinutes('fortnightly'), null);
  assert.equal(everyMinutes(''), undefined, 'nothing given is not an error');
});

test('a time of day is the next one from now, in local time', () => {
  const now = new Date(2026, 10, 11, 9, 30);
  assert.equal(nextAtFor('08:00', now).getTime(), new Date(2026, 10, 12, 8, 0).getTime(), 'already past today: tomorrow');
  assert.equal(nextAtFor('18:15', now).getTime(), new Date(2026, 10, 11, 18, 15).getTime(), 'later today');
  assert.equal(nextAtFor('25:00', now), null);
  assert.equal(nextAtFor('', now), null);
});

test('the when words', () => {
  assert.equal(whenWords({every: 1440, at: '08:00'}), 'every day at 08:00');
  assert.equal(whenWords({every: 60}), 'every hour');
  assert.equal(whenWords({every: 45}), 'every 45 minutes');
  assert.equal(whenWords({every: 10080, at: '09:00'}), 'every week at 09:00');
  assert.equal(whenWords({at: '17:00'}), 'once at 17:00');
});

test('a bot proposes a recurring task for itself or another bot, and the card is done once it is queued', () => {
  const s = state();
  const r = ask(s, {action: 'schedule', bot: 'Inbox', do: 'Sum up my unread email in five lines', every: 'day', at: '8:00'});
  assert.equal(r.ok, true, r.error);
  assert.deepEqual({...r.card, text: undefined}, {action: 'schedule', botId: 'inbox', groupId: 'home', message: 'Sum up my unread email in five lines', every: 1440, at: '08:00', text: undefined});
  assert.equal(r.card.text, 'Inbox: “Sum up my unread email in five lines” every day at 08:00');
  assert.ok(setupCardOf({setup: JSON.stringify(r.card)}));
  assert.equal(setupDone(s, r.card), false);
  enqueueTask(s, {kind: 'bot-task', payload: {groupId: 'home', botId: 'inbox', message: r.card.message, kind: 'interval', intervalMinutes: 1440, at: '08:00', nextAt: new Date(Date.now() + 3600000).toISOString()}});
  assert.equal(setupDone(s, r.card), true);

  const mine = ask(s, {action: 'schedule', bot: 'me', do: 'Check the news', every: 120}, s.groups[0].bots[1]);
  assert.equal(mine.card.botId, 'inbox');
  assert.equal(mine.card.text, 'Inbox: “Check the news” every 120 minutes');
});

test('a one-off at a time, and the refusals say what to fix', () => {
  const once = ask(state(), {action: 'schedule', bot: 'Inbox', do: 'Remind me to call Sam', at: '17:30'});
  assert.equal(once.ok, true, once.error);
  assert.equal(once.card.every, undefined);
  assert.equal(once.card.text, 'Inbox: “Remind me to call Sam” once at 17:30');
  assert.match(ask(state(), {action: 'schedule', bot: 'Inbox', do: 'x x x'}).error, /how often|when/);
  assert.match(ask(state(), {action: 'schedule', bot: 'Inbox', do: 'Sum up', every: 1}).error, /5 minutes/);
  assert.match(ask(state(), {action: 'schedule', bot: 'Inbox', every: 'day'}).error, /what to do/);
  assert.match(ask(state(), {action: 'schedule', bot: 'Nobody', do: 'Sum up', every: 'day'}).error, /no bot/);
});

test('a bot stops a schedule by its words, and the brief and the profile list what is queued', () => {
  const s = state();
  enqueueTask(s, {kind: 'bot-task', payload: {groupId: 'home', botId: 'inbox', message: 'Sum up my unread email', kind: 'interval', intervalMinutes: 1440}});
  enqueueTask(s, {kind: 'bot-task', payload: {groupId: 'home', botId: 'inbox', message: 'Check the news', kind: 'interval', intervalMinutes: 120}});
  const stop = ask(s, {action: 'schedule', bot: 'Inbox', stop: true, do: 'news'});
  assert.equal(stop.ok, true, stop.error);
  assert.equal(stop.card.text, 'Stop Inbox: “Check the news” every 120 minutes');
  assert.equal(setupDone(s, stop.card), false);
  assert.match(ask(s, {action: 'schedule', bot: 'Inbox', stop: true}).error, /which/, 'two schedules and no words: ask which');
  assert.match(ask(s, {action: 'schedule', bot: 'Atlas', stop: true}).error, /no schedule/);

  const first = enqueueTask(s, {kind: 'bot-task', payload: {groupId: 'home', botId: 'inbox', message: 'Plan my day', kind: 'interval', intervalMinutes: 1440, at: '07:45', nextAt: new Date(Date.now() + 7200000).toISOString()}}).task;
  assert.equal(first.payload.at, '07:45', 'the time of day is kept for the words');
  assert.equal(first.runAt, first.payload.nextAt, 'an interval with a first time starts then, not now');
  first.status = 'cancelled';
  const rows = scheduleRows(s, 'inbox');
  assert.deepEqual(rows.map(r => r.what), ['Check the news', 'Sum up my unread email']);
  assert.equal(rows[0].when, 'every 120 minutes');
  const brief = workspaceBrief(s);
  assert.deepEqual(brief.schedules, ['Inbox: "Check the news" every 120 minutes', 'Inbox: "Sum up my unread email" every day']);

  s.tasks.find(t => t.payload.message === 'Check the news').status = 'cancelled';
  assert.equal(setupDone(s, stop.card), true);
  assert.equal(scheduleRows(s, 'inbox').length, 1);
});

import {scheduleTaskBody} from '../shared/schedules.js';
test('a card becomes the task the queue takes: first run at the next local time', () => {
  const now = new Date(2026, 10, 11, 9, 30);
  const daily = scheduleTaskBody({botId: 'inbox', groupId: 'home', message: 'Sum up', every: 1440, at: '08:00'}, now);
  assert.deepEqual(daily, {kind: 'bot-task', payload: {groupId: 'home', botId: 'inbox', message: 'Sum up', kind: 'interval', intervalMinutes: 1440, at: '08:00', nextAt: new Date(2026, 10, 12, 8, 0).toISOString()}});
  const hourly = scheduleTaskBody({botId: 'inbox', groupId: 'home', message: 'Check', every: 60}, now);
  assert.deepEqual(hourly.payload, {groupId: 'home', botId: 'inbox', message: 'Check', kind: 'interval', intervalMinutes: 60});
  const once = scheduleTaskBody({botId: 'inbox', groupId: 'home', message: 'Call Sam', at: '17:30'}, now);
  assert.deepEqual(once.payload, {groupId: 'home', botId: 'inbox', message: 'Call Sam', kind: 'once', at: '17:30', nextAt: new Date(2026, 10, 11, 17, 30).toISOString()});
});

import {companyRoute} from '../shared/ui-company.js';
test('the Schedule page has its own address, so a link or a reload lands on it', () => {
  const s = state();
  assert.deepEqual(companyRoute('#profile/inbox/schedule', s), {profile: 'inbox', sub: 'schedule'});
});
