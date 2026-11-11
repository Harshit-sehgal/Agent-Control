/** The conversation feed: what a bot chat or a thread shows, in order, as plain
 * entries the renderer turns into markup. Pure functions from the stored
 * snapshot, with no DOM and no globals, so Node tests import them directly
 * (tests/ui-feed.test.js).
 *
 * The chat log holds every line a run wrote, helpers' lines included. The chat
 * shows what the mock shows: the owner's lines, the lead's reply, one pill that
 * keeps updating while work is under way and then reads "A and B helped", and the
 * cards that wait on the owner. The handoffs live behind the pill, not in the log. */
import {handoffs, progressPill} from './ui-company.js?v=fbba8d53f7';
import {isRunNote, runBelongsToChat} from './ui-model.js?v=fbba8d53f7';

const isActive = status => status === 'queued' || status === 'running';
const isAwaiting = status => String(status || '').startsWith('awaiting');
// These carry their own words and buttons (a note, a card), so a pill would repeat them.
const NO_PILL = new Set(['awaiting_limit', 'awaiting_plan', 'awaiting_checkpoint', 'failed', 'cancelled', 'interrupted']);

/** The runs that belong to one chat, oldest first. */
export function runsOfChat(state, key) {
  return (state?.groupRuns || []).filter(run => runBelongsToChat(run, key))
    .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
}

function pillEntry(run, state) {
  if (NO_PILL.has(run.status)) return null;
  const pill = progressPill(run, state), passed = handoffs(run);
  // A bot that answered in its own chat did not "help" anyone: no handoff, no pill.
  if (pill?.done && !passed.length) return null;
  return pill ? {kind: 'pill', run, pill, handoffs: pill.done ? passed : []} : null;
}

/** `items` is `timeline()`'s output for the chat; `key` is the chat key (a bot id,
 * or `team-<threadId>`). Entries: day, me, bot, offjob, note, browser, guard, pill, limit. */
export function feed({items = [], state, key}) {
  const runs = runsOfChat(state, key), byId = new Map(runs.map(run => [run.id, run]));
  const lastLine = new Map(), lastNote = new Map();
  items.forEach((item, index) => {
    const m = item.message;
    if (item.kind !== 'message' || !m?.runId) return;
    if (m.role === 'bot') lastLine.set(m.runId, index);
    if (isRunNote(m)) lastNote.set(m.runId, m.id);
  });
  // The runaway guard speaks once in Atlas's chat; only its newest line still asks.
  const lastGuard = items.map(item => item.message).filter(m => m?.kind === 'guard').at(-1)?.id;
  // Only a run where another bot took a turn has lines to fold away.
  const folded = new Set(runs.filter(run => handoffs(run).length > 0 || new Set(run.recipients).size > 1).map(run => run.id));
  const placed = new Set(), out = [];
  items.forEach((item, index) => {
    if (item.kind === 'day') return out.push({kind: 'day', at: item.at});
    const m = item.message, run = m.runId ? byId.get(m.runId) : null;
    if (run && !placed.has(run.id)) {
      placed.add(run.id);
      const entry = pillEntry(run, state);
      if (entry) out.push(entry);
    }
    if (m.role === 'user') return out.push({kind: 'me', message: m});
    if (m.role === 'system') {
      if (m.kind === 'browser') return out.push({kind: 'browser', message: m});
      // The paused run's own card says this, so its note line would say it twice.
      if (m.kind === 'limit') return;
      if (m.kind === 'guard') return out.push({kind: 'guard', message: m, open: m.id === lastGuard && Boolean(state?.guard?.paused)});
      if (!isRunNote(m)) return out.push({kind: 'note', message: m, run: null});
      if (run?.status === 'completed' && m.id === `${run.id}-completed`) return;
      return out.push({kind: 'note', message: m, run: run && lastNote.get(run.id) === m.id ? run : null});
    }
    if (m.kind === 'offjob') {
      // Anything said after it (the owner moved on, or the bot did it anyway) settles it.
      const answered = items.slice(index + 1).some(later => later.kind === 'message' && later.message.role !== 'system');
      return out.push({kind: 'offjob', message: m, open: !answered});
    }
    // Helpers' lines wait behind the pill; a run that did not finish shows them all.
    if (run && folded.has(run.id) && (isActive(run.status) || run.status === 'awaiting_browser' || (run.status === 'completed' && index !== lastLine.get(run.id)))) return;
    out.push({kind: 'bot', message: m});
  });
  for (const run of runs) {
    if (placed.has(run.id)) continue;
    const entry = pillEntry(run, state);
    if (entry && (isActive(run.status) || isAwaiting(run.status) || entry.pill.done)) out.push(entry);
  }
  const paused = runs.filter(run => run.status === 'awaiting_limit').at(-1);
  if (paused) out.push({kind: 'limit', run: paused});
  return out;
}
