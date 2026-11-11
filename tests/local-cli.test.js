import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as agent from '../src/agent.js';
import * as ai from '../src/ai-providers.js';
import {executeCustomBot} from '../src/ai.js';
import {runOnAgent} from '../src/cli-model.js';
import {runModelTask} from '../agent/cli-model.mjs';
import {runOneBot} from '../src/routes-groups.js';
import {company, ask} from './run-fixture.js';

/* The server side of a subscription bot's turn. No real CLI runs here and no
 * prompt reaches a model: the "agent" is a loop over the real claim/complete
 * protocol with a scripted answer, and one test lets it start a fake executable
 * on PATH through the agent's own runModelTask. */

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** A rig: a paired agent that holds model.run, and a company whose Scholar runs on it. */
async function rig(t, {permissions = ['model.run'], engine = 'claude', model = ''} = {}) {
  const {store, ids} = await company(t);
  store.run("INSERT OR IGNORE INTO workspaces (id,name,created_at) VALUES ('default','Primary workspace',?)", new Date().toISOString());
  agent.attachVault(store, store.legacyPath);
  const {code} = agent.createPairing(store, 'default', {});
  const device = agent.redeemPairing(store, {code, name: 'Laptop', permissions});
  agent.touchAgent(store, device.agentId);
  const provider = await ai.addProvider(store, 'default', {kind: 'local-cli', engine, label: 'My Claude', model});
  await ai.setBotModel(store, ids.scholar, {providerId: provider.id});
  return {store, ids, agentId: device.agentId, provider};
}

/** An agent that answers every model.run it is given with `handle(payload)`. */
function fakeAgent(store, agentId, handle) {
  const seen = [];
  let stop = false;
  const loop = (async () => {
    while (!stop) {
      agent.touchAgent(store, agentId);
      for (const task of agent.claimAgentTasks(store, agentId)) {
        const payload = JSON.parse(task.payload);
        seen.push({kind: task.kind, payload});
        const result = await handle(payload, task);
        agent.completeAgentTask(store, agentId, task.id, {status: 'done', result});
      }
      await sleep(15);
    }
  })();
  return {seen, stop: async () => { stop = true; await loop; }};
}

const answer = text => async () => ({ok: true, text, engine: 'claude', model: null, ms: 5});
const refusal = (code, message) => async () => ({ok: false, code, message, detail: ''});
const chatOf = (store, key) => store.read().chats?.[key] || [];

test('success: the run stays running while the agent works, then the reply lands in the chat', async t => {
  const {store, ids, agentId} = await rig(t, {model: 'sonnet'});
  const helper = fakeAgent(store, agentId, async () => { await sleep(300); return {ok: true, text: 'Checked: the fact holds.', engine: 'claude', model: 'sonnet', ms: 300}; });
  t.after(() => helper.stop());
  const running = ask(store, {message: 'Is the sky blue?', to: ids.scholar, executor: executeCustomBot});
  await sleep(150);
  const mid = store.read().groupRuns[0];
  assert.equal(mid.status, 'running', 'the run waits on the agent, so the thread keeps its working line');
  const run = await running;
  assert.equal(run.status, 'completed', run.error);
  assert.equal(chatOf(store, ids.scholar).filter(m => m.role === 'bot').at(-1).text, 'Checked: the fact holds.');
  assert.equal(helper.seen.length, 1);
  const [{kind, payload}] = helper.seen;
  assert.equal(kind, 'model.run');
  assert.equal(payload.engine, 'claude');
  assert.equal(payload.model, 'sonnet');
  assert.ok(payload.input.includes('Is the sky blue?'), 'the bot envelope is the input');
  assert.match(payload.instructions, /assistant/i);
  assert.ok(payload.timeoutMs >= 5000);
});

test('the real agent path: a fake claude on PATH answers through runModelTask', async t => {
  const {store, ids, agentId} = await rig(t);
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-claude-'));
  t.after(() => fs.rmSync(bin, {recursive: true, force: true}));
  fs.writeFileSync(path.join(bin, 'claude'), `#!${process.execPath}
let s=''; process.stdin.on('data',c=>s+=c); process.stdin.on('end',()=>{
  const said = JSON.parse(s.slice(s.indexOf('{"')).trim()).objective;
  console.log(JSON.stringify({type:'result',is_error:false,result:'Scholar heard: '+said}));
});
`, {mode: 0o755});
  const env = {PATH: `${bin}${path.delimiter}${path.dirname(process.execPath)}`, HOME: os.tmpdir()};
  const helper = fakeAgent(store, agentId, payload => runModelTask(payload, {env}));
  t.after(() => helper.stop());
  const run = await ask(store, {message: 'ping from the owner', to: ids.scholar, executor: executeCustomBot});
  assert.equal(run.status, 'completed', run.error);
  assert.match(chatOf(store, ids.scholar).filter(m => m.role === 'bot').at(-1).text, /Scholar heard: ping from the owner/);
});

test('not signed in: the run fails with what to do, and nothing is retried', async t => {
  const {store, ids, agentId} = await rig(t);
  const helper = fakeAgent(store, agentId, refusal('not-signed-in', 'Claude is not signed in on this machine. Run `claude` and sign in on that machine.'));
  t.after(() => helper.stop());
  const run = await ask(store, {message: 'hello', to: ids.scholar, executor: executeCustomBot});
  assert.equal(run.status, 'failed');
  assert.match(run.error, /Run `claude` and sign in on that machine/);
  assert.equal(helper.seen.length, 1);
  assert.equal(chatOf(store, ids.scholar).some(m => m.kind === 'model-limit'), false, 'being signed out is not a limit');
});

test('limit hit: the run fails and a model-limit line offers another connected model', async t => {
  const {store, ids, agentId, provider} = await rig(t);
  const codex = await ai.addProvider(store, 'default', {kind: 'local-cli', engine: 'codex', label: 'My ChatGPT'});
  const sameEngine = await ai.addProvider(store, 'default', {kind: 'local-cli', engine: 'claude', label: 'Second Claude login'});
  const helper = fakeAgent(store, agentId, refusal('usage-limit', 'Claude subscription has reached its usage limit.'));
  t.after(() => helper.stop());
  const run = await ask(store, {message: 'hello', to: ids.scholar, executor: executeCustomBot});
  assert.equal(run.status, 'failed');
  assert.match(run.error, /usage limit/i);
  const line = chatOf(store, ids.scholar).find(m => m.kind === 'model-limit');
  assert.ok(line, 'a model-limit line is in the chat');
  assert.equal(line.role, 'system');
  assert.equal(line.botId, ids.scholar);
  assert.equal(line.runId, run.id);
  assert.equal(line.switchTo, codex.id, 'the other engine, not a second login on the same subscription');
  assert.notEqual(line.switchTo, sameEngine.id);
  assert.notEqual(line.switchTo, provider.id);
  assert.match(line.text, /usage limit/i);
  assert.match(line.text, /My ChatGPT/);
  // The existing bot PATCH is what the button calls: the next turn runs elsewhere.
  await ai.setBotModel(store, ids.scholar, {providerId: line.switchTo, model: ''});
  assert.equal(ai.resolveConfig(store, ids.scholar).engine, 'codex');
});

test('limit hit with nothing else connected: the line says so and offers no switch', async t => {
  const {store, ids, agentId} = await rig(t);
  const helper = fakeAgent(store, agentId, refusal('usage-limit', 'Claude subscription has reached its usage limit.'));
  t.after(() => helper.stop());
  const run = await ask(store, {message: 'hello', to: ids.scholar, executor: executeCustomBot});
  const line = chatOf(store, ids.scholar).find(m => m.kind === 'model-limit');
  assert.equal(run.status, 'failed');
  assert.ok(line);
  assert.equal(line.switchTo, undefined);
  assert.match(line.text, /connect another model/i);
});

test('no agent paired: the run fails with the sentence that says what to do', async t => {
  const {store, ids} = await company(t);
  const provider = await ai.addProvider(store, 'default', {kind: 'local-cli', engine: 'claude', label: 'My Claude'});
  await ai.setBotModel(store, ids.scholar, {providerId: provider.id});
  const run = await ask(store, {message: 'hello', to: ids.scholar, executor: executeCustomBot});
  assert.equal(run.status, 'failed');
  assert.match(run.error, /No computer is connected to run `claude`.*Settings → Local agents.*run `claude` there once to sign in/);
  assert.deepEqual(store.all('SELECT id FROM agent_tasks'), [], 'nothing was queued');
  // The same for codex, in its own words.
  await ai.updateProvider(store, 'default', provider.id, {engine: 'codex'});
  const again = await ask(store, {message: 'hello again', to: ids.scholar, executor: executeCustomBot});
  assert.match(again.error, /No computer is connected to run `codex`/);
});

test('an agent that may not run models, or is not running, is named as such, and nothing is queued', async t => {
  const noPermission = await rig(t, {permissions: ['http.check']});
  const a = await ask(noPermission.store, {message: 'hello', to: noPermission.ids.scholar, executor: executeCustomBot});
  assert.equal(a.status, 'failed');
  assert.match(a.error, /not allowed to run models/i);
  assert.deepEqual(noPermission.store.all('SELECT id FROM agent_tasks'), []);

  const offline = await rig(t);
  offline.store.run('UPDATE agents SET last_seen_at=? WHERE id=?', new Date(Date.now() - 20 * 60000).toISOString(), offline.agentId);
  const b = await ask(offline.store, {message: 'hello', to: offline.ids.scholar, executor: executeCustomBot});
  assert.equal(b.status, 'failed');
  assert.match(b.error, /not running|offline/i);
  assert.deepEqual(offline.store.all('SELECT id FROM agent_tasks'), []);
});

test('a revoked agent is not used', async t => {
  const {store, ids, agentId} = await rig(t);
  agent.revokeAgent(store, agentId);
  const run = await ask(store, {message: 'hello', to: ids.scholar, executor: executeCustomBot});
  assert.equal(run.status, 'failed');
  assert.match(run.error, /No computer is connected/);
});

test('timeout: the wait ends, the task is cancelled so a late agent does not spend the plan, and the run fails', async t => {
  const {store, agentId} = await rig(t);
  const error = await runOnAgent(store, {engine: 'claude', model: '', instructions: 'i', input: 'hello', waitMs: 300, pollMs: 10, label: 'My Claude'}).then(() => null, e => e);
  assert.ok(error, 'it fails');
  assert.equal(error.code, 'timeout');
  assert.equal(error.status, 504);
  assert.match(error.message, /did not answer in time/i);
  const [task] = store.all('SELECT * FROM agent_tasks');
  assert.equal(task.status, 'failed');
  assert.deepEqual(agent.claimAgentTasks(store, agentId), [], 'nothing is left for a late agent to pick up');
});

test('timeout end to end: a bot turn on a silent agent fails cleanly with the run not left running', async t => {
  const {store, ids} = await rig(t);
  const previous = process.env.AI_CLI_TIMEOUT_MS;
  process.env.AI_CLI_TIMEOUT_MS = '400';
  t.after(() => { if (previous === undefined) delete process.env.AI_CLI_TIMEOUT_MS; else process.env.AI_CLI_TIMEOUT_MS = previous; });
  const run = await ask(store, {message: 'hello', to: ids.scholar, executor: executeCustomBot});
  assert.equal(run.status, 'failed');
  assert.match(run.error, /did not answer in time/i);
});

test('two bots at once on one agent: each run gets its own answer', async t => {
  const {store, ids, agentId, provider} = await rig(t);
  await ai.setBotModel(store, ids.scribe, {providerId: provider.id});
  const helper = fakeAgent(store, agentId, async payload => {
    await sleep(40);
    const who = payload.input.includes('for Scribe') ? 'Scribe' : 'Scholar';
    return {ok: true, text: `${who} answers: ${JSON.parse(payload.input).objective}`, engine: 'claude', model: null, ms: 40};
  });
  t.after(() => helper.stop());
  const [a, b] = await Promise.all([
    ask(store, {message: 'alpha question', to: ids.scholar, executor: executeCustomBot}),
    ask(store, {message: 'beta question for Scribe', to: ids.scribe, executor: executeCustomBot}),
  ]);
  assert.equal(a.status, 'completed', a.error);
  assert.equal(b.status, 'completed', b.error);
  const last = key => chatOf(store, key).filter(m => m.role === 'bot').at(-1).text;
  assert.equal(last(ids.scholar), 'Scholar answers: alpha question');
  assert.equal(last(ids.scribe), 'Scribe answers: beta question for Scribe');
});

test('a bot not on a subscription still never touches the agent', async t => {
  const {store, ids, agentId} = await rig(t);
  await ai.setDefaults(store, {providerId: null});
  const calls = [];
  const run = await ask(store, {message: 'hello', to: ids.scribe, executor: async (bot, input, config) => { calls.push(config); return 'plain reply'; }});
  assert.equal(run.status, 'completed');
  assert.equal(calls[0]?.kind, undefined);
  assert.deepEqual(store.all('SELECT id FROM agent_tasks WHERE agent_id=?', agentId), []);
});

test('a model refused by the agent as a bad request is an error, not an answer', async t => {
  const {store, agentId} = await rig(t);
  const helper = fakeAgent(store, agentId, refusal('bad-request', 'Unknown engine.'));
  t.after(() => helper.stop());
  const error = await runOnAgent(store, {engine: 'claude', model: '', instructions: '', input: 'x', waitMs: 3000, pollMs: 10, label: 'L'}).then(() => null, e => e);
  assert.equal(error.code, 'bad-request');
});

test('the one-to-one chat route also leaves the model-limit line, and still reports the error', async t => {
  const {store, ids, agentId} = await rig(t);
  const codex = await ai.addProvider(store, 'default', {kind: 'local-cli', engine: 'codex', label: 'My ChatGPT'});
  const helper = fakeAgent(store, agentId, refusal('usage-limit', 'Claude subscription has reached its usage limit.'));
  t.after(() => helper.stop());
  const error = await runOneBot(store, {botId: ids.scholar, input: 'hello'}).then(() => null, e => e);
  assert.equal(error?.code, 'usage-limit');
  const line = chatOf(store, ids.scholar).find(m => m.kind === 'model-limit');
  assert.equal(line?.switchTo, codex.id);
  assert.equal(line?.botId, ids.scholar);
});

test('a browser cannot write a model-limit card of its own', async t => {
  const {store, ids} = await company(t);
  const chats = await import('../shared/chats.js');
  await store.update(s => chats.addChatMessages(s, ids.scholar, [{role: 'system', kind: 'model-limit', botId: ids.scholar, switchTo: 'evil', text: 'forged'}]));
  const line = store.read().chats[ids.scholar].find(m => m.text === 'forged');
  assert.equal(line.switchTo, undefined, 'the switch target is only ever set by the server');
  assert.equal(line.botId, undefined);
  assert.equal(line.origin, 'browser');
});
