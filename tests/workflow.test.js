import test from 'node:test';
import assert from 'node:assert/strict';
import {migrate,updateRetention,addGroup,addBot,updateBot,updateGroup,removeBot,removeGroup,SCHEMA_VERSION} from '../shared/workflow.js';
import {enqueueTask, completeTask, failTask} from '../shared/tasks.js';
import {initialState} from '../shared/core.js';

const store = () => migrate(initialState());

test('migrate is idempotent and fills legacy state fields', () => {
  const legacy = {version: 1};
  const once = migrate(legacy);
  assert.equal(once.version, SCHEMA_VERSION);
  for (const key of ['runs','tasks','events','groups','groupRuns']) assert.ok(Array.isArray(once[key]), key);
  assert.deepEqual(once.groupMessages, {});
  const twice = migrate(once);
  assert.equal(twice.version, SCHEMA_VERSION);
  assert.deepEqual(twice, once);
  assert.throws(() => migrate(null), /Invalid stored state/);
});

test('migrate leaves an old workspace\'s settings alone and invents none of the X ones', () => {
  // The X settings (topics, style, opinions, delay window) are gone, so a legacy
  // state carrying an empty or partial settings object must not gain them back.
  assert.deepEqual(migrate({version: 1, settings: {}}).settings, {});
  assert.deepEqual(migrate({version: 1}).settings, {});
  const kept = migrate({version: 1, settings: {retention: {events: 30}}}).settings;
  assert.deepEqual(kept, {retention: {events: 30}}, 'a stored value is never overwritten');
  const once = migrate({version: 1, settings: {}});
  assert.deepEqual(migrate(once), once);
});

test('migrate does not add the X-engage lead or any candidate, draft or schedule collection', () => {
  const s = migrate({version: 1});
  assert.deepEqual(s.groups, [], 'no group is seeded into a state that had none');
  for (const key of ['candidates', 'drafts', 'evidence', 'schedules']) assert.equal(s[key], undefined, key);
});

test('settings are only the retention policy, and it is validated', () => {
  const s = store();
  assert.throws(() => updateRetention(s, {events: -1}), /Retention for events must be 0/);
  assert.throws(() => updateRetention(s, {events: 99999}), /0–1825 days/);
  assert.equal(s.settings.retention, undefined, 'a refused policy changes nothing');
  const result = updateRetention(s, {events: 30});
  assert.equal(result, s);
  assert.equal(s.settings.retention.events, 30);
  assert.match(s.events[0].message, /retention policy/);
  // A null policy is the defaults, not a stored null that breaks every later prune.
  updateRetention(s, null);
  assert.equal(typeof s.settings.retention, 'object');
  assert.ok(s.settings.retention);
});

test('migrate() cancels queued reminder and candidate-draft tasks that no handler can run', () => {
  const s = store();
  const future = new Date(Date.now() + 60000).toISOString();
  s.tasks = [
    {id: 't1', kind: 'reminder', status: 'queued', runAt: future, payload: {label: 'Old reminder'}},
    {id: 't2', kind: 'candidate-draft', status: 'running', runAt: future, payload: {}},
    {id: 't3', kind: 'reminder', status: 'done', runAt: future, payload: {}},
    {id: 't4', kind: 'bot-task', status: 'queued', runAt: future, payload: {groupId: 'home', botId: 'atlas', message: 'hi'}},
  ];
  migrate(s);
  const byId = id => s.tasks.find(t => t.id === id);
  assert.equal(byId('t1').status, 'cancelled');
  assert.equal(byId('t2').status, 'cancelled');
  assert.match(byId('t1').lastError, /removed/);
  assert.equal(byId('t3').status, 'done', 'a finished task keeps its outcome');
  assert.equal(byId('t4').status, 'queued', 'a task kind that still exists is untouched');
  const again = structuredClone(s.tasks);
  migrate(s);
  assert.deepEqual(s.tasks, again, 'idempotent');
});

test('groups and bots validate and persist', () => {
  const s = store();
  assert.throws(() => addGroup(s, {name: '  '}), /Group name required/);
  const g = addGroup(s, {name: 'Insights', description: 'Research'});
  assert.throws(() => addBot(s, 'missing', {name: 'x', instructions: 'y'}), /Group not found/);
  const b = addBot(s, g.id, {name: 'Summarizer', instructions: 'Summarize input'});
  assert.equal(g.bots[0].id, b.id);
  assert.ok(s.groups.some(x => x.id === g.id));
});

test('an old workspace keeps its X-engage group as an ordinary group it can delete', () => {
  const s = migrate({
    version: 1,
    groups: [{id: 'x-engage', name: 'X engage', description: 'Old', bots: [
      {id: 'scout', name: 'Scout', instructions: 'Find posts worth a look.', type: 'custom'},
      {id: 'writer', name: 'Writer', instructions: 'Draft replies in the voice.', type: 'custom'},
    ]}],
  });
  assert.ok(s.groups.some(g => g.id === 'x-engage'), 'migrate keeps the group');
  assert.ok(!s.groups.some(g => g.id === 'home'), 'and does not seed another one');
  assert.deepEqual(removeGroup(s, 'x-engage'), {ok: true});
  assert.equal(s.groups.length, 0);
  assert.throws(() => removeGroup(s, 'x-engage'), {status: 404});
});

test('bot profile edits persist through the shared workflow rules', () => {
  const s = store();
  const g = s.groups[0];
  const bot = g.bots.find(b => b.id === 'atlas');
  const updated = updateBot(s, g.id, bot.id, {name: 'Senior Atlas', instructions: 'Answer concisely in the user voice.'});
  assert.equal(updated.name, 'Senior Atlas');
  assert.equal(g.bots.find(b => b.id === 'atlas').name, 'Senior Atlas');
  assert.match(s.events[0].message, /Updated bot Senior Atlas/);
  assert.throws(() => updateBot(s, g.id, 'missing', {name: 'x', instructions: 'y'}), /Bot not found/);
  assert.throws(() => updateBot(s, 'missing', bot.id, {name: 'x', instructions: 'y'}), /Group not found/);
  assert.throws(() => updateBot(s, g.id, bot.id, {name: '  ', instructions: 'y'}), /required/);
});

test('a rename cannot duplicate a name another bot already has', () => {
  // addBot and a model-created bot both refuse a duplicate. A rename was the way
  // in, and findPeer/mentionedBots resolve a name to whichever bot comes first,
  // so a handoff naming the duplicate reached the wrong teammate.
  const s = store();
  const g = s.groups[0];
  const reviewer = addBot(s, g.id, {name: 'Reviewer', instructions: 'Review what the others wrote.'});
  assert.throws(() => updateBot(s, g.id, reviewer.id, {name: 'Atlas'}), error => error.status === 409 && /already in this group/.test(error.message));
  assert.equal(g.bots.find(b => b.id === reviewer.id).name, 'Reviewer', 'A refused rename changes nothing.');
  // Case and padding do not make a different name.
  assert.throws(() => updateBot(s, g.id, reviewer.id, {name: ' atlas '}), {status: 409});
  // Renaming itself, or to a name nobody uses, still works.
  assert.equal(updateBot(s, g.id, reviewer.id, {name: 'Senior Reviewer'}).name, 'Senior Reviewer');
  assert.equal(updateBot(s, g.id, reviewer.id, {name: 'Senior Reviewer', instructions: 'Review deeply.'}).name, 'Senior Reviewer');
});

test('removing the last bot of a pipeline is refused instead of switching to every bot', () => {
  // An empty pipeline reads as "every bot", so dropping the pipeline's last bot
  // used to start bots the person never picked.
  const s = store();
  const g = addGroup(s, {name: 'Pipeline group', description: 'Ordered'});
  const one = addBot(s, g.id, {name: 'First', instructions: 'Do the first step well.'});
  const two = addBot(s, g.id, {name: 'Second', instructions: 'Do the second step well.'});
  updateGroup(s, g.id, {settings: {pipeline: [one.id]}});
  assert.throws(() => removeBot(s, g.id, one.id), error => error.status === 409 && /only bot in this group's pipeline/.test(error.message));
  assert.deepEqual(g.bots.map(b => b.id), [one.id, two.id], 'The bot stays when the removal is refused.');
  assert.deepEqual(g.settings.pipeline, [one.id], 'The pipeline the person chose is kept.');
  // With two bots in the pipeline, either one can go and the pipeline shrinks.
  updateGroup(s, g.id, {settings: {pipeline: [one.id, two.id]}});
  removeBot(s, g.id, two.id);
  assert.deepEqual(g.settings.pipeline, [one.id]);
  // A pipeline entry for a bot that already left is not a choice the group can
  // still honour, so it does not keep the survivor in place.
  const three = addBot(s, g.id, {name: 'Third', instructions: 'Do the third step well.'});
  updateGroup(s, g.id, {settings: {pipeline: [one.id, three.id]}});
  removeBot(s, g.id, three.id);
  updateBot(s, g.id, one.id, {name: 'Only one'});
  assert.deepEqual(g.settings.pipeline, [one.id]);
  // Clearing the pipeline is the deliberate way to run every bot.
  updateGroup(s, g.id, {settings: {pipeline: null}});
  removeBot(s, g.id, one.id);
  assert.deepEqual(g.bots, []);
});

test('removing a bot cancels an in-flight scheduled task so completion cannot re-arm it', () => {
  const s = store();
  const g = s.groups[0];
  const scout = addBot(s, g.id, {name: 'Scout', instructions: 'Look things up for the team.'});
  const task = enqueueTask(s, {kind: 'bot-task', payload: {groupId: g.id, botId: scout.id, message: 'daily', kind: 'interval', intervalMinutes: 60}}).task;
  const kept = enqueueTask(s, {kind: 'bot-task', payload: {groupId: g.id, botId: 'atlas', message: 'weekly', kind: 'interval', intervalMinutes: 60}}).task;
  task.status = 'running';
  kept.status = 'running';
  const runAt = task.runAt;
  removeBot(s, g.id, scout.id);
  assert.equal(task.status, 'cancelled');
  assert.equal(kept.status, 'running');
  completeTask(s, task.id, {ok: true});
  failTask(s, task.id, 'A group run is already active.');
  assert.equal(task.status, 'cancelled');
  assert.equal(task.runAt, runAt);
});

test('removing a bot denies its waiting pages and cancels busy runs it was holding', () => {
  const s = store();
  const scout = addBot(s, 'home', {name: 'Scout', instructions: 'Look things up for the team.'});
  s.browserRequests = [
    {id: 'own', botId: scout.id, chatKey: scout.id, status: 'pending'},
    {id: 'team', botId: scout.id, chatKey: 'team-home', runId: 'g1', status: 'pending'},
    {id: 'keep', botId: 'atlas', chatKey: 'atlas', status: 'pending'},
  ];
  s.groupRuns = [
    {id: 'own', chatKey: scout.id, groupId: 'home', status: 'awaiting_browser'},
    {id: 'g1', chatKey: 'team-home', groupId: 'home', status: 'awaiting_browser'},
    {id: 'keep', chatKey: 'atlas', groupId: 'home', status: 'awaiting_plan'},
  ];
  removeBot(s, 'home', scout.id);
  assert.equal(s.browserRequests.find(r => r.id === 'own').status, 'denied');
  assert.equal(s.browserRequests.find(r => r.id === 'team').status, 'denied');
  assert.equal(s.browserRequests.find(r => r.id === 'keep').status, 'pending');
  assert.equal(s.groupRuns.find(r => r.id === 'own').status, 'cancelled');
  assert.equal(s.groupRuns.find(r => r.id === 'g1').status, 'cancelled');
  assert.equal(s.groupRuns.find(r => r.id === 'keep').status, 'awaiting_plan');
});

test('removing a group cancels that group\'s busy runs', () => {
  const s = store();
  const g = addGroup(s, {name: 'Temp', description: ''});
  addBot(s, g.id, {name: 'A', instructions: 'Do the thing that a specialist bot does here.'});
  s.groupRuns = [{id: 'r', groupId: g.id, chatKey: `team-${g.id}`, status: 'awaiting_plan'}];
  s.browserRequests = [{id: 'p', groupId: g.id, chatKey: `team-${g.id}`, status: 'pending'}];
  removeGroup(s, g.id);
  assert.equal(s.groupRuns[0].status, 'cancelled');
  assert.equal(s.browserRequests[0].status, 'denied');
});

test('a run parked on the X feed loads as cancelled', () => {
  const s = migrate({groupRuns: [{id: 'r1', status: 'awaiting_feed'}, {id: 'r2', status: 'completed'}], runs: [{id: 'b1', status: 'awaiting_feed'}]});
  for (const run of [s.groupRuns[0], s.runs[0]]) {
    assert.equal(run.status, 'cancelled');
    assert.equal(run.error, 'X feed reading was removed');
  }
  assert.equal(s.groupRuns[1].status, 'completed');
  const again = migrate(structuredClone(s));
  assert.deepEqual(again.groupRuns, s.groupRuns);
  assert.deepEqual(again.runs, s.runs);
});
