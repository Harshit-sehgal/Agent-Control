/** What model calls cost: tokens per call, per run and per bot per day, and money only where the owner typed a price.
 *
 * A usage record is `{input, output, cacheRead, cacheWrite}` in tokens. `input` is the uncached input: providers
 * that count cached tokens inside their input total (OpenAI, Gemini) are split by src/ai.js before they get here.
 * A price is `{input, output, cached?}` in US dollars per million tokens, typed by the owner on a saved provider
 * (Settings → Models and keys). No price is ever guessed: a call without one counts its tokens and no money, and
 * cache writes cost the input price because that is the only rate the owner gave. A subscription (CLI) call is
 * `subscription: true`: it costs nothing extra, so it is shown as included.
 *
 * `state.usage = {days: {'YYYY-MM-DD': {<botId>: totals}}}`, kept for USAGE_DAYS days (UTC dates).
 * Pure and browser-safe: the server records with it and the Settings page reads it.
 */
export const USAGE_DAYS = 62;
const FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite'];
const count = v => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.round(Number(v)) : 0);
const rate = v => (v === '' || v === null || v === undefined ? null : Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) <= 10000 ? Number(v) : NaN);

export const emptyUsage = () => ({input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0, cost: 0, unpriced: 0, subscription: 0});
export const tokensOf = u => FIELDS.reduce((sum, key) => sum + count(u?.[key]), 0);

/** A price row, or null when there is none to use. */
export function priceFor(prices, model) {
  const row = prices && typeof prices === 'object' ? prices[String(model || '')] : null;
  if (!row || !Number.isFinite(row.input) || !Number.isFinite(row.output)) return null;
  return row;
}

/** Dollars for one record, or null when no price is known. */
export function costOf(usage, price) {
  if (!price) return null;
  const cached = Number.isFinite(price.cached) ? price.cached : price.input;
  return (count(usage?.input) * price.input + count(usage?.cacheWrite) * price.input + count(usage?.cacheRead) * cached + count(usage?.output) * price.output) / 1e6;
}

/** Fold one call (`{...tokens, cost, subscription}`) into a running total. Returns the total. */
export function addUsage(total, call) {
  const t = total && typeof total === 'object' ? total : emptyUsage();
  for (const key of FIELDS) t[key] = count(t[key]) + count(call?.[key]);
  t.calls = count(t.calls) + count(call?.calls ?? 1);
  t.cost = (Number(t.cost) || 0) + (Number.isFinite(call?.cost) ? call.cost : 0);
  // How many calls had tokens but no price, so a total never reads as the whole bill when it is not.
  t.unpriced = count(t.unpriced) + (call?.unpriced !== undefined ? count(call.unpriced) : (!call?.subscription && !Number.isFinite(call?.cost) ? 1 : 0));
  t.subscription = count(t.subscription) + (call?.subscription === true ? 1 : count(call?.subscription));
  return t;
}

/** Record one call under its bot and day, dropping days older than USAGE_DAYS. Mutates `state`. */
export function recordDay(state, call, at = new Date().toISOString()) {
  state.usage ??= {days: {}};
  if (!state.usage.days || typeof state.usage.days !== 'object') state.usage.days = {};
  const day = String(at).slice(0, 10), bot = String(call?.botId || 'other');
  const days = state.usage.days;
  days[day] ??= {};
  days[day][bot] = addUsage(days[day][bot], call);
  const keys = Object.keys(days).sort();
  for (const old of keys.slice(0, Math.max(0, keys.length - USAGE_DAYS))) delete days[old];
  return days[day][bot];
}

/** This month's totals per bot, most tokens first. `names` maps bot id to name. */
export function monthByBot(state, names = new Map(), now = new Date()) {
  const month = new Date(now).toISOString().slice(0, 7);
  const rows = new Map();
  for (const [day, bots] of Object.entries(state?.usage?.days || {})) {
    if (!day.startsWith(month) || !bots || typeof bots !== 'object') continue;
    for (const [botId, t] of Object.entries(bots)) rows.set(botId, addUsage(rows.get(botId), {...t, calls: t.calls ?? 0}));
  }
  const list = [...rows].map(([botId, t]) => ({botId, name: names.get(botId) || (botId === 'other' ? 'Other' : 'A removed bot'), ...t, tokens: tokensOf(t)}))
    .filter(r => r.tokens || r.calls).sort((a, b) => b.tokens - a.tokens);
  const total = list.reduce((sum, r) => addUsage(sum, r), emptyUsage());
  return {month, rows: list, total: {...total, tokens: tokensOf(total)}};
}

const short = n => (n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k` : String(n));
export const dollars = v => (v > 0 && v < 0.01 ? '<$0.01' : `$${v.toFixed(2)}`);

/** One line for a total: tokens always, money only when every priced call had one. '' when nothing was used. */
export function usageWords(u) {
  const tokens = tokensOf(u), calls = count(u?.calls), plan = count(u?.subscription), unpriced = count(u?.unpriced);
  if (!tokens && !calls) return '';
  const cached = count(u?.cacheRead) ? ` (${short(count(u.cacheRead))} cached)` : '';
  const parts = tokens ? [`${short(count(u?.input) + count(u?.cacheRead) + count(u?.cacheWrite))} tokens in${cached}`, `${short(count(u?.output))} out`] : [];
  const priced = calls - plan - unpriced;
  if (plan && plan >= calls) parts.push('included in subscription');
  else if (priced > 0) parts.push(`≈ ${dollars(Number(u?.cost) || 0)}${unpriced ? ` + ${unpriced} call${unpriced === 1 ? '' : 's'} with no price` : ''}`);
  return parts.join(' · ');
}

/** Prices as the owner types them, one model per line: `model-id: 3 / 15` or `model-id: 3 / 15 / 0.3`
 * (input / output / cached input, dollars per million tokens). Returns {prices, invalid}. */
export function parsePrices(text) {
  const prices = {}, invalid = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^(.+?)\s*[:=]\s*([\d.]+)\s*\/\s*([\d.]+)(?:\s*\/\s*([\d.]+))?\s*$/.exec(line);
    const row = m ? {input: rate(m[2]), output: rate(m[3]), ...(m[4] ? {cached: rate(m[4])} : {})} : null;
    if (!row || Object.values(row).some(v => !Number.isFinite(v))) { invalid.push(line.slice(0, 80)); continue; }
    prices[m[1].trim().slice(0, 120)] = row;
  }
  return {prices, invalid};
}
export const pricesText = prices => Object.entries(prices || {}).map(([model, p]) => `${model}: ${p.input} / ${p.output}${Number.isFinite(p.cached) ? ` / ${p.cached}` : ''}`).join('\n');

/** The server's check of a `prices` body: an object of model id to {input, output, cached?}. Throws a message. */
export function cleanPrices(value) {
  if (value === undefined) return undefined;
  if (value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('Prices must be an object of model id to {input, output}.');
  const out = {};
  const entries = Object.entries(value);
  if (entries.length > 200) throw new Error('Set prices for at most 200 models.');
  for (const [model, row] of entries) {
    const id = String(model || '').trim().slice(0, 120);
    const input = rate(row?.input), output = rate(row?.output), cached = rate(row?.cached);
    if (!id || !Number.isFinite(input) || !Number.isFinite(output) || Number.isNaN(cached)) throw new Error(`The price for "${id || model}" needs an input and an output price in dollars per million tokens.`);
    out[id] = {input, output, ...(cached === null ? {} : {cached})};
  }
  return out;
}
