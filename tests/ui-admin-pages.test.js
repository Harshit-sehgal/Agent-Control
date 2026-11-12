import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

/* The admin pages inside Settings (Models, Notifications, Local agents, Team, Data) are cards of rows in the Settings and
 * Connectors style. The browser behaviour is in tests/usability_smoke.py; this file pins what a source read can: the old
 * shapes are gone, and the security controls and the endpoints other screens call are still wired. */
const read = name => fs.readFileSync(new URL(`../shared/${name}`, import.meta.url), 'utf8');
const js = read('ui-admin.js'), css = read('app.css');

test('no admin page builds the old box-and-row markup or a native checkbox or select for a role', () => {
  assert.doesNotMatch(js, /\bbox\(|\brow\(\{|class="row|check-row|type="checkbox"/);
  assert.doesNotMatch(js, /<select class="input" data-action="set-role"/);
});

test('the pages say nothing from the X era', () => {
  for (const old of ['can never publish', 'bots, posts, drafts', 'posts, drafts', 'disputed evidence']) assert.ok(!js.includes(old), `"${old}" is still in ui-admin.js`);
});

test('the security controls are still there, and still ask first', () => {
  for (const action of ['revoke-agent', 'toggle-agent-permission', 'reveal-credential', 'delete-credential', 'prune-retention', 'backup-export', 'backup-restore', 'remove-user', 'toggle-user-disabled'])
    assert.match(js, new RegExp(`'${action}': async`), `${action} is not a handler`);
  assert.match(js, /\/api\/credentials\/\$\{button\.dataset\.id\}\/reveal/);
  assert.match(js, /api\('\/api\/admin\/backup'\)/);
  assert.match(js, /api\('\/api\/admin\/restore', 'POST'/);
  assert.match(js, /store\.state\?\.me\?\.role === 'owner' \? backupPanel\(\)/, 'a backup is for the owner only');
});

test('sessions are not on the Team page: they live under General > Account, which makes its own calls', () => {
  assert.doesNotMatch(js, /Your sessions|Sign out everywhere|\/api\/sessions/);
  assert.match(read('ui-settings.js'), /\/api\/sessions\/revoke-all/);
});

test('the Models page shows each computer\'s sign-in once, on Local agents, and links there', () => {
  assert.doesNotMatch(js, /Sign-in on your paired agents|function subscriptionBoxes/);
  assert.match(js, /data-action="settings-open" data-section="agents"/);
  assert.match(js, /agentCliRows\(\[agent\]\)/, 'Local agents carries the claude and codex status');
});

test('Add a model is one card, and the default and subscription model fields are one picker', () => {
  assert.match(js, /aria-label="What to add"/);
  assert.equal((js.match(/modelSelect\(modelChoices\(/g) || []).length, 2, 'the subscription form and the default form both use the one dropdown');
  assert.doesNotMatch(js, /btn\('Load models'/, 'the list loads by itself; Refresh models stays under the dots');
  assert.doesNotMatch(js, /field\('Default provider'|ai-default-provider-pick/, 'the default provider is chosen with Make default on its row');
});

test('the small touch rules for the admin pages sit in the coarse-pointer block, which stays last', () => {
  const block = css.slice(css.lastIndexOf('@media (pointer:coarse)'));
  for (const rule of ['.rbtn.ad-more{width:44px;height:44px}', '.ad-panel .st-seg button{min-height:40px}', '.ad-addr .btn{min-height:44px}']) assert.ok(block.includes(rule), `${rule} is not in the coarse block`);
});
