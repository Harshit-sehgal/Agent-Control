/** Where a model call's tokens go.
 *
 * src/ai.js reports every finished call through `noteUsage`. A bot turn runs inside `meterTurn`, which is how a
 * call deep in a turn (a sub-agent, a teammate's answer, a fallback) is counted without passing a callback through
 * every layer: Node's AsyncLocalStorage carries the turn's sink to wherever the call is made. A call outside a turn
 * (a connectivity test, memory upkeep) is not counted.
 *
 * The sink writes two places: the bot's total for the day (`state.usage`, shared/usage.js) and, for a group run,
 * the run's own total (`run.usage`), each with the money only when the owner typed a price for that model.
 */
import {AsyncLocalStorage} from 'node:async_hooks';
import {addUsage, recordDay, costOf, priceFor} from '../shared/usage.js';

const scope = new AsyncLocalStorage();

/** Report one finished call. Never throws: a bookkeeping failure must not cost the owner their answer. */
export async function noteUsage(call) {
  const sink = scope.getStore();
  if (!sink) return;
  try { await sink(call); } catch (error) { console.error('Usage was not recorded:', error.message); }
}

/** The price the owner set for this call's model on its provider, or null. */
function priceOf(state, call) {
  if (call.subscription || !call.providerId) return null;
  const provider = (state.ai?.providers || []).find(p => p.id === call.providerId);
  return priceFor(provider?.prices, call.model);
}

/** Run `fn` (one bot turn) and count every model call inside it. Returns `{value, calls, total}`: `calls` are the
 * records as made (each with its cost, or none), so the caller can note on the trace which model answered. */
export async function meterTurn(store, {runId = null} = {}, fn) {
  const calls = [];
  const sink = async call => {
    const at = new Date().toISOString();
    await store.update(s => {
      const cost = costOf(call, priceOf(s, call));
      const row = {...call, ...(cost === null ? {} : {cost}), at};
      calls.push(row);
      recordDay(s, row, at);
      const run = runId ? (s.groupRuns || []).find(r => r.id === runId) : null;
      if (run) run.usage = addUsage(run.usage, row);
    });
  };
  const value = await scope.run(sink, fn);
  return {value, calls, total: calls.reduce((t, c) => addUsage(t, c), null)};
}

/** What a turn's calls say about fallbacks: one entry per call a fallback model answered. */
export const fallbacksOf = calls => calls.filter(c => c.fallbackFrom).map(c => ({botId: c.botId || null, from: c.fallbackFrom.model, why: c.fallbackFrom.why, to: c.model || ''}));
