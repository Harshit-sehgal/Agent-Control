/** Checkpoints for bots that ask bots.
 *
 * Any bot may ask any other bot. These limits are checkpoints, not walls: when
 * one is reached the task pauses (`awaiting_limit`) and the owner picks Keep
 * going (another round of the same size), Keep going, don't ask again (this
 * task only), or Stop. A message is one ask; its answer rides with it.
 *
 * The tally lives on the run: `run.asks = {total, pairs, depth, seen}`. A round
 * is measured from `run.limitBase`, which Keep going moves up to the counts at
 * the pause. `run.unlimitedAsks` skips the depth, pair and total checkpoints. Two
 * rules stay on under it: the loop rule (the same question getting the same
 * answer), and ASK_CEILING, a hard per-task count nothing lifts. The runaway
 * guard (`shared/runaway.js`) applies as well.
 *
 * Pure and browser-safe.
 */
export const ASK_LIMITS = {depth: 6, pair: 12, total: 60, repeats: 3};
/** Bot-to-bot messages one task may send in all. Not a checkpoint: Keep going and
 * "don't ask again" do not lift it, so the only way on is Stop (src/coordination.js). */
export const ASK_CEILING = 600;

/** The three buttons on the checkpoint card, in order. */
export const LIMIT_CHOICES = [
  {choice: 'more', label: 'Keep going'},
  {choice: 'unlimited', label: 'Keep going, don\'t ask again'},
  {choice: 'stop', label: 'Stop'},
];

const MAX_SEEN = 100;
const norm = value => String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 400);
/** Two bots are one pair whichever way the question goes. */
const pairKey = (a, b) => [String(a), String(b)].sort().join('>');
const questionKey = ({from, to, task}) => `${from}>${to}|${norm(task)}`;
const fresh = () => ({total: 0, pairs: {}, depth: 0, seen: {}});

/** Count one ask, or say which limit it would cross. `depth` is how many bots
 * the chain holds once `to` is in it (the asker counts as one). A refused ask is
 * not counted. */
export function tallyAsk(run, {from, to, task, depth = 2}) {
  const asks = run.asks ??= fresh();
  const base = run.limitBase || {};
  const pair = pairKey(from, to), key = questionKey({from, to, task});
  const entry = asks.seen[key];
  if (asks.total >= ASK_CEILING) return {ok: false, limit: 'ceiling'};
  if (entry && entry.count >= ASK_LIMITS.repeats - 1 && entry.same >= ASK_LIMITS.repeats - 1) return {ok: false, limit: 'loop'};
  if (!run.unlimitedAsks) {
    if (depth > ASK_LIMITS.depth + (base.depth || 0)) return {ok: false, limit: 'depth'};
    if ((asks.pairs[pair] || 0) - (base.pairs?.[pair] || 0) >= ASK_LIMITS.pair) return {ok: false, limit: 'pair'};
    if (asks.total - (base.total || 0) >= ASK_LIMITS.total) return {ok: false, limit: 'total'};
  }
  asks.total++;
  asks.pairs[pair] = (asks.pairs[pair] || 0) + 1;
  asks.depth = Math.max(asks.depth || 0, depth);
  const seen = asks.seen[key] ??= {count: 0, same: 0, lastAnswer: null};
  seen.count++;
  const keys = Object.keys(asks.seen);
  if (keys.length > MAX_SEEN) delete asks.seen[keys[0]];
  return {ok: true};
}

/** Note what a question was answered, so a repeat can tell whether anything new
 * came back. */
export function recordAnswer(run, ask, output) {
  const entry = run.asks?.seen?.[questionKey(ask)];
  if (!entry) return;
  const answer = norm(output);
  entry.same = entry.lastAnswer === answer ? entry.same + 1 : 1;
  entry.lastAnswer = answer;
}

/** Keep going: one more round of the same size, measured from now. */
export function extendLimits(run, kind) {
  const asks = run.asks ??= fresh();
  const base = run.limitBase || {};
  run.limitBase = {total: asks.total, pairs: {...asks.pairs}, depth: (base.depth || 0) + (kind === 'depth' ? ASK_LIMITS.depth : 0)};
  for (const entry of Object.values(asks.seen)) { entry.count = 0; entry.same = 0; }
}

/** The line on the checkpoint card. */
export const limitText = run => `Bots have sent ${run.asks?.total ?? 0} messages for this task.`;
