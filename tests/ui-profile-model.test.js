import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NO_JOB, hasJob, roleLine, lookOf, resolveSection, roleOf, teamLine, moveTargets, menuItems, deleteCopy, profileRows, profileBackRoute, closeTarget, memoryNotes, modelLine,
  newBotDefaults, newBotPayload, canCreate, editChanges, deviceOptions, accountRows, accountOptions, ACTIVITY_FILTERS, activityUrl, activityTarget, activityDays, companyTree, weekUsage, settingsSections, sectionArg,
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
  assert.deepEqual(profileRows(s, 'ops').map(r => r.key), ['memory', 'activity', 'schedule', 'permissions', 'model', 'computer', 'team']);
  assert.deepEqual(profileRows(s, 'mail').map(r => r.key), ['memory', 'activity', 'schedule', 'permissions', 'model', 'computer']);
  assert.deepEqual(profileRows(s, 'atlas').map(r => r.key), ['memory', 'activity', 'schedule', 'permissions', 'model', 'computer', 'team'], 'Atlas browses like every bot, so it has a Computer too');
});

test('the Model row is plain text when there is nothing to pick (the demo, a viewer)', () => {
  const s = stateOf();
  assert.equal(profileRows(s, 'mail').find(r => r.key === 'model').plain, undefined, 'a picker is the default');
  assert.equal(profileRows(s, 'mail').find(r => r.key === 'schedule').value, 'None');
  assert.equal(profileRows({...s, tasks: [{kind: 'bot-task', status: 'queued', payload: {botId: 'mail', message: 'x', kind: 'interval', intervalMinutes: 60}}]}, 'mail').find(r => r.key === 'schedule').value, 'every hour');
  assert.equal(profileRows({...s, tasks: [1, 2].map(i => ({id: `t${i}`, kind: 'bot-task', status: 'queued', payload: {botId: 'mail', message: `x${i}`, kind: 'once'}}))}, 'mail').find(r => r.key === 'schedule').value, '2 tasks');
  const row = profileRows(s, 'mail', {canPickModel: false}).find(r => r.key === 'model');
  assert.equal(row.plain, true);
  assert.equal(row.value, 'Built-in demo');
  assert.equal(profileRows(s, 'mail', {canPickModel: false}).filter(r => r.plain).length, 1, 'no other row is plain');
});

test('row values count notes, rules and reports, and the computer is Idle', () => {
  const s = stateOf([atlas, ops, mail, plan, solo], {
    memory: {rulebooks: {'bot:mail': {rules: [{id: 'r1', text: 'Never reply on Fridays'}, {id: 'r2', text: 'Sign as Harshit'}]}}},
  });
  const row = key => profileRows(s, 'mail', {activityCount: 1}).find(r => r.key === key).value;
  assert.equal(row('memory'), '2 notes');
  assert.equal(row('activity'), '1');
  assert.equal(row('permissions'), 'None', 'a permission held before asks existed is not a rule; only grants count');
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

test('the Runs on choice: any computer first, each paired one by name, and a removed pin still shows', () => {
  const agents = [{id: 'a1', name: 'Laptop', status: 'online'}, {id: 'a2', name: 'Desk PC', status: 'stale'}, {id: 'a3', name: 'Old', status: 'revoked'}];
  assert.deepEqual(deviceOptions(agents, null), [{id: '', label: 'Any computer', selected: true}, {id: 'a1', label: 'Laptop', selected: false}, {id: 'a2', label: 'Desk PC', selected: false}]);
  assert.equal(deviceOptions(agents, 'a2').find(o => o.selected).id, 'a2');
  assert.deepEqual(deviceOptions(agents, 'a3').at(-1), {id: 'a3', label: 'A computer that is no longer paired', selected: true});
  assert.deepEqual(deviceOptions([{id: 'a3', name: 'Old', status: 'revoked'}], null), []);
});

test('a pin to a computer that is gone still shows when every computer is revoked, so the owner can clear it', () => {
  const gone = [{id: 'a3', name: 'Old', status: 'revoked'}];
  assert.deepEqual(deviceOptions(gone, 'a3'), [{id: '', label: 'Any computer', selected: false}, {id: 'a3', label: 'A computer that is no longer paired', selected: true}]);
  assert.deepEqual(deviceOptions([], 'a3').map(o => o.id), ['', 'a3']);
  assert.deepEqual(deviceOptions(gone, ''), []);
});

test('Edit saves the computer only when it changed, and keeps a pin it did not show', () => {
  const was = {name: 'Web', reportsTo: null, shape: 'rounded', tint: 2, device: 'a1'}, same = {name: 'Web', reportsTo: '', shape: 'rounded', tint: 2};
  assert.equal(editChanges(was, same), null);
  assert.equal(editChanges(was, {...same, device: 'a1'}), null);
  assert.deepEqual(editChanges(was, {...same, device: 'a2'}), {settings: {device: 'a2'}});
  assert.deepEqual(editChanges(was, {...same, device: ''}), {settings: {device: null}});
  assert.deepEqual(editChanges(was, {...same, name: 'Scout'}), {name: 'Scout'}, 'a rename by someone who sees no Runs on row keeps the pin');
});

const ACC_A = '0a1b2c3d-1111-4222-8333-444455556666', ACC_B = '0a1b2c3d-1111-4222-8333-777788889999';

test('account rows say whether each is signed in, and when its computer or its storage needs you', () => {
  const rows = accountRows([{id: ACC_A, name: 'CRM', site: 'crm.example.com', deviceId: 'pc-1', state: 'signed-in'}, {id: ACC_B, name: 'Mail', site: 'mail.example.com', deviceId: 'gone', state: 'signed-out', lost: true}], [{id: 'pc-1', name: 'Laptop', status: 'online'}]);
  assert.deepEqual(rows.map(r => [r.word, r.tone, r.computer, r.note]), [['Signed in', 'good', 'Laptop', ''], ['Not signed in', 'warn', '', 'Its computer is not paired. Move it to another.']]);
  assert.deepEqual(rows.map(r => [r.id, r.name, r.site]), [[ACC_A, 'CRM', 'crm.example.com'], [ACC_B, 'Mail', 'mail.example.com']]);
});

test('an account row: not checked yet, a lost sign-in, a revoked computer, an odd or missing state', () => {
  const agents = [{id: 'pc-1', name: 'Laptop', status: 'stale'}, {id: 'pc-2', name: 'Old', status: 'revoked'}];
  const row = (extra, deviceId = 'pc-1') => accountRows([{id: ACC_A, name: 'CRM', site: 'crm.example.com', deviceId, ...extra}], agents)[0];
  assert.deepEqual([row({state: 'unknown'}).word, row({state: 'unknown'}).tone], ['Not checked yet', 'warn']);
  assert.equal(row({state: 'signed-in', lost: true}).note, 'This site keeps its sign-in outside cookies, so sign in again after the computer restarts.');
  assert.equal(row({state: 'signed-in', lost: true}, 'pc-2').note, 'Its computer is not paired. Move it to another.', 'a revoked computer is not paired, and that note comes first');
  assert.equal(row({state: 'signed-in'}, 'pc-2').computer, '');
  assert.deepEqual([row({state: 'wat'}).word, row({}).word, row({}).tone], ['Not signed in', 'Not signed in', 'warn']);
  assert.deepEqual(accountRows(undefined, undefined), []);
});

test('the account choice on Edit: the computer\'s own browser first, each account, a gone one last, nothing with none', () => {
  const accounts = [{id: ACC_A, name: 'CRM', site: 'crm.example.com'}];
  assert.deepEqual(accountOptions(accounts, 'f'.repeat(8) + ACC_A.slice(8)).map(o => o.label), ["The computer's own browser", 'CRM · crm.example.com', 'An account that no longer exists']);
  assert.deepEqual(accountOptions(accounts, null), [{id: '', label: "The computer's own browser", selected: true}, {id: ACC_A, label: 'CRM · crm.example.com', selected: false}]);
  assert.deepEqual(accountOptions(accounts, ACC_A).map(o => o.selected), [false, true]);
  assert.deepEqual(accountOptions([], null), []);
  assert.deepEqual(accountOptions(undefined, ''), []);
  assert.deepEqual(accountOptions([], ACC_B).map(o => [o.id, o.selected]), [['', false], [ACC_B, true]], 'a gone account shows even with none left, so the owner can clear it');
});

test('Edit saves the browser account only when the owner changed it; a form with no such row never sends one', () => {
  const was = {name: 'Web', reportsTo: null, shape: 'rounded', tint: 2, browserAccount: ACC_A}, same = {name: 'Web', reportsTo: '', shape: 'rounded', tint: 2};
  assert.equal(editChanges(was, {...same, browserAccount: ACC_A}), null);
  assert.deepEqual(editChanges(was, {...same, browserAccount: ACC_B}), {settings: {browserAccount: ACC_B}});
  assert.deepEqual(editChanges(was, {...same, browserAccount: ''}), {settings: {browserAccount: null}});
  assert.deepEqual(editChanges({...was, browserAccount: null}, {...same, browserAccount: ACC_A}), {settings: {browserAccount: ACC_A}});
  assert.equal(editChanges({...was, browserAccount: null}, {...same, browserAccount: ''}), null);
  // A member's page draws no row, so the form has no field: a rename is only a rename (a `browserAccount: null` would be a 403).
  assert.deepEqual(editChanges(was, {...same, name: 'Scout'}), {name: 'Scout'});
  assert.deepEqual(editChanges(was, {...same, name: 'Scout', device: 'a1'}), {name: 'Scout', settings: {device: 'a1'}});
});

// ---- activity ----

const NOW = Date.parse('2026-11-11T15:00:00Z');
test('the four filters are All, Sent outside, Permissions and Bots, in that order', () => {
  assert.deepEqual(ACTIVITY_FILTERS.map(f => f[0]), ['all', 'outside', 'perm', 'bots']);
  assert.deepEqual(ACTIVITY_FILTERS.map(f => f[1]), ['All', 'Sent outside', 'Permissions', 'Bots']);
});

test('the activity request names the chip, the page size, the bot and the cursor', () => {
  assert.equal(activityUrl(), '/api/activity?filter=all&limit=50');
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

test('the Permissions row counts the rules a bot has: its grants only', () => {
  const grants = [{botId: 'solo', action: 'send', scope: '', choice: 'always'}, {botId: 'solo', action: 'spend', scope: '', choice: 'deny'}, {botId: 'mail', action: 'post', scope: '', choice: 'ask'}];
  const s = stateOf([atlas, ops, mail, plan, solo], {grants});
  const row = id => profileRows(s, id).find(r => r.key === 'permissions').value;
  assert.equal(row('solo'), '2 rules');
  assert.equal(row('mail'), '1 rule', 'its post grant; the page permission it held before asks is not counted');
  assert.equal(row('plan'), 'None');
});

test('settings sections: six for everyone, the admin ones only for an admin of a live server', () => {
  const keys = list => list.map(s => s.key);
  assert.deepEqual(keys(settingsSections({admin: false, demo: true})), ['general', 'look', 'models', 'conn', 'perm', 'usage', 'about']);
  const live = keys(settingsSections({admin: true, demo: false}));
  assert.ok(['team', 'agents', 'data', 'notifications', 'workspaces'].every(k => live.includes(k)));
  assert.ok(!keys(settingsSections({admin: false, demo: false})).includes('team'));
  assert.deepEqual(keys(settingsSections({admin: false, demo: false})).slice(0, 6), ['general', 'look', 'models', 'conn', 'perm', 'usage']);
  assert.ok(!keys(settingsSections({admin: true, demo: false})).includes('computer'), 'Local agents is reached from General; there is no Computer section');
});

test('an old page name maps to its section, and an unknown or disallowed one to General', () => {
  const demo = settingsSections({admin: false, demo: true});
  assert.equal(resolveSection('ai', demo), 'models');
  assert.equal(resolveSection('', demo), 'general');
  assert.equal(resolveSection('perm', demo), 'perm');
  assert.equal(resolveSection('team', demo), 'general', 'team is admin-only and the demo has no accounts');
  assert.equal(resolveSection('nope', demo), 'general');
  assert.equal(resolveSection('computer', demo), 'general', 'the Computer section is gone');
});

test('Permissions can be opened for one bot: perm/<bot id> is the Permissions section with that bot as its argument', () => {
  const demo = settingsSections({admin: false, demo: true});
  assert.equal(resolveSection('perm/mail', demo), 'perm');
  assert.equal(sectionArg('perm/mail'), 'mail');
  assert.equal(sectionArg('perm'), '');
  assert.equal(sectionArg('perm/odd%20id/x'), 'odd%20id/x', 'only the first slash splits');
  assert.equal(sectionArg(undefined), '');
  assert.equal(resolveSection('usage/mail', demo), 'usage', 'an argument on another section is ignored, not an error');
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

test('the profile header shows the job as one line, never the raw prompt', () => {
  assert.equal(roleLine({name: 'Atlas', instructions: 'You are Atlas, the primary bot. Answer the owner, and hand each piece of work to the bot whose job it is.'}),
    'Answer the owner, and hand each piece of work to the bot whose job it is', 'the lead-in naming the bot is skipped');
  assert.equal(roleLine({name: 'Mail', instructions: 'Watches my inbox. Drafts replies.'}), 'Watches my inbox');
  const long = roleLine({name: 'Mail', instructions: 'Watches my inbox and drafts replies to the people who write to me, every morning before nine, and flags anything urgent.'});
  assert.ok(long.length <= 91 && long.endsWith('…') && !/\s…$/.test(long), long);
  assert.equal(roleLine({name: 'New', instructions: NO_JOB}), '');
});
