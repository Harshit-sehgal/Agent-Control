import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {migrate,updateSettings,addCandidate,seedDemo,beginProcessing,finishProcessing,failProcessing,editDraft,draftAction,addGroup,addBot,updateBot,updateGroup,removeBot,removeGroup,recoverInterrupted,addSchedule,removeSchedule,resetDemo,removeCandidate,findDraft,findCandidate,attachRunDraft,SCHEMA_VERSION} from '../shared/workflow.js';
import {enqueueTask, completeTask, failTask} from '../shared/tasks.js';
import {initialState, minuteCeil} from '../shared/core.js';
import {createRouter} from '../src/router.js';
import {workflowRoutes} from '../src/routes-workflow.js';

const store = () => migrate(initialState());

test('migrate is idempotent and fills legacy state fields', () => {
  const legacy = {version: 1};
  const once = migrate(legacy);
  assert.equal(once.version, SCHEMA_VERSION);
  for (const key of ['candidates','drafts','runs','schedules','events','groups','groupRuns']) assert.ok(Array.isArray(once[key]), key);
  assert.deepEqual(once.groupMessages, {});
  const twice = migrate(once);
  assert.equal(twice.version, SCHEMA_VERSION);
  assert.deepEqual(twice, once);
  assert.throws(() => migrate(null), /Invalid stored state/);
});
test('migrate backfills every settings field the UI and approvals read', () => {
  // A legacy state can carry an empty or partial settings object. The Settings
  // form calls `topics.join(...)` and approvals read the delay window, so a
  // missing field used to be a hard failure rather than a fallback.
  const legacy = migrate({version: 1, settings: {}, candidates: []});
  assert.deepEqual(legacy.settings, {topics: [], style: '', opinions: '', minDelay: 2, maxDelay: 10});
  assert.equal(migrate({version: 1, settings: {topics: 'not-an-array', minDelay: 'soon'}}).settings.topics.length, 0);
  assert.equal(migrate({version: 1, settings: {minDelay: null, maxDelay: 9999}}).settings.minDelay, 2);
  // Existing valid values must never be overwritten.
  assert.deepEqual(migrate({settings: {topics: ['AI'], style: 'short', opinions: 'mine', minDelay: 0, maxDelay: 5}}).settings, {topics: ['AI'], style: 'short', opinions: 'mine', minDelay: 0, maxDelay: 5});
  // Still idempotent after the added backfill.
  const once = migrate({version: 1, settings: {}});
  assert.deepEqual(migrate(once), once);
});

test('a legacy state with no delay window can still approve a draft', () => {
  const s = migrate({version: 1, settings: {}, candidates: []});
  const c = addCandidate(s, {url: 'https://x.com/a/status/8', text: 'A candidate from a legacy workspace'}).candidate;
  const draft = finishProcessing(s, c.id, {score: 50}, {text: 'Draft body', mode: 'template', note: 'n'});
  assert.equal(draftAction(s, draft.id, 'approve', {}).status, 'scheduled');
});


test('candidate add dedupes identical posts and seed records demo items', () => {
  const s = store();
  const first = addCandidate(s, {url: 'https://x.com/a/status/1', text: 'A long enough robotics post for review', author: 'A'});
  assert.equal(first.duplicate, false);
  const second = addCandidate(s, {url: 'https://x.com/a/status/1', text: 'A long enough robotics post for review', author: 'A'});
  assert.equal(second.duplicate, true);
  assert.equal(s.candidates.length, 1);
  seedDemo(s, [{url: 'https://example.com/robotics-demo', text: 'sample post text here', author: 'Demo', topic: 'robotics'}]);
  assert.equal(s.candidates.filter(c => c.demo).length, 1);
  assert.equal(seedDemo(s, [{url: 'https://example.com/robotics-demo', text: 'sample post text here', author: 'Demo', topic: 'robotics'}]).added, 0);
});

test('processing marks an error state when drafting fails', () => {
  const s = store();
  const {candidate} = addCandidate(s, {url: 'https://x.com/a/status/2', text: 'A long enough AI discussion prompt for the queue'});
  const ctx = beginProcessing(s, candidate.id);
  assert.equal(ctx.candidate.status, 'processing');
  const draft = finishProcessing(s, candidate.id, {score: 80}, {text: 'Draft body', mode: 'template', note: 'n'});
  assert.equal(s.candidates[0].status, 'drafted');
  assert.equal(draft.revision, 1);
  assert.equal(draft.score, 80);

  const s2 = store();
  const c2 = addCandidate(s2, {url: 'https://x.com/a/status/3', text: 'Another sufficiently long candidate body'}).candidate;
  beginProcessing(s2, c2.id);
  failProcessing(s2, c2.id, 'provider timeout');
  assert.equal(s2.candidates[0].status, 'error');
  assert.match(s2.events[0].message, /provider timeout/);
});

test('editing a draft always invalidates a prior approval and schedule', () => {
  const s = store();
  const c = addCandidate(s, {url: 'https://x.com/a/status/4', text: 'A candidate used to test the draft lifecycle'}).candidate;
  const draft = finishProcessing(s, c.id, {score: 50}, {text: 'First text', mode: 'template', note: 'n'});
  draftAction(s, draft.id, 'approve', {minDelay: 0, maxDelay: 0});
  assert.equal(draft.status, 'scheduled');
  assert.equal(draft.approvedText, 'First text');
  const edited = editDraft(s, draft.id, 'A revised opinion after reviewing the source');
  assert.equal(edited.status, 'pending');
  assert.equal(edited.revision, 2);
  assert.equal(edited.approvedText, undefined);
  assert.equal(edited.dueAt, undefined);
  assert.throws(() => draftAction(s, draft.id, 'ready'), /Only scheduled/);
});

test('an approval can be pinned to a time, and only a sane one', () => {
  const s = store();
  const c = addCandidate(s, {url: 'https://x.com/a/status/6', text: 'A candidate used to test a pinned approval'}).candidate;
  const draft = finishProcessing(s, c.id, {score: 50}, {text: 'Pinned copy', mode: 'template', note: 'n'});
  const soon = Date.now() + 30 * 60000;
  assert.throws(() => draftAction(s, draft.id, 'approve', {dueAt: 'next tuesday'}), /cannot be read/);
  assert.throws(() => draftAction(s, draft.id, 'approve', {dueAt: new Date(Date.now() - 60000).toISOString()}), /at least a minute/);
  assert.throws(() => draftAction(s, draft.id, 'approve', {dueAt: new Date(Date.now() + 8 * 86400000).toISOString()}), /within the next 7 days/);
  // A refused time changes nothing: the draft is still waiting for a decision.
  assert.equal(draft.status, 'pending');
  const pinned = draftAction(s, draft.id, 'approve', {dueAt: new Date(soon).toISOString()});
  assert.equal(pinned.status, 'scheduled');
  assert.equal(new Date(pinned.dueAt).getTime(), soon, 'the exact instant is kept, not rounded to the delay window');
  // The frozen text is what makes the due check safe, so a pinned approval is the
  // same approval as a delay-window one.
  // The schedule sheet's own floor is a minute boundary rounded *up*: its value
  // has no seconds, so truncating "now + 60s" offers an instant as little as one
  // second away - valid to the input, refused by the server.
  for (const seconds of [0, 1, 45, 59]) {
    const wall = Math.floor(Date.now() / 60000) * 60000 + seconds * 1000;
    assert.ok(minuteCeil(wall + 60000) - wall >= 60000, `the floor for :${seconds} is at least a minute out`);
  }
  const offered = minuteCeil(Date.now() + 60000);
  const later = finishProcessing(s, addCandidate(s, {url: 'https://x.com/a/status/7', text: 'Another candidate for the floor'}).candidate.id, {score: 50}, {text: 'Floor copy', mode: 'template', note: 'n'});
  assert.equal(draftAction(s, later.id, 'approve', {dueAt: new Date(offered).toISOString()}).status, 'scheduled', 'the earliest time the sheet can offer is accepted');
  assert.equal(pinned.approvedText, 'Pinned copy');
  assert.equal(pinned.approvedRevision, pinned.revision);
});

test('a skipped draft can come back, and nothing else can', () => {
  const s = store();
  const c = addCandidate(s, {url: 'https://x.com/a/status/7', text: 'A candidate used to test restoring a skip'}).candidate;
  const draft = finishProcessing(s, c.id, {score: 30}, {text: 'Draft worth keeping', mode: 'template', note: 'n'});
  assert.throws(() => draftAction(s, draft.id, 'restore'), /Only a skipped draft/);
  draftAction(s, draft.id, 'reject');
  const back = draftAction(s, draft.id, 'restore');
  assert.equal(back.status, 'pending');
  assert.equal(back.text, 'Draft worth keeping', 'the text is the one that was skipped, not a rewrite');
  assert.ok(s.events.some(e => e.type === 'restore' && e.meta?.draftId === draft.id), 'the history says it came back');
});

test('posted requires a matching ready approval and cannot be edited after', () => {
  const s = store();
  const c = addCandidate(s, {url: 'https://x.com/a/status/5', text: 'Yet another long enough candidate body here'}).candidate;
  const draft = finishProcessing(s, c.id, {score: 40}, {text: 'Approved copy', mode: 'template', note: 'n'});
  assert.throws(() => draftAction(s, draft.id, 'posted'), /Only ready/);
  draftAction(s, draft.id, 'approve', {minDelay: 0, maxDelay: 0});
  draftAction(s, draft.id, 'ready');
  assert.throws(() => draftAction(s, draft.id, 'posted', {url: 'javascript:alert(1)'}), /not a web address/);
  assert.equal(draft.status, 'ready', 'a refused link does not consume the ready state');
  const posted = draftAction(s, draft.id, 'posted', {url: ' https://x.com/a/status/5 '});
  assert.equal(posted.status, 'posted');
  assert.ok(posted.postedAt);
  assert.equal(posted.postedUrl, 'https://x.com/a/status/5', 'the link is recorded without the whitespace somebody pasted');
  assert.throws(() => editDraft(s, draft.id, 'too late'), /cannot be edited/);
  assert.throws(() => draftAction(s, draft.id, 'reject'), /Cannot reject/);
});

test('settings validation rejects impossible delay windows', () => {
  const s = store();
  assert.throws(() => updateSettings(s, {minDelay: 11, maxDelay: 3}), /Invalid delay window/);
  assert.throws(() => updateSettings(s, {topics: 'AI'}), /Topics must be an array/);
  const result = updateSettings(s, {topics: ['AI', 'robotics'], minDelay: 0, maxDelay: 5});
  assert.deepEqual(result.topics, ['AI', 'robotics']);
  assert.equal(result.maxDelay, 5);
});

test('migrate() converts legacy reminder schedules into structured tasks', () => {
  const legacy = store();
  legacy.schedules = [
    {id: 'r1', label: 'Old once', kind: 'once', nextAt: new Date(Date.now() - 1000).toISOString(), intervalMinutes: null, enabled: true},
    {id: 'r2', label: 'Old interval', kind: 'interval', nextAt: new Date(Date.now() + 60000).toISOString(), intervalMinutes: 42, enabled: true},
    {id: 'r3', label: 'Disabled', kind: 'interval', nextAt: new Date(Date.now() + 60000).toISOString(), intervalMinutes: 42, enabled: false},
  ];
  migrate(legacy);
  assert.deepEqual(legacy.schedules, []);
  assert.equal(legacy.tasks.length, 3);
  assert.ok(legacy.tasks.every(t => t.kind === 'reminder' && t.payload.label && t.status));
  const done = legacy.tasks.find(t => t.payload.label === 'Old once');
  assert.equal(done.status, 'done', 'A one-off whose time already passed must not fire late.');
  assert.equal(legacy.tasks.find(t => t.payload.label === 'Disabled').status, 'done');
  // Migration is idempotent and does not re-convert.
  migrate(legacy);
  assert.equal(legacy.tasks.length, 3);
  assert.equal(legacy.version, SCHEMA_VERSION);
});

test('groups, bots and structured tasks validate and persist', () => {
  const s = store();
  assert.throws(() => addGroup(s, {name: '  '}), /Group name required/);
  const g = addGroup(s, {name: 'Insights', description: 'Research'});
  assert.throws(() => addBot(s, 'missing', {name: 'x', instructions: 'y'}), /Group not found/);
  const b = addBot(s, g.id, {name: 'Summarizer', instructions: 'Summarize input'});
  assert.equal(g.bots[0].id, b.id);
  // Reminder creation now writes a structured task, not a passive schedule row.
  assert.throws(() => addSchedule(s, {label: 'x', kind: 'nope'}), /valid schedule kind/);
  const item = addSchedule(s, {label: 'Check queue', kind: 'interval', intervalMinutes: 60});
  assert.equal(s.tasks.length, 1);
  assert.equal(s.tasks[0].kind, 'reminder');
  assert.equal(s.tasks[0].payload.label, 'Check queue');
  assert.equal(s.schedules.length, 0, 'The legacy schedules collection is emptied by migration.');
  removeSchedule(s, item.id);
  assert.equal(s.tasks[0].status, 'cancelled');
  assert.throws(() => removeSchedule(s, 'none'), /Schedule not found/);
});

test('lookups fail with an HTTP status for the API layer', () => {
  const s = store();
  assert.throws(() => findDraft(s, 'nope'), error => error.status === 404);
  assert.throws(() => findCandidate(s, 'nope'), error => error.status === 404);
});

test('resetDemo removes demo candidates and their drafts only', () => {
  const s = store();
  seedDemo(s, [{url: 'https://example.com/demo', text: 'demo candidate text here', author: 'Demo', topic: 'AI'}]);
  const demo = s.candidates[0];
  finishProcessing(s, demo.id, {score: 10}, {text: 'demo draft', mode: 'template', note: 'n'});
  const real = addCandidate(s, {url: 'https://x.com/real/status/1', text: 'A real candidate with enough length'}).candidate;
  finishProcessing(s, real.id, {score: 20}, {text: 'real draft', mode: 'template', note: 'n'});
  resetDemo(s);
  assert.equal(s.candidates.length, 1);
  assert.equal(s.candidates[0].id, real.id);
  assert.equal(s.drafts.length, 1);
  assert.equal(s.drafts[0].candidateId, real.id);
});
test('bot profile edits persist through the shared workflow rules', () => {
  const s = store();
  const g = s.groups[0];
  const bot = g.bots.find(b => b.id === 'writer');
  const updated = updateBot(s, g.id, bot.id, {name: 'Senior Writer', instructions: 'Draft concise replies in the user voice.'});
  assert.equal(updated.name, 'Senior Writer');
  assert.equal(g.bots.find(b => b.id === 'writer').name, 'Senior Writer');
  assert.match(s.events[0].message, /Updated bot Senior Writer/);
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
  const reviewer = g.bots.find(b => b.id === 'reviewer');
  assert.throws(() => updateBot(s, g.id, reviewer.id, {name: 'Writer'}), error => error.status === 409 && /already in this group/.test(error.message));
  assert.equal(g.bots.find(b => b.id === 'reviewer').name, 'Reviewer', 'A refused rename changes nothing.');
  // Case and padding do not make a different name.
  assert.throws(() => updateBot(s, g.id, reviewer.id, {name: ' writer '}), {status: 409});
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

test('a group-run reply becomes a pending draft only for a captured post the bot may draft', () => {
  const s = store();
  const url = 'https://x.com/ada/status/9';
  addCandidate(s, {url: 'https://x.com/ada', text: 'Short profile link is long enough.', author: 'Ada'});
  const candidate = addCandidate(s, {url, text: 'Rockets slipped a day and the window moved.', author: 'Ada'}).candidate;
  const reply = 'The pad timeline slipped by a day. I would wait for the next window before calling it a delay.';
  const writer = {id: 'writer', type: 'writing', name: 'Writer'};
  assert.equal(attachRunDraft(s, {bot: writer, output: reply, sources: `please reply to ${url}`}).url, url);
  assert.equal(attachRunDraft(s, {bot: writer, output: reply, sources: `please reply to ${url}`})?.text, undefined);
  assert.equal(s.drafts[0].status, 'pending');
  assert.equal(s.drafts[0].text, reply);
  assert.equal(s.drafts[0].candidateId, candidate.id);
  assert.equal(attachRunDraft(s, {bot: writer, output: reply, sources: url}), null, 'A post that already has a draft is left alone.');
  const other = store();
  addCandidate(other, {url, text: 'Rockets slipped a day and the window moved.', author: 'Ada'});
  assert.equal(attachRunDraft(other, {bot: {type: 'writing', permissions: []}, output: reply, sources: url}), null);
  assert.equal(attachRunDraft(other, {bot: writer, output: 'No draft.', sources: url}), null);
  assert.equal(attachRunDraft(other, {bot: writer, output: reply, sources: 'no link here'}), null);
  assert.equal(other.drafts.length, 0);
});

test('candidates stranded in processing by a crash become processable again', () => {
  const s = store();
  const c = addCandidate(s, {url: 'https://x.com/a/status/7', text: 'A candidate interrupted mid-draft'}).candidate;
  beginProcessing(s, c.id);
  assert.equal(s.candidates[0].status, 'processing');
  // Re-running it before recovery must still be rejected.
  assert.throws(() => beginProcessing(s, c.id), /already processing/);
  assert.deepEqual(recoverInterrupted(s), {recovered: 1});
  assert.equal(s.candidates[0].status, 'new');
  assert.doesNotThrow(() => beginProcessing(s, c.id));
  // Idempotent: a pass over clean state releases nothing.
  assert.deepEqual(recoverInterrupted({...s, candidates: [{status: 'new'}]}), {recovered: 0});
});

test('removing a bot cancels an in-flight scheduled task so completion cannot re-arm it', () => {
  const s = store();
  const g = s.groups[0];
  const task = enqueueTask(s, {kind: 'bot-task', payload: {groupId: g.id, botId: 'scout', message: 'daily', kind: 'interval', intervalMinutes: 60}}).task;
  const kept = enqueueTask(s, {kind: 'bot-task', payload: {groupId: g.id, botId: 'writer', message: 'weekly', kind: 'interval', intervalMinutes: 60}}).task;
  task.status = 'running';
  kept.status = 'running';
  const runAt = task.runAt;
  removeBot(s, g.id, 'scout');
  assert.equal(task.status, 'cancelled');
  assert.equal(kept.status, 'running');
  completeTask(s, task.id, {ok: true});
  failTask(s, task.id, 'A group run is already active.');
  assert.equal(task.status, 'cancelled');
  assert.equal(task.runAt, runAt);
});

test('removing a bot denies its waiting pages and cancels busy runs it was holding', () => {
  const s = store();
  s.browserRequests = [
    {id: 'own', botId: 'scout', chatKey: 'scout', status: 'pending'},
    {id: 'team', botId: 'scout', chatKey: 'team-x-engage', runId: 'g1', status: 'pending'},
    {id: 'keep', botId: 'writer', chatKey: 'writer', status: 'pending'},
  ];
  s.groupRuns = [
    {id: 'own', chatKey: 'scout', groupId: 'x-engage', status: 'awaiting_browser'},
    {id: 'g1', chatKey: 'team-x-engage', groupId: 'x-engage', status: 'awaiting_browser'},
    {id: 'keep', chatKey: 'writer', groupId: 'x-engage', status: 'awaiting_plan'},
  ];
  removeBot(s, 'x-engage', 'scout');
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

test('rewrite drops the previous approval, and a provider failure leaves it', async () => {
  const s = store();
  const c = addCandidate(s, {url: 'https://x.com/a/status/9', text: 'A candidate long enough to rewrite after approval'}).candidate;
  const draft = finishProcessing(s, c.id, {score: 40}, {text: 'Approved copy', mode: 'template', note: 'n'});
  draftAction(s, draft.id, 'approve', {minDelay: 0, maxDelay: 0});
  assert.ok(draft.approvedEvidence?.length);
  const router = createRouter();
  workflowRoutes(router, {auth: {listWorkspaces: () => [], roleOf: () => 'owner'}, processCandidate: async () => {}});
  const handler = router.find('POST', `/api/drafts/${draft.id}/rewrite`).route.handler;
  const ctx = body => ({params: {id: draft.id}, body: async () => body, store: {read: () => s, update: async fn => fn(s)}, actor: {email: 'a@b.c', workspaceId: 'default'}});
  const saved = ['AI_API_KEY', 'OPENAI_API_KEY', 'AI_BASE_URL', 'OPENAI_BASE_URL', 'AI_API_STYLE', 'AI_MODEL'].map(k => [k, process.env[k]]);
  const setEnv = values => { for (const [k, v] of Object.entries(values)) { if (v) process.env[k] = v; else delete process.env[k]; } };
  const restore = () => { for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
  const down = http.createServer((req, res) => { req.resume(); res.writeHead(500, {'Content-Type': 'application/json'}); res.end(JSON.stringify({error: {message: 'boom'}})); });
  await new Promise(r => down.listen(0, '127.0.0.1', r));
  try {
    setEnv({AI_BASE_URL: `http://127.0.0.1:${down.address().port}/v1`, AI_API_KEY: 'sk-test-secret', AI_API_STYLE: 'chat', AI_MODEL: 'auto', OPENAI_API_KEY: '', OPENAI_BASE_URL: ''});
    await assert.rejects(() => handler(ctx({direction: 'shorter'})), /500/);
    assert.equal(draft.status, 'scheduled');
    assert.equal(draft.approvedText, 'Approved copy');
    assert.ok(draft.approvedEvidence?.length);
    setEnv({AI_API_KEY: '', OPENAI_API_KEY: '', AI_BASE_URL: '', OPENAI_BASE_URL: '', AI_API_STYLE: '', AI_MODEL: ''});
    const rewritten = await handler(ctx({direction: 'shorter'}));
    assert.equal(rewritten.status, 'pending');
    assert.equal(rewritten.revision, 2);
    assert.equal(rewritten.approvedText, undefined);
    assert.equal(rewritten.approvedRevision, undefined);
    assert.equal(rewritten.approvedEvidence, undefined);
    assert.equal(rewritten.dueAt, undefined);
  } finally {
    restore();
    await new Promise(r => down.close(r));
  }
});

test('removing a captured post takes its uncommitted work and refuses a committed one', () => {
  const s = store();
  const c = addCandidate(s, {url: 'https://x.com/a/status/11', text: 'A captured post that should be removable'}).candidate;
  const draft = finishProcessing(s, c.id, {score: 40}, {text: 'Pending copy', mode: 'template', note: 'n'});
  assert.ok(s.evidence.some(e => e.candidateId === c.id), 'the capture seeded its own source');
  removeCandidate(s, c.id);
  assert.equal(s.candidates.length, 0);
  assert.equal(s.drafts.length, 0);
  // The sources went with the drafts: a row pointing at a post nobody can open
  // is a claim with no subject, and it would keep counting in every summary.
  assert.equal(s.evidence.filter(e => e.draftId === draft.id || e.candidateId === c.id).length, 0);

  // An approved draft is a person's decision. Deleting the capture under it
  // would withdraw that approval without asking, so it refuses and names the
  // draft that has to go first.
  const kept = addCandidate(s, {url: 'https://x.com/a/status/12', text: 'Another captured post with an approval'}).candidate;
  const approved = finishProcessing(s, kept.id, {score: 50}, {text: 'Approved copy', mode: 'template', note: 'n'});
  draftAction(s, approved.id, 'approve', {minDelay: 0, maxDelay: 0});
  assert.equal(approved.status, 'scheduled');
  assert.throws(() => removeCandidate(s, kept.id), /scheduled draft/);
  assert.equal(s.candidates.length, 1);
  assert.throws(() => removeCandidate(s, 'missing'), /Candidate not found/);
});

test('a post with a draft waiting on a person is not processed into a second one', () => {
  const s = store();
  const c = addCandidate(s, {url: 'https://x.com/someone/status/9', text: 'A candidate with enough text to draft.'}).candidate;
  beginProcessing(s, c.id);
  finishProcessing(s, c.id, {score: 50}, {text: 'first draft', mode: 'template', note: 'n'});
  // `finishProcessing` unshifts, so a second pass left two drafts for one post and
  // approving either one stranded the other in the queue forever.
  assert.throws(() => beginProcessing(s, c.id), error => error.status === 409 && /already has a draft waiting/.test(error.message));
  assert.equal(s.drafts.filter(d => d.candidateId === c.id).length, 1);
  // Once the draft is decided, a new pass is allowed again.
  draftAction(s, s.drafts[0].id, 'reject');
  assert.equal(beginProcessing(s, c.id).candidate.status, 'processing');
});

test('a demo reset takes the demo evidence with it', () => {
  const s = store();
  seedDemo(s, [{url: 'https://example.com/demo', text: 'demo candidate text here', author: 'Demo', topic: 'AI'}]);
  const demo = s.candidates[0];
  finishProcessing(s, demo.id, {score: 10}, {text: 'demo draft', mode: 'template', note: 'n'});
  assert.ok(s.evidence.some(e => e.candidateId === demo.id));
  // Reset twice: the old reset only dropped candidates and drafts, so each cycle
  // left another orphaned evidence row behind, forever.
  for (let i = 0; i < 2; i++) {
    resetDemo(s);
    assert.deepEqual(s.evidence.filter(e => e.candidateId === demo.id), []);
    seedDemo(s, [{url: 'https://example.com/demo', text: 'demo candidate text here', author: 'Demo', topic: 'AI'}]);
    finishProcessing(s, s.candidates.find(c => c.demo).id, {score: 10}, {text: 'demo draft', mode: 'template', note: 'n'});
  }
  resetDemo(s);
  assert.equal(s.evidence.length, 0, 'nothing is left pointing at a candidate that is gone');
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
