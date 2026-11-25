// The health watch tells the owner, once, when something stops their bots from working while nobody looks:
// a paired computer gone quiet while a schedule is due, background work running late, a nightly backup that
// stopped, or a site that signed a scheduled task out. A problem must be seen on two checks in a row, so the
// late work every boot finds is not an alert; it is said again only after it cleared, with a "back" notice.
import test from 'node:test';
import assert from 'node:assert/strict';
import {healthIssues, alertChanges, createHealthWatch, signinSites, signinNotice, readBackupFolder, AGENT_GRACE_MS, QUEUE_LAG_MS, BACKUP_STALE_MS} from '../src/health-watch.js';

const NOW = Date.parse('2026-11-25T12:00:00Z');
const ago = ms => new Date(NOW - ms).toISOString();
const soon = new Date(NOW + 5 * 60000).toISOString(), tomorrow = new Date(NOW + 86400000).toISOString();
const schedule = (over = {}) => ({id: 's1', kind: 'bot-task', status: 'queued', runAt: soon, payload: {botId: 'b1', message: 'Check X'}, ...over});
const laptop = (over = {}) => ({id: 'a1', name: 'Laptop', lastSeenAt: ago(AGENT_GRACE_MS + 60000), ...over});

test('a quiet computer is an issue only when a schedule is due soon', () => {
  assert.deepEqual(healthIssues({agents: [laptop()], tasks: [], now: NOW}), [], 'no schedule, nothing to say');
  assert.deepEqual(healthIssues({agents: [laptop()], tasks: [schedule({runAt: tomorrow})], now: NOW}), [], 'a laptop asleep with tomorrow\'s briefing queued');
  const [issue] = healthIssues({agents: [laptop()], tasks: [schedule()], now: NOW});
  assert.equal(issue.key, 'agent-offline:a1');
  assert.equal(issue.urgent, false, 'not worth waking the owner');
  assert.match(issue.title, /Laptop/);
  assert.match(issue.body, /1 schedule due soon/);
  assert.deepEqual(healthIssues({agents: [laptop({lastSeenAt: ago(60000)})], tasks: [schedule()], now: NOW}), [], 'seen a minute ago');
  assert.deepEqual(healthIssues({agents: [laptop({revokedAt: ago(1)})], tasks: [schedule()], now: NOW}), [], 'a removed computer is not missed');
  assert.deepEqual(healthIssues({agents: [laptop({lastSeenAt: null})], tasks: [schedule()], now: NOW}), [], 'paired but never started is the setup checklist\'s job');
  assert.deepEqual(healthIssues({agents: [laptop()], tasks: [schedule({status: 'paused'})], now: NOW}), [], 'a paused schedule waits on nothing');
  assert.deepEqual(healthIssues({agents: [laptop()], tasks: [schedule()], schedulesPaused: true, now: NOW}), [], 'the kill switch holds it');
});

test('work that is late past the lag is one urgent issue, counted', () => {
  const late = {id: 't1', kind: 'group-run', status: 'queued', runAt: ago(QUEUE_LAG_MS + 1000)};
  const onTime = {id: 't2', kind: 'group-run', status: 'queued', runAt: ago(1000)};
  const [issue] = healthIssues({agents: [], tasks: [late, onTime, {...late, id: 't3'}], now: NOW});
  assert.equal(issue.key, 'queue-behind');
  assert.equal(issue.urgent, true);
  assert.match(issue.body, /2 background tasks/);
  assert.deepEqual(healthIssues({agents: [], tasks: [onTime], now: NOW}), []);
  assert.deepEqual(healthIssues({agents: [], tasks: [late], schedulesPaused: true, now: NOW}), [], 'the kill switch holds work on purpose');
});

test('a problem is said once it is seen twice, and cleared at once', () => {
  const issue = {key: 'queue-behind', title: 't', body: 'b'};
  assert.deepEqual(alertChanges([], [issue], new Set()), {raise: [], clear: [], keys: []}, 'first sighting');
  assert.deepEqual(alertChanges([], [issue], new Set(['queue-behind'])), {raise: [issue], clear: [], keys: ['queue-behind']});
  assert.deepEqual(alertChanges(['queue-behind'], [issue], new Set(['queue-behind'])), {raise: [], clear: [], keys: ['queue-behind']});
  assert.deepEqual(alertChanges(['queue-behind'], [], new Set(['queue-behind'])), {raise: [], clear: ['queue-behind'], keys: []});
});

function fakeWorkspace(state, agents) {
  const kv = new Map();
  return {
    read: () => structuredClone(state),
    all: () => agents.map(a => ({id: a.id, name: a.name, last_seen_at: a.lastSeenAt, revoked_at: a.revokedAt || null})),
    kvGet: key => kv.get(key) ?? null,
    kvSet: (key, value) => kv.set(key, value),
    kv,
  };
}

test('the watch says nothing on the first check, notifies once after the second, and says when it is back', async () => {
  const agents = [laptop({lastSeenAt: ago(AGENT_GRACE_MS * 2)})];
  const ws = fakeWorkspace({tasks: [schedule()]}, agents);
  const sent = [];
  const watch = createHealthWatch(ws, {notify: async event => { sent.push(event); }, now: () => NOW});
  await watch.tick();
  assert.equal(sent.length, 0, 'one sighting is not enough');
  await watch.tick();
  await watch.tick();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].urgent, false);
  assert.equal(sent[0].kind, 'health');
  assert.match(sent[0].title, /Laptop/);
  // The said keys live in the workspace, so a restart does not send it again.
  const again = createHealthWatch(ws, {notify: async event => { sent.push(event); }, now: () => NOW});
  await again.tick();
  await again.tick();
  assert.equal(sent.length, 1);
  agents[0].lastSeenAt = ago(1000);
  await again.tick();
  assert.equal(sent.length, 2);
  assert.equal(sent[1].urgent, false);
  assert.match(sent[1].title, /back/i);
});

test('late work found by the first check after boot is not an alert when the queue drains', async () => {
  const state = {tasks: [{id: 't1', kind: 'group-run', status: 'queued', runAt: ago(QUEUE_LAG_MS * 4)}]};
  const ws = fakeWorkspace(state, []);
  ws.read = () => structuredClone(state);
  const sent = [];
  const watch = createHealthWatch(ws, {notify: async event => { sent.push(event); }, now: () => NOW});
  await watch.tick();
  state.tasks = [];
  await watch.tick();
  assert.deepEqual(sent, []);
  state.tasks = [{id: 't2', kind: 'group-run', status: 'queued', runAt: ago(QUEUE_LAG_MS * 2)}];
  await watch.tick();
  await watch.tick();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].urgent, true, 'work that stays late is urgent');
});

test('a watch that cannot read the store logs and keeps going', async () => {
  const ws = {read: () => { throw new Error('closed'); }, all: () => [], kvGet: () => null, kvSet: () => {}};
  const errors = [];
  const watch = createHealthWatch(ws, {notify: async () => {}, now: () => NOW, log: message => errors.push(message)});
  await watch.tick();
  assert.equal(errors.length, 1);
});

test('the watch started on a timer stops after the check in flight', async () => {
  let release;
  const ws = {read: () => ({tasks: []}), all: () => [], kvGet: () => null, kvSet: () => {}, trackWork: async fn => { await new Promise(resolve => { release = resolve; }); return fn(); }};
  const stop = createHealthWatch(ws, {notify: async () => {}, now: () => NOW, intervalMs: 60000}).start();
  await new Promise(resolve => setImmediate(resolve));
  let stopped = false;
  const stopping = stop().then(() => { stopped = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stopped, false);
  release();
  await stopping;
  assert.equal(stopped, true);
});

test('the sites a scheduled task was signed out of come from its sign-in cards', () => {
  const card = site => ({kind: 'setup', setup: JSON.stringify({action: 'signin', site})});
  const lines = [card('x.com'), {kind: 'setup', setup: JSON.stringify({action: 'signin', url: 'https://www.linkedin.com/'})}, {kind: 'setup', setup: JSON.stringify({action: 'connect', app: 'gmail'})}, {kind: 'setup', setup: '{bad'}, {text: 'hi'}, card('x.com')];
  assert.deepEqual(signinSites(lines), ['x.com', 'linkedin.com']);
  const note = signinNotice({botName: 'Scout', sites: ['x.com']});
  assert.equal(note.urgent, false);
  assert.match(note.title, /x\.com/);
  assert.match(note.body, /Scout/);
});

test('a scheduled run that meets a sign-in wall tells the owner at once; one the owner watches does not', async t => {
  const {company, model, ask} = await import('./run-fixture.js');
  const {store} = await company(t);
  const sent = [];
  store.notify = async event => { sent.push(event); };
  const signin = '```setup\n{"action":"signin","site":"x.com"}\n```\nI need you to sign in to X.';
  await ask(store, {message: 'Check my X mentions', executor: model({Atlas: signin}).executor, extra: {unattended: true}});
  await new Promise(resolve => setTimeout(resolve, 20));
  const notes = sent.filter(n => n.kind === 'health');
  assert.equal(notes.length, 1, JSON.stringify(sent));
  assert.equal(notes[0].urgent, false);
  assert.match(notes[0].title, /x\.com/);
  sent.length = 0;
  await ask(store, {message: 'Check my X mentions', executor: model({Atlas: signin}).executor});
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(sent.filter(n => n.kind === 'health'), [], 'the owner is in the chat and sees the card');
});

test('a backup older than a day and a half, none at all, or a folder the app cannot read is an issue', async t => {
  assert.deepEqual(healthIssues({now: NOW}), [], 'no folder set, nothing watched');
  const stale = healthIssues({backup: {readable: true, newest: NOW - BACKUP_STALE_MS - 60000}, now: NOW})[0];
  assert.equal(stale.key, 'backup-stale');
  assert.equal(stale.urgent, false);
  assert.match(stale.title, /did not run/);
  assert.match(healthIssues({backup: {readable: true, newest: null}, now: NOW})[0].body, /no backup in it yet/);
  assert.match(healthIssues({backup: {readable: false, newest: null}, now: NOW})[0].title, /cannot be read/);
  assert.deepEqual(healthIssues({backup: {readable: true, newest: NOW - 3600000}, now: NOW}), []);
  const fs = await import('node:fs/promises'), os = await import('node:os'), path = await import('node:path');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'backups-'));
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  assert.deepEqual(await readBackupFolder(dir), {readable: true, newest: null});
  await fs.writeFile(path.join(dir, 'notes.txt'), 'x');
  assert.equal((await readBackupFolder(dir)).newest, null, 'only backup files count');
  await fs.writeFile(path.join(dir, 'agent-control-20261125T020000Z.tgz.enc'), 'x');
  assert.ok(Math.abs((await readBackupFolder(dir)).newest - Date.now()) < 60000);
  assert.deepEqual(await readBackupFolder(path.join(dir, 'missing')), {readable: false, newest: null});
});

test('only the first workspace watches the host\'s backup folder', async t => {
  const fs = await import('node:fs/promises'), os = await import('node:os'), path = await import('node:path');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'backups-'));
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  const sent = [];
  const notify = async event => { sent.push(event); };
  const other = createHealthWatch(fakeWorkspace({tasks: []}, []), {workspaceId: 'team-2', backupDir: dir, notify, now: () => NOW});
  await other.tick(); await other.tick();
  assert.deepEqual(sent, []);
  const first = createHealthWatch(fakeWorkspace({tasks: []}, []), {backupDir: dir, notify, now: () => NOW});
  await first.tick(); await first.tick();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].meta.health, 'backup-stale');
  assert.equal(sent[0].urgent, false);
});
