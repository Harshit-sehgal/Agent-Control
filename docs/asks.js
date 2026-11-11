/** One ask mechanism, and the grants an answer can leave behind.
 *
 * A bot never answers "I don't have permission". When it needs something that
 * leaves the app, it asks the owner, and the owner answers Decline, Allow, or
 * Always allow for this bot. Always allow is a grant, and a grant belongs to one
 * bot, one action and, where it means something, one origin (a browser) or one
 * account (a connector). Bots never inherit their creator's grants.
 *
 * Two lists live in the workspace state:
 *   state.asks   [{id, botId, runId, chatKey, action, target, detail, grantScope,
 *                  status 'pending'|'allowed'|'declined', scope 'once'|'always'|null,
 *                  createdAt, answeredAt?, expiresAt?, expired?, requestId?, implies?}]
 *   state.grants [{botId, action, scope, choice 'always'|'ask'|'deny', at}]
 *
 * The basic kit (ask a bot, make a bot, set a schedule) is never asked about;
 * its limits are checkpoints and the runaway guard. Payments (`spend`) are
 * asked every time: no answer path and no stored grant can make them automatic.
 *
 * Pure and browser-safe, like the other shared modules: the server and the
 * Pages demo share every rule here.
 */
import {fail} from './errors.js?v=697db3ab25';
import {cleanText} from './core.js?v=697db3ab25';
import {logActivity} from './activity-log.js?v=697db3ab25';

/** What every bot may do without a grant. */
export const BASIC_KIT = ['bot.ask', 'bot.create', 'schedule.set'];
/** The actions that ask. Connector actions are `connector.<name>.read|write`. */
export const ASK_ACTIONS = ['browser.use', 'send', 'post', 'delete', 'spend'];
const CONNECTOR = /^connector\.([a-z0-9_-]+)\.(read|write)$/;

export const isAskAction = action => ASK_ACTIONS.includes(action) || CONNECTOR.test(String(action ?? ''));
export const isBasicKit = action => BASIC_KIT.includes(action);

export const ASK_ANSWERS = ['decline', 'allow', 'always'];
export const GRANT_CHOICES = ['always', 'ask', 'deny'];
/** The words on the ask card's buttons and the grant picker, verbatim. */
export const ASK_ANSWER_LABELS = {decline: 'Decline', allow: 'Allow', always: 'Always allow for this bot'};
export const GRANT_LABELS = {always: 'Always allow', ask: 'Ask each time', deny: 'Deny'};
/** A payment is only ever Decline or Allow, and a grant for it is Ask each time or Deny. */
export const askChoices = action => (action === 'spend' ? ['decline', 'allow'] : [...ASK_ANSWERS]);
export const grantChoices = action => (action === 'spend' ? ['ask', 'deny'] : [...GRANT_CHOICES]);

export const ASK_EXPIRY_MS = 24 * 3600000;
/** Settled asks kept in state; a pending one is never dropped. */
export const MAX_SETTLED_ASKS = 500;

const iso = () => new Date().toISOString();
const botIds = state => new Set((state.groups || []).flatMap(g => (g.bots || []).map(b => b.id)));

/** Where a grant applies: the origin for a browser page, the account for a connector, nothing else. */
export function scopeOf({action, target} = {}) {
  if (action === 'browser.use') {
    try {
      const url = new URL(String(target ?? ''));
      return /^https?:$/.test(url.protocol) ? url.origin.toLowerCase() : '';
    } catch { return ''; }
  }
  if (CONNECTOR.test(String(action ?? ''))) return cleanText(String(target ?? ''), 200).toLowerCase();
  return '';
}

const botNameOf = (state, id) => (state.groups || []).flatMap(g => g.bots || []).find(b => b.id === id)?.name || 'A bot';
/** What a grant lets a bot do, as the end of a sentence. */
function verbOf(action, scope) {
  if (action === 'browser.use') return `open ${scope.replace(/^https?:\/\//, '')}`;
  if (action === 'spend') return 'spend money';
  const connector = CONNECTOR.exec(action);
  if (connector) return `${connector[2]} ${connector[1]}${scope ? ` (${scope})` : ''}`;
  return action;
}
/** The log's sentence for a grant change. */
const grantSentence = (name, action, scope, choice) => {
  const verb = verbOf(action, scope);
  return choice === 'always' ? `${name} is always allowed to ${verb}.` : choice === 'deny' ? `${name} is not allowed to ${verb}.` : `${name} will ask you each time to ${verb}.`;
};

const sameGrant = (g, botId, action, scope) => g?.botId === botId && g.action === action && g.scope === scope;

/** What the owner has said about this bot doing this: 'always', 'ask', 'deny', or null for nothing yet.
 * A stored 'always' for a payment is refused here too (a doctored backup could carry one). */
export function grantFor(state, botId, action, scope = '') {
  if (!botIds(state).has(botId)) return null;
  const grant = (state.grants || []).find(g => sameGrant(g, botId, action, scope || ''));
  if (!grant || !GRANT_CHOICES.includes(grant.choice)) return null;
  if (action === 'spend' && grant.choice === 'always') return 'ask';
  return grant.choice;
}

export const grantsOf = (state, botId) => (state.grants || []).filter(g => g?.botId === botId);

/** Set one grant, replacing the same key. Refuses Always allow for a payment, an action that is not
 * asked about, a browser grant with no site and a connector grant with no account. */
export function setGrant(state, botId, action, scope, choice, now = iso(), {log = true, threadId = null} = {}) {
  if (!isAskAction(action)) fail(`"${String(action ?? '').slice(0, 60)}" is not something a bot asks about.`);
  if (!GRANT_CHOICES.includes(choice)) fail('Choose always, ask or deny.');
  if (action === 'spend' && choice === 'always') fail('A payment is asked every time. Choose Ask each time or Deny.');
  if (!botIds(state).has(botId)) fail('Bot not found.', 404);
  const where = action === 'browser.use' || CONNECTOR.test(action) ? scopeOf({action, target: scope}) : '';
  if (action === 'browser.use' && !where) fail('A browser grant is for one site. Say which.');
  if (CONNECTOR.test(action) && !where) fail('A connector grant is for one account. Say which.');
  state.grants ??= [];
  const found = state.grants.find(g => sameGrant(g, botId, action, where));
  if (found) Object.assign(found, {choice, at: now});
  else state.grants.push({botId, action, scope: where, choice, at: now});
  if (log) logActivity(state, {botId, kind: 'perm', text: grantSentence(botNameOf(state, botId), action, where, choice), threadId, now});
  return state.grants.find(g => sameGrant(g, botId, action, where));
}

const settled = ask => ask.status !== 'pending';

/** The gate for one action: allowed, refused with a place to change it, or an ask is needed.
 * A permission a bot held before asks existed still counts: with the old "run without asking"
 * setting it was Always allow, otherwise it was Ask each time. An explicit grant wins over it. */
export function verdict(state, bot, action, target = '') {
  if (isBasicKit(action)) return {verdict: 'allow', scope: ''};
  if (!isAskAction(action)) return {verdict: 'deny', scope: '', message: `${bot?.name || 'This bot'} cannot do that.`};
  // `target` may be the page URL or the origin itself; a connector's is its account.
  const scope = scopeOf({action, target});
  let choice = grantFor(state, bot?.id, action, scope);
  if (!choice && action !== 'spend' && Array.isArray(bot?.permissions) && bot.permissions.includes(action) && bot.settings?.browserApproval === 'auto') choice = 'always';
  if (choice === 'always') return {verdict: 'allow', scope};
  if (choice === 'deny') {
    const name = bot?.name || 'this bot';
    return {verdict: 'deny', scope, message: `${name} is set to Deny for this. Change it on ${name}'s profile → Permissions.`};
  }
  return {verdict: 'ask', scope};
}

/** One action after another, riskiest first: any Deny stops it, otherwise the first one that is not
 * yet Always allow is what the owner is asked about. `needs` is [{action, target, detail}]. */
export function decide(state, bot, needs) {
  let ask = null;
  const rest = [];
  for (const need of needs) {
    const v = verdict(state, bot, need.action, need.target);
    if (v.verdict === 'deny') return {verdict: 'deny', need, message: v.message};
    if (v.verdict === 'ask' && !ask) ask = {...need, scope: v.scope};
    else if (v.verdict === 'ask') rest.push({...need, scope: v.scope});
  }
  if (!ask) return {verdict: 'allow'};
  // Always allow on the riskiest ask also covers the rest of what the same request needs.
  return {verdict: 'ask', need: ask, implies: rest.filter(n => n.action !== 'spend').map(n => ({action: n.action, scope: n.scope}))};
}

/** Create a pending ask. An ask from an unattended run (nobody typed in it) lapses after 24 hours. */
export function createAsk(state, {botId, runId = null, chatKey = null, action, target = '', detail = '', unattended = false, requestId = null, implies = [], now = iso(), makeId = () => crypto.randomUUID()} = {}) {
  if (!isAskAction(action)) fail(`"${String(action ?? '').slice(0, 60)}" is not something a bot asks about.`);
  if (!botId) fail('An ask needs the bot that is asking.');
  const ask = {
    id: makeId(), botId, runId, chatKey, action,
    target: cleanText(String(target ?? ''), 2000), detail: cleanText(String(detail ?? ''), 300),
    grantScope: scopeOf({action, target}), status: 'pending', scope: null, createdAt: now,
    ...(unattended ? {expiresAt: new Date(Date.parse(now) + ASK_EXPIRY_MS).toISOString()} : {}),
    ...(requestId ? {requestId} : {}),
    ...(implies.length ? {implies} : {}),
  };
  state.asks ??= [];
  state.asks.push(ask);
  // Settled history is bounded; an ask nobody has answered never is.
  const open = state.asks.filter(a => !settled(a));
  const done = state.asks.filter(settled);
  if (done.length > MAX_SETTLED_ASKS) state.asks = [...done.slice(-MAX_SETTLED_ASKS), ...open].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  return ask;
}

/** True when another pending ask still holds this run. */
const holds = (state, ask) => (state.asks || []).some(a => a.runId === ask.runId && a.id !== ask.id && a.status === 'pending');
const parked = (state, runId) => runId ? (state.groupRuns || []).find(r => r.id === runId && r.status === 'awaiting_ask') || null : null;

/** The owner's answer. Always allow also stores the grant for this bot, this action and this origin or
 * account (and for the rest of what the same request needed). Returns the ask and the run to resume:
 * only when that run is still waiting on asks and this was the last one. An answer to an ask whose run
 * was cancelled or deleted is recorded, its grant stands, and nothing resumes. */
export function answerAsk(state, askId, answer, now = iso()) {
  if (!ASK_ANSWERS.includes(answer)) fail('Answer decline, allow or always.');
  const ask = (state.asks || []).find(a => a.id === askId);
  if (!ask) fail('Ask not found.', 404);
  if (answer === 'always' && ask.action === 'spend') fail('A payment is asked every time. Choose Allow or Decline.');
  if (ask.status !== 'pending') fail('This ask was already answered.', 409);
  ask.status = answer === 'decline' ? 'declined' : 'allowed';
  ask.scope = answer === 'always' ? 'always' : answer === 'allow' ? 'once' : null;
  ask.answeredAt = now;
  delete ask.expiresAt;
  if (answer === 'always' && botIds(state).has(ask.botId)) {
    // One entry for the answer, in the chat it was asked in; what the same request also covered is not a second event.
    setGrant(state, ask.botId, ask.action, ask.grantScope, 'always', now, {threadId: ask.chatKey});
    for (const extra of ask.implies || []) if (extra.action !== 'spend') setGrant(state, ask.botId, extra.action, extra.scope, 'always', now, {log: false});
  }
  const run = parked(state, ask.runId);
  return {ask, resumeRunId: run && !holds(state, ask) ? run.id : null};
}

/** Decline every ask whose 24 hours are up. Returns them and the runs that may now go on. */
export function expireAsks(state, now = iso()) {
  const expired = [];
  for (const ask of state.asks || []) {
    if (ask.status !== 'pending' || !ask.expiresAt || Date.parse(ask.expiresAt) > Date.parse(now)) continue;
    Object.assign(ask, {status: 'declined', scope: null, answeredAt: now, expired: true});
    delete ask.expiresAt;
    expired.push(ask);
  }
  const resumeRunIds = [...new Set(expired.map(a => parked(state, a.runId) && !holds(state, a) ? a.runId : null).filter(Boolean))];
  return {expired, resumeRunIds};
}

/** A run ended (or a bot went away) with asks still open: they stay answerable for a day, then lapse. */
export function orphanAsks(state, match, now = iso()) {
  for (const ask of state.asks || []) {
    if (ask.status === 'pending' && !ask.expiresAt && match(ask)) ask.expiresAt = new Date(Date.parse(now) + ASK_EXPIRY_MS).toISOString();
  }
}

/** An ask whose run is no longer parked on it (stopped, deleted, cut by a restore) cannot resume anything:
 * give it the 24 hours every orphan gets. Run on every load, so a restored backup cannot leave an ask in
 * Needs you for ever. */
export function lapseOrphans(state, now = iso()) {
  const parkedIds = new Set((state.groupRuns || []).filter(r => r.status === 'awaiting_ask').map(r => r.id));
  orphanAsks(state, ask => ask.runId && !parkedIds.has(ask.runId), now);
}

/** Every ask still waiting on the owner, newest first: the "Needs you" list. */
export const pendingAsks = state => (state.asks || []).filter(a => a.status === 'pending').reverse();

/** Drop grants that cannot be honoured: a bot that is gone, an action nobody asks about, a choice
 * that is not one, a payment set to Always. Idempotent; run on every load and restore. */
export function sweepGrants(state) {
  const ids = botIds(state);
  state.grants = (Array.isArray(state.grants) ? state.grants : []).filter(g => g && typeof g === 'object'
    && ids.has(g.botId) && isAskAction(g.action) && typeof g.scope === 'string'
    && GRANT_CHOICES.includes(g.choice) && !(g.action === 'spend' && g.choice === 'always'));
  return state;
}

/** A bot is gone: its grants go with it and its open asks lapse. */
export function forgetBotAsks(state, botId, now = iso()) {
  state.grants = (state.grants || []).filter(g => g?.botId !== botId);
  orphanAsks(state, ask => ask.botId === botId, now);
}

/** The card's one sentence. */
export const askText = (ask, botName = 'A bot') => `${botName} wants to ${ask.detail || (ask.action === 'browser.use' ? `open ${ask.target}` : `do this: ${ask.action}`)}.`;

/** What an answered card collapses to. */
export function answeredText(ask) {
  if (ask.status === 'pending') return 'Waiting for you';
  if (ask.expired) return 'No answer in 24 hours, so it was declined';
  if (ask.status === 'declined') return 'You declined it';
  return ask.scope === 'always' ? 'You always allow it for this bot' : 'You allowed it once';
}
