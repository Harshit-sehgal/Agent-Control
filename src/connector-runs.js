/** The calls a run is waiting to make through connectors.
 *
 * A bot's reply can carry `connector` blocks. The engine files them on the run
 * (`run.connectorCalls`, see `recordConnectorCalls` in `shared/connectors.js`):
 * a call that needed an ask waits for the owner's answer, one that did not is
 * ready. When the run next starts a step, every ready call is made here, in
 * order, and the answers are written back as the next turn's `connectorResult`:
 * text from outside the app, handed to the same bot as data, never as instructions.
 */
import {cleanText} from '../shared/core.js';
import {logActivity} from '../shared/activity-log.js';
import {useConnector} from './connector-use.js';
import {holdSend} from './held-sends.js';

/** Total a run keeps of what its connectors answered. */
const MAX_PAGE_CHARS = 5000;

/** A result goes into a prompt, so it cannot carry a fence: a bot that echoed one would start a call. */
const defang = text => String(text ?? '').replace(/`{3,}/g, "'''");

/** What the activity log says a write that went out did. A send names the recipient and the subject. */
const toLine = args => cleanText((Array.isArray(args?.to) ? args.to : [args?.to]).filter(Boolean).join(', '), 120);
const outsideText = call => (call.tool === 'gmail.send'
  ? `${call.botName} sent an email to ${toLine(call.args)}: "${cleanText(String(call.args?.subject ?? '').replace(/\s+/g, ' '), 80)}".`
  : `${call.botName} used ${call.connectorName}: ${call.tool}.`);

const missing = (connector, call) => (!connector
  ? `${call.connectorName} was removed, so nothing was done.`
  : (connector.status || 'ready') === 'reconnect' ? `${connector.name} needs to be reconnected (Settings → Connectors), so nothing was done.` : '');

/** Make every cleared call of this run. Returns false when the run was stopped meanwhile (its results are dropped),
 * true otherwise. `say(state, run, line)` writes a line into the run's conversation. */
export async function runConnectorCalls(store, runId, {say, now = () => new Date().toISOString()}) {
  const first = store.read().groupRuns.find(r => r.id === runId);
  const ready = (first?.connectorCalls || []).filter(c => c.status === 'go');
  if (!ready.length) return true;
  const results = [];
  for (const call of ready) {
    const state = store.read();
    if (state.groupRuns.find(r => r.id === runId)?.status !== 'running') return false;
    const connector = (state.connectors || []).find(c => c.id === call.connectorId) || null;
    let outcome;
    const blocked = missing(connector, call);
    if (blocked) outcome = {ok: false, text: blocked};
    else {
      try { outcome = call.hold ? await holdSend(store, connector, call) : await useConnector(store, connector, call.tool, call.args); }
      catch (error) { outcome = {ok: false, text: cleanText(error?.message, 300) || 'The connector failed.'}; }
    }
    results.push({call, outcome});
  }
  return store.update(s => {
    const live = (s.groupRuns || []).find(r => r.id === runId);
    if (!live || live.status !== 'running') return false;
    let page = live.connectorPage || '';
    for (const {call, outcome} of results) {
      const stored = (live.connectorCalls || []).find(c => c.id === call.id);
      if (stored) { stored.status = outcome.ok ? 'done' : 'failed'; delete stored.args; }
      const body = defang(outcome.text);
      page += `${page ? '\n\n---\n\n' : ''}Result of ${call.connectorName} · ${call.tool}${outcome.ok ? '' : ' (it reported an error)'}:\n${body}`;
      // A write that went out is something that left the app. A held send already logged itself, with its Undo window.
      if (outcome.ok && call.write && !outcome.activityId) logActivity(s, {botId: call.botId, kind: 'outside', text: outsideText(call), threadId: call.chatKey});
      say(s, live, {
        id: `connector-${call.id}`.slice(0, 64), role: 'system', kind: outcome.ok ? 'connector' : 'connector-error', connectorId: call.connectorId, at: now(),
        text: outcome.activityId ? `${call.botName} is sending an email to ${toLine(call.args)}. You can undo it until it goes out.` : outcome.ok ? `${call.botName} used ${call.connectorName}: ${call.tool}.` : `${call.botName} could not use ${call.connectorName}: ${call.tool}. ${cleanText(body, 200)}`,
        ...(outcome.activityId ? {activityId: outcome.activityId, undoUntil: outcome.undoUntil} : {}),
      });
    }
    live.connectorPage = page.length > MAX_PAGE_CHARS ? `${page.slice(0, MAX_PAGE_CHARS)}\n[cut]` : page;
    return true;
  });
}
