/** View models for the ask card, the per-bot permission rows and the pause banner:
 * pure functions from the stored snapshot, with no DOM and no globals, so Node tests
 * import them directly (tests/ui-asks.test.js). The rules themselves (what an answer
 * stores, which choices a payment gets) live in asks.js; this file only turns them
 * into what a screen shows.
 *
 * An ask is a line in a chat (`{kind: 'ask', askId, text}`) whose status lives in
 * `state.asks`, so answering never rewrites a line. A grant is `{botId, action,
 * scope, choice}` in `state.grants`. */
import {ASK_ANSWER_LABELS, GRANT_LABELS, ASK_ACTIONS, askChoices, grantChoices, answeredText, grantFor, isAskAction, scopeOf} from './asks.js?v=588d41953d';

export const PAUSE_TEXT = 'All bots are paused. Nothing runs until you resume.';
/** The banner while everything bots start is paused; `resume` says whether this person may lift it. */
export const pauseBanner = (state, {canResume = false} = {}) => (state?.guard?.paused ? {text: PAUSE_TEXT, resume: Boolean(canResume)} : null);

const roster = state => (state?.groups || []).find(g => g.id === 'home')?.bots || [];

/** What one ask line shows. Open: the asking bot's waiting face, one sentence, the buttons.
 * Answered (or an ask the state no longer holds): one muted line. The primary's "Needs you"
 * copy is the same card, so the face above it is the asking bot's and its collapsed line says whose. */
export function askCard(state, line) {
  const ask = (state?.asks || []).find(a => a.id === line?.askId), bot = roster(state).find(b => b.id === ask?.botId);
  const botName = bot?.name || 'A bot', copy = /^Needs you: /.test(line?.text || '');
  if (!ask || ask.status !== 'pending') {
    const said = ask ? answeredText(ask) : 'Answered';
    return {open: false, botId: ask?.botId || null, botName, text: copy && ask ? `${said} (${botName})` : said, choices: [], note: '', target: ''};
  }
  return {
    open: true, ask, askId: ask.id, botId: ask.botId, botName, text: line.text,
    choices: askChoices(ask.action).map(id => ({id, label: ASK_ANSWER_LABELS[id], primary: id === 'allow'})),
    target: ask.action === 'browser.use' ? ask.target || '' : '',
    note: ask.action === 'spend' ? 'Payments are asked every time.' : '',
  };
}

/* ---------- grants ---------- */

const host = scope => { try { return new URL(scope).host; } catch { return String(scope || '').replace(/^https?:\/\//, ''); } };
/** What a grant lets a bot do, as a short phrase: "Open example.com", "Send", "Read gmail (me@x.com)". */
export function grantWhat(action, scope = '') {
  if (action === 'browser.use') return scope ? `Open ${host(scope)}` : 'Open web pages';
  const plain = {send: 'Send', post: 'Post', delete: 'Delete', spend: 'Spend money'}[action];
  if (plain) return plain;
  const match = /^connector\.([a-z0-9_-]+)\.(read|write)$/.exec(String(action));
  if (match) return `${match[2] === 'read' ? 'Read' : 'Change'} ${match[1]}${scope ? ` (${scope})` : ''}`;
  return String(action);
}
export const scopeOfAction = (action, target) => scopeOf({action, target});

const rank = action => { const i = ASK_ACTIONS.indexOf(action); return i < 0 ? ASK_ACTIONS.length : i; };

/** One bot's rules. Each row carries the choices it may be set to (spend has no Always allow) and which one is
 * on. A permission the bot held before asks existed, with no grant of its own, is listed read-only: it counts as
 * Always allow only when it ran without asking. */
export function grantRows(state, botId) {
  const bot = roster(state).find(b => b.id === botId);
  if (!bot) return [];
  const row = (action, scope, choice, legacy) => ({
    botId, botName: bot.name, action, scope, choice, legacy, label: grantWhat(action, scope),
    choices: legacy ? [] : grantChoices(action).map(id => ({id, label: GRANT_LABELS[id], on: id === choice})),
  });
  const explicit = (state.grants || []).filter(g => g?.botId === botId && isAskAction(g.action))
    .map(g => row(g.action, g.scope || '', grantFor(state, botId, g.action, g.scope || '') || 'ask', false))
    .sort((a, b) => rank(a.action) - rank(b.action) || a.action.localeCompare(b.action) || a.scope.localeCompare(b.scope));
  const old = (bot.permissions || []).filter(a => isAskAction(a) && !explicit.some(r => r.action === a))
    .map(a => row(a, '', a !== 'spend' && bot.settings?.browserApproval === 'auto' ? 'always' : 'ask', true));
  return [...explicit, ...old];
}
/** Every rule of every bot, in roster order. */
export const allGrantRows = state => roster(state).flatMap(b => grantRows(state, b.id));

/** The request a choice makes: POST /api/grants {botId, action, scope?, choice}. */
export function grantUrl(row, choice) {
  const body = {botId: row.botId, action: row.action, ...(row.scope ? {scope: row.scope} : {}), choice};
  return {url: '/api/grants', body};
}
