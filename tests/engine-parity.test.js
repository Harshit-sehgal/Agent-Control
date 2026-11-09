/** Run-engine parity: the GitHub Pages simulator against the served orchestrator.
 *
 * WHY this file exists: one group-run policy is implemented by two loops —
 * `simulateGroup` (shared/group-simulator.js, runs in the browser/Pages build)
 * and `runGroup` (src/coordination.js, runs on a served workspace). Both are
 * supposed to agree on who is in the roster, which bot runs when, where a run
 * pauses and resumes, when a missing outcome is retried once, and what the run
 * ends up as. Nothing tied them together, so they could drift and nobody would
 * notice until a user reported that a run behaves differently on Pages than on
 * their own server.
 *
 * WHAT is compared: the decisions a run makes, normalised into one shape
 * (`decisions()` below) — the ordered recipient list, the step sequence with the
 * next recipient, the pause position, the run-outcome lines, and the final
 * status/error. WHAT is not: ids, timestamps, sender names, reply text, and the
 * demo's own "Simulated, no live AI" banner. Those are plumbing, and the two
 * engines are allowed to differ there.
 *
 * Both sides are driven offline: the simulator with a stubbed api/emit/makeId,
 * the server with a real SqliteStore in a temp dir and an injected executor, the
 * same harness shape tests/coordination.test.js already uses. No network, no
 * model calls.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {MAX_HANDOFFS, createRun, instructLead, summonableGuests, wakeBots} from '../shared/coordination.js';
import {simulateGroup} from '../shared/group-simulator.js';
import {SqliteStore} from '../src/sqlite-store.js';
import {coordinationState, resumeGroupRun, runGroup} from '../src/coordination.js';

/* ------------------------------------------------------------------ fixtures */

/** A bot whose type only matters to the simulator's canned reply switch. */
const bot = (id, {type = 'context', settings = {}} = {}) => ({
  id, name: id[0].toUpperCase() + id.slice(1), type, instructions: `Act as ${id}`, settings,
});
const group = (id, bots, settings = {}) => ({id, name: id, bots, settings});
/** The browser-local document the simulator reads (candidates/drafts/settings). */
const demoState = (extra = {}) => ({settings: {topics: []}, candidates: [], drafts: [], chats: {}, ...extra});

const noApi = async () => { throw new Error('the simulator must not reach the API in this case'); };

/* -------------------------------------------------------------------- drivers */

/** Drive the Pages engine the way shared/local-api.js:75 and shared/ui-chat.js:147
 * do: guests are the summonable bots of every other group, `emit` writes into
 * the conversation, and a resumed run is the object the pause returned. */
async function demoEngine({groups, groupId, message, directBotId = null, state = demoState(), api = noApi, resume = null, conversation = [], guests = null}) {
  let n = 0;
  const groupRecord = groups.find(g => g.id === groupId);
  const run = await simulateGroup({
    group: groupRecord, message, directBotId,
    guests: guests || summonableGuests(groups, groupId, {includeOff: true}),
    state, api, makeId: () => `demo-${++n}`, emit: entry => conversation.push(entry),
    resume,
  });
  return {run, conversation};
}

/** Drive the server engine. The plan is built here exactly as
 * src/coordination.js:queueGroupRun builds it (instructLead -> createRun with the
 * same arguments) because `runGroup` starts from a stored run; queueGroupRun
 * itself is not usable here — it requires a configured AI provider and fires
 * `runGroup` without awaiting it. The loop under test is the real one. */
async function serverEngine(t, {groups, groupId, message, directBotId = null, checkpoints = false, executor, beforeRun = null}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'ac-parity-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const store = await new SqliteStore(path.join(dir, 'state.db'), path.join(dir, 'state.json')).init();
  let runId = null;
  await store.update(s => {
    s.groups = structuredClone(groups);
    coordinationState(s);
    const groupRecord = s.groups.find(g => g.id === groupId);
    const guests = summonableGuests(s.groups, groupId, {includeOff: true});
    const instructed = instructLead(groupRecord, message, directBotId, guests);
    const run = createRun({
      group: groupRecord, message, directBotId: instructed.directBotId,
      guests, makeId: randomUUID, checkpoints, task: instructed.task,
    });
    if (run.status !== 'awaiting_plan') wakeBots(groupRecord, run.task?.woke);
    s.groupRuns.push(run);
    runId = run.id;
    // Reach into the plan-to-execution gap (a guest switched off, a bot edited)
    // the way another tab can while a run sits queued.
    beforeRun?.(s);
  });
  await runGroup(store, runId, executor);
  return {store, runId};
}

/** The conversation the server wrote. `say` (src/coordination.js:35-38) appends
 * the run notes to the run's chat; reading that chat keeps both engines' lines
 * comparable. */
function serverDecisions(store, runId) {
  const state = store.read();
  const run = state.groupRuns.find(r => r.id === runId);
  return decisions(run, state.chats?.[run.chatKey] || []);
}

/* --------------------------------------------------------------- normalisation */

/** Classify a run-outcome line. Both engines build these from the same `runNote`
 * / retry strings, so the text itself must match; only ids and timestamps are
 * stripped. Everything else a conversation holds (the plan line, the demo's
 * "Passing this through N bot(s)" banner, "Starting.") is written by the caller
 * around the loop and is deliberately not a run-loop decision. */
function outcomeOf(text) {
  if (/^Paused after step \d+\./.test(text)) return 'paused';
  if (/has not finished its part\. Asking once more\.$/.test(text)) return 'retry';
  if (/^The run failed: /.test(text)) return 'failed';
  if (/^(Done in \d+ step\(s\)\.|Done\. |Not finished\. )/.test(text)) return 'completed';
  return null;
}

function outcomeLines(conversation) {
  return conversation
    .filter(line => line.role === 'system')
    .map(line => ({kind: outcomeOf(line.text), text: line.text}))
    .filter(line => line.kind);
}

/** The common shape the two engines are allowed to differ nowhere in. */
function decisions(run, conversation) {
  return {
    recipients: [...run.recipients],
    steps: run.trace.map(step => ({botId: step.botId, toBotId: step.toBotId ?? null})),
    status: run.status,
    currentStep: run.currentStep,
    pausedAt: run.status === 'awaiting_checkpoint' ? run.checkpoint?.nextStep ?? null : null,
    error: run.error ?? null,
    outcomes: outcomeLines(conversation),
  };
}

/* ---------------------------------------------------------------------- cases */

test('a default pipeline runs the same ordered roster on both engines', async t => {
  // No mention and no tracked task: the group routing decides. Both must pick
  // the pipeline in roster order, hand each bot the next one, and stop at the
  // last bot instead of looping or running the roster twice.
  const groups = [group('team', [bot('alpha'), bot('beta'), bot('gamma')])];
  const demo = await demoEngine({groups, groupId: 'team', message: 'Coordinate these bots'});
  const server = await serverEngine(t, {
    groups, groupId: 'team', message: 'Coordinate these bots',
    executor: async b => `Report from ${b.name}`,
  });
  const expected = {
    recipients: ['alpha', 'beta', 'gamma'],
    steps: [
      {botId: 'alpha', toBotId: 'beta'},
      {botId: 'beta', toBotId: 'gamma'},
      {botId: 'gamma', toBotId: null},
    ],
    status: 'completed',
    currentStep: 3,
    pausedAt: null,
    error: null,
    outcomes: [{kind: 'completed', text: 'Done in 3 step(s). Anything to post still needs your approval.'}],
  };
  assert.deepEqual(decisions(demo.run, demo.conversation), expected);
  assert.deepEqual(serverDecisions(server.store, server.runId), expected);
});

test('an explicit @mention narrows both engines to that one bot', async t => {
  // A mention overrides the pipeline. The failure this catches is one engine
  // treating the mention as a hint and still running the whole roster.
  const groups = [group('team', [bot('alpha'), bot('beta'), bot('gamma')])];
  const message = '@Beta please handle this post';
  const demo = await demoEngine({groups, groupId: 'team', message});
  const server = await serverEngine(t, {
    groups, groupId: 'team', message, executor: async b => `Report from ${b.name}`,
  });
  const expected = {
    recipients: ['beta'],
    steps: [{botId: 'beta', toBotId: null}],
    status: 'completed',
    currentStep: 1,
    pausedAt: null,
    error: null,
    outcomes: [{kind: 'completed', text: 'Done in 1 step(s). Anything to post still needs your approval.'}],
  };
  assert.deepEqual(decisions(demo.run, demo.conversation), expected);
  assert.deepEqual(serverDecisions(server.store, server.runId), expected);
});

test('a summonable guest from another group is on both rosters', async t => {
  // The roster is built two different ways: the simulator is handed `guests`
  // from local-api.js, while the server re-resolves the guest through
  // summonableGuests in resolveBot (src/coordination.js:102-110). A run that
  // works on one build and reports "bot no longer exists" on the other starts
  // here, so both must run the guest as the only step.
  const groups = [
    group('host', [bot('alpha')]),
    group('other', [bot('guest', {settings: {summonable: true}})]),
  ];
  const message = '@Guest take this over';
  const demo = await demoEngine({groups, groupId: 'host', message});
  const server = await serverEngine(t, {
    groups, groupId: 'host', message, executor: async b => `Report from ${b.name}`,
  });
  const expected = {
    recipients: ['guest'],
    steps: [{botId: 'guest', toBotId: null}],
    status: 'completed',
    currentStep: 1,
    pausedAt: null,
    error: null,
    outcomes: [{kind: 'completed', text: 'Done in 1 step(s). Anything to post still needs your approval.'}],
  };
  assert.deepEqual(decisions(demo.run, demo.conversation), expected);
  assert.deepEqual(serverDecisions(server.store, server.runId), expected);
});

test('both engines stop at the handoff maximum and at a smaller group cap', async t => {
  // The cap is the product promise that one run cannot fan out forever. A drift
  // here shows up as a Pages run that spends six model calls where the server
  // spends nine, or vice versa.
  const many = Array.from({length: 9}, (_, i) => bot(`b${i}`));
  const groups = [group('big', many)];
  const demo = await demoEngine({groups, groupId: 'big', message: 'Coordinate'});
  const server = await serverEngine(t, {
    groups, groupId: 'big', message: 'Coordinate', executor: async b => `Report from ${b.name}`,
  });
  const capped = decisions(demo.run, demo.conversation);
  assert.equal(MAX_HANDOFFS, 6, 'the harness assumes the default cap');
  assert.deepEqual(capped.recipients, many.slice(0, MAX_HANDOFFS).map(b => b.id));
  assert.equal(capped.steps.length, MAX_HANDOFFS, 'it stops at the cap, not at the end of the roster');
  assert.deepEqual(serverDecisions(server.store, server.runId), capped);

  // A group may lower the cap; both engines read it from the same shared
  // createRun, and both must honour the smaller number rather than the default.
  const tight = [group('tight', [bot('a'), bot('b'), bot('c')], {maxSteps: 2})];
  const demoTight = await demoEngine({groups: tight, groupId: 'tight', message: 'Coordinate'});
  const serverTight = await serverEngine(t, {
    groups: tight, groupId: 'tight', message: 'Coordinate', executor: async b => `Report from ${b.name}`,
  });
  const small = decisions(demoTight.run, demoTight.conversation);
  assert.deepEqual(small.recipients, ['a', 'b']);
  assert.equal(small.status, 'completed');
  assert.deepEqual(serverDecisions(serverTight.store, serverTight.runId), small);
});

test('a checkpoint pauses both engines after the same step and resumes the same step', async t => {
  // Checkpoints are the human gate: a run must stop after the same step on both
  // builds and, on approval, continue with the recipient it was about to ask —
  // not restart the run and not skip a bot.
  const groups = [group('cp', [bot('alpha'), bot('beta'), bot('gamma')], {checkpoints: true})];
  const message = 'Coordinate';
  const executor = async b => `Report from ${b.name}`;
  const conversation = [];

  // The demo reads the group setting (shared/group-simulator.js:74); the server
  // route sends the same setting as its `checkpoints` flag (shared/ui-chat.js:116).
  let demo = await demoEngine({groups, groupId: 'cp', message, conversation});
  const server = await serverEngine(t, {groups, groupId: 'cp', message, checkpoints: true, executor});

  const pausedOnce = {
    recipients: ['alpha', 'beta', 'gamma'],
    steps: [{botId: 'alpha', toBotId: 'beta'}],
    status: 'awaiting_checkpoint',
    currentStep: 1,
    pausedAt: 1,
    error: null,
    outcomes: [{kind: 'paused', text: 'Paused after step 1. Approve the next step to continue.'}],
  };
  assert.deepEqual(decisions(demo.run, conversation), pausedOnce);
  assert.deepEqual(serverDecisions(server.store, server.runId), pausedOnce);

  // Approve once: each engine advances exactly one step, with the recipient the
  // pause named, and stops again before the last handoff.
  const firstPause = demo.run;
  demo = await demoEngine({groups, groupId: 'cp', message, conversation, resume: firstPause});
  await resumeGroupRun(server.store, server.runId, executor);
  const pausedTwice = {
    recipients: ['alpha', 'beta', 'gamma'],
    steps: [{botId: 'alpha', toBotId: 'beta'}, {botId: 'beta', toBotId: 'gamma'}],
    status: 'awaiting_checkpoint',
    currentStep: 2,
    pausedAt: 2,
    error: null,
    outcomes: [
      {kind: 'paused', text: 'Paused after step 1. Approve the next step to continue.'},
      {kind: 'paused', text: 'Paused after step 2. Approve the next step to continue.'},
    ],
  };
  assert.deepEqual(decisions(demo.run, conversation), pausedTwice);
  assert.deepEqual(serverDecisions(server.store, server.runId), pausedTwice);

  // Approve again: the run finishes on both.
  const secondPause = demo.run;
  demo = await demoEngine({groups, groupId: 'cp', message, conversation, resume: secondPause});
  await resumeGroupRun(server.store, server.runId, executor);
  const completed = {
    recipients: ['alpha', 'beta', 'gamma'],
    steps: [
      {botId: 'alpha', toBotId: 'beta'},
      {botId: 'beta', toBotId: 'gamma'},
      {botId: 'gamma', toBotId: null},
    ],
    status: 'completed',
    currentStep: 3,
    pausedAt: null,
    error: null,
    outcomes: [
      {kind: 'paused', text: 'Paused after step 1. Approve the next step to continue.'},
      {kind: 'paused', text: 'Paused after step 2. Approve the next step to continue.'},
      {kind: 'completed', text: 'Done in 3 step(s). Anything to post still needs your approval.'},
    ],
  };
  assert.deepEqual(decisions(demo.run, conversation), completed);
  assert.deepEqual(serverDecisions(server.store, server.runId), completed);
});

test('both engines retry a missing outcome once, then close instead of looping', async t => {
  // The tracked task asked for a draft. A Writer that refuses has produced no
  // outcome, so the run asks it once more (`assessTask` gives one retry while a
  // step is left) and then closes with "Not finished". Without this, a refused
  // handoff either dies silently or retries forever.
  const groups = [group('tracked', [
    bot('lead', {type: 'custom', settings: {lead: true}}),
    bot('writer', {type: 'writing'}),
  ], {coordination: 'tracked'})];
  const message = 'draft a reply to that post';
  const refusal = 'I cannot draft without a post. Share one with the + button.';
  const state = demoState();

  const demo = await demoEngine({groups, groupId: 'tracked', message, directBotId: 'lead', state});
  const server = await serverEngine(t, {
    groups, groupId: 'tracked', message, directBotId: 'lead',
    // The server writer's reply must be the same refusal, so `assessTask` sees
    // the same missing outcome as the simulator's canned refusal.
    executor: async () => refusal,
  });
  const expected = {
    recipients: ['writer', 'writer'],
    steps: [{botId: 'writer', toBotId: null}, {botId: 'writer', toBotId: null}],
    status: 'completed',
    currentStep: 2,
    pausedAt: null,
    error: null,
    outcomes: [
      {kind: 'retry', text: 'Writer has not finished its part. Asking once more.'},
      {kind: 'completed', text: 'Not finished. A reply draft is waiting on you.'},
    ],
  };
  assert.deepEqual(decisions(demo.run, demo.conversation), expected);
  assert.deepEqual(serverDecisions(server.store, server.runId), expected);
  // A refusal is not a draft on either engine.
  assert.deepEqual(state.drafts, []);
  assert.deepEqual(server.store.read().drafts, []);
});

test('a step that throws is not retried, and both engines record the failure', async t => {
  // "Fails once then succeeds": neither loop retries a thrown step, so a stub
  // that would succeed on its second call is called exactly once on both. The
  // failure must then land somewhere the user can see: both engines mark the run
  // failed with the error and write a "The run failed: ..." line into the chat.
  // The simulator used to reject instead (shared/group-simulator.js had no catch
  // around the api call), so a Pages user was dropped back into a silent chat
  // with a failed run record and no step trace.
  const groups = [group('fail', [bot('writer', {type: 'writing'})])];
  const state = demoState({
    candidates: [{id: 'c1', author: 'Ada', text: 'A post about robotics', url: 'https://x.com/ada/status/1', status: 'ready'}],
  });
  let demoCalls = 0;
  const demoApi = async () => {
    demoCalls++;
    if (demoCalls === 1) throw new Error('Model unavailable');
    return {id: 'd1', candidateId: 'c1', status: 'pending', text: 'A drafted reply, long enough to count.'};
  };
  let serverCalls = 0;
  const executor = async () => {
    serverCalls++;
    if (serverCalls === 1) throw new Error('Model unavailable');
    return 'A drafted reply, long enough to count, citing https://x.com/ada/status/1';
  };

  const demo = await demoEngine({groups, groupId: 'fail', message: '@Writer draft a reply', state, api: demoApi});
  assert.equal(demoCalls, 1, 'the simulator retried a thrown step');
  const server = await serverEngine(t, {groups, groupId: 'fail', message: '@Writer draft a reply', executor});
  assert.equal(serverCalls, 1, 'the server retried a thrown step');

  const expected = {
    recipients: ['writer'],
    steps: [],
    status: 'failed',
    currentStep: 0,
    pausedAt: null,
    error: 'Model unavailable',
    outcomes: [{kind: 'failed', text: 'The run failed: Model unavailable'}],
  };
  assert.deepEqual(decisions(demo.run, demo.conversation), expected);
  assert.deepEqual(serverDecisions(server.store, server.runId), expected);
});

test('a resumed run clears the checkpoint it came from on both engines', async t => {
  // The simulator resumes by copying the paused run. It used to keep that run's
  // `checkpoint`, so a finished Pages run still carried the pause it resumed from
  // (and shared/local-runs.js persists whatever the loop returns). Nothing reads
  // `checkpoint` past `awaiting_checkpoint`, but a stale field on a finished run
  // is a lie the next reader would have to know about; the server clears it on
  // completion, so the simulator does too.
  const groups = [group('cp', [bot('alpha'), bot('beta')], {checkpoints: true})];
  const message = 'Coordinate';
  const executor = async b => `Report from ${b.name}`;
  const conversation = [];

  const first = await demoEngine({groups, groupId: 'cp', message, conversation});
  assert.equal(first.run.status, 'awaiting_checkpoint');
  let demo = await demoEngine({groups, groupId: 'cp', message, conversation, resume: first.run});
  while (demo.run.status === 'awaiting_checkpoint') {
    demo = await demoEngine({groups, groupId: 'cp', message, conversation, resume: demo.run});
  }
  const server = await serverEngine(t, {groups, groupId: 'cp', message, checkpoints: true, executor});
  await resumeGroupRun(server.store, server.runId, executor);
  for (;;) {
    const status = server.store.read().groupRuns.find(r => r.id === server.runId).status;
    if (status !== 'awaiting_checkpoint') break;
    await resumeGroupRun(server.store, server.runId, executor);
  }

  assert.equal(demo.run.status, 'completed');
  const serverRun = server.store.read().groupRuns.find(r => r.id === server.runId);
  assert.equal(serverRun.status, 'completed');
  assert.equal(serverRun.checkpoint, null);
  assert.equal(demo.run.checkpoint, null, 'the simulator kept the checkpoint it resumed from');
  assert.deepEqual(decisions(demo.run, conversation), decisions(serverRun, server.store.read().chats?.[serverRun.chatKey] || []));
});

test('a guest switched off after the plan is made is refused by both engines', async t => {
  // Planning hands `includeOff` guests in on purpose (a switched-off mention is
  // refused by name rather than silently re-routed), so a plan can name a guest
  // that is no longer shared by the time the loop runs. Both engines must refuse
  // it: the server re-resolves every recipient through resolveBot
  // (src/coordination.js:102-110) and requires the guest to still be summonable
  // and switched on; the simulator reads the guest's current record out of the
  // state it was given. Before that it kept using the stale snapshot and ran a bot
  // the user had just switched off.
  const groups = [
    group('host', [bot('alpha')]),
    group('other', [bot('guest', {settings: {summonable: true}})]),
  ];
  const message = '@Guest take this over';
  const guests = summonableGuests(groups, 'host', {includeOff: true});
  const disabled = structuredClone(groups);
  disabled[1].bots[0].settings.enabled = false;

  const demo = await demoEngine({
    groups: disabled, groupId: 'host', message,
    // The caller captured the guest list before the switch, like local-api does,
    // and the state it passes to the loop is the one that has the live groups.
    guests, state: demoState({groups: disabled}),
  });
  const server = await serverEngine(t, {
    groups, groupId: 'host', message,
    executor: async b => `Report from ${b.name}`,
    beforeRun: s => { s.groups.find(g => g.id === 'other').bots[0].settings.enabled = false; },
  });

  const expected = {
    recipients: ['guest'],
    steps: [],
    status: 'failed',
    currentStep: 0,
    pausedAt: null,
    error: 'Guest can no longer be summoned. It was switched off, made private or removed.',
    outcomes: [{kind: 'failed', text: 'The run failed: Guest can no longer be summoned. It was switched off, made private or removed.'}],
  };
  assert.deepEqual(decisions(demo.run, demo.conversation), expected);
  assert.deepEqual(serverDecisions(server.store, server.runId), expected);
});
