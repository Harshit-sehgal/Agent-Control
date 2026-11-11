import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NO_JOB, hasJob, lookOf, resolveSection, roleOf, teamLine, moveTargets, menuItems, deleteCopy, profileRows, profileBackRoute, closeTarget, memoryNotes, modelLine,
  newBotDefaults, newBotPayload, canCreate, editChanges, ACTIVITY_FILTERS, activityUrl, activityTarget, activityDays, companyTree, permissionRows, weekUsage, settingsSections,
} from '../shared/ui-profile-model.js';

const bot = (id, name, settings = {}, instructions = 'Does its work.', extra = {}) => ({id, name, instructions, settings, ...extra});
const atlas = bot('atlas', 'Atlas', {lead: true}, 'Runs the company.');
const ops = bot('ops', 'Ops lead', {reportsTo: 'atlas'});
const mail = bot('mail', 'Mailroom', {reportsTo: 'ops'}, 'Reads and drafts email.', {permissions: ['browser.use', 'bot.ask']});
const plan = bot('plan', 'Planner', {reportsTo: 'ops'});
const solo = bot('solo', 'Ledger', {});
const fresh = bot('fresh', 'Fresh', {}, NO_JOB);
const stateOf = (bots = [atlas, ops, mail, plan, solo], extra = {}) => ({groups: [{id: 'home', name: 'Home', settings: {}, bots}], chats: {}, events: [], ...extra});

// ---- jobs and roles ----

test('a bot made without a job says it is waiting for one', () => {
  assert.equal(hasJob(fresh), false);
  assert.equal(hasJob(mail), true);
  assert.equal(hasJob(bot('x', 'X', {}, '   ')), false);
});

test('the role is Primary, Manager (has reports) or Bot', () => {
  const s = stateOf();
  assert.equal(roleOf(s, 'atlas'), 'Primary');
  assert.equal(roleOf(s, 'ops'), 'Manager');
  assert.equal(roleOf(s, 'mail'), 'Bot');
});

test('the team line names the manager, or says it reports to Atlas', () => {
  const s = stateOf();
  assert.equal(teamLine(s, 'atlas'), 'Primary');
  assert.equal(teamLine(s, 'ops'), 'Manager · reports to Atlas');
  assert.equal(teamLine(s, 'mail'), "Bot · Ops lead's team");
  assert.equal(teamLine(s, 'solo'), 'Bot · reports to Atlas');
});

// ---- the menu and Move to ----

test('Move to lists managers first, then other bots, never itself, its own team or the primary', () => {
  const s = stateOf();
  const ids = moveTargets(s, 'solo').map(t => t.id);
  assert.deepEqual(ids, ['ops', 'mail', 'plan']);
  assert.deepEqual(moveTargets(s, 'ops').map(t => t.id), ['solo'], 'a manager cannot move under its own reports');
});

test('Move to offers Solo only to a bot that has a manager, and never to the primary', () => {
  const s = stateOf();
  assert.deepEqual(moveTargets(s, 'mail').find(t => t.id === null), {id: null, label: 'Solo (reports to Atlas)', kind: 'solo'});
  assert.equal(moveTargets(s, 'solo').some(t => t.id === null), false);
  assert.deepEqual(moveTargets(s, 'atlas'), []);
});

test('the current manager is not offered again', () => {
  assert.equal(moveTargets(stateOf(), 'mail').some(t => t.id === 'ops'), false);
});

test('a manager target is marked, so the menu can show it first', () => {
  const targets = moveTargets(stateOf(), 'solo');
  assert.equal(targets[0].kind, 'manager');
  assert.equal(targets.find(t => t.id === 'mail').kind, 'bot');
});

test('the menu is Message, Pin, Move to, Hide, Delete; Atlas gets neither Hide nor Delete', () => {
  const s = stateOf();
  assert.deepEqual(menuItems(s, 'mail', {pinned: false}).map(i => i.id), ['message', 'pin', 'move', 'hide', 'delete']);
  assert.deepEqual(menuItems(s, 'atlas', {pinned: true}).map(i => i.id), ['message', 'pin']);
});

test('the Pin item flips to Unpin and the delete item is the dangerous one', () => {
  const s = stateOf();
  assert.equal(menuItems(s, 'mail', {pinned: true}).find(i => i.id === 'pin').label, 'Unpin');
  assert.equal(menuItems(s, 'mail', {pinned: false}).find(i => i.id === 'pin').label, 'Pin');
  assert.equal(menuItems(s, 'mail', {}).find(i => i.id === 'delete').danger, true);
  assert.equal(menuItems(s, 'mail', {}).find(i => i.id === 'message').label, 'Message Mailroom');
});

test('a bot with nowhere to move has no Move to item', () => {
  const s = stateOf([atlas, solo]);
  assert.equal(menuItems(s, 'solo', {}).some(i => i.id === 'move'), false);
});

test('delete says what goes, that it cannot be undone, where reports go and that threads stay', () => {
  const s = stateOf();
  assert.equal(deleteCopy(s, 'mail').title, 'Delete Mailroom?');
  assert.equal(deleteCopy(s, 'mail').detail, "Its job, memory and permissions are deleted. This can't be undone. Its threads stay.");
  assert.equal(deleteCopy(s, 'ops').detail, "Its job, memory and permissions are deleted. This can't be undone. Its 2 reports move to Solo. Its threads stay.");
  const one = stateOf([atlas, ops, mail]);
  assert.match(deleteCopy(one, 'ops').detail, /Its 1 report moves to Solo\./);
});

// ---- the profile ----

test('the profile card lists Memory, Activity, Permissions, Model, Computer and, for a manager, Team', () => {
  const s = stateOf();
  assert.deepEqual(profileRows(s, 'ops').map(r => r.key), ['memory', 'activity', 'permissions', 'model', 'computer', 'team']);
  assert.deepEqual(profileRows(s, 'mail').map(r => r.key), ['memory', 'activity', 'permissions', 'model', 'computer']);
  assert.deepEqual(profileRows(s, 'atlas').map(r => r.key), ['memory', 'activity', 'permissions', 'model', 'team'], 'Atlas has no Computer row');
});

test('row values count notes, rules and reports, and the computer is Idle', () => {
  const s = stateOf([atlas, ops, mail, plan, solo], {
    memory: {rulebooks: {'bot:mail': {rules: [{id: 'r1', text: 'Never reply on Fridays'}, {id: 'r2', text: 'Sign as Harshit'}]}}},
  });
  const row = key => profileRows(s, 'mail', {activityCount: 1}).find(r => r.key === key).value;
  assert.equal(row('memory'), '2 notes');
  assert.equal(row('activity'), '1');
  assert.equal(row('permissions'), '2 rules');
  assert.equal(row('computer'), 'Idle');
  assert.equal(profileRows(s, 'ops').find(r => r.key === 'team').value, '2 bots');
  assert.equal(profileRows(s, 'solo').find(r => r.key === 'memory').value, 'Empty');
  assert.equal(profileRows(s, 'solo').find(r => r.key === 'permissions').value, 'None');
});

test('memory notes come from the bot own book', () => {
  const s = stateOf([atlas, mail], {memory: {rulebooks: {'bot:mail': {rules: [{id: 'a', text: 'One', source: 'user'}]}, 'bot:atlas': {rules: []}}}});
  assert.deepEqual(memoryNotes(s, 'mail').map(n => n.id), ['a']);
  assert.deepEqual(memoryNotes(s, 'atlas'), []);
  assert.deepEqual(memoryNotes({groups: []}, 'mail'), []);
});

test('the model line is the bot override, else the workspace default, else the demo', () => {
  const ai = {providers: [{id: 'p1', label: 'OpenAI'}], defaultProviderId: 'p1', defaultModel: 'gpt-5', bots: {mail: {providerId: 'p1', model: 'gpt-5-mini'}}};
  assert.equal(modelLine({ai}, 'mail'), 'OpenAI · gpt-5-mini');
  assert.equal(modelLine({ai}, 'ops'), 'OpenAI · gpt-5');
  assert.equal(modelLine({aiEnabled: true, aiModel: 'claude-x'}, 'ops'), 'claude-x');
  assert.equal(modelLine({}, 'ops'), 'Built-in demo');
});

test('back from a profile goes to the thread it was opened from, else to the bot chat', () => {
  assert.deepEqual(profileBackRoute('mail', 't1'), {thread: 't1'});
  assert.deepEqual(profileBackRoute('mail', null), {bot: 'mail'});
  assert.deepEqual(profileBackRoute('mail'), {bot: 'mail'});
});

test('a close button pops the page that was opened from the list or Settings', () => {
  for (const route of [{settings: ''}, {settings: 'perm'}, {newBot: true}, {company: true}, {activity: true}]) assert.deepEqual(closeTarget(route), {route: {home: true}, pop: true});
});

test('a profile closes to its bot chat or thread, and a sub-page closes to its profile', () => {
  assert.deepEqual(closeTarget({profile: 'mail'}), {route: {bot: 'mail'}, pop: false});
  assert.deepEqual(closeTarget({profile: 'mail'}, 't1'), {route: {thread: 't1'}, pop: false});
  assert.deepEqual(closeTarget({profile: 'mail', sub: 'memory'}, 't1'), {route: {profile: 'mail'}, pop: false});
  assert.deepEqual(closeTarget({company: true}).route, {home: true}, 'never the Company page from a profile');
});

// ---- new bot and edit ----

test('a new bot starts with the first colour no bot uses, and the rounded shape', () => {
  const s = stateOf([bot('a', 'A', {lead: true, tint: 0}), bot('b', 'B', {tint: 1}), bot('c', 'C', {tint: 3})]);
  assert.deepEqual(newBotDefaults(s), {tint: 2, shape: 'rounded'});
});

test('Create needs a name', () => {
  assert.equal(canCreate({name: ''}), false);
  assert.equal(canCreate({name: '   '}), false);
  assert.equal(canCreate({name: 'Scholar'}), true);
});

test('the create payload carries the name, colour and, when changed, shape and manager', () => {
  const p = newBotPayload({name: '  Scholar ', tint: 7, shape: 'hexagon', reportsTo: 'ops'});
  assert.deepEqual(p, {name: 'Scholar', instructions: NO_JOB, settings: {tint: 7, shape: 'hexagon', reportsTo: 'ops'}});
  assert.deepEqual(newBotPayload({name: 'Quill', tint: 0, shape: 'rounded'}).settings, {tint: 0});
});

test('a job from Make a new bot becomes the new bot instructions', () => {
  assert.equal(newBotPayload({name: 'Quill', tint: 1, job: '  Summarise my papers every Monday  '}).instructions, 'Summarise my papers every Monday');
  assert.equal(newBotPayload({name: 'Quill', tint: 1, job: 'x'.repeat(5000)}).instructions.length, 3000);
});

test('Edit only sends what changed, so a shape left alone stays the role default', () => {
  const was = {name: 'Mailroom', reportsTo: 'ops', shape: 'rounded', tint: 2};
  assert.deepEqual(editChanges(was, {name: 'Mailroom', reportsTo: 'ops', shape: 'rounded', tint: 2}), null);
  assert.deepEqual(editChanges(was, {name: ' Post ', reportsTo: 'ops', shape: 'rounded', tint: 2}), {name: 'Post'});
  assert.deepEqual(editChanges(was, {name: 'Mailroom', reportsTo: '', shape: 'blob', tint: 5}), {settings: {reportsTo: null, shape: 'blob', tint: 5}});
});

// ---- activity ----

const NOW = Date.parse('2026-11-11T15:00:00Z');
test('the four filters are Left the app, Permissions, Bots and All, in that order', () => {
  assert.deepEqual(ACTIVITY_FILTERS.map(f => f[0]), ['outside', 'perm', 'bots', 'all']);
  assert.deepEqual(ACTIVITY_FILTERS.map(f => f[1]), ['Left the app', 'Permissions', 'Bots', 'All']);
});

test('the activity request names the chip, the page size, the bot and the cursor', () => {
  assert.equal(activityUrl(), '/api/activity?filter=outside&limit=50');
  assert.equal(activityUrl({filter: 'all', botId: 'mail', limit: 5}), '/api/activity?filter=all&limit=5&bot=mail');
  assert.equal(activityUrl({filter: 'bots', before: 'a b'}), '/api/activity?filter=bots&limit=50&before=a%20b');
});

test('tapping an entry opens its thread, or its bot chat, or nothing', () => {
  assert.deepEqual(activityTarget({threadId: 'team-t1'}), {thread: 't1'});
  assert.deepEqual(activityTarget({threadId: 'mail'}), {bot: 'mail'});
  assert.equal(activityTarget({threadId: null}), null);
  assert.equal(activityTarget(undefined), null);
});

test('entries group by day: Today, Yesterday, then the date', () => {
  const rows = [
    {id: '1', at: '2026-11-11T14:00:00Z'}, {id: '2', at: '2026-11-11T13:00:00Z'},
    {id: '3', at: '2026-11-10T09:00:00Z'}, {id: '4', at: '2026-11-01T09:00:00Z'},
  ];
  const days = activityDays(rows, NOW);
  assert.deepEqual(days.map(d => d.label).slice(0, 2), ['Today', 'Yesterday']);
  assert.equal(days.length, 3);
  assert.deepEqual(days[0].rows.map(r => r.id), ['1', '2']);
});

// ---- the company chart ----

test('the chart is Atlas, then managers, then their teams; Solo bots sit under Atlas', () => {
  const tree = companyTree(stateOf());
  assert.equal(tree.id, 'atlas');
  assert.deepEqual(tree.children.map(c => c.id), ['ops', 'solo']);
  assert.deepEqual(tree.children[0].children.map(c => c.id), ['mail', 'plan']);
  assert.equal(tree.children[0].role, 'Manager');
});

test('a reporting cycle cannot hang the chart', () => {
  const a = bot('a', 'A', {reportsTo: 'b'}), b = bot('b', 'B', {reportsTo: 'a'});
  const tree = companyTree(stateOf([atlas, a, b]));
  const seen = [];
  (function walk(n) { seen.push(n.id); n.children.forEach(walk); })(tree);
  assert.ok(seen.length <= 3, seen.join());
});

// ---- settings ----

test('permission rows list every grant of every bot, read-only', () => {
  const rows = permissionRows(stateOf());
  assert.deepEqual(rows.map(r => `${r.botId}:${r.action}`), ['mail:browser.use', 'mail:bot.ask']);
  assert.match(rows[0].label, /browser/i);
});

test('settings sections: seven for everyone, the admin ones only for an admin of a live server', () => {
  const keys = list => list.map(s => s.key);
  assert.deepEqual(keys(settingsSections({admin: false, demo: true})), ['general', 'look', 'models', 'conn', 'perm', 'usage', 'computer', 'about']);
  const live = keys(settingsSections({admin: true, demo: false}));
  assert.ok(['team', 'agents', 'data', 'notifications', 'workspaces'].every(k => live.includes(k)));
  assert.ok(!keys(settingsSections({admin: false, demo: false})).includes('team'));
  assert.deepEqual(keys(settingsSections({admin: false, demo: false})).slice(0, 7), ['general', 'look', 'models', 'conn', 'perm', 'usage', 'computer']);
});

test('an old page name maps to its section, and an unknown or disallowed one to General', () => {
  const demo = settingsSections({admin: false, demo: true});
  assert.equal(resolveSection('ai', demo), 'models');
  assert.equal(resolveSection('', demo), 'general');
  assert.equal(resolveSection('perm', demo), 'perm');
  assert.equal(resolveSection('team', demo), 'general', 'team is admin-only and the demo has no accounts');
  assert.equal(resolveSection('nope', demo), 'general');
});

test('the Edit page starts from what the bot looks like now, role defaults filled in', () => {
  const s = stateOf([atlas, ops, mail, plan, solo]);
  assert.deepEqual(lookOf(s, 'ops'), {name: 'Ops lead', reportsTo: null, shape: 'hexagon', tint: 1});
  assert.equal(lookOf(s, 'atlas').shape, 'circle');
  assert.equal(lookOf(s, 'mail').reportsTo, 'ops');
  assert.equal(lookOf(s, 'solo').shape, 'rounded');
  const tinted = stateOf([atlas, bot('b', 'B', {tint: 8, shape: 'blob'})]);
  assert.deepEqual(lookOf(tinted, 'b'), {name: 'B', reportsTo: null, shape: 'blob', tint: 8});
});

test('week usage counts each bot turns in the last seven days, biggest first', () => {
  const now = Date.parse('2026-11-11T12:00:00Z');
  const runs = [
    {createdAt: '2026-11-10T10:00:00Z', trace: [{botId: 'atlas', output: 'a'}, {botId: 'mail', kind: 'ask', to: 'plan', task: 't'}, {botId: 'plan', kind: 'peer', output: 'p'}, {botId: 'mail', output: 'm'}, {botId: 'mail', output: 'm2'}]},
    {createdAt: '2026-10-20T10:00:00Z', trace: [{botId: 'solo', output: 'old'}]},
  ];
  const usage = weekUsage(stateOf(undefined, {groupRuns: runs}), now);
  assert.equal(usage.total, 4);
  assert.deepEqual(usage.rows.map(r => [r.botId, r.count, r.pct]), [['mail', 2, 50], ['atlas', 1, 25], ['plan', 1, 25]]);
  assert.deepEqual(weekUsage(stateOf(), now), {total: 0, rows: []});
});
