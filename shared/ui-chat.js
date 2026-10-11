/** Conversation controller: what happens after the user hits send.
 * Group messages (and @mentions) run the group, on the server orchestrator when a
 * model is configured and in the deterministic simulator otherwise. A custom bot
 * runs its own instructions on the server; everything else answers from the
 * offline command set. Nothing here can publish. */
import {classifyMessage, statusSummary} from './chat-engine.js';
import {simulateGroup} from './group-simulator.js';
import {planHandoffs, runNote} from './coordination.js';
import {store, api, sync, conversation, appendMessage, setTyping, isStaticDemo, isLive, logLocalRun, teamKey} from './ui-store.js';

const TERMINAL = ['completed', 'failed', 'interrupted', 'awaiting_checkpoint'];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
// Offline replies are computed instantly; a short beat between them lets the
// bot be seen thinking, so a handoff reads as a conversation, not a dump.
const BEAT_MS = 450;

/** Stream a server-coordinated group run into the conversation until it finishes
 * or pauses at a human checkpoint. */
export async function streamGroupRun(groupId, key = teamKey(groupId), runId = null) {
  const seen = new Set((store.messages[key] || []).map(m => m.id));
  let last = null;
  // Free-tier routing can take minutes per bot, so poll generously and only
  // stop on a terminal state; the run keeps executing server-side regardless.
  for (let i = 0; i < 200; i++) {
    await wait(3000);
    let snap; try { snap = await api(`/api/groups/${groupId}/chat`); } catch { continue; }
    for (const m of snap.messages || []) {
      // The endpoint returns the whole group's history; keep only this run's.
      if (seen.has(m.id) || m.role === 'user' || (runId && m.runId !== runId)) continue;
      seen.add(m.id);
      appendMessage(key, {id: m.id, role: m.role, senderId: m.senderId, senderName: m.senderName, toBotId: m.toBotId, text: m.text, at: m.at, mode: 'ai'});
    }
    last = (snap.runs || []).find(r => runId ? r.id === runId : r.groupId === groupId) || null;
    if (last && TERMINAL.includes(last.status)) break;
  }
  // The server writes the same line under the same id, so it is stored once.
  const note = last && runNote(last);
  if (note && !(store.messages[key] || []).some(m => m.id === note.id)) appendMessage(key, note);
}

async function runOnServer(group, message, directBotId, key) {
  appendMessage(key, {role: 'system', text: directBotId ? 'Working on it.' : 'Passing this to the group.'});
  const run = await api(`/api/groups/${group.id}/chat`, 'POST', {message, directBotId: directBotId || null, checkpoints: store.checkpoints, chatKey: key});
  await streamGroupRun(group.id, key, run?.runId || null);
}

async function runSimulated(group, message, isTeam, key) {
  // Validate recipients before execution; messages cannot cross group boundaries.
  const route = planHandoffs(group, message, {directBotId: isTeam ? null : undefined});
  // Refresh first: the simulator reads state.drafts to pick a post that still
  // needs a draft, so a stale snapshot would re-draft one already handled.
  const state = await api('/api/state');
  const said = [];
  const run = await simulateGroup({group, message, state, api, makeId: () => crypto.randomUUID(), emit: entry => said.push(entry)});
  for (const entry of said) { await wait(BEAT_MS); appendMessage(key, {...entry, at: new Date().toISOString()}); }
  logLocalRun({id: run.id, groupId: group.id, input: message, mode: route.mode, recipients: run.recipients, status: run.status, trace: run.trace, createdAt: run.createdAt});
}

/** The offline command set for a direct chat with a built-in bot. */
async function localReply(conv, message) {
  const {state} = store, {bot, group} = conv, demo = isStaticDemo();
  const cmd = classifyMessage(message);
  const pending = state.drafts.filter(d => d.status === 'pending').length;
  switch (cmd.intent) {
    case 'status': return `Here is where things stand.\n\n${statusSummary(state)}`;
    case 'approvals': return pending ? `${pending} draft(s) are waiting on you. Open the X-engage chat and tap "need you" to decide. Nothing posts by itself.` : 'Nothing is waiting on you right now.';
    case 'discover': return `I have ${state.candidates.length} post(s) collected. ${demo ? 'This demo cannot read a live X feed.' : 'I do not crawl X; capture posts with the browser extension.'} Share a post in the X-engage chat with the + button.`;
    case 'draft': {
      const post = state.candidates.find(c => !state.drafts.some(d => d.candidateId === c.id)) || state.candidates[0];
      if (!post) return 'There is no post to reply to yet. Share one in the X-engage chat with the + button.';
      const draft = await api(`/api/candidates/${post.id}/process`, 'POST', {});
      return `I drafted a reply to ${post.author} (score ${draft.score}/100). It is in the X-engage chat, waiting on you.\n\nIt is a template, not AI writing, so read it before you approve.`;
    }
    case 'create-bot': {
      if (!cmd.name || cmd.name.length < 2 || cmd.name.length >= 60) return 'Tap + in the chat list to create a bot with a name, a group and a job.';
      const created = await api(`/api/groups/${group.id}/bots`, 'POST', {name: cmd.name, instructions: `Custom bot ${cmd.name}. Update this profile with a clear job, permitted tools and approval boundaries.`});
      return `Created ${created.name} in ${group.name}. It is in your chat list now. Open its profile to give it a real job.`;
    }
    case 'schedules': return `Approved drafts wait ${state.settings.minDelay} to ${state.settings.maxDelay} minutes before they are ready. Change it under Voice and timing in the X-engage chat info. ${demo ? 'This demo only checks timers while the page is open.' : 'The server scheduler runs while the Node process is up.'}`;
    default: return `I'm ${bot.name}. My job: ${bot.instructions || 'not set yet.'}\n\n${demo ? 'This is an offline demo, not a connected AI model.' : 'Direct chat uses built-in commands; group runs use the server model when a key is set.'} Try "Show status", "Draft a reply" or "What needs me?".`;
  }
}

async function reply(conv, message) {
  const {group, bot, isTeam, id} = conv;
  if (isTeam || planHandoffs(group, message).mode === 'mention') {
    if (isLive()) return runOnServer(group, message, isTeam ? null : bot.id, id);
    return runSimulated(group, message, isTeam, id);
  }
  // On the Node build a custom bot runs its instructions through the server
  // provider. Built-in bots and the static demo keep the deterministic commands.
  if (isLive() && bot.type === 'custom') {
    const run = await api('/api/bots/run', 'POST', {botId: bot.id, input: message});
    return appendMessage(id, {role: 'bot', text: run.output || 'The bot returned no output.', mode: 'ai'});
  }
  const text = await localReply(conv, message);
  await wait(BEAT_MS);
  appendMessage(id, {role: 'bot', text});
}

/** Send `text` to a conversation and let the right engine answer. */
export async function sendChat(id, text) {
  const conv = conversation(id), message = String(text ?? '').trim();
  if (!conv || !message) return;
  appendMessage(id, {role: 'user', text: message});
  setTyping(id, true);
  try { await reply(conv, message); }
  catch (error) { appendMessage(id, {role: 'system', text: `That did not go through: ${error.message}`}); }
  finally { setTyping(id, false); }
  await sync().catch(() => {});
}
