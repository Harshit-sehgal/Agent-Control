import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, readdir} from 'node:fs/promises';
import {mentionSuggestions, completeMention, chatTasks, pipelineRows, moveRow, pipelineValue, tintOf, chatRows, parseRoute} from '../shared/ui-model.js';

const sharedDir = new URL('../shared/', import.meta.url);
const uiFiles = ['app.js', ...(await readdir(sharedDir)).filter(f => /^ui-.+\.js$/.test(f)).sort()];
const js = (await Promise.all(uiFiles.map(f => readFile(new URL(f, sharedDir), 'utf8')))).join('\n');
// The offline run engine now lives in the local adapter, behind the same routes
// the server serves, not in the UI modules.
const localApi = await readFile(new URL('local-api.js', sharedDir), 'utf8');

const roster = [{id: 'scout', name: 'Scout'}, {id: 'writer', name: 'Writer'}, {id: 'web', name: 'Web Researcher'}];
const group = {id: 'g', bots: [{id: 'a', name: 'A'}, {id: 'b', name: 'B'}, {id: 'c', name: 'C'}]};

test('mention suggestions open only on a trailing @word and match names or ids', () => {
  assert.deepEqual(mentionSuggestions(roster, 'hello'), []);
  assert.deepEqual(mentionSuggestions(roster, '@scout and more'), [], 'A finished mention offers nothing');
  assert.deepEqual(mentionSuggestions(roster, 'email@wr'), [], 'An @ inside a word is not a mention');
  assert.deepEqual(mentionSuggestions(roster, 'ask @w').map(m => m.name), ['Writer', 'Web Researcher']);
  assert.deepEqual(mentionSuggestions(roster, '@WRI').map(m => m.id), ['writer']);
  assert.deepEqual(mentionSuggestions(roster, '@').length, 3);
  assert.deepEqual(mentionSuggestions(roster, '@', {limit: 2}).length, 2);
});
test('@everyone is offered only in a team chat, and duplicate names once', () => {
  assert.ok(!mentionSuggestions(roster, '@e').some(m => m.id === 'everyone'));
  assert.deepEqual(mentionSuggestions(roster, '@e', {team: true}).map(m => m.name), ['everyone']);
  const twins = [...roster, {id: 'scout-2', name: 'scout'}];
  assert.equal(mentionSuggestions(twins, '@sc').length, 1);
  assert.deepEqual(mentionSuggestions([{id: 'x', name: ''}, null], '@'), []);
});
test('completing a mention replaces only the word being typed', () => {
  assert.equal(completeMention('ask @wr', 'Writer'), 'ask @Writer ');
  assert.equal(completeMention('@', 'Web Researcher'), '@Web Researcher ');
  assert.equal(completeMention('a@b then @s', 'Scout'), 'a@b then @Scout ');
});
test('scheduled tasks are listed per chat and removed ones are hidden', () => {
  const tasks = [
    {id: '1', kind: 'bot-task', status: 'queued', payload: {groupId: 'g', botId: null}},
    {id: '2', kind: 'bot-task', status: 'queued', payload: {groupId: 'g', botId: 'a'}},
    {id: '3', kind: 'bot-task', status: 'cancelled', payload: {groupId: 'g', botId: 'a'}},
    {id: '4', kind: 'reminder', status: 'queued', payload: {groupId: 'g'}},
    {id: '5', kind: 'bot-task', status: 'failed', payload: {groupId: 'other', botId: 'a'}},
    {id: '6', kind: 'bot-task', status: 'done', payload: {groupId: 'g'}},
  ];
  assert.deepEqual(chatTasks(tasks, 'g').map(t => t.id), ['1', '6']);
  assert.deepEqual(chatTasks(tasks, 'g', 'a').map(t => t.id), ['2']);
  assert.deepEqual(chatTasks(undefined, 'g'), []);
});
test('the pipeline editor keeps the saved order and appends bots left out', () => {
  assert.deepEqual(pipelineRows(group), [{id: 'a', included: true}, {id: 'b', included: true}, {id: 'c', included: true}]);
  assert.deepEqual(pipelineRows(group, ['c', 'a', 'gone']), [{id: 'c', included: true}, {id: 'a', included: true}, {id: 'b', included: false}]);
  assert.deepEqual(pipelineRows({bots: []}), []);
});
test('moving a pipeline row swaps neighbours and ignores the ends', () => {
  const rows = pipelineRows(group);
  assert.deepEqual(moveRow(rows, 2, -1).map(r => r.id), ['a', 'c', 'b']);
  assert.deepEqual(moveRow(rows, 0, 1).map(r => r.id), ['b', 'a', 'c']);
  assert.deepEqual(moveRow(rows, 0, -1).map(r => r.id), ['a', 'b', 'c']);
  assert.deepEqual(moveRow(rows, 2, 1).map(r => r.id), ['a', 'b', 'c']);
  assert.deepEqual(rows.map(r => r.id), ['a', 'b', 'c'], 'The input is not mutated');
});
test('saving the pipeline sends null for "every bot in order", else the ticked ids', () => {
  const rows = pipelineRows(group);
  assert.equal(pipelineValue(rows, group), null);
  assert.deepEqual(pipelineValue(moveRow(rows, 0, 1), group), ['b', 'a', 'c']);
  assert.deepEqual(pipelineValue(rows.map(r => r.id === 'b' ? {...r, included: false} : r), group), ['a', 'c']);
  assert.deepEqual(pipelineValue(rows.map(r => ({...r, included: false})), group), []);
});
test('a synced tint wins over the local pick, which wins over position', () => {
  assert.equal(tintOf({id: 'a', settings: {tint: 4}}, 1, {a: {avatarIndex: 2}}), 4);
  assert.equal(tintOf({id: 'a', settings: {tint: null}}, 1, {a: {avatarIndex: 2}}), 2);
  assert.equal(tintOf({id: 'a'}, 1, {}), 1);
  assert.equal(tintOf({id: 'a'}, -1, {}), 0);
  const rows = chatRows({state: {groups: [{id: 'g', bots: [{id: 'a', name: 'A', settings: {tint: 5}}]}]}});
  assert.equal(rows.find(r => r.id === 'a').tint, 5);
});
test('the new info sections are routable', () => {
  const state = {groups: [{id: 'g', bots: [{id: 'a', name: 'A'}]}]};
  assert.equal(parseRoute('#chat/team-g/info/group-settings', state).info, 'group-settings');
  assert.equal(parseRoute('#chat/team-g/info/tasks', state).info, 'tasks');
  assert.equal(parseRoute('#chat/a/info/tasks', state).info, 'tasks');
  assert.equal(parseRoute('#chat/a/info/group-settings', state).info, 'home', 'A bot chat has no group settings');
});
test('the UI wires settings, scheduled tasks and guest mentions to the engine contract', () => {
  assert.match(js, /id="group-settings-form"/);
  assert.match(js, /id="bot-task-form"/);
  assert.match(js, /title: 'Schedule a task'/);
  assert.match(js, /kind: 'bot-task', payload/);
  assert.match(js, /'PATCH', \{name: f\.name, description: f\.description \|\| '', settings: \{/);
  assert.match(js, /summonableGuests\(groups\(\), group\.id, \{includeOff: true\}\)/, 'A mention of a switched-off guest must reach the planner so it is refused by name.');
  assert.match(localApi, /simulateGroup\(\{/);
  assert.match(localApi, /summonableGuests\(state\.groups, groupId, \{includeOff: true\}\)/);
  assert.match(js, /is switched off\. Turn it on in its profile\./);
  // The approval gate is the group's server-side setting now, not a local toggle.
  assert.doesNotMatch(js, /checkpoint-toggle|store\.checkpoints/);
  assert.match(js, /checkRow\('checkpoints', 'Approve between steps'/);
  // Destructive changes ask first.
  for (const message of ['Remove this scheduled task?', 'Remove ${bot.name} from ${group.name}?', 'Delete ${group.name}?'])
    assert.ok(js.includes(`confirmSheet(\`${message}`) || js.includes(`confirmSheet('${message}`), `${message} must be confirmed`);
  // Group deletion is admin-only on the Node build and never offered for X-engage.
  assert.match(js, /const removable = !isXGroup\(group\) && \(isAdmin\(\) \|\| isStaticDemo\(\)\)/);
  assert.match(js, /An admin sets voice and timing for this workspace/);
  assert.match(js, /canEdit \? btn\('Save'/);
  // Runs now live on the workspace snapshot in both builds, so the list and
  // timeline read `recentRuns()` with no per-build merge and no separate log.
  assert.doesNotMatch(js, /localOnlyRuns|localRuns:/);
  assert.match(js, /store\.state\?\.groupRuns \|\| \[\]\)\.filter\(r => r\.groupId === groupId\)/);
  assert.match(js, /isRunNote\(i\.message\)/);
  assert.match(js, /threadLineActions\(/);
  assert.doesNotMatch(js, /grant \|\| plan/);
  assert.match(js, /flags\.plan \? `\$\{btn\('Start', 'approve-plan'/);
  assert.match(js, /if \(!canWrite\(\)\) return botHome\(conv\)/);
  assert.match(js, /const lock = writable \? '' : ' disabled'/);
  assert.match(js, /label: 'AI and models'/);
});
