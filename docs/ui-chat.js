/** Conversation controller: what happens after the user hits send.
 * A bot's own chat and a thread both run through the group routes
 * (`POST /api/groups/:group/chat`): a bot chat posts to the company group with
 * the bot as `directBotId`, a thread posts to its own group and Atlas answers.
 * The server orchestrator runs them when a model is configured and the offline
 * simulator does otherwise; the UI cannot tell which. Nothing here can publish. */
import {pollRun, runWithTyping} from './run-follow.js?v=380b6c0594';
import {botSettings, groupSettings} from './bot-settings.js?v=380b6c0594';
import {store, api, sync, go, conversation, appendMessage, setTyping, teamKey, flushChats} from './ui-store.js?v=380b6c0594';
import {toast} from './ui-dialogs.js?v=380b6c0594';
import {isOfflineError, OFFLINE_TEXT} from './ui-model.js?v=380b6c0594';

/** In-flight sends per conversation, so two overlapping sends keep the typing
 * indicator up until the last one finishes instead of the first clearing it. */
const inFlight = new Map();

/** Stream a server-coordinated group run into the conversation until it finishes
 * or pauses at a human checkpoint. The loop itself is `pollRun` in
 * `shared/run-follow.js`; this is the store-and-transport adapter around it. */
export async function streamGroupRun(groupId, key = teamKey(groupId), runId = null, {ignore = []} = {}) {
  if (!runId) return;
  await pollRun({
    runId, groupId, ignore,
    wait: ms => new Promise(resolve => setTimeout(resolve, ms)),
    sync: () => sync().catch(() => {}),
    readLog: () => api(`/api/groups/${groupId}/chat`),
    messages: () => store.messages[key] || [],
    requests: () => store.state.browserRequests || [],
    onLine: m => appendMessage(key, {id: m.id, role: m.role, senderId: m.senderId, senderName: m.senderName, toBotId: m.toBotId, text: m.text, at: m.at, mode: 'ai', kind: m.kind, runId: m.runId}),
    onNote: note => appendMessage(key, note),
    onStall: ({exhausted = false} = {}) => toast(exhausted ? 'This is taking a while. The run keeps going on the server, and its answer shows here when it is done.' : 'Still trying to reach the run log. The run keeps going on the server.'),
  });
}

/** A queued run the server has already paused or stopped. Returns true when the
 * chat should show that record and not claim the others are already working. */
export async function watchQueuedRun(groupId, key, run) {
  // `waiting`: the bot is still on the last message, and this one runs as soon as it is free (src/follow-ups.js).
  if (['waiting', 'failed', 'interrupted', 'awaiting_plan', 'awaiting_checkpoint', 'awaiting_limit', 'completed', 'cancelled'].includes(run?.status)) {
    await sync().catch(() => {});
    return true;
  }
  if (run?.status === 'awaiting_browser') {
    await sync().catch(() => {});
    const open = (store.state.browserRequests || []).find(r => r.runId === run.runId && r.status === 'dispatched');
    if (open) await streamGroupRun(groupId, key, run.runId, {ignore: ['awaiting_browser']});
    return true;
  }
  return false;
}

/** Start a run in a chat and follow it. The progress pill, not a chat line, says
 * what is happening, so nothing is appended here. `anyway` is the owner's "Do it
 * anyway" on an out-of-job reply: the bot does the request once. */
async function runOnServer(group, message, directBotId, key, {anyway = false} = {}) {
  const run = await api(`/api/groups/${group.id}/chat`, 'POST', {message, directBotId: directBotId || null, chatKey: key, ...(anyway ? {anyway: true} : {})});
  if (await watchQueuedRun(group.id, key, run)) return;
  await streamGroupRun(group.id, key, run?.runId || null);
}

async function reply(conv, message) {
  const {group, bot, isTeam, id} = conv;
  if (!isTeam && !botSettings(bot).enabled) return appendMessage(id, {role: 'system', text: `${bot.name} is switched off. Turn it on in its profile.`});
  // A thread always goes to Atlas (the server ignores @ there); a bot chat to that bot.
  return runOnServer(group, message, isTeam ? null : bot.id, id);
}

/** "Do it anyway" under an out-of-job reply: the same request again, once. */
export async function runAnyway(botId, request) {
  const conv = conversation(botId); if (!conv || conv.isTeam) throw new Error('That bot is no longer here.');
  setTyping(botId, true);
  try { await runOnServer(conv.group, request, botId, botId, {anyway: true}); }
  finally { setTyping(botId, false); }
  await sync().catch(() => {});
}

/** A new thread, run by Atlas. The server writes the owner's first line itself, so
 * it is not posted again: refresh, open the thread, then follow Atlas's run. */
export async function startThread(text, {title = ''} = {}) {
  const message = String(text ?? '').trim(); if (!message) return null;
  const {thread, run} = await api('/api/threads', 'POST', {message, ...(title ? {title} : {})});
  const key = teamKey(thread.id);
  await sync().catch(() => {});
  // Leaving the new-thread page, so Back does not return to an empty box.
  go({thread: thread.id}, {replace: Boolean(store.route.newThread)});
  setTyping(key, true);
  try { if (!(await watchQueuedRun(thread.id, key, run))) await streamGroupRun(thread.id, key, run?.runId || null); }
  finally { setTyping(key, false); }
  await sync().catch(() => {});
  return thread;
}

/** The owner's answer to a checkpoint card: keep going, keep going without
 * asking again for this task, or stop. The POST answers when the next step is done,
 * so the log is followed beside it. */
export async function answerLimit(groupId, runId, choice) {
  const run = (store.state?.groupRuns || []).find(r => r.id === runId);
  const key = run?.chatKey || teamKey(groupId);
  await runWithTyping({key, setTyping, sync, concurrent: true,
    send: () => api(`/api/groups/${groupId}/runs/${runId}/continue`, 'POST', {choice}),
    follow: () => streamGroupRun(groupId, key, runId)});
}

/** Run a message again in the conversation it came from (Retry, or after a Switch to another model). */
export async function rerun(groupId, {message, direct = '', chat = ''} = {}) {
  const key = chat || teamKey(groupId), group = (store.state?.groups || []).find(g => g.id === groupId);
  const run = await api(`/api/groups/${groupId}/chat`, 'POST', {message, directBotId: direct || null, checkpoints: groupSettings(group || {}).checkpoints, chatKey: key});
  if (await watchQueuedRun(groupId, key, run)) return 'queued';
  await streamGroupRun(groupId, key, run?.runId || null); await sync();
  return 'ran';
}

/** Send `text` to a conversation and let the right engine answer. `again`: Retry after a send that never reached
 * the server, so the message is already in the chat and is not added twice. */
export async function sendChat(id, text, {again = false, attachments = []} = {}) {
  // A message of files alone is named by them, the same way shared/chats.js stores it.
  const conv = conversation(id), message = String(text ?? '').trim() || attachments.map(a => a.name).join(', ');
  if (!conv || !message) return;
  if (!again) appendMessage(id, {role: 'user', text: message, ...(attachments.length ? {attachments} : {})});
  // The bot reads the files from the stored line, so that line must land before the run starts.
  if (attachments.length) await flushChats().catch(() => {});
  const count = (inFlight.get(id) || 0) + 1;
  inFlight.set(id, count);
  if (count === 1) setTyping(id, true);
  try { await reply(conv, message); }
  catch (error) {
    // The server's busy refusal is matched by its own retry logic, so it is reworded here, not there.
    const said = error?.message || String(error);
    // Nothing reached the server: say that plainly, with a Retry, instead of quoting a network error.
    if (isOfflineError(error)) appendMessage(id, {role: 'system', kind: 'offline', text: OFFLINE_TEXT});
    else if (/No AI provider is configured/i.test(said)) appendMessage(id, {role: 'system', kind: 'no-model', text: `${conv.name} needs a model before it can answer. Connect one in Settings → Models and keys. A Claude or ChatGPT sign-in on this computer needs no key.`});
    else appendMessage(id, {role: 'system', text: /already active/i.test(said) ? 'Still working on your last message. Send this again once it is done.' : `That did not go through: ${said}`});
  }
  finally {
    const left = (inFlight.get(id) || 1) - 1;
    if (left <= 0) { inFlight.delete(id); setTyping(id, false); } else inFlight.set(id, left);
  }
  await sync().catch(() => {});
}
