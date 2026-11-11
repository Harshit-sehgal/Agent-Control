import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, readdir} from 'node:fs/promises';
import {tintOf, chatRows} from '../shared/ui-model.js';

const sharedDir = new URL('../shared/', import.meta.url);
const uiFiles = ['app.js', ...(await readdir(sharedDir)).filter(f => /^ui-.+\.js$/.test(f)).sort()];
const js = (await Promise.all(uiFiles.map(f => readFile(new URL(f, sharedDir), 'utf8')))).join('\n');
// The offline run engine now lives in the local adapter, behind the same routes
// the server serves, not in the UI modules.
const localApi = await readFile(new URL('local-api.js', sharedDir), 'utf8');

test('a synced tint wins over the local pick, which wins over position', () => {
  assert.equal(tintOf({id: 'a', settings: {tint: 4}}, 1, {a: {avatarIndex: 2}}), 4);
  assert.equal(tintOf({id: 'a', settings: {tint: null}}, 1, {a: {avatarIndex: 2}}), 2);
  assert.equal(tintOf({id: 'a'}, 1, {}), 1);
  assert.equal(tintOf({id: 'a'}, -1, {}), 0);
  const rows = chatRows({state: {groups: [{id: 'g', bots: [{id: 'a', name: 'A', settings: {tint: 5}}]}]}});
  assert.equal(rows.find(r => r.id === 'a').tint, 5);
});
test('the UI wires bot pages and guest mentions to the engine contract', () => {
  // Bots are made, edited and remembered through their own pages; the group settings
  // form, the scheduled-task sheet and the old info panel are gone.
  assert.match(js, /id: 'new-bot-form'/);
  assert.match(js, /id: 'edit-bot-form'/);
  assert.match(js, /id="memory-form"/);
  assert.doesNotMatch(js, /group-settings-form|bot-task-form|renderInfo/);
  // The UI no longer plans mentions itself: a bot chat posts to the group route and the
  // engine (server or simulator) refuses a switched-off bot by name.
  assert.doesNotMatch(js, /summonableGuests|planHandoffs/);
  assert.match(localApi, /simulateGroup\(\{/);
  assert.match(localApi, /summonableGuests\(state\.groups, groupId, \{includeOff: true\}\)/);
  assert.match(js, /is switched off\. Turn it on in its profile\./);
  // The approval gate is the group's server-side setting now, not a local toggle.
  assert.doesNotMatch(js, /checkpoint-toggle|store\.checkpoints/);
  // Destructive changes ask first: deleting a bot says what goes and that it cannot be undone.
  assert.match(js, /confirmSheet\(copy\.title, \{confirm: 'Delete', danger: true, detail: copy\.detail\}\)/);
  // Runs now live on the workspace snapshot in both builds, so the list and
  // timeline read `recentRuns()` with no per-build merge and no separate log.
  assert.doesNotMatch(js, /localOnlyRuns|localRuns:/);
  assert.match(js, /store\.state\?\.groupRuns \|\| \[\]\)\.filter\(r => r\.groupId === groupId\)/);
  assert.match(js, /isRunNote\(m\)/);
  assert.match(js, /threadLineActions\(/);
  assert.doesNotMatch(js, /grant \|\| plan/);
  assert.match(js, /flags\.plan && btn\('Start', 'approve-plan'/);
  // Settings loads an admin page by key only; the per-page title and sub-line were never shown and are gone.
  assert.match(js, /ADMIN_PAGES = \{[^}]*\bai: true/);
});

