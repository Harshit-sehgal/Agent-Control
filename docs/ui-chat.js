/** Conversation controller: what happens after the user hits send.
 * Group messages (and @mentions) run the group, on the server orchestrator when a
 * model is configured and in the deterministic simulator otherwise. A custom bot
 * runs its own instructions on the server; everything else answers from the
 * offline command set. Nothing here can publish. */
import {classifyMessage, statusSummary} from './chat-engine.js?v=6734c0a812';
import {simulateGroup} from './group-simulator.js?v=6734c0a812';
import {planHandoffs, leadShouldRunGroup, runNote, summonableGuests, BUSY_STATUSES} from './coordination.js?v=6734c0a812';
import {feedPauseAction} from './ui-model.js?v=6734c0a812';
import {botSettings, groupSettings} from './bot-settings.js?v=6734c0a812';
import {store, api, sync, conversation, appendMessage, setTyping, isStaticDemo, teamKey, groups, recentRuns} from './ui-store.js?v=6734c0a812';
import {claimLocalRun, renewLocalRun, finishLocalRun, localRunCancelled} from './local-runs.js?v=6734c0a812';
import {toast} from './ui-dialogs.js?v=6734c0a812';

const TERMINAL = ['completed', 'failed', 'interrupted', 'awaiting_checkpoint', 'awaiting_plan', 'awaiting_feed', 'awaiting_browser', 'cancelled'];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
/** In-flight sends per conversation, so two overlapping sends keep the typing
 * indicator up until the last one finishes instead of the first clearing it. */
const inFlight = new Map();
function groupInFlight(group) {
  const chats = new Set([`team-${group.id}`, ...(group.bots || []).map(b => b.id)]);
  let n = 0;
  for (const [id, count] of inFlight) if (chats.has(id)) n += count;
  return n;
}
// Offline replies are computed instantly; a short beat between them lets the
// bot be seen thinking, so a handoff reads as a conversation, not a dump.
const BEAT_MS = 450;

/** Stream a server-coordinated group run into the conversation until it finishes
 * or pauses at a human checkpoint. */
function sayOnce(key, text) {
  if (!text || (store.messages[key] || []).some(m => m.text === text)) return;
  appendMessage(key, {role: 'system', text});
}

export async function streamGroupRun(groupId, key = teamKey(groupId), runId = null, {ignore = []} = {}) {
  if (isStaticDemo() || !runId) return;
  const seen = new Set((store.messages[key] || []).map(m => m.id));
  const skip = new Set(ignore);
  let last = null, graceUsed = false, failures = 0;
  // Free-tier routing can take minutes per bot, so poll generously and only
  // stop on a terminal state; the run keeps executing server-side regardless.
  for (let i = 0; i < 200; ) {
    await wait(3000);
    // The run log is not the conversation. Browser cards and their Approve
    // buttons live on the workspace snapshot, so refresh that before painting
    // the next lines. A failed refresh still leaves the run log to follow.
    await sync().catch(() => {});
    for (const m of store.messages[key] || []) seen.add(m.id);
    let snap; try { snap = await api(`/api/groups/${groupId}/chat`); failures = 0; } catch {
      // A run log that cannot be read looks exactly like a run that is thinking,
      // for up to ten minutes. Say it once, then keep trying quietly.
      if (++failures === 4) toast('Still trying to reach the run log. The run keeps going on the server.');
      i++; continue;
    }
    for (const m of snap.messages || []) {
      // The endpoint returns the whole group's history; keep only this run's.
      if (seen.has(m.id) || m.role === 'user' || (runId && m.runId !== runId)) continue;
      seen.add(m.id);
      appendMessage(key, {id: m.id, role: m.role, senderId: m.senderId, senderName: m.senderName, toBotId: m.toBotId, text: m.text, at: m.at, mode: 'ai', kind: m.kind, runId: m.runId});
    }
    last = (snap.runs || []).find(r => runId ? r.id === runId : r.groupId === groupId) || null;
    // A dispatched feed or page still counts as this run. Do not spend the
    // poll budget on it; keep watching until the status actually changes.
    const waiting = last && skip.has(last.status);
    if (!last || !TERMINAL.includes(last.status) || waiting) { if (!waiting) i++; continue; }
    if (last.status === 'awaiting_browser') {
      const open = (store.state.browserRequests || []).find(r => r.runId === last.id && ['pending', 'dispatched'].includes(r.status) && r.purpose !== 'feed');
      if (open?.status === 'dispatched') { skip.add('awaiting_browser'); continue; }
      break;
    }
    if (last.status !== 'awaiting_feed') break;
    // Start answers before the read is filed. Look once more, then either
    // keep watching a read that was sent or stop on the Approve card.
    // A failed refresh must not abandon the run log; the lines are still there.
    await sync().catch(() => {});
    const request = (store.state.browserRequests || []).find(r => r.runId === last.id && r.purpose === 'feed');
    const choice = feedPauseAction(request, {graceUsed});
    if (choice.action === 'follow') { skip.add('awaiting_feed'); sayOnce(key, choice.text); continue; }
    if (choice.action === 'lookAgain') { graceUsed = true; i++; continue; }
    sayOnce(key, choice.text);
    break;
  }
  // The server writes the same line under the same id, so it is stored once.
  const note = last && runNote(last);
  if (note && !(store.messages[key] || []).some(m => m.id === note.id)) appendMessage(key, note);
}

/** A queued run the server has already paused or stopped. Returns true when the
 * chat should show that record and not claim the others are already working. */
export async function watchQueuedRun(groupId, key, run) {
  if (isStaticDemo()) return false;
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

async function runSimulated(group, message, directBotId, guests, key, {started = false, runId = null, resume = null} = {}) {
  // Start is the way through a shown plan. Another send must wait, same as Node.
  // inFlight includes this call, so 1 is the live send or Start; 2 is a pile-up.
  if (groupInFlight(group) > 1 || (!started && recentRuns(group.id).some(r => BUSY_STATUSES.includes(r.status)))) {
    throw Object.assign(new Error('A group run is already active. Wait or retry later.'), {status: 409});
  }
  // Validate recipients before execution; messages cannot cross group boundaries
  // except to bots their own group lets be @mentioned.
  if (!resume) planHandoffs(group, message, {directBotId, guests});
  // Claim the group across tabs before /api/state can advance due tasks.
  const lease = await claimLocalRun(started
    ? {id: runId, groupId: group.id}
    : {id: crypto.randomUUID(), groupId: group.id, input: message, mode: 'simulated', recipients: [], status: 'running', createdAt: new Date().toISOString(), chatKey: key},
  {existing: started});
  const heartbeat = setInterval(() => { void renewLocalRun(lease).catch(() => {}); }, 30_000);
  try {
    // Refresh first: the simulator reads state.drafts to pick a post that still
    // needs a draft, so a stale snapshot would re-draft one already handled.
    const state = await api('/api/state');
    const said = [];
    let used = false;
    const makeId = () => {
      if (!used) { used = true; return lease.id; }
      return crypto.randomUUID();
    };
    const run = await simulateGroup({group, message, directBotId, guests, state, api, makeId, emit: entry => said.push(entry), chatKey: key, started: started || Boolean(resume), resume, shouldStop: () => localRunCancelled(lease.id)});
    if (!localRunCancelled(lease.id)) {
      for (const entry of said) {
        await wait(BEAT_MS);
        if (localRunCancelled(lease.id)) break;
        appendMessage(key, {...entry, at: new Date().toISOString()});
      }
    }
    const finished = await finishLocalRun(lease, run);
    return finished?.status === 'cancelled' ? {...run, status: 'cancelled'} : run;
  } catch (error) {
    await finishLocalRun(lease, {status: 'failed', error: String(error?.message || error).slice(0, 400)});
    throw error;
  } finally {
    clearInterval(heartbeat);
  }
}

/** The demo's Start button, and Approve next step for a paused simulation. */
export async function continueDemoPlan(group, message, key, {runId, resume} = {}) {
  const lead = (group?.bots || []).find(b => botSettings(b).lead);
  const guests = summonableGuests(groups(), group.id, {includeOff: true});
  const count = (inFlight.get(key) || 0) + 1;
  inFlight.set(key, count);
  if (count === 1) setTyping(key, true);
  try { return await runSimulated(group, message, lead?.id || null, guests, key, {started: true, runId, resume}); }
  finally {
    const left = (inFlight.get(key) || 1) - 1;
    if (left <= 0) { inFlight.delete(key); setTyping(key, false); } else inFlight.set(key, left);
  }
}

/** The offline command set for a direct chat with a built-in bot. */
async function localReply(conv, message) {
  const {state} = store, {bot, group} = conv, demo = isStaticDemo();
  const cmd = classifyMessage(message);
  const pending = state.drafts.filter(d => d.status === 'pending').length;
  switch (cmd.intent) {
    case 'status': return `Here is where things stand.\n\n${statusSummary(state)}`;
    case 'approvals': return pending ? `${pending} draft(s) are waiting on you. Open the X-engage chat and tap "need you" to decide. Nothing posts by itself.` : 'Nothing is waiting on you right now.';
    case 'discover': return `I have ${state.candidates.length} post(s) collected. ${demo ? 'This demo cannot read a live X feed.' : 'Ask the primary bot to scroll your home feed. That opens a read-only page you approve. The extension still captures one post at a time.'} Share a post in the X-engage chat with the + button.`;
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
  if (!isTeam && !botSettings(bot).enabled) return appendMessage(id, {role: 'system', text: `${bot.name} is switched off. Turn it on in its profile.`});
  const guests = summonableGuests(groups(), group.id, {includeOff: true});
  const mention = !isTeam && planHandoffs(group, message, {directBotId: bot.id, guests}).mode === 'mention';
  if (isTeam || mention || leadShouldRunGroup(group, message, bot.id)) {
    const directBotId = isTeam ? null : bot.id;
    // The static Pages build has no provider, so it simulates. The Node server
    // always asks the model; a missing key or a failed call is an error, not a demo.
    if (!isStaticDemo()) return runOnServer(group, message, directBotId, id);
    return runSimulated(group, message, directBotId, guests, id);
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
