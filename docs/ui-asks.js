/** View models for the ask card, the per-bot permission rows and the pause banner:
 * pure functions from the stored snapshot, with no DOM and no globals, so Node tests
 * import them directly (tests/ui-asks.test.js). The rules themselves (what an answer
 * stores, which choices a payment gets) live in asks.js; this file only turns them
 * into what a screen shows.
 *
 * An ask is a line in a chat (`{kind: 'ask', askId, text}`) whose status lives in
 * `state.asks`, so answering never rewrites a line. A grant is `{botId, action,
 * scope, choice}` in `state.grants`. */
import {ASK_ANSWER_LABELS, GRANT_LABELS, ASK_ACTIONS, askChoices, acrossSites, grantChoices, answeredText, grantFor, isAskAction, scopeOf} from './asks.js?v=64ddf06799';

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
    return {open: false, botId: ask?.botId || null, botName, text: copy && ask ? `${said} (${botName})` : said, choices: [], note: '', target: '', body: ''};
  }
  return {
    open: true, ask, askId: ask.id, botId: ask.botId, botName, text: line.text,
    // Strongest yes first: Always allow (or Allow, where Always is not offered), then Allow once, then Decline.
    choices: (() => { const ids = askChoices(ask.action, {acrossSites: acrossSites(ask)}); const order = ['always', 'allow', 'decline'].filter(id => ids.includes(id)); return order.map((id, i) => ({id, label: ids.includes('always') || id !== 'allow' ? ASK_ANSWER_LABELS[id] : 'Allow', primary: i === 0})); })(),
    target: ask.action === 'browser.use' ? ask.target || '' : '',
    // The whole text a write would carry (an email body): the card shows all of it, folded.
    body: typeof ask.body === 'string' ? ask.body : '',
    note: ask.action === 'spend' ? 'Payments are asked every time.' : '',
  };
}

/* ---------- grants ---------- */

const host = scope => { try { return new URL(scope).host; } catch { return String(scope || '').replace(/^https?:\/\//, ''); } };
/** What a grant lets a bot do, as a short phrase: "Open example.com", "Send", "Read gmail (me@x.com)". */
export function grantWhat(action, scope = '') {
  if (action === 'browser.use') return scope ? `Open ${host(scope)}` : 'Open web pages';
  const plain = {send: 'Send', post: 'Post', delete: 'Delete', spend: 'Spend money'}[action];
  if (plain) return scope && action !== 'spend' ? `${plain} on ${host(scope)}` : plain;
  const match = /^connector\.([a-z0-9_-]+)\.(read|write)(?:\.([A-Za-z0-9_.:-]{1,128}))?$/.exec(String(action));
  if (match) return `${match[2] === 'read' ? 'Read' : 'Change'} ${match[1]}${match[3] ? `: ${match[3]}` : ''}${scope ? ` (${scope})` : ''}`;
  return String(action);
}
export const scopeOfAction = (action, target) => scopeOf({action, target});

const rank = action => { const i = ASK_ACTIONS.indexOf(action); return i < 0 ? ASK_ACTIONS.length : i; };

/** One bot's rules: its explicit grants only (see verdict in shared/asks.js). Each row carries the choices it
 * may be set to (spend has no Always allow) and which one is on. */
export function grantRows(state, botId) {
  const bot = roster(state).find(b => b.id === botId);
  if (!bot) return [];
  const row = (action, scope, choice) => ({
    botId, botName: bot.name, action, scope, choice, label: grantWhat(action, scope),
    choices: grantChoices(action).map(id => ({id, label: GRANT_LABELS[id], on: id === choice})),
  });
  return (state.grants || []).filter(g => g?.botId === botId && isAskAction(g.action))
    .map(g => row(g.action, g.scope || '', grantFor(state, botId, g.action, g.scope || '') || 'ask'))
    .sort((a, b) => rank(a.action) - rank(b.action) || a.action.localeCompare(b.action) || a.scope.localeCompare(b.scope));
}
/** Every rule of every bot, in roster order. */
export const allGrantRows = state => roster(state).flatMap(b => grantRows(state, b.id));

/** The request a choice makes: POST /api/grants {botId, action, scope?, choice}. */
export function grantUrl(row, choice) {
  const body = {botId: row.botId, action: row.action, ...(row.scope ? {scope: row.scope} : {}), choice};
  return {url: '/api/grants', body};
}
