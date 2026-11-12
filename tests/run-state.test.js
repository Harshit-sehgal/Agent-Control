/** The run-status vocabulary is declared once, in `shared/run-state.js`, and
 * every reader derives from it. These tests are what stop the readers — the
 * orchestrator (`shared/coordination.js`), the Pages demo engine
 * (`shared/local-api.js`) and the stop route (`src/coordination.js`) — from
 * growing their own lists again and quietly disagreeing about what "busy" means.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {BUSY_STATUSES, INTERRUPT_STATUSES, STOPPABLE_STATUSES} from '../shared/run-state.js';
import {BUSY_STATUSES as VIA_COORDINATION, INTERRUPT_STATUSES as INTERRUPT_VIA_COORDINATION} from '../shared/coordination.js';

test('one declaration is the source every reader sees', () => {
  // The coordination module re-exports the same arrays rather than copies, so a
  // change in one place reaches every importer.
  assert.equal(VIA_COORDINATION, BUSY_STATUSES);
  assert.equal(INTERRUPT_VIA_COORDINATION, INTERRUPT_STATUSES);
});

test('the Pages run engine derives from the one declaration', async () => {
  // The demo used to keep its own copy of the busy set in `shared/local-runs.js`
  // and store runs beside it. It answers the same routes now and reads the same
  // vocabulary, so a fourth list cannot grow back.
  const source = await fs.readFile(new URL('../shared/local-api.js', import.meta.url), 'utf8');
  assert.match(source, /from '\.\/run-state\.js'/);
  assert.doesNotMatch(source, /local-runs\.js/);
});

test('the categories nest the way the transitions need them to', () => {
  // Everything a restart cuts is busy; a plan and a checkpoint are busy but not
  // cut, which is what lets Start and Continue survive a restart.
  for (const status of INTERRUPT_STATUSES) assert.ok(BUSY_STATUSES.includes(status), `${status} is busy`);
  assert.ok(!INTERRUPT_STATUSES.includes('awaiting_plan'));
  assert.ok(!INTERRUPT_STATUSES.includes('awaiting_checkpoint'));
  // Everything busy can be stopped, and no finished run can.
  assert.deepEqual([...STOPPABLE_STATUSES].sort(), [...BUSY_STATUSES].sort());
  for (const status of ['completed', 'failed', 'cancelled', 'interrupted']) {
    assert.ok(!BUSY_STATUSES.includes(status), `${status} is not busy`);
    assert.ok(!STOPPABLE_STATUSES.includes(status), `${status} cannot be stopped`);
  }
});

test('run-state stays pure, so the browser bundle can import it', async () => {
  const source = await fs.readFile(new URL('../shared/run-state.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /^\s*import\b/m, 'no imports: shared/ modules may not reach Node or the server');
  assert.doesNotMatch(source, /process\.env/, 'no environment reads in a browser-safe module');
});

test('a run can no longer wait on the X feed', () => {
  assert.equal(BUSY_STATUSES.includes('awaiting_feed'), false);
  assert.equal(INTERRUPT_STATUSES.includes('awaiting_feed'), false);
});
