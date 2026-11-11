/* Agent Control browser-local transport (used by the static GitHub Pages build).
 *
 * All data stays inside this browser via localStorage. The lifecycle rules are
 * not reimplemented here: they come from the same `workflow.js` + `core.js`
 * modules the Node server uses, so the demo and the real dashboard cannot drift.
 */
import {initialState} from './core.js';
import {migrate, addGroup, addBot, updateBot, updateGroup, removeBot, removeGroup} from './workflow.js';
import {enqueueTask, retryTask, cancelTask} from './tasks.js';
import {addChatMessages, clearChat} from './chats.js';
import {publicMemory, addRules, removeRule, forgetChat, forgetRulebook} from './memory.js';
import {summonableGuests} from './coordination.js';
import {simulateGroup} from './group-simulator.js';
import {BUSY_STATUSES} from './run-state.js';
import {botSettings} from './bot-settings.js';
import {denyBrowserRequest} from './bot-browser.js';
import {withLocalLock} from './locks.js';

const KEY = 'agent-control-ghpages-v1';
const now = () => new Date().toISOString();
let dueDepth = 0;

async function read() {
  try {
    const value = localStorage.getItem(KEY);
    if (value) {
      const state = JSON.parse(value);
      // Always migrate: a stored version equal to SCHEMA_VERSION can still be
      // missing a field added later in the same version, and a legacy shape must
      // gain every collection the UI indexes into.
      if (state && typeof state === 'object' && Array.isArray(state.groups)) return migrate(state);
    }
  } catch { throw new Error('Browser storage is unavailable. Enable local storage to use this demo.'); }
  return migrate(initialState());
}
function save(state) {
  try { localStorage.setItem(KEY, JSON.stringify(state)); }
  catch { throw new Error('Unable to save browser-local data. Check available storage and private browsing settings.'); }
}
/** A due scheduled bot task runs through the same offline engine as a chat, so
 * both store the run, its lines and its record in the same places. */
async function runBotTask(state, t) {
  const {groupId, botId, message, label} = t.payload;
  const group = state.groups.find(g => g.id === groupId), bot = botId ? group?.bots.find(b => b.id === botId) : null;
  if (!group || (botId && !bot)) { t.status = 'cancelled'; t.lastError = 'That bot or group no longer exists.'; return; }
  const chatKey = botId || `team-${groupId}`;
  if (bot && !botSettings(bot).enabled) {
    addChatMessages(state, chatKey, [{role: 'system', text: `Scheduled task "${label}" skipped: ${bot.name} is switched off.`}], {trusted: true});
    return;
  }
  // A busy group is a delay, not a skipped task: refuse before writing the
  // "Scheduled task" line, so a wait does not read as work that happened.
  if (state.groupRuns.some(r => r.groupId === groupId && BUSY_STATUSES.includes(r.status))) {
    throw Object.assign(new Error('A group run is already active. Wait or retry later.'), {status: 409});
  }
  addChatMessages(state, chatKey, [{role: 'system', text: `Scheduled task: ${message}`}], {trusted: true});
  try {
    // `started` skips the plan gate. Scheduling the task was the approval.
    await localRun(state, groupId, {message, directBotId: botId, chatKey, started: true});
  } catch (error) {
    addChatMessages(state, chatKey, [{role: 'system', text: `Scheduled task "${label}" did not run: ${error.message}`}], {trusted: true});
    throw error;
  }
}

/** First id a run mints is the id it was given, so starting a shown plan or
 * resuming a pause updates that record instead of forking a second one. */
function idFactory(preferred) {
  let used = false;
  return () => (!used && preferred ? (used = true, preferred) : crypto.randomUUID());
}

/** The API the offline simulator is allowed to call mid-run. It answers against
 * the in-memory state directly, never back through `localApi`: the state lock is
 * already held by the request that started the run, and a nested lock would
 * deadlock. Same reason the server runs its steps inside one store update. */
function runApi(state) {
  return async (url, method = 'POST', body = {}) => {
    let m;
    if ((m = url.match(/^\/api\/groups\/([a-z0-9-]+)\/bots\/([a-z0-9-]+)$/)) && method === 'PATCH') return updateBot(state, m[1], m[2], body);
    throw new Error(`Not available to a browser-local run: ${method} ${url}`);
  };
}

/** Store one run's emitted lines where the server stores them: the conversation
 * (`chats`) is what a reader sees, `groupMessages` is the run log the streaming
 * read returns. Only bot lines go in the log; a user line is already there. */
function storeRunLines(state, run, entries) {
  const key = run.chatKey || `team-${run.groupId}`;
  const log = (state.groupMessages[run.groupId] ??= []);
  for (const entry of entries) {
    const line = {id: entry.id || crypto.randomUUID(), runId: run.id, role: entry.role, senderId: entry.senderId, senderName: entry.senderName, toBotId: entry.toBotId, text: entry.text, at: entry.at || now()};
    if (line.role === 'bot') log.push({...line, kind: entry.kind});
    try { addChatMessages(state, key, [line], {trusted: true}); } catch { /* The conversation was removed mid-run. */ }
  }
  state.groupMessages[run.groupId] = log.slice(-300);
}

function upsertRun(state, run) {
  const i = state.groupRuns.findIndex(r => r.id === run.id);
  if (i === -1) state.groupRuns.unshift(run); else state.groupRuns[i] = run;
  state.groupRuns = state.groupRuns.slice(0, 100);
}

/** End the runs a chat is waiting on when that chat, bot or group goes away. */
function cancelRunsForChat(state, key, reason) {
  for (const run of state.groupRuns) {
    if (!BUSY_STATUSES.includes(run.status) || (run.chatKey || `team-${run.groupId}`) !== key) continue;
    run.status = 'cancelled'; run.completedAt = now(); run.checkpoint = null; run.error = reason;
  }
}

/** One offline coordination run, behind the routes the Node orchestrator serves.
 *
 * The demo used to run this in the UI and keep the run in localStorage, so the
 * only way to continue, start or stop it was a branch on `isStaticDemo()`. Now
 * the run is created, run and stored here, and the UI reaches it only through
 * `POST/GET /api/groups/:group/chat` and the `runs/:run/*` routes — the same
 * paths the server answers — so nothing above the transport asks which backend
 * it is talking to. */
async function localRun(state, groupId, {message = '', directBotId = null, checkpoints = false, chatKey = null, runId = null, resume = false, started = false, approve = null} = {}) {
  const group = state.groups.find(g => g.id === groupId);
  if (!group) throw Object.assign(new Error('Group not found.'), {status: 404});
  const prior = runId ? state.groupRuns.find(r => r.id === runId) : null;
  if (runId && (!prior || prior.groupId !== groupId)) throw Object.assign(new Error('Run not found.'), {status: 404});
  // Declining a shown plan is a cancel, and is answered even on an old record.
  if (approve === false) {
    prior.status = 'cancelled'; prior.completedAt = now(); prior.checkpoint = null;
    storeRunLines(state, prior, [{id: crypto.randomUUID(), role: 'system', text: 'Plan cancelled. Nothing ran.'}]);
    return {runId, status: 'cancelled'};
  }
  if (resume && prior.status !== 'awaiting_checkpoint') throw Object.assign(new Error('Only a run paused at a checkpoint can be continued.'), {status: 409});
  // One live run per group. Any other busy run blocks the start; a Start or
  // Continue of a run that is itself busy is the way through, same as the server.
  if (state.groupRuns.some(r => r.groupId === groupId && BUSY_STATUSES.includes(r.status) && r.id !== runId)) {
    throw Object.assign(new Error('A group run is already active. Wait or retry later.'), {status: 409});
  }
  const guests = summonableGuests(state.groups, groupId, {includeOff: true});
  const entries = [];
  const run = await simulateGroup({
    group, message: resume ? prior.input : message, directBotId, guests, state, api: runApi(state),
    makeId: idFactory(runId), emit: e => entries.push(e),
    chatKey: chatKey || prior?.chatKey || null,
    started: started || resume, resume: resume ? prior : null,
    checkpoints,
  });
  upsertRun(state, run);
  storeRunLines(state, run, entries);
  return {runId: run.id, status: run.status};
}

async function due(state) {
  const time = Date.now();
  let changed = false;
  for (const t of state.tasks) {
    if (t.kind !== 'bot-task' || t.status !== 'queued' || !(Date.parse(t.runAt) <= time)) continue;
    changed = true;
    let failed = false;
    try { await runBotTask(state, t); if (t.status === 'queued') t.lastError = null; }
    catch (error) {
      failed = true;
      t.lastError = String(error?.message || error).slice(0, 400);
      // A busy group is a delay, same as the server queue. Anything else did
      // not run: a one-off is a failure, an interval waits for its next window.
      const busy = error?.status === 409 && /already active/i.test(t.lastError);
      if (busy) t.runAt = new Date(time + 15000).toISOString();
      else if (t.payload.kind === 'once') { t.status = 'failed'; t.completedAt = new Date(time).toISOString(); }
      else t.runAt = new Date(time + t.intervalMinutes * 60000).toISOString();
    }
    if (failed || t.status !== 'queued') continue;
    if (t.payload.kind === 'once') { t.status = 'done'; t.completedAt = new Date(time).toISOString(); }
    else t.runAt = new Date(time + t.intervalMinutes * 60000).toISOString();
  }
  if (changed) save(state);
}
async function localApi(path, method = 'GET', body = {}) {
  return withLocalLock('state', () => localApiUnlocked(path, method, body));
}

async function localApiUnlocked(path, method = 'GET', body = {}) {
  if (path === '/api/login' || path === '/api/logout') return {ok: true};
  const state = await read();
  dueDepth++;
  try {
    if (dueDepth === 1) await due(state);
  } finally { dueDepth--; }
  if (path === '/api/state' && method === 'GET') return {...state, aiEnabled: false, serverTime: now()};

  let m;
  if (path === '/api/groups' && method === 'POST') { const g = addGroup(state, body); save(state); return g; }
  if ((m = path.match(/^\/api\/groups\/([a-z0-9-]+)\/bots$/)) && method === 'POST') { const b = addBot(state, m[1], body); save(state); return b; }
  // Keep lasting bot profile edits in the store so they survive a reload, exactly
  // like the Node backend, instead of living only in browser-local UI state.
  if ((m = path.match(/^\/api\/groups\/([a-z0-9-]+)\/bots\/([a-z0-9-]+)$/)) && method === 'PATCH') { const b = updateBot(state, m[1], m[2], body); save(state); return b; }
  if ((m = path.match(/^\/api\/groups\/([a-z0-9-]+)\/bots\/([a-z0-9-]+)$/)) && method === 'DELETE') { const r = removeBot(state, m[1], m[2]); cancelRunsForChat(state, m[2], 'Bot removed.'); save(state); return r; }
  if ((m = path.match(/^\/api\/groups\/([a-z0-9-]+)$/)) && method === 'PATCH') { const g = updateGroup(state, m[1], body); save(state); return g; }
  if ((m = path.match(/^\/api\/groups\/([a-z0-9-]+)$/)) && method === 'DELETE') { const r = removeGroup(state, m[1]); cancelRunsForChat(state, `team-${m[1]}`, 'Group removed.'); save(state); return r; }
  // Durable group coordination: the same paths and shapes the Node orchestrator
  // serves, so the UI drives the demo and the server identically.
  if ((m = path.match(/^\/api\/groups\/([a-z0-9-]+)\/chat$/)) && method === 'GET') {
    if (!state.groups.some(g => g.id === m[1])) throw Object.assign(new Error('Group not found.'), {status: 404});
    return {messages: (state.groupMessages[m[1]] || []).slice(-300), runs: state.groupRuns.filter(r => r.groupId === m[1]).slice(0, 50)};
  }
  if ((m = path.match(/^\/api\/groups\/([a-z0-9-]+)\/chat$/)) && method === 'POST') {
    const r = await localRun(state, m[1], {message: body.message, directBotId: body.directBotId || null, checkpoints: body.checkpoints === true, chatKey: typeof body.chatKey === 'string' ? body.chatKey : null});
    save(state); return r;
  }
  if ((m = path.match(/^\/api\/groups\/([a-z0-9-]+)\/runs\/([a-z0-9-]+)\/continue$/)) && method === 'POST') { const r = await localRun(state, m[1], {runId: m[2], resume: true}); save(state); return r; }
  if ((m = path.match(/^\/api\/groups\/([a-z0-9-]+)\/runs\/([a-z0-9-]+)\/plan$/)) && method === 'POST') { const r = await localRun(state, m[1], {runId: m[2], started: body?.approve !== false, approve: body?.approve}); save(state); return r; }
  if ((m = path.match(/^\/api\/groups\/([a-z0-9-]+)\/runs\/([a-z0-9-]+)\/cancel$/)) && method === 'POST') {
    const run = state.groupRuns.find(r => r.id === m[2] && r.groupId === m[1]);
    if (!run) throw Object.assign(new Error('Run not found.'), {status: 404});
    if (BUSY_STATUSES.includes(run.status)) {
      run.status = 'cancelled'; run.completedAt = now(); run.checkpoint = null;
      storeRunLines(state, run, [{id: crypto.randomUUID(), role: 'system', text: 'Stopped. Nothing after this runs.'}]);
    }
    save(state); return {runId: run.id, status: run.status};
  }
  if (path === '/api/bots/run') throw new Error('Running AI bots requires the separate Node backend, not GitHub Pages.');
  if ((m = path.match(/^\/api\/browser-requests\/([a-z0-9-]+)\/approve$/)) && method === 'POST') throw Object.assign(new Error('Browser requests run on your own device through a paired local agent, which needs the Node build. This demo cannot open pages.'), {status: 409});
  if ((m = path.match(/^\/api\/browser-requests\/([a-z0-9-]+)\/deny$/)) && method === 'POST') { const r = denyBrowserRequest(state, m[1]); save(state); return r; }
  // Structured task endpoints, identical to the Node server's queue surface.
  if (path === '/api/tasks' && method === 'POST') {
    // Delivery tasks are created by the server from a user's own preferences.
    // Taken from a request, one would send to any stored webhook.
    if (body.kind === 'notification') throw Object.assign(new Error('Notification deliveries are queued by the server, not by request.'), {status: 403});
    const t = enqueueTask(state, body); save(state); return t.task;
  }
  if ((m = path.match(/^\/api\/tasks\/([a-f0-9-]+)\/retry$/)) && method === 'POST') { const r = retryTask(state, m[1]); save(state); return r; }
  if ((m = path.match(/^\/api\/tasks\/([a-f0-9-]+)$/)) && method === 'DELETE') { const r = cancelTask(state, m[1]); save(state); return r; }
  // Conversation history, stored with the rest of the browser-local state.
  if ((m = path.match(/^\/api\/chats\/([a-z0-9-]+)\/messages$/)) && method === 'POST') { const r = addChatMessages(state, m[1], Array.isArray(body.messages) ? body.messages : [body]); save(state); return r; }
  if ((m = path.match(/^\/api\/chats\/([a-z0-9-]+)$/)) && method === 'DELETE') { const r = clearChat(state, m[1]); cancelRunsForChat(state, m[1], 'Chat cleared.'); save(state); return r; }
  // Durable memory: the rulebook and chat recap are part of local state, so a
  // person can delete a rule here too. A model-written pass needs the Node build.
  if (path === '/api/memory' && method === 'GET') return publicMemory(state);
  if (path === '/api/memory/rules' && method === 'POST') {
    if (!body.model) throw new Error('Which model should keep this rule?');
    const r = addRules(state, body.model, [body.text], {source: 'user', label: body.label});
    save(state);
    return {ok: true, model: body.model, rules: r.book.rules.map(rule => ({id: rule.id, text: rule.text, source: rule.source}))};
  }
  const memoryPath = path.split('?')[0];
  if ((m = memoryPath.match(/^\/api\/memory\/rules\/([a-z0-9-]+)$/)) && method === 'DELETE') {
    const model = new URLSearchParams(path.split('?')[1] || '').get('model') || '';
    const r = removeRule(state, model, m[1]); save(state); return r;
  }
  if (path === '/api/memory/forget' && method === 'POST') {
    if (body.model) forgetRulebook(state, body.model);
    if (body.chat) forgetChat(state, body.chat);
    save(state);
    return {ok: true, model: body.model || null, chat: body.chat || null};
  }
  if (path === '/api/memory/consolidate' && method === 'POST') throw Object.assign(new Error('Updating memory needs the Node build and an AI provider. Rules you add by hand still work here.'), {status: 409});
  // First boot of the demo: start from the same workspace the server seeds.
  if (path === '/api/reset-workspace' && method === 'POST') { const fresh = migrate(initialState()); save(fresh); return {state: fresh}; }
  throw Object.assign(new Error(`Not available in the browser-local demo: ${method} ${path}`), {status: 404});
}

window.AGENT_LOCAL_API = localApi;
window.AGENT_PAGES_DEMO = localApi; // Backwards-compatible alias used by the test suite.
