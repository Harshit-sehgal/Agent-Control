/** Bot browser requests on the server: run an approved request on this host's
 * own headless browser, or hand it to a paired local agent that holds its
 * permission, then bring the result back into the conversation and let the bot
 * continue from it.
 *
 * `BROWSER_RUNTIME` decides where it runs (see `browser-runtime.js`). The
 * server path exists so a bot can read a page when no device is paired and
 * nothing of the user's is awake; the agent path stays for a laptop that has
 * the browser and the signed-in profile.
 */
import * as agent from './agent.js';
import {browserRuntime} from './browser-runtime.js';
import {fail} from '../shared/errors.js';
import {addChatMessages} from '../shared/chats.js';
import {activity, cleanText} from '../shared/core.js';
import {browserResultText, capturePageText, hostOf, MAX_BROWSER_DEPTH} from '../shared/bot-browser.js';
import {logActivity} from '../shared/activity-log.js';

const stamp = () => new Date().toISOString();
/** The risky classes the owner cleared this request for; none for a request recorded before they were. */
const approvedOf = request => (Array.isArray(request.approved) ? request.approved.filter(a => typeof a === 'string') : []);
const say = (s, key, text) => { try { addChatMessages(s, key, [{role: 'system', kind: 'browser-result', text}], {trusted: true}); } catch { /* Conversation removed. */ } };

/** How to hand a finished page back to the conversation. The modules that own
 * those functions import this one, so a direct import would be a cycle; the
 * server sets them once (see `setBrowserResultHooks`). */
let resultHooks = {};
export function setBrowserResultHooks(hooks) { resultHooks = {...resultHooks, ...hooks}; }

/** How long a page sent to a device may take before it is failed, so a run never waits on it forever. */
export const BROWSER_WAIT_MS = 600000;
const OFFLINE = 'Your computer\'s agent is offline. A server on your own computer restarts it within a few seconds; on another machine, start it there (`node agent/agent.mjs run`), then approve again.';
/** Seen lately. A device paired a moment ago counts until its first beat lands. */
const online = (row, nowMs = Date.now()) => Boolean(row?.last_seen_at || row?.paired_at) && Date.parse(row.last_seen_at || row.paired_at) > nowMs - agent.AGENT_ONLINE_MS;

/** The most recently seen online agent that may run this kind; null when none may; throws when the ones that may are offline. */
function pickAgent(store, kind) {
  if (typeof store.all !== 'function') return null;
  const may = store.all('SELECT id,permissions,last_seen_at,paired_at FROM agents WHERE revoked_at IS NULL ORDER BY last_seen_at DESC')
    .filter(a => { try { return JSON.parse(a.permissions || '[]').includes(kind); } catch { return false; } });
  const live = may.find(a => online(a));
  if (may.length && !live) fail(OFFLINE, 409);
  return live?.id || null;
}

/** Send a pending request to a local agent, or run it here. A request with no
 * capable agent stays pending, so pairing one and approving again still works. */
export async function dispatchBrowserRequest(store, id, {actor = null, runtime = browserRuntime} = {}) {
  const request = (store.read().browserRequests || []).find(r => r.id === id);
  if (!request) fail('Browser request not found.', 404);
  if (request.status !== 'pending') fail('This browser request is no longer waiting.', 409);
  const here = runtime.mode !== 'agent' && runtime.available();
  const agentId = here ? null : pickAgent(store, request.kind);
  if (!here && !agentId) fail(`No paired local agent holds the ${request.kind} permission. ${runtime.mode === 'agent'
    ? 'This install only runs browser requests on a paired device (BROWSER_RUNTIME=agent). Pair one in Settings → Local agents and grant it, then approve again.'
    : 'A server started on your own computer connects this computer by itself; restart it, pair one in Settings → Local agents, or give this server a browser: set AGENT_BROWSER_ALLOWLIST=* for any public site (or name hosts) and install Chrome, or point AGENT_BROWSER_PATH at one. Then approve again.'}`, 409);
  // Claim pending before any agent task exists. A denial that commits first
  // stays denied, and the device is never asked to open the page.
  const claimed = await store.update(s => {
    const live = (s.browserRequests || []).find(r => r.id === id);
    if (!live || live.status !== 'pending') fail(live ? 'This browser request is no longer waiting.' : 'Browser request not found.', live ? 409 : 404);
    live.status = 'dispatched'; live.approvedBy = actor || 'auto'; live.via = here ? 'server' : 'agent'; live.updatedAt = stamp();
    // Sending the page out is the moment it leaves the app. A page nobody opened (declined, stopped) is never logged.
    const n = (live.steps || []).length;
    logActivity(s, {botId: live.botId, kind: 'outside', text: `${live.botName} ${n ? 'used' : 'read'} ${hostOf(live.url) || live.url}${n ? ` (${n} step${n === 1 ? '' : 's'})` : ''}.`, threadId: live.chatKey});
    return live;
  });
  // The server has the browser: run it in the background, so the approve
  // request returns at once and the chat card fills in when the page is read.
  if (here) {
    void runHere(store, claimed.id, runtime);
    return claimed;
  }
  // `enqueueAgentTask` inserts its own row (auto-commit) from inside this document
  // write, so the task can exist even when the document write is rejected. Track
  // it separately from "the write landed", or the revert below is skipped and the
  // request stays dispatched forever with no ids to match the device's page.
  let taskId = null;
  let committed = false;
  try {
    const live = await store.update(s => {
      const current = (s.browserRequests || []).find(r => r.id === id);
      // A feed can still be denied after the claim and before this enqueue.
      if (!current || current.status !== 'dispatched') fail(current ? 'This browser request is no longer waiting.' : 'Browser request not found.', current ? 409 : 404);
      const {task} = agent.enqueueAgentTask(store, agentId, {kind: request.kind, payload: {url: request.url, steps: request.steps, botId: request.botId}, approved: approvedOf(request), idempotencyKey: `browser:${id}`, createdBy: actor || `bot:${request.botId}`});
      taskId = task.id;
      current.agentTaskIds = [task.id]; current.notAfter = Date.now() + BROWSER_WAIT_MS; current.updatedAt = stamp();
      activity(s, 'agent', `Sent ${current.botName}'s browser request to a local agent.`, {requestId: id, taskId: task.id});
      return current;
    });
    committed = true;
    return live;
  } catch (error) {
    // An orphaned task row would let the device open a page for a request that is
    // about to be pending again (and the idempotency key would then hand the same
    // dead task to the next approval), so fail it before reverting.
    if (!committed && taskId) {
      try { agent.discardAgentTask(store, taskId); }
      catch (cleanupError) { error.cause = cleanupError; }
    }
    // The claim already committed. Put it back unless a denial won, or the
    // task row exists and must stay tied to this dispatched request.
    if (!committed && error.status !== 404 && !(error.status === 409 && /no longer waiting/.test(error.message || ''))) {
      try {
        await store.update(s => {
          const live = (s.browserRequests || []).find(r => r.id === id);
          if (!live || live.status !== 'dispatched' || (live.agentTaskIds || []).length) return;
          live.status = 'pending'; delete live.approvedBy; delete live.via; live.updatedAt = stamp();
        });
      } catch (revertError) { error.cause = revertError; }
    }
    throw error;
  }
}

/** Run one claimed request on this server's browser. A failure is reported in
 * the chat exactly like a device failure, and the request is finished either
 * way, so nothing is left reading `dispatched` with no task behind it. */
async function runHere(store, id, runtime) {
  const request = (store.read().browserRequests || []).find(r => r.id === id);
  if (!request) return;
  try {
    const result = await runtime.run({url: request.url, steps: request.steps || [], approved: approvedOf(request)});
    await finishBrowserRequest(store, request, {ok: true, result});
  } catch (error) {
    await finishBrowserRequest(store, request, {ok: false, error: error.message});
  }
}

/** Requests a bot set to run without asking go out at once. A failure is
 * reported in the chat and the request stays pending for a person. */
export async function autoDispatch(store, records, {runtime = browserRuntime} = {}) {
  for (const record of records) {
    try { await dispatchBrowserRequest(store, record.id, {runtime}); }
    catch (error) {
      // Already approved or denied: it is not waiting on a person.
      if (error.status === 409 && /no longer waiting/.test(error.message || '')) continue;
      await store.update(s => say(s, record.chatKey, `${record.botName}'s browser request is waiting: ${error.message}`));
    }
  }
}

/** A 1:1 browse continues that bot, with the page in its own envelope field
 * (untrusted text with a restriction, mirroring the group-run envelope).
 * Anything else is a group run. */
export function continueBrowserWork(store, spec, {runBot, runGroup}) {
  if (spec?.directBotId && typeof runBot === 'function') return runBot(store, {botId: spec.directBotId, input: spec.message, page: spec.page, browserDepth: spec.browserDepth || 0});
  return runGroup(store, spec);
}

/** Which page this is, so a bot (or a teammate handed it later) knows it already read that address. */
const pageHeading = (request, result) => {
  const url = cleanText(result?.finalUrl || result?.url || request.url, 500), title = cleanText(result?.title, 200);
  return `Page: ${url}${title ? `\nTitle: ${title}` : ''}${request.find ? `\nPassages holding: ${request.find}` : ''}\n\n`;
};

/** A browser request finished, here or on a device. Record the result, post the
 * chat line, and give the page back to the bot that asked for it. */
export async function finishBrowserRequest(store, request, {ok, result = null, error = null}, hooks = resultHooks) {
  const {continueRun, resumeBrowser} = hooks || {};
  // The owner took the browser while it ran: the steps after that point were not run, and what comes
  // back is the page as they left it. The chat and the bot are each told so.
  const tookOver = ok && result?.tookOver === true;
  const captured = ok ? `${tookOver ? 'The owner took over the browser while this ran, so the steps after that point were not run. This is the page as they left it.\n\n' : ''}${pageHeading(request, result)}${capturePageText(result, 12000, request.find || '')}` : '';
  const text = ok ? `${browserResultText(request, result)}${tookOver ? '\n\nYou took over the browser, so the steps after that point were not run. This is the page as you left it.' : ''}` : `${request.botName}'s browser request failed: ${cleanText(error, 300) || 'the browser reported a failure.'}`;
  const done = await store.update(s => {
    const live = (s.browserRequests || []).find(r => r.id === request.id);
    if (!live || ['done', 'failed', 'denied'].includes(live.status)) return null;
    live.status = ok ? 'done' : 'failed'; live.updatedAt = stamp(); live.error = ok ? null : cleanText(error, 300);
    live.result = ok && result && typeof result === 'object' ? {title: cleanText(result.title, 200) || null, finalUrl: cleanText(result.finalUrl || result.url, 2000) || null, text: cleanText(text, 4000), page: captured || null} : null;
    say(s, live.chatKey, text);
    return live;
  });
  // The continued turn is one round deeper; recordBrowserRequests refuses to
  // open another page once a chain reaches MAX_BROWSER_DEPTH.
  if (done?.runId) {
    if (!resumeBrowser) {
      await store.update(s => say(s, done.chatKey, 'The page came back, but this run could not be resumed.'));
      return done;
    }
    try { await resumeBrowser(store, done, {ok, text: captured}); }
    catch (error) { await store.update(s => say(s, done.chatKey, `The result could not be handed back to ${done.botName}: ${error.message}`)); }
    return done;
  }
  if (ok && done?.status === 'done' && continueRun) {
    const peers = (store.read().browserRequests || []).filter(r => r.chatKey === done.chatKey && !r.runId);
    if (peers.some(r => r.id !== done.id && ['pending', 'dispatched'].includes(r.status))) return done;
    const capturedAll = peers.filter(r => r.status === 'done').map(r => r.result?.page).filter(Boolean).join('\n\n---\n\n') || captured || text;
    const host = store.read().groups.find(g => g.id === done.groupId), own = host?.bots.some(b => b.id === done.botId);
    const follow = `${own ? '' : `@${done.botName} `}Here is the page you asked for. Continue the task with it.`;
    // The agent POST times out at 15s. A 1:1 model turn can take minutes, so
    // do not hold that request open for it.
    void Promise.resolve(continueRun(store, {groupId: done.groupId, message: follow, page: String(capturedAll).slice(0, 4000), directBotId: own ? done.botId : null, chatKey: done.chatKey, browserDepth: done.depth + 1}))
      .catch(error => store.update(s => say(s, done.chatKey, `The result could not be handed back to ${done.botName}: ${error.message}`)))
      // That handler is itself a write (a paused or restoring workspace refuses
      // it), and an unhandled rejection takes the whole server down.
      .catch(error => console.error('Handing a page back to a bot:', error.message));
  }
  return done;
}

/** A person takes over the page a bot asked for, to sign in or answer a
 * challenge the browser cannot pass on its own.
 *
 * The page is opened in a context the runtime keeps until `handBackTakeover`,
 * so a cookie earned here survives from one call to the next — and nothing
 * else: the next capture still starts with a fresh, signed-out context. The
 * request stays waiting on a person meanwhile, so a takeover that times out
 * leaves nothing stuck: the runtime refuses a second takeover and a bot's page
 * while the person is holding it, and the request can be taken over again. The
 * bot is resumed when the person hands the page back, with the page as they
 * left it. */
export async function beginTakeover(store, requestId, {actor = null, runtime = browserRuntime} = {}) {
  const request = (store.read().browserRequests || []).find(r => r.id === requestId);
  if (!request) fail('Browser request not found.', 404);
  if (['done', 'failed', 'denied'].includes(request.status)) fail('That browser request has already finished.', 409);
  if (runtime.mode === 'agent' || !runtime.available()) fail(`No browser is available on this server to take over. ${runtime.mode === 'agent'
    ? 'This install only runs browser requests on a paired device (BROWSER_RUNTIME=agent).'
    : 'Set AGENT_BROWSER_ALLOWLIST (a host list, or * for any public site) and install Chrome, or point AGENT_BROWSER_PATH at one.'}`, 409);
  const view = await runtime.beginLive({url: request.url, requestId: request.id, openedBy: actor});
  return {...view, requestId: request.id};
}

/** The person is done: hand the page they reached back to the bot that asked.
 * The context is disposed either way — a takeover is not a session the next
 * capture inherits. */
export async function handBackTakeover(store, sessionId, {runtime = browserRuntime} = {}) {
  const {requestId, page} = await runtime.endLive(sessionId);
  if (!requestId) return {handedBack: false, reason: 'That takeover was not opened for a bot request.', page};
  const request = (store.read().browserRequests || []).find(r => r.id === requestId);
  if (!request || ['done', 'failed', 'denied'].includes(request.status)) return {handedBack: false, reason: 'That browser request has already finished.', page};
  const url = page?.url || request.url;
  const text = String(page?.text || '');
  const result = {
    url, finalUrl: url, title: page?.title || null,
    excerpt: text.slice(0, 600), text: text.slice(0, 60000),
    elements: Array.isArray(page?.elements) ? page.elements : [],
    elementCount: Number(page?.elementCount) || 0,
    blockedRequests: Number(page?.blockedRequests) || 0,
    engine: 'browser', capturedAt: stamp(),
  };
  const done = await finishBrowserRequest(store, request, {ok: true, result});
  // The owner signed in and the bot was handed what they reached: that left the app too.
  await store.update(s => logActivity(s, {botId: request.botId, kind: 'outside', text: `${request.botName} was handed ${hostOf(url) || url} after you signed in.`, threadId: request.chatKey}));
  return {handedBack: true, requestId, request: done, page};
}

/** Fail every page a device was sent and will not deliver: its computer has stopped being seen, or the
 * page is past its deadline. The task is failed first, so a device that wakes later is not handed it, and
 * the request then finishes like any failed page, which lets a run that waited on it carry on. Returns
 * how many pages were failed. */
export async function expireBrowserTasks(store, hooks = resultHooks, nowMs = Date.now()) {
  if (typeof store.get !== 'function') return 0;
  let expired = 0;
  for (const request of (store.read().browserRequests || []).filter(r => r.status === 'dispatched' && r.via === 'agent')) {
    for (const taskId of request.agentTaskIds || []) {
      const task = store.get('SELECT agent_id,status FROM agent_tasks WHERE id=?', taskId);
      if (!task || !['queued', 'running'].includes(task.status)) continue;
      const device = store.get('SELECT last_seen_at,paired_at,revoked_at FROM agents WHERE id=?', task.agent_id);
      const reason = !online(device, nowMs) ? 'Your computer went offline before it opened the page. Start the app on it again, then ask again.'
        : Number.isFinite(request.notAfter) && nowMs > request.notAfter ? 'Your computer did not open the page in time.' : null;
      if (!reason) continue;
      agent.failAgentTasks(store, [taskId], reason);
      if (await onAgentTaskResult(store, taskId, hooks)) expired++;
    }
  }
  return expired;
}

/** Run `expireBrowserTasks` on a short cadence, so a page waits a bounded time even when no device beats. */
export function startBrowserExpiry(ws, intervalMs = 30000) {
  let busy = false, stopped = false;
  const run = async () => {
    if (busy || stopped) return;
    busy = true;
    try { await (ws.trackWork ? ws.trackWork(() => expireBrowserTasks(ws)) : expireBrowserTasks(ws)); }
    catch (e) { if (e?.status !== 503) console.error('Browser expiry error:', e.message); }
    finally { busy = false; }
  };
  void run();
  const timer = setInterval(() => void run(), intervalMs); timer.unref();
  return async () => { stopped = true; clearInterval(timer); if (busy) await new Promise(resolve => setTimeout(resolve, 50)); };
}

/** An agent reported on a task. A task that will retry changes nothing yet. */
export async function onAgentTaskResult(store, taskId, hooks = {}) {
  const request = (store.read().browserRequests || []).find(r => (r.agentTaskIds || []).includes(taskId));
  if (!request || typeof store.get !== 'function') return null;
  const row = store.get('SELECT status,result,error FROM agent_tasks WHERE id=?', taskId);
  if (!row || !['done', 'failed'].includes(row.status)) return null;
  let result = null;
  try { result = row.result ? JSON.parse(row.result) : null; } catch { /* Unreadable result: reported as empty. */ }
  return finishBrowserRequest(store, request, {ok: row.status === 'done', result, error: row.error}, hooks);
}
