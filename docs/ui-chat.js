/** Conversation controller: what happens after the user hits send.
 * Group messages (and @mentions) run the group, on the server orchestrator when a
 * model is configured and in the deterministic simulator otherwise. A custom bot
 * runs its own instructions on the server; everything else answers from the
 * offline command set. Nothing here can publish. */
import {planHandoffs, leadShouldRunGroup, summonableGuests} from './coordination.js?v=2d8fb27009';
import {feedPauseAction} from './ui-model.js?v=2d8fb27009';
import {pollRun} from './run-follow.js?v=2d8fb27009';
import {botSettings, groupSettings} from './bot-settings.js?v=2d8fb27009';
import {store, api, sync, conversation, appendMessage, setTyping, isStaticDemo, teamKey, groups} from './ui-store.js?v=2d8fb27009';
import {toast} from './ui-dialogs.js?v=2d8fb27009';

/** In-flight sends per conversation, so two overlapping sends keep the typing
 * indicator up until the last one finishes instead of the first clearing it. */
const inFlight = new Map();
// Offline replies are computed instantly; a short beat between them lets the
// bot be seen thinking, so a handoff reads as a conversation, not a dump.
const BEAT_MS = 450;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Stream a server-coordinated group run into the conversation until it finishes
 * or pauses at a human checkpoint. The loop itself is `pollRun` in
 * `shared/run-follow.js`; this is the store-and-transport adapter around it. */
function sayOnce(key, text) {
  if (!text || (store.messages[key] || []).some(m => m.text === text)) return;
  appendMessage(key, {role: 'system', text});
}

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
    onSay: text => sayOnce(key, text),
    onNote: note => appendMessage(key, note),
    onStall: () => toast('Still trying to reach the run log. The run keeps going on the server.'),
  });
}

/** A queued run the server has already paused or stopped. Returns true when the
 * chat should show that record and not claim the others are already working. */
export async function watchQueuedRun(groupId, key, run) {
  if (['failed', 'interrupted', 'awaiting_plan', 'awaiting_checkpoint', 'completed', 'cancelled'].includes(run?.status)) {
    await sync().catch(() => {});
    return true;
  }
  if (run?.status === 'awaiting_browser') {
    await sync().catch(() => {});
    const open = (store.state.browserRequests || []).find(r => r.runId === run.runId && r.status === 'dispatched' && r.purpose !== 'feed');
    if (open) await streamGroupRun(groupId, key, run.runId, {ignore: ['awaiting_browser']});
    return true;
  }
  if (run?.status !== 'awaiting_feed') return false;
  try { await sync(); }
  catch (error) {
    if (error?.status === 401) throw error;
    // The server already paused on the feed. Keep following the run log so a
    // missed snapshot cannot drop the Approve card or the lines after it.
    await streamGroupRun(groupId, key, run.runId);
    return true;
  }
  const request = (store.state.browserRequests || []).find(r => r.runId === run.runId && r.purpose === 'feed');
  const choice = feedPauseAction(request, {graceUsed: true});
  sayOnce(key, choice.text);
  if (choice.action === 'follow') await streamGroupRun(groupId, key, run.runId, {ignore: ['awaiting_feed']});
  return true;
}

async function runOnServer(group, message, directBotId, key) {
  const bringing = leadShouldRunGroup(group, message, directBotId);
  const run = await api(`/api/groups/${group.id}/chat`, 'POST', {message, directBotId: directBotId || null, checkpoints: groupSettings(group).checkpoints, chatKey: key});
  if (await watchQueuedRun(group.id, key, run)) return;
  appendMessage(key, {role: 'system', text: bringing ? 'Bringing the others in.' : directBotId ? 'Working on it.' : 'Passing this to the group.'});
  await streamGroupRun(group.id, key, run?.runId || null);
}

/** A name in "create a bot named X", or null when the message asks for none. */
const BOT_NAME = /(?:create|add|make)\s+(?:(?:a|an|new)\s+)*bot\s+(?:named|called)\s+([\w][\w \-]{1,45})/i;

/** The offline reply for a direct chat with a built-in bot. */
async function localReply(conv, message) {
  const {bot, group} = conv, demo = isStaticDemo();
  if (/\b(create|add|make)\b.{0,24}\bbot\b/i.test(message)) {
    const name = message.match(BOT_NAME)?.[1]?.replace(/\s+(?:that|which|who|to)\b.*$/i, '').trim();
    if (!name || name.length < 2 || name.length >= 60) return 'Tap + in the chat list to create a bot with a name, a group and a job.';
    const created = await api(`/api/groups/${group.id}/bots`, 'POST', {name, instructions: `Custom bot ${name}. Update this profile with a clear job, permitted tools and approval boundaries.`});
    return `Created ${created.name} in ${group.name}. It is in your chat list now. Open its profile to give it a real job.`;
  }
  return `I'm ${bot.name}. My job: ${bot.instructions || 'not set yet.'}\n\n${demo ? 'This is an offline demo, not a connected AI model.' : 'Direct chat uses built-in commands; group runs use the server model when a key is set.'} Try "Create a bot named Researcher".`;
}

async function reply(conv, message) {
  const {group, bot, isTeam, id} = conv;
  if (!isTeam && !botSettings(bot).enabled) return appendMessage(id, {role: 'system', text: `${bot.name} is switched off. Turn it on in its profile.`});
  const guests = summonableGuests(groups(), group.id, {includeOff: true});
  const mention = !isTeam && planHandoffs(group, message, {directBotId: bot.id, guests}).mode === 'mention';
  if (isTeam || mention || leadShouldRunGroup(group, message, bot.id)) {
    const directBotId = isTeam ? null : bot.id;
    // Both backends answer `POST /api/groups/:group/chat`; the local adapter
    // runs the offline simulator, the server asks the model.
    return runOnServer(group, message, directBotId, id);
  }
  if (!isStaticDemo()) {
    const run = await api('/api/bots/run', 'POST', {botId: bot.id, input: message});
    // The sender is named, so the write fence keeps this a bot line rather than
    // rewriting it as something the user said.
    return appendMessage(id, {id: run.id, role: 'bot', senderId: bot.id, senderName: bot.name, text: run.output || 'The bot returned no output.', mode: 'ai'});
  }
  const text = await localReply(conv, message);
  await wait(BEAT_MS);
  appendMessage(id, {role: 'bot', senderId: bot.id, senderName: bot.name, text});
}

/** Send `text` to a conversation and let the right engine answer. */
export async function sendChat(id, text) {
  const conv = conversation(id), message = String(text ?? '').trim();
  if (!conv || !message) return;
  appendMessage(id, {role: 'user', text: message});
  const count = (inFlight.get(id) || 0) + 1;
  inFlight.set(id, count);
  if (count === 1) setTyping(id, true);
  try { await reply(conv, message); }
  catch (error) { appendMessage(id, {role: 'system', text: `That did not go through: ${error?.message || String(error)}`}); }
  finally {
    const left = (inFlight.get(id) || 1) - 1;
    if (left <= 0) { inFlight.delete(id); setTyping(id, false); } else inFlight.set(id, left);
  }
  await sync().catch(() => {});
}
