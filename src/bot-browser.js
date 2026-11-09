/** Bot browser requests on the server: hand an approved request to a paired
 * local agent that holds its permission, then bring the result back into the
 * conversation and let the bot continue from it.
 *
 * Nothing here opens a browser. The local agent does, on the user's device,
 * inside its own allowlist and proxy; the server only queues signed work for it.
 */
import * as agent from './agent.js';
import {addChatMessages} from '../shared/chats.js';
import {activity, cleanText} from '../shared/core.js';
import {browserResultText, capturePageText, feedPageText, MAX_BROWSER_DEPTH} from '../shared/bot-browser.js';

const fail = (message, status = 400) => { throw Object.assign(new Error(message), {status}); };
const stamp = () => new Date().toISOString();
const say = (s, key, text) => { try { addChatMessages(s, key, [{role: 'system', kind: 'browser-result', text}], {trusted: true}); } catch { /* Conversation removed. */ } };

/** The most recently seen agent that may run this kind, or null. */
function pickAgent(store, kind) {
  if (typeof store.all !== 'function') return null;
  const row = store.all('SELECT id,permissions FROM agents WHERE revoked_at IS NULL ORDER BY last_seen_at DESC')
    .find(a => { try { return JSON.parse(a.permissions || '[]').includes(kind); } catch { return false; } });
  return row?.id || null;
}

/** Send a pending request to a local agent. A request with no capable agent
 * stays pending, so pairing one and approving again still works. */
export async function dispatchBrowserRequest(store, id, {actor = null} = {}) {
  const request = (store.read().browserRequests || []).find(r => r.id === id);
  if (!request) fail('Browser request not found.', 404);
  if (request.status !== 'pending') fail('This browser request is no longer waiting.', 409);
  const agentId = pickAgent(store, request.kind);
  if (!agentId) fail(`No paired local agent holds the ${request.kind} permission. Pair one under You → Local agents and grant it, then approve again.`, 409);
  // Claim pending before any agent task exists. A denial that commits first
  // stays denied, and the device is never asked to open the page.
  await store.update(s => {
    const live = (s.browserRequests || []).find(r => r.id === id);
    if (!live || live.status !== 'pending') fail(live ? 'This browser request is no longer waiting.' : 'Browser request not found.', live ? 409 : 404);
    live.status = 'dispatched'; live.approvedBy = actor || 'auto'; live.updatedAt = stamp();
  });
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
      const {task} = agent.enqueueAgentTask(store, agentId, {kind: request.kind, payload: {url: request.url, steps: request.steps}, idempotencyKey: `browser:${id}`, createdBy: actor || `bot:${request.botId}`});
      taskId = task.id;
      current.agentTaskIds = [task.id]; current.updatedAt = stamp();
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
          live.status = 'pending'; delete live.approvedBy; live.updatedAt = stamp();
        });
      } catch (revertError) { error.cause = revertError; }
    }
    throw error;
  }
}

/** Requests a bot set to run without asking go out at once. A failure is
 * reported in the chat and the request stays pending for a person. */
export async function autoDispatch(store, records) {
  for (const record of records) {
    try { await dispatchBrowserRequest(store, record.id); }
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

/** An agent reported on a task. When it belongs to a bot's browser request and
 * is final, post the result and give it back to the bot, at most
 * MAX_BROWSER_DEPTH rounds deep. A task that will retry changes nothing yet. */
export async function onAgentTaskResult(store, taskId, {continueRun, resumeFeed, resumeBrowser} = {}) {
  const request = (store.read().browserRequests || []).find(r => (r.agentTaskIds || []).includes(taskId));
  if (!request || typeof store.get !== 'function') return null;
  const row = store.get('SELECT status,result,error FROM agent_tasks WHERE id=?', taskId);
  if (!row || !['done', 'failed'].includes(row.status)) return null;
  let result = null;
  try { result = row.result ? JSON.parse(row.result) : null; } catch { /* Unreadable result: reported as empty. */ }
  const captured = row.status === 'done' ? capturePageText(result) : '';
  const text = row.status === 'done' ? browserResultText(request, result) : `${request.botName}'s browser request failed: ${cleanText(row.error, 300) || 'the agent reported a failure.'}`;
  const done = await store.update(s => {
    const live = s.browserRequests.find(r => r.id === request.id);
    if (!live || ['done', 'failed', 'denied'].includes(live.status)) return null;
    live.status = row.status; live.updatedAt = stamp(); live.error = row.status === 'failed' ? cleanText(row.error, 300) : null;
    live.result = result && typeof result === 'object' ? {title: cleanText(result.title, 200) || null, finalUrl: cleanText(result.finalUrl || result.url, 2000) || null, text: cleanText(text, 4000), page: captured || null} : null;
    say(s, live.chatKey, text);
    return live;
  });
  // The continued turn is one round deeper; recordBrowserRequests refuses to
  // open another page once a chain reaches MAX_BROWSER_DEPTH.
  // A home-feed read belongs to the run that asked for it. The other bots
  // start only when the page comes back; a failure stops that run.
  if (done?.purpose === 'feed') {
    const page = feedPageText(result);
    if (!resumeFeed) {
      await store.update(s => say(s, done.chatKey, 'The feed result came back, but this run could not be resumed. Nothing else ran.'));
      return done;
    }
    // `ok` is whether the agent finished. An empty page is still a finished
    // read: the resume path then says to sign in, instead of claiming the
    // feed was never opened.
    try { await resumeFeed(store, done, {ok: done.status === 'done', text: page}); }
    catch (error) { await store.update(s => say(s, done.chatKey, `The feed result could not continue the run: ${error.message}`)); }
    return done;
  }
  if (done?.runId) {
    if (!resumeBrowser) {
      await store.update(s => say(s, done.chatKey, 'The page came back, but this run could not be resumed.'));
      return done;
    }
    try { await resumeBrowser(store, done, {ok: done.status === 'done', text: captured}); }
    catch (error) { await store.update(s => say(s, done.chatKey, `The result could not be handed back to ${done.botName}: ${error.message}`)); }
    return done;
  }
  if (done?.status === 'done' && continueRun) {
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
