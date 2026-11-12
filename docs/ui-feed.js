/** The conversation feed: what a bot chat or a thread shows, in order, as plain
 * entries the renderer turns into markup. Pure functions from the stored
 * snapshot, with no DOM and no globals, so Node tests import them directly
 * (tests/ui-feed.test.js).
 *
 * The chat log holds every line a run wrote, helpers' lines included. The chat
 * shows only what the owner needs: their own lines, each final answer, one line
 * per run that keeps updating ("Checking with Scout", then "Ranker messaged
 * Atlas") and opens the hops, the cards that wait on the owner, and a failure that
 * ended a run. What a bot read, which connector it used, and the lines a page or
 * connector call left on the way are stored but not shown (tests/clean-feed.test.js). */
import {handoffs, hopLine, progressPill} from './ui-company.js?v=e4e0fdac0c';
import {isRunNote, runBelongsToChat} from './ui-model.js?v=e4e0fdac0c';
import {connectorLine, modelLimitLine} from './ui-connect-model.js?v=e4e0fdac0c';
import {setupCardOf, setupDone} from './setup.js?v=e4e0fdac0c';
import {requestOfMessage} from './bot-browser.js?v=e4e0fdac0c';

const isActive = status => status === 'queued' || status === 'running';
const isAwaiting = status => String(status || '').startsWith('awaiting');
// These carry their own words and buttons (a note, a card), so a pill would repeat them.
const NO_PILL = new Set(['awaiting_ask', 'awaiting_limit', 'awaiting_plan', 'awaiting_checkpoint', 'failed', 'cancelled', 'interrupted']);

/* The lines a page or connector call leaves on its way (shared/bot-browser.js, shared/connectors.js write them
 * with no kind). The bot's answer says what came of it, so the chat does not repeat them. */
const CHATTER = [
  / already has that page, so it was not opened again\.$/,
  / asked for (another|a) web page, but /,
  / asked to use a connector( again)?, but /,
  / asked to use a connector and to open a web page in one reply\./,
  / asked for a connector called "/,
  / has no tool called "/,
  /^Passing this (to the group|through \d+ bot)/,
];
const DONE_NOTE = /^Done in \d+ step\(s\)\.$/;

/** True for a stored line the chat does not show. */
function quiet(m, run, state) {
  // A bot's working step (it went to fetch pages) is covered by the run's live line; only answers show.
  if (m.role === 'bot') return Boolean(m.step);
  if (m.role !== 'system') return false;
  // An ask is a card only while it waits; once answered (or gone) it leaves the chat, and the work goes on.
  if (m.kind === 'ask') return (state?.asks || []).find(a => a.id === m.askId)?.status !== 'pending';
  // A page request is only a card while it waits on a person; a bot-to-bot message lives behind the run's line.
  if (m.kind === 'browser') return requestOfMessage(state, m.id)?.status !== 'pending';
  if (m.kind === 'browser-result' || m.kind === 'peer') return true;
  // A send held for Undo, and what became of it, are the owner's to see; every other connector line is not.
  if (m.kind === 'connector' || m.kind === 'connector-error') return !(m.undoUntil || m.activityId || String(m.id).startsWith('send-'));
  if (m.kind) return false;
  if (CHATTER.some(re => re.test(String(m.text || '')))) return true;
  if (m.runId && m.id === `${m.runId}-completed`) return DONE_NOTE.test(String(m.text || '')) || run?.status === 'completed';
  // "Waiting for the page to come back" only matters while the run still waits (it carries Stop).
  if (m.runId && m.id === `${m.runId}-awaiting_browser`) return run?.status !== 'awaiting_browser';
  return false;
}

/** The runs that belong to one chat, oldest first. */
export function runsOfChat(state, key) {
  return (state?.groupRuns || []).filter(run => runBelongsToChat(run, key))
    .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
}

function pillEntry(run, state) {
  // A run that stopped at a card or a failure keeps its hops behind one muted line; the card says the rest.
  const pill = NO_PILL.has(run.status) ? hopLine(run, state) : progressPill(run, state), passed = handoffs(run);
  // A bot that answered in its own chat messaged no one: no line.
  if (pill?.done && !passed.length) return null;
  return pill ? {kind: 'pill', run, pill, handoffs: passed} : null;
}

/** `items` is `timeline()`'s output for the chat; `key` is the chat key (a bot id,
 * or `team-<threadId>`). `now` is the clock a held send's Undo window is read against. Entries: day, me, bot, offjob,
 * note, browser, ask, guard, pill, limit, connector, model-limit, setup, no-model. */
export function feed({items = [], state, key, now = Date.now()}) {
  const runs = runsOfChat(state, key), byId = new Map(runs.map(run => [run.id, run]));
  const lastLine = new Map(), lastNote = new Map();
  // What the chat does not show is dropped first, so it can neither take a run's buttons nor be the last line.
  items = items.filter(item => item.kind !== 'message' || !quiet(item.message, byId.get(item.message?.runId), state));
  items.forEach((item, index) => {
    const m = item.message;
    if (item.kind !== 'message' || !m?.runId) return;
    if (m.role === 'bot') lastLine.set(m.runId, index);
    // A browser-written line (`origin: 'browser'`, shared/chats.js) carries no run's buttons, so it is never the note.
    if (isRunNote(m) && m.origin !== 'browser') lastNote.set(m.runId, m.id);
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
      // Only a line the server (or the Pages engine) wrote paints a card; a browser-written one is a plain note.
      if (m.kind === 'browser') return m.origin === 'browser' ? undefined : out.push({kind: 'browser', message: m});
      // The card reads its status from state.asks, so it needs no pill: it carries the asking bot's waiting face.
      if (m.kind === 'ask') return out.push({kind: 'ask', message: m});
      // The paused run's own card says this, so its note line would say it twice.
      if (m.kind === 'limit') return;
      // What a connector read or did (and a send held for Undo), and the line a usage limit leaves with its Switch button.
      if (m.kind === 'connector' || m.kind === 'connector-error') return out.push({kind: 'connector', message: m, line: connectorLine(m, {state, items, now})});
      // A bot's proposed settings change, with its Apply button; only a server-written line carries one.
      if (m.kind === 'setup') { const card = m.origin === 'browser' ? null : setupCardOf(m); return out.push({kind: 'setup', message: m, card, done: setupDone(state, card)}); }
      // Only opens a Settings page, so a line the browser wrote may carry it.
      if (m.kind === 'no-model') return out.push({kind: 'no-model', message: m});
      if (m.kind === 'model-limit') return out.push({kind: 'model-limit', message: m, line: modelLimitLine(m, {state})});
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
    // A bot's message to another bot waits behind the run's line, whatever became of the run; so does every
    // line of a live run, and every line but the last of a finished one: only the final answer is a bubble.
    if (m.toBotId && m.toBotId !== 'None') return;
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
