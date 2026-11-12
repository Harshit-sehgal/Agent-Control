/** One ask mechanism, and the grants an answer can leave behind.
 *
 * A bot never answers "I don't have permission". When it needs something that
 * leaves the app, it asks the owner, and the owner answers Decline, Allow, or
 * Always allow for this bot. Always allow is a grant, and a grant belongs to one
 * bot, one action and, where it means something, one origin (a browser) or one
 * account (a connector). Bots never inherit their creator's grants.
 *
 * Two lists live in the workspace state:
 *   state.asks   [{id, botId, runId, chatKey, action, target, detail, body?, argsHash?, grantScope,
 *                  status 'pending'|'allowed'|'declined', scope 'once'|'always'|null,
 *                  createdAt, answeredAt?, expiresAt?, expired?, requestId?, implies?, covers?}]
 *   state.grants [{botId, action, scope, choice 'always'|'ask'|'deny', at}]
 *
 * The basic kit (ask a bot, make a bot, set a schedule) is never asked about;
 * its limits are checkpoints and the runaway guard. Basic access (open a web page, read a connected app) is
 * allowed until the owner sets Ask each time or Deny for that site or account. Payments (`spend`) ask
 * every time unless the owner sets Always allow for one bot on one site; a payment Deny with no site
 * covers every site.
 *
 * Pure and browser-safe, like the other shared modules: the server and the
 * Pages demo share every rule here.
 */
import {fail} from './errors.js?v=71b92f8de6';
import {cleanText} from './core.js?v=71b92f8de6';
import {logActivity} from './activity-log.js?v=71b92f8de6';

/** What every bot may do without a grant. */
export const BASIC_KIT = ['bot.ask', 'bot.create', 'schedule.set'];
/** The actions that ask. Connector actions are `connector.<name>.read` and `connector.<name>.write.<tool>`; a bare
 * `connector.<name>.write` is the connector-wide grant from before writes were per tool (only its Deny still counts). */
export const ASK_ACTIONS = ['browser.use', 'send', 'post', 'delete', 'spend'];
const CONNECTOR = /^connector\.([a-z0-9_-]+)\.(read|write)(?:\.([A-Za-z0-9_.:-]{1,128}))?$/;
const valid = match => Boolean(match) && !(match[2] === 'read' && match[3]);
const connectorOf = action => { const match = CONNECTOR.exec(String(action ?? '')); return valid(match) ? match : null; };
const isConnector = action => Boolean(connectorOf(action));
/** The connector-wide write grant a per-tool write falls under. */
const umbrellaOf = action => { const match = connectorOf(action); return match?.[3] ? `connector.${match[1]}.write` : null; };

export const isAskAction = action => ASK_ACTIONS.includes(action) || isConnector(action);
export const isBasicKit = action => BASIC_KIT.includes(action);
/** What every bot may do with no grant: open a web page, and read a connected app. A click that sends, posts,
 * deletes or pays on that page is its own action and still asks; so does every connector write. */
export const BASIC_ACCESS = ['browser.use', 'connector read'];
export const isBasicAccess = action => action === 'browser.use' || connectorOf(action)?.[2] === 'read';

export const ASK_ANSWERS = ['decline', 'allow', 'always'];
export const GRANT_CHOICES = ['always', 'ask', 'deny'];
/** The words on the ask card's buttons and the grant picker, verbatim. */
export const ASK_ANSWER_LABELS = {decline: "Don't allow", allow: 'Allow once', always: 'Always allow'};
export const GRANT_LABELS = {always: 'Always allow', ask: 'Ask each time', deny: "Don't allow"};
/** An ask that covers more than one site is only Decline or Allow: a grant is for one site, so no single
 * Always allow can mean what it shows. A payment with no site has no Always allow either. */
export const askChoices = (action, {acrossSites = false, site = true} = {}) => (acrossSites || (action === 'spend' && !site) ? ['decline', 'allow'] : [...ASK_ANSWERS]);
/** Does this ask cover more than one site? `covers` is every (action, scope) pair one ask stands for. */
export const acrossSites = ask => new Set([ask?.grantScope, ...(ask?.covers || []).map(c => c?.scope)].filter(Boolean)).size > 1;
/** A payment rule with no site is Ask each time or Deny: an Always allow is for one site. */
export const grantChoices = (action, {site = true} = {}) => (action === 'spend' && !site ? ['ask', 'deny'] : [...GRANT_CHOICES]);

export const ASK_EXPIRY_MS = 24 * 3600000;
/** Settled asks kept in state; a pending one is never dropped. */
export const MAX_SETTLED_ASKS = 500;

const iso = () => new Date().toISOString();
const botIds = state => new Set((state.groups || []).flatMap(g => (g.bots || []).map(b => b.id)));

/** The actions whose grant is for one site: a page, and a Send, Post or Delete click on it. */
const PER_ORIGIN = ['browser.use', 'send', 'post', 'delete'];
const SITE_WORD = {'browser.use': 'browser', send: 'send', post: 'post', delete: 'delete', spend: 'payment Always allow'};
/** A payment's grant is for one site, or (Ask each time or Deny only) for every site. */
const originOf = target => { try { const url = new URL(String(target ?? '')); return /^https?:$/.test(url.protocol) ? url.origin.toLowerCase() : ''; } catch { return ''; } };

/** Where a grant applies: the origin for a browser page or a click on one, the account for a connector,
 * the site for a payment (Ask each time or Deny may also be for every site, with no scope). */
export function scopeOf({action, target} = {}) {
  if (PER_ORIGIN.includes(action) || action === 'spend') return originOf(target);
  if (isConnector(action)) return cleanText(String(target ?? ''), 200).toLowerCase();
  return '';
}

const botNameOf = (state, id) => (state.groups || []).flatMap(g => g.bots || []).find(b => b.id === id)?.name || 'A bot';
/** What a grant lets a bot do, as the end of a sentence. */
function verbOf(action, scope) {
  if (action === 'browser.use') return `open ${scope.replace(/^https?:\/\//, '')}`;
  if (action === 'spend') return scope ? `pay on ${scope.replace(/^https?:\/\//, '')}` : 'spend money';
  const connector = connectorOf(action);
  if (connector) return `${connector[2]} ${connector[1]}${connector[3] ? ` with ${connector[3]}` : ''}${scope ? ` (${scope})` : ''}`;
  return scope ? `${action} on ${scope.replace(/^https?:\/\//, '')}` : action;
}
/** The log's sentence for a grant change. */
const grantSentence = (name, action, scope, choice) => {
  const verb = verbOf(action, scope);
  return choice === 'always' ? `${name} is always allowed to ${verb}.` : choice === 'deny' ? `${name} is not allowed to ${verb}.` : `${name} will ask you each time to ${verb}.`;
};

const sameGrant = (g, botId, action, scope) => g?.botId === botId && g.action === action && g.scope === scope;

/** What the owner has said about this bot doing this: 'always', 'ask', 'deny', or null for nothing yet.
 * A payment Always allow with no site is refused here too (a doctored backup could carry one). */
export function grantFor(state, botId, action, scope = '') {
  if (!botIds(state).has(botId)) return null;
  const grant = (state.grants || []).find(g => sameGrant(g, botId, action, scope || ''));
  if (!grant || !GRANT_CHOICES.includes(grant.choice)) return null;
  if (action === 'spend' && grant.choice === 'always' && !grant.scope) return 'ask';
  return grant.choice;
}

export const grantsOf = (state, botId) => (state.grants || []).filter(g => g?.botId === botId);

/** Set one grant, replacing the same key. Refuses a payment Always allow with no site, an action that is
 * not asked about, a browser grant with no site and a connector grant with no account. */
export function setGrant(state, botId, action, scope, choice, now = iso(), {log = true, threadId = null} = {}) {
  if (!isAskAction(action)) fail(`"${String(action ?? '').slice(0, 60)}" is not something a bot asks about.`);
  if (!GRANT_CHOICES.includes(choice)) fail('Choose always, ask or deny.');
  if (!botIds(state).has(botId)) fail('Bot not found.', 404);
  const where = PER_ORIGIN.includes(action) || isConnector(action) || action === 'spend' ? scopeOf({action, target: scope}) : '';
  if ((PER_ORIGIN.includes(action) || (action === 'spend' && choice === 'always')) && !where) fail(`A ${SITE_WORD[action]} grant is for one site. Say which.`);
  if (isConnector(action) && !where) fail('A connector grant is for one account. Say which.');
  state.grants ??= [];
  const found = state.grants.find(g => sameGrant(g, botId, action, where));
  if (found) Object.assign(found, {choice, at: now});
  else state.grants.push({botId, action, scope: where, choice, at: now});
  if (log) logActivity(state, {botId, kind: 'perm', text: grantSentence(botNameOf(state, botId), action, where, choice), threadId, now});
  return state.grants.find(g => sameGrant(g, botId, action, where));
}

/** The owner's switch: `ask` true makes every bot ask before it opens a page or reads a connected app, as
 * it does for everything else; false (the default) lets them. Logged like a grant change. */
export function setAskBasics(state, ask, now = iso()) {
  if (typeof ask !== 'boolean') fail('Say true or false.');
  state.askBasics = ask;
  logActivity(state, {kind: 'perm', text: ask ? 'Bots now ask before opening a web page or reading a connected app.' : 'Bots now open web pages and read connected apps without asking.', now});
  return {askBasics: ask};
}

const settled = ask => ask.status !== 'pending';

/** The gate for one action: allowed, refused with a place to change it, or an ask is needed.
 * Only an explicit grant allows. The old permission checkbox and "run without asking" are settings a
 * member can change, so they read as Ask each time. */
export function verdict(state, bot, action, target = '', {readPrivate = false} = {}) {
  if (isBasicKit(action)) return {verdict: 'allow', scope: ''};
  if (!isAskAction(action)) return {verdict: 'deny', scope: '', message: `${bot?.name || 'This bot'} cannot do that.`};
  // `target` may be the page URL or the origin itself; a connector's is its account.
  const scope = scopeOf({action, target});
  const umbrella = umbrellaOf(action);
  // A Deny on the connector-wide write (from before writes were per tool) still covers every write tool.
  // A payment Deny with no site covers every site; otherwise the site's own grant, then the every-site one.
  const everywhere = action === 'spend' && scope ? grantFor(state, bot?.id, action, '') : null;
  const choice = (umbrella && grantFor(state, bot?.id, umbrella, scope) === 'deny') || everywhere === 'deny' ? 'deny' : grantFor(state, bot?.id, action, scope) ?? everywhere;
  if (choice === 'always') return {verdict: 'allow', scope};
  if (choice === 'deny') {
    const name = bot?.name || 'this bot';
    return {verdict: 'deny', scope, message: `${name} is set to Don't allow for this. Change it on ${name}'s profile → Permissions.`};
  }
  // The basics need no answer. But once this run has read private data, a page on a site the bot has no grant
  // for, or a read on a connector that did not supply that data, asks: an address or a query is enough to carry
  // what was read off. The caller says which basics the guard is for (`readPrivate`, per need in `decide`).
  // `askBasics` is the owner's switch to have even these asked (Settings → Permissions).
  if (choice === null && !state?.askBasics && isBasicAccess(action) && !readPrivate) return {verdict: 'allow', scope};
  return {verdict: 'ask', scope};
}

/** The need the owner already declined in this task, or null. `declined` is the run's [{action, scope}]: only that
 * action on that site or account stays closed; everything else asks or goes as usual. */
export const declinedNeed = (declined, needs) => (Array.isArray(declined) && declined.length
  ? needs.find(n => declined.some(d => d?.action === n.action && (d.scope || '') === scopeOf(n))) || null : null);

/** One action after another, riskiest first: any Deny stops it, otherwise the first one that is not
 * yet Always allow is what the owner is asked about. `needs` is [{action, target, detail}]. */
export function decide(state, bot, needs, guard = {}) {
  let ask = null;
  const rest = [];
  for (const need of needs) {
    // `guard.readPrivate` may be a test of one need: the guard is per page or per connector, not per request.
    const v = verdict(state, bot, need.action, need.target, typeof guard.readPrivate === 'function' ? {...guard, readPrivate: Boolean(guard.readPrivate(need))} : guard);
    if (v.verdict === 'deny') return {verdict: 'deny', need, message: v.message};
    if (v.verdict === 'ask' && !ask) ask = {...need, scope: v.scope};
    else if (v.verdict === 'ask') rest.push({...need, scope: v.scope});
  }
  if (!ask) return {verdict: 'allow'};
  // `asked`: everything one ask must stand for, riskiest first. Always allow on the riskiest ask also
  // covers the rest of what the same request needs on that site.
  return {verdict: 'ask', need: ask, asked: [ask, ...rest], implies: rest.filter(n => n.scope === ask.scope).map(n => ({action: n.action, scope: n.scope}))};
}

/** Create a pending ask. An ask from an unattended run (nobody typed in it) lapses after 24 hours. */
export function createAsk(state, {botId, runId = null, chatKey = null, action, target = '', detail = '', body = '', argsHash = '', unattended = false, requestId = null, implies = [], covers = [], now = iso(), makeId = () => crypto.randomUUID()} = {}) {
  if (!isAskAction(action)) fail(`"${String(action ?? '').slice(0, 60)}" is not something a bot asks about.`);
  if (!botId) fail('An ask needs the bot that is asking.');
  const ask = {
    id: makeId(), botId, runId, chatKey, action,
    target: cleanText(String(target ?? ''), 2000), detail: cleanText(String(detail ?? ''), 4000),
    // The whole text a write would carry (an email body), for the card to show in full; and the fingerprint of the arguments shown.
    ...(typeof body === 'string' && body ? {body: body.slice(0, 20000)} : {}),
    ...(typeof argsHash === 'string' && argsHash ? {argsHash: argsHash.slice(0, 64)} : {}),
    grantScope: scopeOf({action, target}), status: 'pending', scope: null, createdAt: now,
    ...(unattended ? {expiresAt: new Date(Date.parse(now) + ASK_EXPIRY_MS).toISOString()} : {}),
    ...(requestId ? {requestId} : {}),
    ...(implies.length ? {implies} : {}),
    ...(covers.length > 1 ? {covers: covers.map(c => ({action: c.action, scope: c.scope || ''}))} : {}),
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
  if (answer === 'always' && ask.action === 'spend' && !ask.grantScope) fail("This payment has no site to remember. Choose Allow once or Don't allow.");
  if (answer === 'always' && acrossSites(ask)) fail("This ask covers more than one site, and a grant is for one. Choose Allow once or Don't allow.");
  if (ask.status !== 'pending') fail('This ask was already answered.', 409);
  ask.status = answer === 'decline' ? 'declined' : 'allowed';
  ask.scope = answer === 'always' ? 'always' : answer === 'allow' ? 'once' : null;
  ask.answeredAt = now;
  delete ask.expiresAt;
  if (answer === 'always' && botIds(state).has(ask.botId)) {
    // One entry for the answer, in the chat it was asked in; what the same request also covered is not a second event.
    setGrant(state, ask.botId, ask.action, ask.grantScope, 'always', now, {threadId: ask.chatKey});
    for (const extra of ask.implies || []) if (extra.scope === ask.grantScope) setGrant(state, ask.botId, extra.action, extra.scope, 'always', now, {log: false});
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
 * that is not one, a payment set to Always with no site, a per-site grant with no site (a Send, Post or Delete
 * grant stored before those were per site). A connector-wide write Always allow (from before writes
 * were per tool) becomes Ask each time. Idempotent; run on every load and restore. */
export function sweepGrants(state) {
  const ids = botIds(state);
  for (const g of Array.isArray(state.grants) ? state.grants : []) {
    if (g && g.choice === 'always' && /^connector\.[a-z0-9_-]+\.write$/.test(String(g.action))) g.choice = 'ask';
  }
  state.grants = (Array.isArray(state.grants) ? state.grants : []).filter(g => g && typeof g === 'object'
    && ids.has(g.botId) && isAskAction(g.action) && typeof g.scope === 'string'
    && GRANT_CHOICES.includes(g.choice) && !(g.action === 'spend' && g.choice === 'always' && !g.scope)
    && !(PER_ORIGIN.includes(g.action) && !g.scope));
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
