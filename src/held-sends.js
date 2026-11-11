/** An email send the owner has Always-allowed waits 30 seconds, so it can be undone.
 *
 * The bot's `gmail.send` was already cleared (a grant, no ask this time). Instead of going out at once it is held:
 * an `outside` entry goes in the activity log with `undoUntil`, the chat line carries the same entry id, and a timer
 * sends it when the window ends. `POST /api/activity/:id/undo` inside the window cancels it. A send the owner just
 * answered Allow on the ask card is not held (they read exactly that mail); it goes at once and is only logged.
 *
 * The held mail lives in `state.heldSends` (kv, never in a backup or the state snapshot). The timer is in this
 * process only, so a restart during the window sends NOTHING: the entry is settled as "not sent" and the owner is told.
 * Failing to send is safer than sending a mail the owner could not undo.
 */
import {cleanText} from '../shared/core.js';
import {fail} from '../shared/errors.js';
import {logActivity, closeUndo} from '../shared/activity-log.js';
import {addChatMessages} from '../shared/chats.js';
import {UNDO_WINDOW_MS} from '../shared/connectors.js';
import {callGoogle} from './google-actions.js';

/** The window, in one place so a test can shorten it. */
export const HOLD = {ms: UNDO_WINDOW_MS};
const timers = new Map();
const toLine = args => cleanText((Array.isArray(args?.to) ? args.to : [args?.to]).filter(Boolean).join(', '), 120);
const subjectOf = args => cleanText(String(args?.subject ?? '').replace(/\s+/g, ' '), 80);
const line = (state, key, entry) => { try { addChatMessages(state, key, [entry], {trusted: true}); } catch { /* That conversation is gone. */ } };

function schedule(store, id, ms) {
  const timer = setTimeout(() => { timers.delete(id); releaseSend(store, id).catch(error => console.error('Held send:', cleanText(error.message, 120))); }, ms);
  timer.unref?.();
  timers.set(id, timer);
}

/** Hold one cleared `gmail.send`. Returns the result the bot is told, plus the entry the chat line points at. */
export async function holdSend(store, connector, call) {
  const until = new Date(Date.now() + HOLD.ms).toISOString();
  const to = toLine(call.args), subject = subjectOf(call.args);
  const entry = await store.update(s => {
    const made = logActivity(s, {botId: call.botId, kind: 'outside', text: `${call.botName} is sending an email to ${to}: "${subject}". You can undo it until it goes out.`, threadId: call.chatKey, undoUntil: until});
    (s.heldSends ??= []).push({id: made.id, connectorId: connector.id, args: call.args, botId: call.botId, botName: call.botName, chatKey: call.chatKey, undoUntil: until, status: 'held'});
    return made;
  });
  schedule(store, entry.id, HOLD.ms);
  return {ok: true, text: `The email to ${to} will be sent in a moment unless the owner undoes it.`, activityId: entry.id, undoUntil: until};
}

/** The window ended: send it, unless it was undone. */
export async function releaseSend(store, id) {
  const held = await store.update(s => {
    const h = (s.heldSends || []).find(x => x.id === id && x.status === 'held');
    if (!h) return null;
    h.status = 'sending';
    return {...h};
  });
  if (!held) return;
  let outcome;
  try {
    const connector = store.read().connectors.find(c => c.id === held.connectorId);
    if (!connector || connector.status !== 'ready') throw new Error('Google is not connected any more.');
    outcome = await callGoogle(store, connector, 'gmail.send', held.args);
  } catch (error) { outcome = {ok: false, text: cleanText(error.message, 200) || 'It failed.'}; }
  await store.update(s => {
    s.heldSends = (s.heldSends || []).filter(h => h.id !== id);
    line(s, held.chatKey, {id: `send-${id}`.slice(0, 64), role: 'system', kind: outcome.ok ? 'connector' : 'connector-error', connectorId: held.connectorId, at: new Date().toISOString(),
      text: outcome.ok ? `${held.botName}'s email to ${toLine(held.args)} was sent.` : `${held.botName}'s email to ${toLine(held.args)} could not be sent: ${outcome.text}`});
  });
}

/** Undo inside the window. 404: no such entry; 409: it is already out (or on its way). */
export async function undoHeldSend(store, id) {
  const out = await store.update(s => {
    const h = (s.heldSends || []).find(x => x.id === id);
    if (!h) { if ((s.activity || []).some(a => a.id === id)) fail('It already went out, so it cannot be undone.', 409); fail('There is nothing to undo.', 404); }
    if (h.status !== 'held' || Date.parse(h.undoUntil) <= Date.now()) fail('It already went out, so it cannot be undone.', 409);
    s.heldSends = s.heldSends.filter(x => x.id !== id);
    closeUndo(s, id);
    logActivity(s, {botId: h.botId, kind: 'outside', text: `${h.botName}'s email to ${toLine(h.args)} was not sent: you undid it.`, threadId: h.chatKey});
    line(s, h.chatKey, {id: `send-${id}`.slice(0, 64), role: 'system', kind: 'connector', connectorId: h.connectorId, text: `You undid ${h.botName}'s email to ${toLine(h.args)}. It was not sent.`, at: new Date().toISOString()});
    return {ok: true};
  });
  clearTimeout(timers.get(id));
  timers.delete(id);
  return out;
}

/** Holds this process has no timer for (the server restarted) are never sent: they are settled and logged.
 * `fresh` treats every hold as one of those (a test, or a start-up). */
export async function settleHeldOnStart(store, {fresh = false} = {}) {
  const lost = await store.update(s => {
    const gone = (s.heldSends || []).filter(h => fresh || !timers.has(h.id));
    s.heldSends = (s.heldSends || []).filter(h => !gone.includes(h));
    for (const h of gone) {
      closeUndo(s, h.id);
      logActivity(s, {botId: h.botId, kind: 'outside', text: `${h.botName}'s email to ${toLine(h.args)} was not sent: the server restarted during the Undo window. Ask again.`, threadId: h.chatKey});
      line(s, h.chatKey, {id: `send-${h.id}`.slice(0, 64), role: 'system', kind: 'connector-error', connectorId: h.connectorId, at: new Date().toISOString(), text: `${h.botName}'s email to ${toLine(h.args)} was not sent: the server restarted before it went out. Ask again.`});
    }
    return gone.map(h => h.id);
  });
  for (const id of lost) { clearTimeout(timers.get(id)); timers.delete(id); }
}

/** Per-workspace start-up: settle what a restart cut. Returns the stop function the workspace starter collects. */
export function startHeldSends(ws) {
  void (ws.trackWork ? ws.trackWork(() => settleHeldOnStart(ws)) : settleHeldOnStart(ws)).catch(error => { if (error?.status !== 503) console.error('Held sends:', cleanText(error.message, 120)); });
  return async () => {};
}
