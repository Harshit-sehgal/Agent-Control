/** Messages sent to a chat while its bot is still working. Each one waits on the run that is working and starts as
 * soon as that run ends, oldest first, so the owner never has to send it again. A timer's run does not wait here:
 * the task queue retries it on its own. */
import {chatIsBusy, chatKeyFor} from '../shared/coordination.js';

export const MAX_FOLLOW_UPS = 5;
const ENDED = ['completed', 'failed', 'cancelled', 'interrupted'];

/** Hold `message` on the busy run of its chat. Returns {runId} when held, or null when the chat is free. */
export function holdFollowUp(state, {groupId, chatKey = null, directBotId = null, message, checkpoints = false, now = new Date().toISOString()}) {
  const group = (state.groups || []).find(g => g.id === groupId);
  if (!group) return null;
  const key = chatKeyFor(group, {chatKey, directBotId});
  if (!chatIsBusy(state.groupRuns, group, key)) return null;
  const busy = (state.groupRuns || []).find(r => r.groupId === groupId && !ENDED.includes(r.status) && (r.chatKey || `team-${r.groupId}`) === key)
    || (state.groupRuns || []).find(r => r.groupId === groupId && !ENDED.includes(r.status));
  if (!busy) return null;
  busy.followUps ??= [];
  if (busy.followUps.length >= MAX_FOLLOW_UPS) throw Object.assign(new Error(`${MAX_FOLLOW_UPS} messages are already waiting in this chat. They run as soon as the bot is free.`), {status: 409});
  busy.followUps.push({message: String(message), groupId, chatKey: key, directBotId, checkpoints: Boolean(checkpoints), at: now});
  return {runId: busy.id};
}

/** The oldest waiting message whose chat is free now, taken off its run; or null. */
export function nextFollowUp(state) {
  const ended = (state.groupRuns || []).filter(r => ENDED.includes(r.status) && r.followUps?.length)
    .sort((a, b) => String(a.followUps[0].at).localeCompare(String(b.followUps[0].at)));
  for (const run of ended) {
    const item = run.followUps[0], group = (state.groups || []).find(g => g.id === item.groupId);
    if (!group) { run.followUps = []; continue; }
    if (chatIsBusy(state.groupRuns, group, item.chatKey)) continue;
    run.followUps = run.followUps.slice(1);
    // The rest wait on the run this one starts (holdFollowUp moves them there).
    return item;
  }
  return null;
}

/** Start each waiting message whose chat is free. `queue` is queueGroupRun, passed in so this module stays below it. */
export function startFollowUps(store, queue, intervalMs = 1000) {
  let busy = false, stopped = false;
  const run = async () => {
    if (busy || stopped) return;
    busy = true;
    try {
      for (let i = 0; i < 10; i++) {
        let item = null, rest = [];
        await store.update(s => {
          item = nextFollowUp(s);
          // The messages still waiting behind it follow the run it starts, in order.
          if (item) { const from = s.groupRuns.find(r => r.followUps && r.followUps.length && r.followUps[0].chatKey === item.chatKey && ENDED.includes(r.status)); if (from) { rest = from.followUps; from.followUps = []; } }
        });
        if (!item) break;
        try {
          const out = await queue(store, {groupId: item.groupId, message: item.message, directBotId: item.directBotId, chatKey: item.chatKey, checkpoints: item.checkpoints});
          if (rest.length) await store.update(s => { const next = s.groupRuns.find(r => r.id === out.runId); if (next) next.followUps = [...(next.followUps || []), ...rest]; });
        } catch (e) {
          await store.update(s => { const chat = (s.chats ||= {})[item.chatKey] ||= []; chat.push({id: `followup-${Date.now()}`, role: 'system', text: `Your message "${item.message.slice(0, 60)}" could not start: ${e.message}`, at: new Date().toISOString()}); });
        }
      }
    } catch (e) { if (e?.status !== 503) console.error('Follow-up error:', e.message); }
    finally { busy = false; }
  };
  const timer = setInterval(() => void run(), intervalMs); timer.unref();
  return async () => { stopped = true; clearInterval(timer); };
}
