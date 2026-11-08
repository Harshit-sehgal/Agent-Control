/* Agent Control browser-local transport (used by the static GitHub Pages build).
 *
 * All data stays inside this browser via localStorage. The lifecycle rules are
 * not reimplemented here: they come from the same `workflow.js` + `core.js`
 * modules the Node server uses, so the demo and the real dashboard cannot drift.
 */
import {scoreCandidate, templateDraft, cleanText, initialState, markDue, activity, DEMO_SAMPLES} from './core.js?v=20376b59b1';
import {
  migrate, seedDemo, updateSettings, addCandidate, beginProcessing,
  finishProcessing, editDraft, findDraft, rewriteDraft, draftAction, addGroup,
  addBot, updateBot, updateGroup, removeBot, removeGroup, addSchedule, removeSchedule, resetDemo,
} from './workflow.js?v=20376b59b1';
import {enqueueTask, retryTask, cancelTask} from './tasks.js?v=20376b59b1';
import {addEvidence, verifyEvidence, dropEvidence} from './evidence.js?v=20376b59b1';
import {addChatMessages, clearChat} from './chats.js?v=20376b59b1';
import {summonableGuests} from './coordination.js?v=20376b59b1';
import {simulateGroup} from './group-simulator.js?v=20376b59b1';
import {botSettings} from './bot-settings.js?v=20376b59b1';
import {denyBrowserRequest} from './bot-browser.js?v=20376b59b1';
import {withLocalLock, claimLocalRun, renewLocalRun, finishLocalRun, localRunCancelled, reclaimExpiredLocalRuns, cancelLocalRunsForChat} from './local-runs.js?v=20376b59b1';

const KEY = 'agent-control-ghpages-v1';
const now = () => new Date().toISOString();
let dueDepth = 0;

async function read() {
  await reclaimExpiredLocalRuns();
  try {
    const value = localStorage.getItem(KEY);
    if (value) {
      const state = JSON.parse(value);
      // Always migrate: a stored version equal to SCHEMA_VERSION can still be
      // missing a field added later in the same version, and a legacy shape must
      // gain every collection the UI indexes into.
      if (state && typeof state === 'object' && Array.isArray(state.candidates)) return migrate(state);
    }
  } catch { throw new Error('Browser storage is unavailable. Enable local storage to use this demo.'); }
  return migrate(initialState());
}
function save(state) {
  try { localStorage.setItem(KEY, JSON.stringify(state)); }
  catch { throw new Error('Unable to save browser-local data. Check available storage and private browsing settings.'); }
}
const find = (items, key) => items.find(x => x.id === key) || (() => { throw new Error('Item not found.'); })();

/** Advance the local clock so scheduled drafts and due tasks resolve.
 * This mirrors the Node `src/scheduler.js` (drafts) and `src/queue.js`
 * (reminder tasks) with the same `markDue`/`activity` primitives, so a
 * transition logged by the Node backend is logged identically here. */
function processLocal(state, id) {
  const ctx = beginProcessing(state, id);
  const result = {text: templateDraft(ctx.candidate, ctx.settings), mode: 'template', note: 'Static template only; not real AI, research or verified fact-checking.'};
  return finishProcessing(state, id, scoreCandidate(ctx.candidate, ctx.settings.topics), result);
}

/** A due scheduled bot task runs through the same offline simulator as a chat. */
async function runBotTask(state, t) {
  const {groupId, botId, message, label} = t.payload;
  const group = state.groups.find(g => g.id === groupId), bot = botId ? group?.bots.find(b => b.id === botId) : null;
  if (!group || (botId && !bot)) { t.status = 'cancelled'; t.lastError = 'That bot or group no longer exists.'; return; }
  const chatKey = botId || `team-${groupId}`;
  if (bot && !botSettings(bot).enabled) {
    addChatMessages(state, chatKey, [{role: 'system', text: `Scheduled task "${label}" skipped: ${bot.name} is switched off.`}], {trusted: true});
    return;
  }
  const entries = [];
  const holdId = crypto.randomUUID();
  const lease = await claimLocalRun({id: holdId, groupId, chatKey, status: 'running', createdAt: now()});
  const heartbeat = setInterval(() => { void renewLocalRun(lease).catch(() => {}); }, 30_000);
  // `started` skips the plan gate. Scheduling the task was the approval.
  // includeOff so a mention of a switched-off guest is refused by name.
  let run;
  try {
    run = await simulateGroup({
      group, message, directBotId: botId, guests: summonableGuests(state.groups, groupId, {includeOff: true}),
      state: {...state, drafts: [...state.drafts]},
      api: async (url, method) => {
        const m = url.match(/^\/api\/candidates\/([a-z0-9-]+)\/process$/);
        if (!m || method !== 'POST') throw new Error(`Not available to a scheduled task: ${method} ${url}`);
        return processLocal(state, m[1]);
      },
      makeId: () => crypto.randomUUID(), emit: e => entries.push(e), chatKey, started: true,
      shouldStop: () => localRunCancelled(holdId),
    });
  } catch (error) {
    clearInterval(heartbeat);
    const finished = await finishLocalRun(lease, {status: 'failed', error: String(error.message || error).slice(0, 400)});
    if (finished?.status === 'cancelled') return;
    addChatMessages(state, chatKey, [{role: 'system', text: `Scheduled task "${label}" did not run: ${error.message}`}], {trusted: true});
    throw error;
  }
  clearInterval(heartbeat);
  const finished = await finishLocalRun(lease, run);
  if (finished?.status === 'cancelled') return;
  addChatMessages(state, chatKey, [{role: 'system', text: `Scheduled task: ${message}`}, ...entries], {trusted: true});
}

async function due(state) {
  const time = Date.now();
  let changed = false;
  for (const d of state.drafts) {
    if (markDue(d, time)) { changed = true; activity(state, 'ready', `Draft for ${d.author} is ready for manual posting.`, {draftId: d.id}); }
  }
  // Reminder tasks fire here exactly like the server's queue worker: a one-off
  // completes, an interval re-arms for the next window.
  for (const t of state.tasks) {
    if (t.kind !== 'reminder' || t.status !== 'queued') continue;
    if (!(Date.parse(t.runAt) <= time)) continue;
    activity(state, 'reminder', t.payload.label, {taskId: t.id});
    changed = true;
    if (t.payload.kind === 'once') {
      t.status = 'done';
      t.completedAt = new Date(time).toISOString();
    } else {
      t.runAt = new Date(time + t.intervalMinutes * 60000).toISOString();
    }
  }
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

  if (path === '/api/demo/seed' && method === 'POST') { const r = seedDemo(state, DEMO_SAMPLES); save(state); return r; }
  if (path === '/api/settings' && method === 'PATCH') { const r = updateSettings(state, body); save(state); return r; }
  if (path === '/api/candidates' && method === 'POST') { const r = addCandidate(state, body); save(state); return {...r.candidate, duplicate: r.duplicate}; }

  let m;
  if ((m = path.match(/^\/api\/candidates\/([a-z0-9-]+)\/process$/)) && method === 'POST') {
    const draft = processLocal(state, m[1]);
    save(state);
    return draft;
  }
  if ((m = path.match(/^\/api\/drafts\/([a-z0-9-]+)$/)) && method === 'PATCH') { const d = editDraft(state, m[1], body.text); save(state); return d; }
  if ((m = path.match(/^\/api\/drafts\/([a-z0-9-]+)\/(approve|reject|ready|posted|rewrite)$/)) && method === 'POST') {
    const draft = findDraft(state, m[1]);
    let result;
    if (m[2] === 'rewrite') {
      const candidate = find(state.candidates, draft.candidateId);
      const direction = cleanText(body?.direction, 240);
      result = rewriteDraft(state, m[1], {text: templateDraft(candidate, state.settings, direction), mode: 'template', note: direction ? 'Template draft. The requested direction is recorded but was not applied by an AI model.' : 'Template draft. Rewrite instructions have not been processed by an AI model.'});
    } else {
      result = draftAction(state, m[1], m[2]);
    }
    save(state);
    return result;
  }
  if (path === '/api/groups' && method === 'POST') { const g = addGroup(state, body); save(state); return g; }
  if ((m = path.match(/^\/api\/groups\/([a-z0-9-]+)\/bots$/)) && method === 'POST') { const b = addBot(state, m[1], body); save(state); return b; }
  // Keep lasting bot profile edits in the store so they survive a reload, exactly
  // like the Node backend, instead of living only in browser-local UI state.
  if ((m = path.match(/^\/api\/groups\/([a-z0-9-]+)\/bots\/([a-z0-9-]+)$/)) && method === 'PATCH') { const b = updateBot(state, m[1], m[2], body); save(state); return b; }
  if ((m = path.match(/^\/api\/groups\/([a-z0-9-]+)\/bots\/([a-z0-9-]+)$/)) && method === 'DELETE') { const r = removeBot(state, m[1], m[2]); await cancelLocalRunsForChat(state, m[2], 'Bot removed.'); save(state); return r; }
  if ((m = path.match(/^\/api\/groups\/([a-z0-9-]+)$/)) && method === 'PATCH') { const g = updateGroup(state, m[1], body); save(state); return g; }
  if ((m = path.match(/^\/api\/groups\/([a-z0-9-]+)$/)) && method === 'DELETE') { const r = removeGroup(state, m[1]); await cancelLocalRunsForChat(state, `team-${m[1]}`, 'Group removed.'); save(state); return r; }
  if (path === '/api/bots/run') throw new Error('Running AI bots requires the separate Node backend, not GitHub Pages.');
  if ((m = path.match(/^\/api\/browser-requests\/([a-z0-9-]+)\/approve$/)) && method === 'POST') throw Object.assign(new Error('Browser requests run on your own device through a paired local agent, which needs the Node build. This demo cannot open pages.'), {status: 409});
  if ((m = path.match(/^\/api\/browser-requests\/([a-z0-9-]+)\/deny$/)) && method === 'POST') { const r = denyBrowserRequest(state, m[1]); save(state); return r; }
  if (path === '/api/schedules' && method === 'POST') { const s = addSchedule(state, body); save(state); return s; }
  if ((m = path.match(/^\/api\/schedules\/([a-z0-9-]+)$/)) && method === 'DELETE') { const r = removeSchedule(state, m[1]); save(state); return r; }
  // Structured task endpoints, identical to the Node server's queue surface.
  if (path === '/api/tasks' && method === 'POST') { const t = enqueueTask(state, body); save(state); return t.task; }
  if ((m = path.match(/^\/api\/tasks\/([a-f0-9-]+)\/retry$/)) && method === 'POST') { const r = retryTask(state, m[1]); save(state); return r; }
  if ((m = path.match(/^\/api\/tasks\/([a-f0-9-]+)$/)) && method === 'DELETE') { const r = cancelTask(state, m[1]); save(state); return r; }
  if ((m = path.match(/^\/api\/drafts\/([a-f0-9-]+)\/evidence$/)) && method === 'POST') { const e = addEvidence(state, {...body, draftId: m[1]}); save(state); return e; }
  if ((m = path.match(/^\/api\/evidence\/([a-f0-9-]+)\/verify$/)) && method === 'POST') { const e = verifyEvidence(state, m[1], body.status); save(state); return e; }
  if ((m = path.match(/^\/api\/evidence\/([a-f0-9-]+)$/)) && method === 'DELETE') { const r = dropEvidence(state, m[1]); save(state); return r; }
  // Conversation history, stored with the rest of the browser-local state.
  if ((m = path.match(/^\/api\/chats\/([a-z0-9-]+)\/messages$/)) && method === 'POST') { const r = addChatMessages(state, m[1], Array.isArray(body.messages) ? body.messages : [body]); save(state); return r; }
  if ((m = path.match(/^\/api\/chats\/([a-z0-9-]+)$/)) && method === 'DELETE') { const r = clearChat(state, m[1]); await cancelLocalRunsForChat(state, m[1], 'Chat cleared.'); save(state); return r; }
  if (path === '/api/reset-demo' && method === 'POST') { const r = resetDemo(state); save(state); return r; }
  throw new Error(`Not available in the browser-local demo: ${method} ${path}`);
}

window.AGENT_LOCAL_API = localApi;
window.AGENT_PAGES_DEMO = localApi; // Backwards-compatible alias used by the test suite.
