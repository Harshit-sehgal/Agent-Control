/** View models for the ask card, the per-bot permission rows and the pause banner:
 * pure functions from the stored snapshot, with no DOM and no globals, so Node tests
 * import them directly (tests/ui-asks.test.js). The rules themselves (what an answer
 * stores, which choices a payment gets) live in asks.js; this file only turns them
 * into what a screen shows.
 *
 * An ask is a line in a chat (`{kind: 'ask', askId, text}`) whose status lives in
 * `state.asks`, so answering never rewrites a line. A grant is `{botId, action,
 * scope, choice}` in `state.grants`. */
import {ASK_ANSWER_LABELS, GRANT_LABELS, ASK_ACTIONS, UNTIL_CHOICES, askChoices, acrossSites, grantChoices, answeredText, grantFor, isAskAction, scopeOf, grantEnded} from './asks.js?v=a9557469c7';
import {limitsOf, FAIL_STREAK} from './limits.js?v=a9557469c7';

export const PAUSE_TEXT = 'All bots are paused. Nothing runs until you resume.';
/** The banner while everything bots start is paused; `resume` says whether this person may lift it. */
export const pauseBanner = (state, {canResume = false} = {}) => (state?.guard?.paused ? {text: PAUSE_TEXT, resume: Boolean(canResume)} : null);

const roster = state => (state?.groups || []).find(g => g.id === 'home')?.bots || [];

/** The card's question: "Let Atlas open example.com?". Plain text: the caller escapes it. */
export const askQuestion = (ask, botName = 'A bot') => `Let ${botName} ${String(ask?.detail || (ask?.action === 'browser.use' ? `open ${ask?.target || 'a web page'}` : `do this: ${ask?.action}`)).replace(/[.?!\s]+$/, '')}?`;

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
    question: askQuestion(ask, botName),
    // Allow once (the raised one), Always allow where it is offered, and Don't allow: the owner picks one.
    // Nothing answers for them: closing or Escape leaves the card waiting.
    choices: (() => { const ids = askChoices(ask.action, {acrossSites: acrossSites(ask), site: Boolean(ask.grantScope)}); return ['allow', 'always', 'decline'].filter(id => ids.includes(id)).map((id, i) => ({id, label: ASK_ANSWER_LABELS[id], primary: i === 0})); })(),
    target: ask.action === 'browser.use' ? ask.target || '' : '',
    // The whole text a write would carry (an email body): the card shows all of it, folded.
    body: typeof ask.body === 'string' ? ask.body : '',
    note: ask.action === 'spend' ? (ask.grantScope ? 'Payments ask every time unless you choose Always allow for this site.' : 'Payments are asked every time.') : '',
    // Always allow on a payment lets this bot pay on this site without asking, so the card confirms it first.
    ...(ask.action === 'spend' && ask.grantScope ? {confirmAlways: payAlwaysText(botName, ask.grantScope)} : {}),
  };
}

/** The confirmation an Always allow on payments shows first, on an ask card and on a setup rule card alike. */
export const payAlwaysText = (botName, scope) => `${botName} will pay on ${host(scope)} without asking you. You can change this on ${botName}'s profile → Permissions.`;

/* ---------- grants ---------- */

const host = scope => { try { return new URL(scope).host; } catch { return String(scope || '').replace(/^https?:\/\//, ''); } };
/** What a grant lets a bot do, as a short phrase: "Open example.com", "Send", "Read gmail (me@x.com)". */
export function grantWhat(action, scope = '') {
  if (action === 'browser.use') return scope ? `Open ${host(scope)}` : 'Open web pages';
  const plain = {send: 'Send', post: 'Post', delete: 'Delete', spend: 'Spend money'}[action];
  if (plain) return scope ? `${plain} on ${host(scope)}` : action === 'spend' ? 'Spend money anywhere' : plain;
  const match = /^connector\.([a-z0-9_-]+)\.(read|write)(?:\.([A-Za-z0-9_.:-]{1,128}))?$/.exec(String(action));
  if (match) return `${match[2] === 'read' ? 'Read' : 'Change'} ${match[1]}${match[3] ? `: ${match[3]}` : ''}${scope ? ` (${scope})` : ''}`;
  return String(action);
}
export const scopeOfAction = (action, target) => scopeOf({action, target});

const rank = action => { const i = ASK_ACTIONS.indexOf(action); return i < 0 ? ASK_ACTIONS.length : i; };

/** One bot's rules: its explicit grants only (see verdict in shared/asks.js). Each row carries the choices it
 * may be set to and which one is on. */
export function grantRows(state, botId) {
  const bot = roster(state).find(b => b.id === botId);
  if (!bot) return [];
  const row = (action, scope, choice, until) => ({
    botId, botName: bot.name, action, scope, choice, label: grantWhat(action, scope), until: choice === 'always' ? until || null : null,
    choices: grantChoices(action, {site: Boolean(scope)}).map(id => ({id, label: GRANT_LABELS[id], on: id === choice})),
  });
  // An Always allow whose end has passed is no rule any more (asks.js), so it is no row either.
  return (state.grants || []).filter(g => g?.botId === botId && isAskAction(g.action) && !grantEnded(g))
    .map(g => row(g.action, g.scope || '', grantFor(state, botId, g.action, g.scope || '') || 'ask', g.until))
    .sort((a, b) => rank(a.action) - rank(b.action) || a.action.localeCompare(b.action) || a.scope.localeCompare(b.scope));
}
/** One bot's permissions in plain words, for the top of its Permissions page: what it may do without asking,
 * what asks, what it may not do, and the limits on every run. Each entry of `free`, `asks` and `denied` is
 * {text, until?}; `limits` is sentences. Derived from the same rules `verdict` reads (BASIC_KIT, basic access,
 * `askBasics`, Hands-off, this bot's grants) and from shared/limits.js. Null for a bot that is not there. */
export function permissionSummary(state, botId) {
  const rows = grantRows(state, botId);
  if (!roster(state).some(b => b.id === botId)) return null;
  const ask = Boolean(state?.askBasics), hands = state?.handsOff === true;
  const of = choice => rows.filter(r => r.choice === choice).map(r => ({text: r.label, ...(r.until ? {until: r.until} : {})}));
  const basics = {text: 'Open web pages and read connected apps'};
  const free = [{text: 'Chat, hand work to its team, make bots and set schedules'}, ...(ask ? [] : [basics]),
    ...(hands ? [{text: 'Send, post and change connected apps on any site'}] : []), ...of('always')];
  const asks = [...(ask ? [basics] : []), ...(hands ? [] : [{text: 'Send, post or change a connected app'}]),
    {text: 'Delete anything'}, {text: 'Pay for anything, every time'}, ...of('ask')];
  const l = limitsOf(state), limits = [];
  if (l.pages) limits.push(`At most ${l.pages} pages at once.`);
  if (l.rounds) limits.push(`At most ${l.rounds} look-ups before answering.`);
  if (l.steps) limits.push(`At most ${l.steps} bot hand-offs per message.`);
  if (l.askCheckpoints) limits.push('Long tasks between bots pause and ask you.');
  if (!limits.length) limits.push(`No limits on pages, look-ups or hand-offs. A run stops after ${FAIL_STREAK} failed rounds in a row.`);
  if (state?.guard?.paused) limits.unshift('All bots are paused right now.');
  return {free, asks, denied: of('deny'), limits};
}

/** Every rule of every bot, in roster order. */
export const allGrantRows = state => roster(state).flatMap(b => grantRows(state, b.id));

/** The request a choice makes: POST /api/grants {botId, action, scope?, choice, until?}. No `until` clears an end. */
export function grantUrl(row, choice, until = null) {
  const body = {botId: row.botId, action: row.action, ...(row.scope ? {scope: row.scope} : {}), choice, ...(until ? {until} : {})};
  return {url: '/api/grants', body};
}

/** The ends an Always allow row offers, the ask card's own (UNTIL_CHOICES; `untilFor` in asks.js turns one into a
 * time). A row that already ends leads with that end (`id: ''`, its `until` for the markup to word), so the select
 * shows it until the owner picks another. Any other row has none. */
export function untilOptions(row) {
  if (row?.choice !== 'always') return [];
  const now = row.until ? [{id: '', label: '', on: true, until: row.until}] : [];
  return [...now, ...UNTIL_CHOICES.map(([id, label]) => ({id, label, on: !row.until && id === 'always'}))];
}
