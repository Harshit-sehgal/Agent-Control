// Found by the real-model sweep: asked to save a task template, Atlas offered a company note; asked for its token
// use, it said it could not see it; asked for a daily briefing, it proposed a plain schedule that never gets the
// briefing's facts. A bot can now propose a template, a safety preset and the real briefing as setup cards, and its
// workspace brief carries the templates, the preset, the briefing, the fallback model and this month's tokens.
import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveSetup, setupCardOf, setupDone, workspaceBrief, SETUP_TOOL_HINT} from '../shared/setup.js';
import {BRIEFING_KEY} from '../shared/briefing.js';

const month = new Date().toISOString().slice(0, 7);
const state = () => ({
  groups: [{id: 'home', bots: [{id: 'atlas', name: 'Atlas', instructions: 'Runs things.', settings: {lead: true}}, {id: 'scout', name: 'Scout', instructions: 'Finds jobs.'}]}],
  ai: {providers: [{id: 'p1', label: 'My Claude', kind: 'local-cli', engine: 'claude'}], defaultProviderId: 'p1', fallback: {providerId: 'p1', model: 'haiku'}},
  templates: [{id: 't1', title: 'HN digest', text: 'Summarise the top 5 Hacker News stories', createdAt: '2026-11-01T00:00:00Z'}],
  usage: {days: {[`${month}-02`]: {atlas: {input: 1200, output: 300, calls: 2}, scout: {input: 500, output: 100, calls: 1}}}},
  tasks: [], grants: [],
});
const card = (s, request) => { const r = resolveSetup(s, request); assert.equal(r.ok, true, r.error); return r.card; };

test('the setup hint teaches the template, preset and briefing actions', () => {
  for (const action of ['template', 'preset', 'briefing']) assert.match(SETUP_TOOL_HINT, new RegExp(`"action":"${action}"`));
});

test('a template card saves a titled message, and a remove card names the saved one', () => {
  const s = state();
  const add = card(s, {action: 'template', title: 'Weekly AI news', text: 'Give me the five biggest AI stories of the week, with links.'});
  assert.equal(setupCardOf({setup: add})?.action, 'template');
  assert.match(add.text, /Weekly AI news/);
  assert.equal(setupDone(s, add), false);
  s.templates.push({id: 't2', title: 'Weekly AI news', text: add.templateText});
  assert.equal(setupDone(s, add), true);
  const del = card(s, {action: 'template', remove: 'hn digest'});
  assert.equal(del.templateId, 't1');
  assert.equal(resolveSetup(s, {action: 'template', remove: 'nothing like it'}).ok, false);
  assert.equal(resolveSetup(s, {action: 'template', text: ''}).ok, false);
});

test('a preset card names the preset, and Hands-off says payments still ask', () => {
  const s = state();
  const hands = card(s, {action: 'preset', preset: 'hands-off'});
  assert.equal(hands.preset, 'handsOff');
  assert.match(hands.text, /Payments and deletes still ask/i);
  assert.equal(setupDone(s, card(s, {action: 'preset', preset: 'balanced'})), true, 'balanced is already on');
  assert.equal(resolveSetup(s, {action: 'preset', preset: 'yolo'}).ok, false);
  assert.ok(setupCardOf({setup: hands}));
});

test('a briefing card turns on the real briefing at a time, and one more turns it off', () => {
  const s = state();
  const on = card(s, {action: 'briefing', at: '7:30'});
  assert.equal(on.at, '07:30');
  assert.equal(setupDone(s, on), false);
  s.tasks.push({id: 'b1', kind: 'bot-task', status: 'queued', idempotencyKey: BRIEFING_KEY, payload: {botId: 'atlas', groupId: 'home', message: 'Daily briefing', brief: 'daily', kind: 'interval', intervalMinutes: 1440, at: '07:30'}});
  assert.equal(setupDone(s, on), true);
  const off = card(s, {action: 'briefing', stop: true});
  assert.equal(off.taskId, 'b1');
  assert.equal(resolveSetup(s, {action: 'briefing', at: 'soon'}).ok, false);
});

test('the brief tells a bot its templates, preset, briefing, fallback and this month\'s tokens', () => {
  const brief = workspaceBrief(state());
  assert.deepEqual(brief.templates, ['HN digest: Summarise the top 5 Hacker News stories']);
  assert.equal(brief.preset, 'Balanced');
  assert.match(brief.briefing, /off/);
  assert.match(brief.fallbackModel, /My Claude · haiku/);
  assert.match(brief.usageThisMonth.total, /2\.1k tokens/);
  assert.deepEqual(brief.usageThisMonth.byBot.map(r => r.split(':')[0]), ['Atlas', 'Scout']);
});

test('the new cards have their own button words', async () => {
  const {setupButton} = await import('../shared/setup.js');
  const s = state();
  assert.equal(setupButton(card(s, {action: 'template', title: 'X', text: 'Do x.'})), 'Save template');
  assert.equal(setupButton(card(s, {action: 'template', remove: 'hn digest'})), 'Delete');
  assert.equal(setupButton(card(s, {action: 'preset', preset: 'careful'})), 'Switch');
  assert.equal(setupButton(card(s, {action: 'briefing', at: '08:00'})), 'Turn on');
});

test('the brief also tells a bot what was used today (UTC), so "how many tokens today" has an answer', () => {
  const s = state();
  const today = new Date().toISOString().slice(0, 10);
  s.usage.days[today] = {atlas: {input: 900, output: 100, calls: 3}};
  const brief = workspaceBrief(s);
  assert.match(brief.usageThisMonth.today, /1\.0k tokens in 3 model calls/);
  assert.match(brief.usageThisMonth.today, /UTC/);
  assert.match(workspaceBrief(state()).usageThisMonth.today, /nothing/);
});

test('a template card with "remove": false saves the template (seen from haiku)', () => {
  const add = card(state(), {action: 'template', title: 'Top 5 HN', text: 'Summarise the top 5 Hacker News stories', remove: false});
  assert.equal(add.remove, undefined);
  assert.equal(add.templateText, 'Summarise the top 5 Hacker News stories');
});

test('a briefing card moves a briefing that is already on to a new time, in one tap (seen from haiku)', async () => {
  const {setupButton} = await import('../shared/setup.js');
  const s = state();
  s.tasks.push({id: 'b1', kind: 'bot-task', status: 'queued', idempotencyKey: BRIEFING_KEY, payload: {botId: 'atlas', groupId: 'home', message: 'Daily briefing', brief: 'daily', kind: 'interval', intervalMinutes: 1440, at: '19:36'}});
  const move = card(s, {action: 'briefing', at: '8:00'});
  assert.equal(move.replaces, 'b1');
  assert.equal(move.at, '08:00');
  assert.match(move.text, /Move the daily briefing to 08:00/);
  assert.equal(setupButton(move), 'Move');
  assert.ok(setupCardOf({setup: move}));
  assert.equal(setupDone(s, move), false, 'still at 19:36');
  assert.equal(resolveSetup(s, {action: 'briefing', at: '19:36'}).ok, false, 'already at that time');
});

test('a template card shows the title the saved template will carry', () => {
  const c = card(state(), {action: 'template', text: 'Summarise the top 5 Hacker News stories'});
  const long = card(state(), {action: 'template', text: 'Every Monday, list the five biggest AI research papers of last week with links'});
  assert.ok(long.title.length <= 41 && long.title.endsWith('…'), long.title);
  assert.match(c.text, new RegExp(`“${c.title}”`));
});
