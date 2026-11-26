/** The pause and the kill switch must survive a restart. The store keeps only the payload of a task
 * verbatim, and the switch is a kv flag, so this test goes through the real SQLite store and reopens it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {SqliteStore} from '../src/sqlite-store.js';
import {enqueueTask, pauseTask, pauseAllSchedules, resumeAllSchedules, resumeTask} from '../shared/tasks.js';

async function sandbox() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-pause-'));
  return path.join(dir, 'state.db');
}
const open = db => new SqliteStore(db, path.join(path.dirname(db), 'state.json')).init();
const bodyFor = message => ({kind: 'bot-task', payload: {groupId: 'home', botId: 'atlas', message, kind: 'interval', intervalMinutes: 1440}});

test('a paused schedule stays paused after a restart, and resumes after it', async () => {
  const db = await sandbox();
  const first = await open(db);
  let id;
  await first.update(s => { id = enqueueTask(s, bodyFor('Check my feed')).task.id; });
  await first.update(s => pauseTask(s, id));

  const reopened = await open(db);
  const task = reopened.read().tasks.find(t => t.id === id);
  assert.equal(task.status, 'paused');
  assert.equal(task.payload.pausedBy, 'owner', 'who paused it survives the restart in the payload');
  await reopened.update(s => resumeTask(s, id));
  assert.equal((await open(db)).read().tasks.find(t => t.id === id).status, 'queued');
});

test('the kill switch survives a restart: held schedules stay held, new ones start held, and resume restores only its own', async () => {
  const db = await sandbox();
  const first = await open(db);
  let kept, byHand;
  await first.update(s => {
    kept = enqueueTask(s, bodyFor('Kill switch me')).task.id;
    byHand = enqueueTask(s, bodyFor('Owner paused me')).task.id;
    pauseTask(s, byHand);
    pauseAllSchedules(s);
  });

  const reopened = await open(db);
  assert.equal(reopened.read().schedulesPaused, true, 'the switch itself is saved');
  assert.equal(reopened.read().tasks.find(t => t.id === kept).status, 'paused');
  await reopened.update(s => enqueueTask(s, bodyFor('Made during the stop')));
  const madeDuring = reopened.read().tasks.find(t => t.payload.message === 'Made during the stop');
  assert.equal(madeDuring.status, 'paused', 'a new schedule made while the switch is on starts paused');

  const after = await open(db);
  await after.update(s => resumeAllSchedules(s));
  const final = (await open(db)).read();
  assert.equal(final.schedulesPaused, false);
  assert.equal(final.tasks.find(t => t.id === kept).status, 'queued');
  assert.equal(final.tasks.find(t => t.id === byHand).status, 'paused', 'the one the owner paused by hand stays paused');
});
