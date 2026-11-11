/* Agent Control browser-local transport (used by the static GitHub Pages build).
 *
 * All data stays inside this browser via localStorage. The lifecycle rules are
 * not reimplemented here: they come from the same `workflow.js` + `core.js`
 * modules the Node server uses, so the demo and the real dashboard cannot drift.
 */
import {initialState, cleanText} from './core.js';
import {migrate, addGroup, addBot, updateBot, updateGroup, removeBot, removeGroup, updateRetention} from './workflow.js';
import {RETENTION_DEFAULTS} from './retention.js';
import {enqueueTask, retryTask, cancelTask} from './tasks.js';
import {addChatMessages, clearChat} from './chats.js';
import {publicMemory, rememberFromOwner, addRules, editRule, removeRule, bookKeyOfRule, forgetChat, forgetRulebook, botKey, COMPANY_KEY} from './memory.js';
import {summonableGuests, chatKeyFor, chatIsBusy} from './coordination.js';
import {createThread, titleFrom} from './threads.js';
import {pauseAll, resumeGuard, noteBotWork, paused as botsPaused} from './runaway.js';
import {simulateGroup} from './group-simulator.js';
import {BUSY_STATUSES} from './run-state.js';
import {botSettings} from './bot-settings.js';
import {denyBrowserRequest} from './bot-browser.js';
import {answerAsk, expireAsks, orphanAsks, setGrant, setAskBasics} from './asks.js';
import {setLimits} from './limits.js';
import {activityPage} from './activity-log.js';
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
  if (chatIsBusy(state.groupRuns, group, chatKey)) {
    throw Object.assign(new Error('A group run is already active. Wait or retry later.'), {status: 409});
  }
  // A timer is bot-initiated work: counted against the runaway guard, and skipped while bots are paused.
  if (noteBotWork(state, 'run').paused) {
    addChatMessages(state, chatKey, [{role: 'system', text: `Scheduled task "${label}" skipped: bots are paused.`}], {trusted: true});
    return;
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
    const line = {id: entry.id || crypto.randomUUID(), runId: run.id, role: entry.role, senderId: entry.senderId, senderName: entry.senderName, toBotId: entry.toBotId, text: entry.text, at: entry.at || now(),
      // The cards a conversation draws (out of job, a hire, a limit, a setup change) carry their kind;
      // a plain reply's `handoff` kind is only the run log's.
      ...(entry.kind && entry.kind !== 'handoff' ? {kind: entry.kind} : {}), ...(entry.request ? {request: entry.request} : {}), ...(entry.botId ? {botId: entry.botId} : {}), ...(entry.mode ? {mode: entry.mode} : {}), ...(entry.setup ? {setup: entry.setup} : {})};
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
    orphanAsks(state, ask => ask.runId === run.id);
  }
}

/** A run parked on an ask whose answer has come (or lapsed). The offline engine cannot open a page or
 * take a model turn, so the run ends here instead of resuming: a decline says what was declined, and an
 * allow says the demo cannot do it. The answer and any grant are recorded either way, like the server's. */
function settleParkedRun(state, runId, ask) {
  const run = state.groupRuns.find(r => r.id === runId);
  if (!run || run.status !== 'awaiting_ask') return;
  run.status = 'cancelled'; run.completedAt = now(); run.checkpoint = null; run.askIds = [];
  storeRunLines(state, run, [{id: crypto.randomUUID(), role: 'system', text: ask.status === 'declined'
    ? `The owner declined: ${ask.detail || ask.action}.`
    : 'This offline demo cannot open pages, so the run stopped here.'}]);
}

/** One answer to an ask, the same rules and the same reply shape as the server's `POST /api/asks/:id`. */
function answerAskLocal(state, askId, answer) {
  const out = answerAsk(state, askId, answer);
  // A page the owner turned down is never opened.
  const request = (state.browserRequests || []).find(r => r.id === out.ask.requestId);
  if (answer === 'decline' && request?.status === 'pending') denyBrowserRequest(state, request.id);
  if (out.resumeRunId) settleParkedRun(state, out.resumeRunId, out.ask);
  return {ask: out.ask, resumed: Boolean(out.resumeRunId)};
}

/** One offline coordination run, behind the routes the Node orchestrator serves.
 *
 * The demo used to run this in the UI and keep the run in localStorage, so the
 * only way to continue, start or stop it was a branch on `isStaticDemo()`. Now
 * the run is created, run and stored here, and the UI reaches it only through
 * `POST/GET /api/groups/:group/chat` and the `runs/:run/*` routes — the same
 * paths the server answers — so nothing above the transport asks which backend
 * it is talking to. */
async function localRun(state, groupId, {message = '', directBotId = null, checkpoints = false, chatKey = null, runId = null, resume = false, started = false, approve = null, anyway = false} = {}) {
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
  if (resume && prior.status !== 'awaiting_checkpoint' && prior.status !== 'awaiting_limit') throw Object.assign(new Error('Only a run paused at a checkpoint can be continued.'), {status: 409});
  // A run parked by the runaway guard goes on once bots are resumed, not before.
  if (resume && prior.status === 'awaiting_limit' && botsPaused(state)) throw Object.assign(new Error('Bots are paused. Resume them first.'), {status: 409});
  // One live run per chat (per group, for every group but the company). Any other
  // busy run blocks the start; a Start or Continue of a run that is itself busy
  // is the way through, same as the server.
  if (chatIsBusy(state.groupRuns.filter(r => r.id !== runId), group, chatKeyFor(group, {chatKey: chatKey || prior?.chatKey || null, directBotId}))) {
    throw Object.assign(new Error('A group run is already active. Wait or retry later.'), {status: 409});
  }
  const guests = summonableGuests(state.groups, groupId, {includeOff: true});
  const entries = [];
  const run = await simulateGroup({
    group, message: resume ? prior.input : message, directBotId, guests, state, api: runApi(state),
    makeId: idFactory(runId), emit: e => entries.push(e),
    chatKey: chatKey || prior?.chatKey || null,
    started: started || resume, resume: resume ? prior : null,
    checkpoints, anyway,
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
  // An ask from an unattended run lapses after 24 hours, as on the server; nothing else runs a timer here.
  const lapsed = expireAsks(state);
  if (lapsed.expired.length) {
    for (const runId of lapsed.resumeRunIds) settleParkedRun(state, runId, lapsed.expired.find(a => a.runId === runId));
    save(state);
  }
  // The log is paged through /api/activity, not carried in the snapshot (same as the server).
  if (path === '/api/state' && method === 'GET') { const {activity: _log, ...snapshot} = state; return {...snapshot, aiEnabled: false, serverTime: now()}; }
  if (path.split('?')[0] === '/api/activity' && method === 'GET') {
    const q = new URLSearchParams(path.split('?')[1] || '');
    const limit = q.has('limit') ? Number(q.get('limit')) : undefined;
    if (q.has('limit') && !Number.isFinite(limit)) throw Object.assign(new Error('Limit must be a number.'), {status: 400});
    return activityPage(state, {filter: q.get('filter') || undefined, before: q.get('before') || null, limit, botId: q.get('bot') || null});
  }

  let m;
  // The demo has no browser to watch: the Computer view reads this and says so, the way it would say "no device" on a server.
  const live = path.split('?')[0];
  if (live === '/api/browser-live' && method === 'GET') return [];
  if ((m = live.match(/^\/api\/browser-live\/([a-z0-9-]+)$/)) && method === 'GET') return {botId: m[1], agent: false, demo: true, seq: 0, changed: false, state: 'idle', url: null, title: null, site: null};
  if (/^\/api\/browser-live\/[a-z0-9-]+\/(takeover|handback|input)$/.test(live) && method === 'POST') throw Object.assign(new Error('The demo has no browser to take over. Run the full app with the local agent to use one.'), {status: 409});

  // The demo has no connectors, no model provider and no paired agent: Settings reads `demo` and says it needs the server.
  if (live === '/api/connectors' && method === 'GET') return {connectors: [], google: null, demo: true};
  if (live === '/api/ai' && method === 'GET') return {providers: [], defaultProviderId: null, defaultModel: null, bots: {}, demo: true};
  if (live === '/api/agents' && method === 'GET') return {agents: [], actions: [], demo: true};

  // A thread: a new chat run by the primary bot, started in one call like the server's.
  if (path === '/api/threads' && method === 'POST') {
    const message = cleanText(body.message, 4000);
    if (!message) throw Object.assign(new Error('Say what the thread is about.'), {status: 400});
    const thread = createThread(state, {title: titleFrom(message)});
    state.groups.push(thread);
    addChatMessages(state, `team-${thread.id}`, [{role: 'user', text: message}], {trusted: true});
    const run = await localRun(state, thread.id, {message});
    save(state); return {thread, run};
  }
  // Pause all bots and Keep going, like the server's /api/guard. Stop also cancels
  // whatever the guard parked, though the demo's offline engine parks nothing yet.
  if (path === '/api/guard' && method === 'POST') {
    if (typeof body.paused !== 'boolean') throw Object.assign(new Error('Say whether bots are paused: {"paused": true} or {"paused": false}.'), {status: 400});
    if (body.paused) { pauseAll(state); save(state); return {guard: state.guard, resumed: 0, cancelled: 0}; }
    resumeGuard(state);
    const parked = state.groupRuns.filter(r => r.status === 'awaiting_limit' && r.limit?.kind === 'guard');
    // Keep going starts each parked run again where it waited; Stop cancels it.
    for (const run of parked) {
      if (body.stop === true) { run.status = 'cancelled'; run.completedAt = now(); run.checkpoint = null; storeRunLines(state, run, [{id: crypto.randomUUID(), role: 'system', text: 'Stopped. Bots were paused and nothing else ran.'}]); }
      else await localRun(state, run.groupId, {runId: run.id, resume: true});
    }
    save(state); return {guard: state.guard, resumed: body.stop === true ? 0 : parked.length, cancelled: body.stop === true ? parked.length : 0};
  }
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
    const r = await localRun(state, m[1], {message: body.message, directBotId: body.directBotId || null, checkpoints: body.checkpoints === true, chatKey: typeof body.chatKey === 'string' ? body.chatKey : null, anyway: body.anyway === true});
    // What the owner asked every bot to remember is kept, as on the server.
    rememberFromOwner(state, body.message);
    save(state); return r;
  }
  if ((m = path.match(/^\/api\/groups\/([a-z0-9-]+)\/runs\/([a-z0-9-]+)\/continue$/)) && method === 'POST') {
    // A run parked at a limit asks which way to go: more and unlimited carry on (when
    // bots are not paused), stop ends the task.
    const parked = state.groupRuns.find(r => r.id === m[2] && r.groupId === m[1]);
    if (parked?.status === 'awaiting_limit') {
      if (!['more', 'unlimited', 'stop'].includes(body?.choice)) throw Object.assign(new Error('Choose more, unlimited or stop.'), {status: 400});
      if (body.choice === 'stop') {
        parked.status = 'cancelled'; parked.completedAt = now(); parked.checkpoint = null; delete parked.limit;
        storeRunLines(state, parked, [{id: crypto.randomUUID(), role: 'system', text: 'Stopped. Bots were paused and nothing else ran.'}]);
        save(state); return {runId: parked.id, status: 'cancelled'};
      }
    }
    const r = await localRun(state, m[1], {runId: m[2], resume: true}); save(state); return r;
  }
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
  // The owner answers an ask, and sets what a bot may do without asking.
  if ((m = path.match(/^\/api\/asks\/([a-z0-9-]+)$/)) && method === 'POST') { const r = answerAskLocal(state, m[1], body?.answer); save(state); return r; }
  if (path === '/api/permissions/basics' && method === 'POST') { const r = setAskBasics(state, body?.ask); save(state); return r; }
  if (path === '/api/limits' && method === 'POST') { const r = setLimits(state, body); save(state); return r; }
  if (path === '/api/grants' && method === 'POST') { const g = setGrant(state, String(body?.botId ?? ''), String(body?.action ?? ''), body?.scope ?? '', body?.choice); save(state); return g; }
  if (path === '/api/bots/run') throw new Error('Running AI bots requires the separate Node backend, not GitHub Pages.');
  // The old approve and deny routes answer the request's ask (Allow, Decline) for one phase; a request with no ask cannot be opened here.
  if ((m = path.match(/^\/api\/browser-requests\/([a-z0-9-]+)\/(approve|deny)$/)) && method === 'POST') {
    const request = (state.browserRequests || []).find(r => r.id === m[1]);
    if (request?.askId) { answerAskLocal(state, request.askId, m[2] === 'approve' ? 'allow' : 'decline'); save(state); return (state.browserRequests || []).find(r => r.id === m[1]); }
    if (m[2] === 'approve') throw Object.assign(new Error('Browser requests run on your own device through a paired local agent, which needs the Node build. This demo cannot open pages.'), {status: 409});
    const r = denyBrowserRequest(state, m[1]); save(state); return r;
  }
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
  if (path === '/api/retention' && method === 'PATCH') { updateRetention(state, body); save(state); return {...RETENTION_DEFAULTS, ...state.settings.retention}; }
  // A book is named by `bot` (an id, or `company`) or, for an older client, `model`.
  const memoryPath = path.split('?')[0], memoryQuery = new URLSearchParams(path.split('?')[1] || '');
  const bookOf = from => { const bot = from?.bot || memoryQuery.get('bot'), model = from?.model || memoryQuery.get('model'); return bot ? (bot === COMPANY_KEY ? COMPANY_KEY : botKey(bot)) : model || null; };
  if (memoryPath === '/api/memory' && method === 'GET') { const bot = memoryQuery.get('bot'); return publicMemory(state, {bot: bot && bot !== COMPANY_KEY ? bot : null}); }
  if (path === '/api/memory/rules' && method === 'POST') {
    const book = bookOf(body);
    if (!book) throw Object.assign(new Error('Which bot should keep this rule?'), {status: 400});
    const r = addRules(state, book, [body.text], {source: 'user', label: body.label});
    save(state);
    return {ok: true, model: book, rules: r.book.rules.map(rule => ({id: rule.id, text: rule.text, source: rule.source}))};
  }
  if ((m = memoryPath.match(/^\/api\/memory\/rules\/([a-z0-9-]+)$/)) && method === 'PATCH') {
    const rule = editRule(state, bookOf(body) || bookKeyOfRule(state, m[1]) || '', m[1], body.text);
    if (!rule) throw Object.assign(new Error('That bot already keeps that line.'), {status: 409});
    save(state); return {ok: true, rule: {id: rule.id, text: rule.text, source: rule.source}};
  }
  if ((m = memoryPath.match(/^\/api\/memory\/rules\/([a-z0-9-]+)$/)) && method === 'DELETE') {
    const r = removeRule(state, bookOf(null) || bookKeyOfRule(state, m[1]) || '', m[1]); save(state); return r;
  }
  if (path === '/api/memory/forget' && method === 'POST') {
    if (bookOf(body)) forgetRulebook(state, bookOf(body));
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
