import test from 'node:test';
import assert from 'node:assert/strict';
import {migrate,updateSettings,addCandidate,seedDemo,beginProcessing,finishProcessing,failProcessing,editDraft,draftAction,addGroup,addBot,updateBot,recoverInterrupted,addSchedule,removeSchedule,resetDemo,findDraft,findCandidate,SCHEMA_VERSION} from '../shared/workflow.js';
import {initialState} from '../shared/core.js';

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

test('posted requires a matching ready approval and cannot be edited after', () => {
  const s = store();
  const c = addCandidate(s, {url: 'https://x.com/a/status/5', text: 'Yet another long enough candidate body here'}).candidate;
  const draft = finishProcessing(s, c.id, {score: 40}, {text: 'Approved copy', mode: 'template', note: 'n'});
  assert.throws(() => draftAction(s, draft.id, 'posted'), /Only ready/);
  draftAction(s, draft.id, 'approve', {minDelay: 0, maxDelay: 0});
  draftAction(s, draft.id, 'ready');
  const posted = draftAction(s, draft.id, 'posted');
  assert.equal(posted.status, 'posted');
  assert.ok(posted.postedAt);
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
