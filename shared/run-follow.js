/** Run following: the five steps around a decision on a run, and the one loop
 * that watches a server run's log.
 *
 * Continue, Start, Approve page and Decline page all do the same five things —
 * turn the typing indicator on, send the decision, follow the run until it stops,
 * turn typing off, refresh — and each call site wrote that sequence out itself.
 * `runWithTyping` owns it; a caller keeps only what differs (which request to
 * send, and which run to follow).
 *
 * The loop that follows a run's log is the densest UI logic with no DOM in it,
 * yet it could only be checked by a regex over its own source. It lives here as
 * `pollRun`, over injected pieces (the log reader, the message and request
 * accessors, the append effects, the wait and the sync), so a test drives it
 * with fake snapshots and no browser at all.
 *
 * Pure and dependency-free like the other shared modules: the browser imports
 * it, and no Node builtin is touched.
 */
import {runNote} from './coordination.js';

/** The statuses that end a watch: the run stopped for a person, or it is done.
 * A run in any other state is still working, so the loop keeps looking. */
export const RUN_TERMINAL = ['completed', 'failed', 'interrupted', 'awaiting_checkpoint', 'awaiting_plan', 'awaiting_browser', 'cancelled'];

/** How long to wait between looks at a run's log. Free-tier routing can take
 * minutes per bot, so the poll is unhurried; the run keeps executing regardless. */
export const RUN_POLL_MS = 3000;

/** Run one decision under the typing indicator and refresh when it settles.
 * `send` may return a promise that outlives the follow — Continue's POST only
 * answers when the next bot is done — so `concurrent` races the two. Serial is
 * the default: a plan or a page must be sent before the log can show its effect. */
export async function runWithTyping({key, setTyping, sync, send = null, follow, concurrent = false}) {
  setTyping(key, true);
  try {
    if (concurrent && send) await Promise.all([send(), follow()]);
    else { if (send) await send(); await follow(); }
  } finally { setTyping(key, false); }
  await sync();
}

/** Watch a run's log until it reaches a terminal state or pauses for a person.
 *
 * Every dependency is injected so the loop has no DOM and no store of its own:
 *   readLog()   -> {messages, runs}: the group's chat snapshot from the server
 *   messages()  -> the lines already stored for this chat, for de-duplication
 *   requests()  -> the workspace's browser requests, for the page pause
 *   onLine(m)   -> store one server line
 *   onNote(n)   -> store the run's closing note; onStall() -> one "still trying"
 *   wait(ms), sync() -> the beat between looks and the snapshot refresh
 * Returns the last run it saw, so a caller can read the outcome. */
export async function pollRun({runId = null, groupId = null, ignore = [], maxPolls = 200, wait, sync = null, readLog, messages, requests, onLine, onNote = null, onStall = null}) {
  const seen = new Set(messages().map(m => m.id));
  const skip = new Set(ignore);
  let last = null, failures = 0;
  for (let i = 0; i < maxPolls; ) {
    await wait(RUN_POLL_MS);
    // The run log is not the conversation: browser cards and their Approve
    // buttons live on the workspace snapshot, so refresh that before the next
    // lines. A failed refresh still leaves the run log to follow.
    if (sync) await sync();
    for (const m of messages()) seen.add(m.id);
    let snap;
    try { snap = await readLog(); failures = 0; }
    catch {
      // A run log that cannot be read looks exactly like a run that is thinking,
      // for up to ten minutes. Say it once, then keep trying quietly.
      if (++failures === 4 && onStall) onStall();
      i++; continue;
    }
    for (const m of snap.messages || []) {
      // The endpoint returns the whole group's history; keep only this run's.
      if (seen.has(m.id) || m.role === 'user' || (runId && m.runId !== runId)) continue;
      seen.add(m.id);
      onLine(m);
    }
    last = (snap.runs || []).find(r => runId ? r.id === runId : r.groupId === groupId) || null;
    // A dispatched page still counts as this run. Do not spend the poll
    // budget on it; keep watching until the status actually changes.
    const waiting = last && skip.has(last.status);
    if (!last || !RUN_TERMINAL.includes(last.status) || waiting) { if (!waiting) i++; continue; }
    if (last.status === 'awaiting_browser') {
      const open = requests().find(r => r.runId === last.id && ['pending', 'dispatched'].includes(r.status));
      if (open?.status === 'dispatched') { skip.add('awaiting_browser'); continue; }
    }
    break;
  }
  const note = last && runNote(last);
  if (note && onNote && !messages().some(m => m.id === note.id)) onNote(note);
  return last;
}
