// The health watch tells the owner, once, when something stops their bots from working while nobody looks:
// a paired computer gone quiet while schedules wait on it, background work running late, or a site that
// signed a scheduled task out. It says so again only after the problem cleared, and says when it is back.
import test from 'node:test';
import assert from 'node:assert/strict';
import {healthIssues, alertChanges, createHealthWatch, signinSites, signinNotice, AGENT_GRACE_MS, QUEUE_LAG_MS} from '../src/health-watch.js';

const NOW = Date.parse('2026-11-25T12:00:00Z');
const ago = ms => new Date(NOW - ms).toISOString();
const schedule = (over = {}) => ({id: 's1', kind: 'bot-task', status: 'queued', runAt: new Date(NOW + 3600000).toISOString(), payload: {botId: 'b1', message: 'Check X'}, ...over});

test('a quiet computer is an issue only when a schedule waits on it', () => {
  const agents = [{id: 'a1', name: 'Laptop', lastSeenAt: ago(AGENT_GRACE_MS + 60000)}];
  assert.deepEqual(healthIssues({agents, tasks: [], now: NOW}), [], 'no schedule, nothing to say');
  const [issue] = healthIssues({agents, tasks: [schedule()], now: NOW});
  assert.equal(issue.key, 'agent-offline:a1');
  assert.match(issue.title, /Laptop/);
  assert.match(issue.body, /1 schedule/);
  assert.deepEqual(healthIssues({agents: [{...agents[0], lastSeenAt: ago(60000)}], tasks: [schedule()], now: NOW}), [], 'seen a minute ago');
  assert.deepEqual(healthIssues({agents: [{...agents[0], revokedAt: ago(1)}], tasks: [schedule()], now: NOW}), [], 'a removed computer is not missed');
  assert.deepEqual(healthIssues({agents: [{...agents[0], lastSeenAt: null}], tasks: [schedule()], now: NOW}), [], 'paired but never started is the setup checklist\'s job');
  assert.deepEqual(healthIssues({agents, tasks: [schedule({status: 'paused'})], now: NOW}), [], 'a paused schedule waits on nothing');
});

test('work that is late past the lag is one issue, counted', () => {
  const late = {id: 't1', kind: 'group-run', status: 'queued', runAt: ago(QUEUE_LAG_MS + 1000)};
  const onTime = {id: 't2', kind: 'group-run', status: 'queued', runAt: ago(1000)};
  const [issue] = healthIssues({agents: [], tasks: [late, onTime, {...late, id: 't3'}], now: NOW});
  assert.equal(issue.key, 'queue-behind');
  assert.match(issue.body, /2 background tasks/);
  assert.deepEqual(healthIssues({agents: [], tasks: [onTime], now: NOW}), []);
  assert.deepEqual(healthIssues({agents: [], tasks: [late], schedulesPaused: true, now: NOW}), [], 'the kill switch holds work on purpose');
});

test('an alert is raised once and cleared once', () => {
  const issue = {key: 'queue-behind', title: 't', body: 'b'};
  assert.deepEqual(alertChanges([], [issue]), {raise: [issue], clear: [], keys: ['queue-behind']});
  assert.deepEqual(alertChanges(['queue-behind'], [issue]), {raise: [], clear: [], keys: ['queue-behind']});
  assert.deepEqual(alertChanges(['queue-behind'], []), {raise: [], clear: ['queue-behind'], keys: []});
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

test('the watch notifies urgently once, stays quiet while it lasts, and says when it is back', async () => {
  const agents = [{id: 'a1', name: 'Laptop', lastSeenAt: ago(AGENT_GRACE_MS * 2)}];
  const ws = fakeWorkspace({tasks: [schedule()]}, agents);
  const sent = [];
  const watch = createHealthWatch(ws, {notify: async event => { sent.push(event); }, now: () => NOW});
  await watch.tick();
  await watch.tick();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].urgent, true);
  assert.equal(sent[0].kind, 'health');
  assert.match(sent[0].title, /Laptop/);
  // The raised keys live in the workspace, so a restart does not send it again.
  const again = createHealthWatch(ws, {notify: async event => { sent.push(event); }, now: () => NOW});
  await again.tick();
  assert.equal(sent.length, 1);
  agents[0].lastSeenAt = ago(1000);
  await again.tick();
  assert.equal(sent.length, 2);
  assert.equal(sent[1].urgent, false);
  assert.match(sent[1].title, /back/i);
});

test('a watch that cannot read the store logs and keeps going', async () => {
  const ws = {read: () => { throw new Error('closed'); }, all: () => [], kvGet: () => null, kvSet: () => {}};
  const errors = [];
  const watch = createHealthWatch(ws, {notify: async () => {}, now: () => NOW, log: message => errors.push(message)});
  await watch.tick();
  assert.equal(errors.length, 1);
});

test('the sites a scheduled task was signed out of come from its sign-in cards', () => {
  const card = site => ({kind: 'setup', setup: JSON.stringify({action: 'signin', site})});
  const lines = [card('x.com'), {kind: 'setup', setup: JSON.stringify({action: 'signin', url: 'https://www.linkedin.com/'})}, {kind: 'setup', setup: JSON.stringify({action: 'connect', app: 'gmail'})}, {kind: 'setup', setup: '{bad'}, {text: 'hi'}, card('x.com')];
  assert.deepEqual(signinSites(lines), ['x.com', 'linkedin.com']);
  const note = signinNotice({botName: 'Scout', sites: ['x.com']});
  assert.equal(note.urgent, true);
  assert.match(note.title, /x\.com/);
  assert.match(note.body, /Scout/);
});

test('a scheduled run that meets a sign-in wall tells the owner at once; one the owner watches does not', async t => {
  const {company, model, ask} = await import('./run-fixture.js');
  const {store} = await company(t);
  const sent = [];
  store.notify = async event => { sent.push(event); };
  const signin = '```setup\n{"action":"signin","site":"x.com"}\n```\nI need you to sign in to X.';
  const ai = model({Atlas: signin});
  await ask(store, {message: 'Check my X mentions', executor: ai.executor, extra: {unattended: true}});
  await new Promise(resolve => setTimeout(resolve, 20));
  const notes = sent.filter(n => n.kind === 'health');
  assert.equal(notes.length, 1, JSON.stringify(sent));
  assert.equal(notes[0].urgent, true);
  assert.match(notes[0].title, /x\.com/);
  sent.length = 0;
  await ask(store, {message: 'Check my X mentions', executor: model({Atlas: signin}).executor});
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(sent.filter(n => n.kind === 'health'), [], 'the owner is in the chat and sees the card');
});

test('a nightly backup older than a day and a half is an issue, only when the backup folder is set', async t => {
  const {BACKUP_STALE_MS, newestBackupAt} = await import('../src/health-watch.js');
  assert.deepEqual(healthIssues({lastBackupAt: undefined, now: NOW}), [], 'no folder set, nothing watched');
  const [issue] = healthIssues({lastBackupAt: NOW - BACKUP_STALE_MS - 60000, now: NOW});
  assert.equal(issue.key, 'backup-stale');
  assert.match(issue.body, /backup/i);
  assert.equal(healthIssues({lastBackupAt: null, now: NOW})[0].key, 'backup-stale', 'a folder with no backup in it');
  assert.deepEqual(healthIssues({lastBackupAt: NOW - 3600000, now: NOW}), []);
  const fs = await import('node:fs/promises'), os = await import('node:os'), path = await import('node:path');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'backups-'));
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  assert.equal(await newestBackupAt(dir), null);
  await fs.writeFile(path.join(dir, 'notes.txt'), 'x');
  assert.equal(await newestBackupAt(dir), null, 'only backup files count');
  await fs.writeFile(path.join(dir, 'agent-control-20261125T020000Z.tgz.enc'), 'x');
  assert.ok(Math.abs(await newestBackupAt(dir) - Date.now()) < 60000);
  assert.equal(await newestBackupAt(path.join(dir, 'missing')), null);
});

test('only the first workspace watches the host\'s backup folder', async t => {
  const fs = await import('node:fs/promises'), os = await import('node:os'), path = await import('node:path');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'backups-'));
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  const sent = [];
  const notify = async event => { sent.push(event); };
  await createHealthWatch(fakeWorkspace({tasks: []}, []), {workspaceId: 'team-2', backupDir: dir, notify, now: () => NOW}).tick();
  assert.deepEqual(sent, []);
  await createHealthWatch(fakeWorkspace({tasks: []}, []), {workspaceId: 'default', backupDir: dir, notify, now: () => NOW}).tick();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].meta.health, 'backup-stale');
  assert.equal(sent[0].urgent, true);
});
