import test from 'node:test';
import assert from 'node:assert/strict';
import {pruneState, normalizeRetention} from '../shared/retention.js';

const days = n => n * 86400000;
const at = (now, back) => new Date(now - back).toISOString();
const policy = {events: 90, doneTasks: 30, runs: 30};

test('a record with no timestamp is recent, not ancient', () => {
  const now = Date.now();
  const state = {
    events: [{id: 'undated', kind: 'note'}, {id: 'old', at: at(now, days(120))}, {id: 'recent', at: at(now, days(1))}],
    tasks: [],
    // A run record written before `at` was always set is the shape that used to
    // parse as NaN and get pruned with everything around it.
    runs: [{id: 'r-undated'}, {id: 'r-old', at: at(now, days(120))}],
  };
  const report = pruneState(state, {now, policy});
  // Pruning writes its own activity line, so compare the records that were there.
  assert.deepEqual(state.events.filter(e => e.type !== 'retention').map(e => e.id), ['undated', 'recent']);
  assert.deepEqual(state.runs.map(r => r.id), ['r-undated']);
  assert.equal(report.events, 1);
  assert.equal(report.runs, 1);
});

test('finished tasks are pruned on completion or update, queued work never is', () => {
  const now = Date.now();
  const state = {
    events: [],
    tasks: [
      {id: 'done-old', status: 'done', completedAt: at(now, days(40))},
      {id: 'failed-old', status: 'failed', updatedAt: at(now, days(40))},
      {id: 'queued-old', status: 'queued', updatedAt: at(now, days(400))},
      {id: 'done-undated', status: 'done'},
      {id: 'done-fresh', status: 'done', completedAt: at(now, days(2))},
    ],
    runs: [],
  };
  const report = pruneState(state, {now, policy});
  assert.deepEqual(state.tasks.map(t => t.id), ['queued-old', 'done-undated', 'done-fresh']);
  assert.equal(report.doneTasks, 2, 'An untimestamped record is kept, not pruned.');
});

test('group runs are pruned when settled and kept while a person or a restart can resume them', () => {
  const now = Date.now();
  const old = at(now, days(40));
  const state = {
    events: [],
    tasks: [],
    runs: [{id: 'r-old', at: old}],
    groupRuns: [
      {id: 'done', status: 'completed', completedAt: old},
      {id: 'failed', status: 'failed', updatedAt: old},
      {id: 'undated-failed', status: 'failed'},
      {id: 'running', status: 'running', updatedAt: old},
      {id: 'paused', status: 'awaiting_checkpoint', updatedAt: old},
      {id: 'plan', status: 'awaiting_plan', updatedAt: old},
      {id: 'fresh', status: 'completed', completedAt: at(now, days(1))},
    ],
  };
  const report = pruneState(state, {now, policy});
  assert.deepEqual(state.groupRuns.map(r => r.id), ['undated-failed', 'running', 'paused', 'plan', 'fresh']);
  // Group runs count under the `runs` policy: that is the knob the settings
  // page shows and the number the preview reports.
  assert.equal(report.runs, 3, 'Two settled runs and the old run record.');
  assert.equal(state.runs.length, 0);
});

test('a dry run reports group runs without deleting them', () => {
  const now = Date.now();
  const old = at(now, days(40));
  const state = {
    events: [{id: 'e', at: old}],
    tasks: [],
    runs: [],
    groupRuns: [{id: 'done', status: 'completed', completedAt: old}],
  };
  const report = pruneState(state, {now, policy, dryRun: true});
  assert.equal(report.dryRun, true);
  assert.equal(report.runs, 1);
  assert.equal(state.groupRuns.length, 1);
  assert.equal(state.events.length, 1);
});

test('retention still refuses a typo and 0 disables pruning', () => {
  assert.throws(() => normalizeRetention({runs: 5000}), /0–1825 days/);
  const state = {events: [{id: 'e', at: at(Date.now(), days(4000))}], tasks: [], runs: [{id: 'r'}], groupRuns: [{id: 'g', status: 'completed', completedAt: at(Date.now(), days(4000))}]};
  const report = pruneState(state, {now: Date.now(), policy: {events: 0, doneTasks: 0, runs: 0}});
  assert.deepEqual(report, {events: 0, doneTasks: 0, runs: 0, dryRun: false});
  assert.equal(state.groupRuns.length, 1);
});
