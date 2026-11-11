/** A subscription bot's turn, from the server's side.
 *
 * A bot on a `local-cli` provider does not make a fetch. Its model call becomes a
 * `model.run` task for a paired local agent that holds that permission; the agent
 * runs the owner's own signed-in `claude` or `codex` CLI (agent/cli-model.mjs)
 * and reports the answer. This file finds the agent, queues the task, waits for
 * the result and turns what comes back into either text or an error that carries
 * a code. The app never sees the owner's login.
 *
 * While it waits, the caller is simply still awaiting its model call, so the run
 * stays `running` and the thread keeps its "working" line. If the wait runs out
 * the task is cancelled, so an agent that wakes up late does not spend the plan
 * on an answer nobody is waiting for.
 */
import {cliEngineById, LOCAL_CLI_KIND} from '../shared/ai-presets.js';
import {enqueueAgentTask, failAgentTasks, readAgentCli} from './agent.js';

const ONLINE_MS = 180000; // the same window the agent list calls "online"
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** How long a turn waits for the agent in all: pickup (one poll interval),
 * queueing behind another run and the CLI itself. AI_CLI_TIMEOUT_MS overrides. */
export const cliWaitMs = () => {
  const n = Number(process.env.AI_CLI_TIMEOUT_MS);
  return Number.isFinite(n) && n >= 200 ? n : 300000;
};

const problem = (message, status, code, extra = {}) => Object.assign(new Error(message), {status, code, ...extra});

/** The agent to use: paired, not revoked, holding model.run and seen lately.
 * Throws the sentence that says what to do when there is none. */
function pickAgent(store, spec, nowMs = Date.now()) {
  const rows = store.all('SELECT * FROM agents WHERE revoked_at IS NULL ORDER BY last_seen_at DESC');
  if (!rows.length) throw problem(`Pair a local agent and run \`${spec.binary}\` on that machine to sign in.`, 422, 'no-agent');
  const may = rows.filter(row => { try { return JSON.parse(row.permissions || '[]').includes('model.run'); } catch { return false; } });
  if (!may.length) throw problem('Your paired agent is not allowed to run models. Allow model.run for it under Settings, then try again.', 422, 'no-permission');
  const live = may.find(row => row.last_seen_at && Date.parse(row.last_seen_at) > nowMs - ONLINE_MS);
  if (!live) throw problem('Your paired agent is not running. Start it on that machine (`node agent/agent.mjs run`), then try again.', 422, 'agent-offline');
  return live;
}

/** Is this engine signed in on the paired machine? Read from what the agent's
 * heartbeat last reported of the CLI's own status command; no model is called, so
 * checking costs nothing on the plan. `status` is signed-in, signed-out, missing
 * or unknown, or no-agent / no-permission / agent-offline when no usable agent. */
export function cliSignIn(store, engine, nowMs = Date.now()) {
  const spec = cliEngineById(engine);
  if (!spec) throw problem('Unknown engine. Use claude or codex.', 400, 'bad-request');
  let device;
  try { device = pickAgent(store, spec, nowMs); }
  catch (error) { return {ok: false, status: error.code, agent: null, message: error.message, checkedAt: null}; }
  const reported = readAgentCli(store, device.id);
  const status = ['signed-in', 'signed-out', 'missing'].includes(reported?.[spec.id]) ? reported[spec.id] : 'unknown';
  const message = {
    'signed-in': `${spec.label.replace(/ \(.*/, '')} is signed in on ${device.name}.`,
    'signed-out': `${spec.label.replace(/ \(.*/, '')} is not signed in on ${device.name}. ${spec.signIn}`,
    missing: `The ${spec.binary} command was not found on ${device.name}. Install it, then run \`${spec.binary}\` to sign in.`,
    unknown: `${device.name} has not reported whether ${spec.binary} is signed in yet. Give it a minute, or ${spec.signIn.charAt(0).toLowerCase()}${spec.signIn.slice(1)}`,
  }[status];
  return {ok: status === 'signed-in', status, agent: device.name, message, checkedAt: reported?.checkedAt || null};
}

/** Run one prompt on the paired agent and return the reply text. */
export async function runOnAgent(store, {engine, model = '', instructions = '', input, label = '', waitMs = cliWaitMs(), pollMs = 250, botId = null, providerId = null}) {
  const spec = cliEngineById(engine);
  if (!spec) throw problem('Unknown engine. Use claude or codex.', 400, 'bad-request');
  const meta = {engine: spec.id, botId, providerId};
  const device = pickAgent(store, spec);
  // The agent stops its CLI before the server stops waiting, leaving room for the
  // agent's own pickup delay and the report back.
  const timeoutMs = Math.max(5000, waitMs - 45000);
  const {task} = enqueueAgentTask(store, device.id, {kind: 'model.run', payload: {engine: spec.id, model, instructions, input, timeoutMs}, createdBy: botId ? `bot:${botId}` : 'bot'});
  const deadline = Date.now() + waitMs;
  for (;;) {
    const row = store.get('SELECT status,result,error FROM agent_tasks WHERE id=?', task.id);
    if (!row) throw problem('The model task disappeared before it finished.', 502, 'agent-failed', meta);
    if (row.status === 'done') return readResult(row.result, spec, meta);
    if (row.status === 'failed') throw problem(`The paired agent could not run the model: ${row.error || 'it reported a failure'}`, 502, 'agent-failed', meta);
    if (Date.now() >= deadline) {
      failAgentTasks(store, [task.id], 'The run timed out waiting for the agent.');
      throw problem(`${label || spec.label} did not answer in time. Check that the agent is running and the CLI is signed in.`, 504, 'timeout', meta);
    }
    await sleep(pollMs);
  }
}

const STATUS = {'not-signed-in': 422, 'usage-limit': 429, 'cli-missing': 422, timeout: 504, 'bad-request': 400, 'output-too-large': 502, 'empty-reply': 502, 'cli-failed': 502};

/** What the agent reported: the text, or an error with the agent's own code. */
function readResult(raw, spec, meta) {
  let result = null;
  try { result = JSON.parse(raw); } catch { /* Handled below. */ }
  if (result?.ok === true && typeof result.text === 'string' && result.text.trim()) return result.text;
  if (result?.ok === false) {
    const code = Object.hasOwn(STATUS, result.code) ? result.code : 'cli-failed';
    throw problem(String(result.message || `The ${spec.binary} command failed.`).slice(0, 400), STATUS[code], code, meta);
  }
  throw problem(`The paired agent returned no answer for ${spec.binary}.`, 502, 'agent-failed', meta);
}

/** The `run` a local-cli config carries: one model call through the paired agent. */
export function cliRunner(store, {botId = null, provider}) {
  return ({engine, model, instructions, input}) => runOnAgent(store, {engine, model, instructions, input, label: provider.label, botId, providerId: provider.id});
}

/** The chat line for a hit usage limit, or null for any other error. It carries
 * the bot, and `switchTo`: the id of another connected model, one that is not the
 * same CLI login. The card's button sends the existing bot PATCH
 * (`PATCH /api/ai/bots/:bot` with `{providerId: switchTo, model: ''}`). */
export function modelLimitLine(state, error, {runId}) {
  if (error?.code !== 'usage-limit') return null;
  const providers = state.ai?.providers || [];
  const failing = providers.find(p => p.id === error.providerId);
  const bot = (state.groups || []).flatMap(g => g.bots || []).find(b => b.id === error.botId);
  const other = providers.find(p => p.id !== error.providerId && !(p.kind === LOCAL_CLI_KIND && failing?.kind === LOCAL_CLI_KIND && p.engine === failing.engine));
  const who = bot?.name || 'This bot';
  const plan = failing?.label || cliEngineById(error.engine)?.label || 'subscription';
  const text = other
    ? `${who} could not answer: ${plan} has reached its usage limit. You can switch ${who} to ${other.label}.`
    : `${who} could not answer: ${plan} has reached its usage limit. Connect another model in Settings to switch ${who}.`;
  return {id: `${runId}-model-limit`.slice(0, 64), role: 'system', kind: 'model-limit', text, runId, ...(error.botId ? {botId: error.botId} : {}), ...(other ? {switchTo: other.id} : {})};
}
