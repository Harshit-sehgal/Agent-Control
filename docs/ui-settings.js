/** Settings, the Company chart and Activity. Ported from mock v46.
 *
 * Settings is one page opened from the owner's initials. On a laptop it is a large
 * dialog with the sections on the left; on a phone it is a full page of grouped
 * cards, and each row with a chevron opens its section. The section bodies are
 * built here; Models and keys (and the live-server pages: workspaces, notifications,
 * team, agents, data) load the existing admin forms from ui-admin.js into the body.
 *
 * The lists behind it are pure and tested in ui-profile-model.js. */
import {face} from './ui-face.js?v=e0e04f8691';
import {botStatus} from './ui-company.js?v=e0e04f8691';
import {esc, icon, btn, empty, note, roundBtn, switchBtn, fullDate} from './ui-kit.js?v=e0e04f8691';
import {store, api, sync, go, back, findBot, isAdmin, isStaticDemo, applyTheme, themeChoice, THEMES, saveLocal} from './ui-store.js?v=e0e04f8691';
import {isDesk, initials, setupCardHtml, PERM_SEEN} from './ui-shell.js?v=e0e04f8691';
import {ADMIN_PAGES, adminPage} from './ui-admin.js?v=e0e04f8691';
import {faceOf, headBar, activityBlocks, grantsHtml, grantNote} from './ui-profile.js?v=e0e04f8691';
import {allGrantRows, permissionSummary} from './ui-asks.js?v=e0e04f8691';
import {PRESETS, presetOf, applyPreset} from './presets.js?v=e0e04f8691';
import {toast, confirmSheet} from './ui-dialogs.js?v=e0e04f8691';
import {
  ACTIVITY_FILTERS, activityUrl, companyTree, weekUsage, settingsSections, resolveSection, sectionArg,
} from './ui-profile-model.js?v=e0e04f8691';
import {COLORS} from './ui-face.js?v=e0e04f8691';
import {limitsOf, limitWords, FAIL_STREAK} from './limits.js?v=e0e04f8691';
import {monthByBot, usageWords} from './usage.js?v=e0e04f8691';
import {companyBots} from './company.js?v=e0e04f8691';

const el = id => document.getElementById(id);
const ICONS = {general: 'gear', look: 'half', models: 'key', conn: 'plug', perm: 'shield', usage: 'chart'};
const ADMIN_OF = {models: 'ai', conn: 'connectors', notifications: 'notifications', workspaces: 'workspaces', team: 'team', agents: 'agents', data: 'data'};
const ownerName = () => store.state?.me?.name || String(store.state?.me?.email || '').split('@')[0] || 'You';
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const paused = () => Boolean(store.state?.guard?.paused);
const canPause = () => isAdmin() || isStaticDemo();

/** Which admin page (if any) a section loads from the server. */
const adminKeyOf = key => {
  if (!ADMIN_OF[key]) return null;
  // Models and Connectors also open in the demo, where the page itself says it needs the server (the way the demo treats its one owner).
  if (key === 'models' || key === 'conn') return isAdmin() || isStaticDemo() ? ADMIN_OF[key] : null;
  return (key === 'notifications' || key === 'workspaces' || isAdmin()) && !isStaticDemo() ? ADMIN_OF[key] : null;
};

/* ---------- rows and cards ---------- */

const card = (rows, label = '') => `<section class="st-g">${label ? `<h4 class="st-h">${esc(label)}</h4>` : ''}<div class="cd">${rows}</div></section>`;
const srow = (label, right = '', sub = '') => `<div class="rw"><span class="w">${label}${sub ? `<small>${sub}</small>` : ''}</span>${right}</div>`;
const link = (section, label, sub = '', value = '') => `<button type="button" class="rw" data-action="settings-open" data-section="${section}"><span class="w">${esc(label)}${sub ? `<small>${esc(sub)}</small>` : ''}</span>${value ? `<span class="pv">${esc(value)}</span>` : ''}${icon('chevron', 18)}</button>`;

const pauseRow = () => {
  const on = !paused();
  return switchRow('Bots running', on ? 'Switch off to pause every bot at once' : 'Everything is paused', on, 'settings-pause', 'data-pause', canPause(), ' data-pause-sub');
};

function account() {
  const demo = isStaticDemo(), me = store.state?.me || {};
  const who = demo ? '' : `<small>Signed in as ${esc(me.role || 'member')}</small>`;
  const actions = demo ? '' : `<div class="st-acts">${btn('Change password', 'change-password', {small: true})}${btn('Sign out', 'logout', {small: true})}</div>`;
  const where = demo ? '<small>Your bots and chats are kept in this browser only</small>' : '';
  return `<div class="rw acct"><span class="ini av" aria-hidden="true">${esc(initials())}</span><span class="w">${esc(demo ? 'This browser' : ownerName())}${who}${where}</span></div>${actions}`;
}

/* ---------- your sessions (a live server only) ---------- */

const sessionRows = list => {
  if (!list.length) return '<div class="rw"><span class="w st-quiet">No active sessions.</span></div>';
  const rows = list.map(x => `<div class="rw"><span class="w">${x.current ? 'This device' : 'Another device'}<small>${esc(x.ip || 'unknown ip')} · expires ${esc(fullDate(x.expiresAt))}</small></span>${x.current ? '<span class="pv">Current</span>' : btn('Revoke', 'account-revoke', {kind: 'danger', id: x.id, small: true})}</div>`).join('');
  return rows + (list.length > 1 ? `<button type="button" class="rw" data-action="account-revoke-all"><span class="w">Sign out everywhere<small>Ends every session except this one</small></span></button>` : '');
};
/** Fill (or refill) the sessions card of General. */
async function loadSessions() {
  const box = el('acct-sessions'); if (!box) return;
  try {
    const {sessions = []} = await api('/api/sessions');
    if (el('acct-sessions') === box) box.innerHTML = sessionRows(sessions);
  } catch (error) { if (el('acct-sessions') === box) box.innerHTML = `<div class="rw"><span class="w st-quiet">${esc(error.message || 'Could not load sessions.')}</span></div>`; }
}

/* ---------- the sections ---------- */

function general(sections) {
  const more = sections.filter(s => s.extra).map(s => link(s.key, s.label)).join('');
  const sessions = isStaticDemo() ? '' : `<section class="st-g"><h4 class="st-h">Your sessions</h4><div class="cd" id="acct-sessions"><div class="rw"><span class="w st-quiet">Loading…</span></div></div></section>`;
  // The account is a fact, not a door: it sits flat on the page so it does not read as a row to tap.
  return setupCardHtml() + `<section class="st-g"><h4 class="st-h">Account</h4><div class="acct-flat">${account()}</div></section>` + sessions
    + card(pauseRow(), 'Bots')
    + card(more, 'More')
    + (isStaticDemo() ? '' : card(`<button type="button" class="rw bad" data-action="delete-account"><span class="w">Delete my account</span></button>`));
}

function look() {
  const now = themeChoice();
  const seg = THEMES.map(t => `<button type="button" data-action="settings-theme" data-theme="${t.id}" aria-pressed="${t.id === now}">${esc(t.name)}</button>`).join('');
  return card(srow('Theme', `<span class="st-seg" role="group" aria-label="Colour theme">${seg}</span>`, 'Light by day, dark by night, or pinned'));
}

const adminHost = key => `<div id="admin-panel" class="st-admin" data-page="${ADMIN_OF[key]}">${note('Loading…')}</div>`;
function models() {
  if (adminKeyOf('models')) return adminHost('models');
  return card(srow('Your own keys', '', 'Only the owner or an admin can add model keys.'));
}

const conn = () => (adminKeyOf('conn') ? adminHost('conn') : card(srow('Connectors', '', 'Only the owner or an admin can add Google or an MCP server.')));

/** A row whose switch is the whole row: a tap anywhere on it flips the switch (the switch keeps the keyboard focus). */
const switchRow = (label, sub, on, action, attr, owner, subAttr = '') => `<div class="rw sw-row"${owner ? ` data-action="${action}"` : ''}><span class="w">${esc(label)}<small${subAttr}>${esc(sub)}</small></span>${switchBtn(on, label, ` data-action="${action}" ${attr}${owner ? '' : ' disabled'}`)}</div>`;

/** From a profile: that bot's rules first, then one link to what applies to every bot. With no bot: Pause all at the
 * top, the switches and limits for every bot, then every bot's rules. This is the only place rules are listed and revoked. */
function perm(arg) {
  // Opening this page is the checklist's "review permissions" step (setupChecklist), for this person.
  saveLocal(PERM_SEEN, true);
  const bot = arg ? findBot(arg) : null;
  if (bot) {
    const chip = `<div class="st-chip">${faceOf(bot, 22, {state: 'asleep', motion: false})}<span>Showing <b>${esc(bot.name)}</b></span><button type="button" class="link" data-action="perm-all">Show all</button></div>`;
    const all = card(`<button type="button" class="rw" data-action="perm-all"><span class="w">Limits for all bots<small>Browsing, limits and Pause all apply to every bot</small></span>${icon('chevron', 18)}</button>`);
    return `${chip}<div data-summary="${esc(bot.id)}">${summaryHtml(bot.id)}</div><h4 class="st-h">Rules</h4><div data-grants="${esc(bot.id)}">${grantsHtml(bot.id)}</div>${grantNote('st-note')}${all}`;
  }
  const ask = Boolean(store.state?.askBasics), owner = canPause();
  const basics = card(switchRow('Browse and read without asking', basicsWords(ask), !ask, 'settings-basics', 'data-basics', owner, ' data-basics-sub'));
  return `${card(pauseRow())}<div data-presets>${presetCard()}</div><p class="st-note">Every bot can chat, hand work to its team, make bots and set schedules. Sending, posting, deleting and paying ask you first; you can Always allow a bot per site.</p>${basics}${limitsCard(owner)}<div data-grants="all">${grantsHtml(null)}</div>${grantNote('st-note')}`;
}

/** Presets and Undo are the owner's alone (the routes are owner only); the demo's one person is its owner. */
const isOwner = () => isStaticDemo() || store.state?.me?.role === 'owner';

/** One bot's permissions in plain words (permissionSummary): what it does without asking, what asks, what it may not do. */
function summaryHtml(botId) {
  const sum = permissionSummary(store.state, botId);
  if (!sum) return '';
  const rows = items => items.map(i => srow(esc(i.text), '', i.until ? `Until ${esc(fullDate(i.until))}` : '')).join('');
  const part = (label, items) => (items.length ? card(rows(items), label) : '');
  return part('Does without asking', sum.free) + part('Asks you first', sum.asks) + part('Not allowed', sum.denied)
    + card(sum.limits.map(l => srow(esc(l))).join(''), 'Every run');
}

/** The three safety presets, the one the settings match pressed (none for Custom). */
function presetCard() {
  const now = presetOf(store.state), on = PRESETS.find(p => p.id === now), owner = isOwner();
  const seg = PRESETS.map(p => `<button type="button" data-action="settings-preset" data-preset="${p.id}" aria-pressed="${p.id === now}"${owner ? '' : ' disabled'}>${esc(p.name)}</button>`).join('');
  const sub = on ? on.text : 'Custom: your own mix of the switches and rules below.';
  return card(`<div class="rw st-pre"><span class="w">Safety preset<small>${esc(owner ? sub : `${sub} Only the owner changes the preset.`)}</small></span><span class="st-seg" role="group" aria-label="Safety preset">${seg}</span></div>`);
}

/** Repaint what a preset or its Undo changes, in place. */
function refreshPerm() {
  const ask = Boolean(store.state?.askBasics);
  document.querySelectorAll('[data-presets]').forEach(x => { x.innerHTML = presetCard(); });
  document.querySelectorAll('[data-basics]').forEach(x => x.setAttribute('aria-checked', String(!ask)));
  document.querySelectorAll('[data-basics-sub]').forEach(x => { x.textContent = basicsWords(ask); });
  document.querySelectorAll('[data-grants]').forEach(x => { x.innerHTML = grantsHtml(x.dataset.grants === 'all' ? null : x.dataset.grants); });
  document.querySelectorAll('[data-summary]').forEach(x => { x.innerHTML = summaryHtml(x.dataset.summary); });
}

/** A toast whose Undo puts the permissions back the way `undo` says (POST /api/permissions/restore). */
export function undoToast(message, undo) {
  if (!undo || !isOwner()) { toast(message); return; }
  toast(message, false, {label: 'Undo', run: async () => {
    await api('/api/permissions/restore', 'POST', undo);
    await sync();
    refreshPerm();
    toast('Put back as it was.');
  }});
}

// How far bots go on one message. Empty is no limit: only the safety stop (BACKSTOP) and the stop after repeated
// failures apply. The owner picks a smaller number here when they want one; each row says why they might.
const LIMIT_ROWS = [
  ['pages', 'Pages opened at once', 'Pages or app reads a bot opens side by side. Set one to keep a bot from fanning out across many sites.', [1, 3, 5]],
  ['rounds', 'Look-ups before answering', 'Times in a row a bot reads more before it replies. Set one for quicker, cheaper answers.', [2, 5, 10]],
  ['steps', 'Bot hand-offs per message', 'Bot turns one message can take across a team. Set one to stop bots passing work around for long.', [3, 6, 12]],
];
function limitsCard(owner) {
  const now = limitsOf(store.state);
  const seg = (key, values) => [null, ...values].map(v => `<button type="button" data-action="settings-limit" data-key="${key}" data-value="${v ?? ''}" aria-pressed="${now[key] === v}"${owner ? '' : ' disabled'}>${esc(limitWords(v))}</button>`).join('');
  const rows = LIMIT_ROWS.map(([key, label, sub, values]) => `<div class="rw st-lim">${`<span class="w">${esc(label)}<small>${esc(sub)}</small></span>`}<span class="st-seg" role="group" aria-label="${esc(label)}">${seg(key, values)}</span></div>`).join('');
  const check = switchRow('Check in on long tasks', 'Pause and ask you when bots message each other a lot on one task', now.askCheckpoints, 'settings-limit-check', 'data-limit-check', owner);
  return card(rows + check, 'Limits for all bots') + `<p class="st-note">No limit is the default. A bot that fails ${FAIL_STREAK} times in a row stops and tells you.</p>`;
}

const basicsWords = ask => (ask ? 'Bots ask you before opening a web page or reading a connected app' : "Bots open web pages and read connected apps on their own; a site you set to Ask each time or Don't allow still asks or refuses");

/** Tokens this month by bot, with the cost where the owner set a price on the model (Models and keys). */
function monthCard() {
  const names = new Map(companyBots(store.state).map(b => [b.id, b.name]));
  const {rows, total} = monthByBot(store.state, names);
  if (!rows.length) return '';
  const who = rows.map(r => { const bot = findBot(r.botId); return `<div class="rw"><span class="w">${bot ? faceOf(bot, 20, {state: 'asleep', motion: false}) : ''}${esc(r.name)}<small>${esc(usageWords(r))}</small></span></div>`; }).join('');
  return `<section class="st-g"><h4 class="st-h">This month</h4><div class="cd">${srow('All bots', '', esc(usageWords(total)))}${who}</div></section>
    <p class="st-note">Tokens each bot's model calls used this month. A cost shows only for models you gave a price under Models and keys; a subscription is included in its plan.</p>`;
}

function usage() {
  const {total, rows} = weekUsage(store.state);
  if (!total) return `<section class="st-g"><h4 class="st-h">This week</h4><div class="cd pad"><p class="st-quiet">No bot has done any work this week.</p></div></section>${monthCard()}`;
  const bar = rows.map(r => { const bot = findBot(r.botId), i = Math.max(0, (store.state.groups.find(g => g.id === 'home')?.bots || []).indexOf(bot)); const tint = Number.isInteger(bot?.settings?.tint) ? bot.settings.tint : i; return `<span style="width:${r.pct}%;background:${COLORS[Math.abs(tint) % COLORS.length]}"></span>`; }).join('');
  const who = rows.map(r => { const bot = findBot(r.botId); return `<span>${bot ? faceOf(bot, 20, {state: 'asleep', motion: false}) : ''}${esc(r.name)} <em>${r.pct}%</em></span>`; }).join('');
  return `<section class="st-g"><h4 class="st-h">This week</h4><div class="cd pad"><div class="st-big">${total}<small>bot ${total === 1 ? 'turn' : 'turns'}</small></div>
    <div class="st-stack" role="img" aria-label="${esc(rows.map(r => `${r.name} ${r.pct}%`).join(', '))} of this week's work">${bar}</div><div class="whoused">${who}</div></div></section>
    <p class="st-note">Each bot's turns in the runs of the last seven days.</p>${monthCard()}`;
}

function about() {
  const state = store.state, demo = isStaticDemo(), ai = Boolean(state?.aiEnabled), model = state?.aiModel;
  const text = demo ? 'GitHub Pages serves only static files, so bots answer with built-in commands instead of a language model, and everything stays in this browser. Do not type secrets into a chat.'
    : ai ? 'A server-side AI provider is connected. Every bot answers with it. If a call fails, the chat says why.'
      : 'No AI provider is configured. Add one under Settings, Models and keys, or set AI_API_KEY on the server. Bots will say so instead of answering with the demo.';
  const fact = (label, value) => srow(label, `<span class="pv">${value}</span>`);
  return `<p class="st-note">${esc(text)}</p>` + card(fact('Storage', demo ? 'This browser' : 'Node server') + fact('Real AI', demo || !ai ? 'Not connected' : (model ? `Connected · ${esc(model)}` : 'Connected')) + fact('Sync across devices', demo ? 'Not available' : 'Yes, through the server'));
}

function body(key, sections, arg = '') {
  if (key === 'general') return general(sections);
  if (key === 'look') return look();
  if (key === 'models') return models();
  if (key === 'conn') return conn();
  if (key === 'perm') return perm(arg);
  if (key === 'usage') return usage();
  if (key === 'about') return about();
  return adminKeyOf(key) ? adminHost(key) : general(sections);
}
const titleOf = (key, sections) => sections.find(s => s.key === key)?.label || 'Settings';

/* ---------- the dialog (laptop) and the cards (phone) ---------- */

const CLOSE = roundBtn('x', 'Close settings', 'settings-close');

function dialog(sections, key, arg) {
  const main = sections.filter(s => !s.extra), extra = sections.find(s => s.key === key)?.extra;
  const nav = main.map(s => { const on = s.key === (extra ? 'general' : key); return `<button type="button" class="${on ? 'on' : ''}" data-action="settings-open" data-section="${s.key}"${on ? ' aria-current="page" autofocus' : ''}>${icon(ICONS[s.key], 17)}<span>${esc(s.label)}</span></button>`; }).join('');
  const lead = extra ? `<button type="button" class="rbtn" data-action="settings-open" data-section="general" aria-label="Back to General">${icon('back', 20)}</button>` : '';
  return `<div class="st-wrap"><div class="st-scrim" data-action="settings-close" aria-hidden="true"></div>
    <div class="st-dlg" role="dialog" aria-modal="true" aria-label="Settings">
      <nav class="st-nav" aria-label="Settings sections">${nav}<hr>
        <button type="button" data-action="go-activity">${icon('pulse', 17)}<span>Activity</span></button>
        <button type="button" data-action="go-company">${icon('people', 17)}<span>Company</span></button></nav>
      <div class="st-main"><header class="st-head">${lead}<h2>${esc(titleOf(key, sections))}</h2>${CLOSE}</header><div class="st-body">${body(key, sections, arg)}</div></div>
    </div></div>`;
}

/** The phone's Settings is the list of sections and nothing else: each shows its one value, and the account, the
 * pause switch and the rest of the pages (Team, Notifications, About...) are behind General. */
function phoneCards(sections) {
  const {total} = weekUsage(store.state), rules = allGrantRows(store.state).length, mode = themeChoice();
  const sub = {general: 'Account, pause, more', models: 'Providers, keys and the default model', conn: 'Google, MCP servers'};
  const value = {usage: total ? plural(total, 'turn') : '', perm: rules ? plural(rules, 'rule') : '', look: mode === 'system' ? 'System' : mode === 'cream' ? 'Light' : 'Dark'};
  const row = s => `<button type="button" class="rw" data-action="settings-open" data-section="${s.key}"><span class="rw-i">${icon(ICONS[s.key], 22)}</span><span class="w">${esc(s.label)}${sub[s.key] ? `<small>${esc(sub[s.key])}</small>` : ''}</span>${value[s.key] ? `<span class="pv">${esc(value[s.key])}</span>` : ''}${icon('chevron', 18)}</button>`;
  const jump = (action, name, glyph) => `<button type="button" class="rw" data-action="${action}"><span class="rw-i">${icon(glyph, 22)}</span><span class="w">${name}</span>${icon('chevron', 18)}</button>`;
  return `<section class="pg pr st-phone">${headBar('Settings', roundBtn('x', 'Close settings', 'settings-close'))}
    <div class="pg-body pr-body st-cards">
      <div class="cd">${sections.filter(s => !s.extra).map(row).join('')}</div>
      <div class="cd">${jump('go-activity', 'Activity', 'pulse')}${jump('go-company', 'Company', 'people')}</div>
    </div></section>`;
}

function phoneSection(sections, key, arg) {
  return `<section class="pg pr st-phone">${headBar(titleOf(key, sections), `<button type="button" class="rbtn" data-action="settings-back" aria-label="Back to Settings">${icon('back', 20)}</button>`)}
    <div class="pg-body pr-body st-cards st-section">${body(key, sections, arg)}</div></section>`;
}

const sectionsNow = () => settingsSections({admin: isAdmin(), demo: isStaticDemo()});
export function settingsView(route) {
  const sections = sectionsNow(), key = resolveSection(route.settings, sections), arg = sectionArg(route.settings);
  if (adminKeyOf(key)) setTimeout(reloadAdminPage, 0);
  if (key === 'general' && !isStaticDemo()) setTimeout(loadSessions, 0);
  if (isDesk()) return dialog(sections, key, arg);
  return route.settings ? phoneSection(sections, key, arg) : phoneCards(sections);
}

/* ---------- the admin pages inside Settings ---------- */

/** Text typed into a form but not submitted, kept across a repaint of the panel: a
 * reload after one click must not throw away a half-typed key on another row. */
const typedKey = f => `${f.form?.id || ''}|${f.name || ''}`;
const typedFields = root => [...root.querySelectorAll('form input, form textarea')].filter(f => !['checkbox', 'radio', 'hidden', 'file', 'submit', 'button'].includes(f.type) && !f.readOnly);
function unsavedText(root) {
  const saved = new Map();
  for (const f of typedFields(root)) if (f.value !== f.defaultValue) saved.set(typedKey(f), f.value);
  return saved;
}
function restoreText(root, saved) {
  if (!saved.size) return;
  for (const f of typedFields(root)) { const value = saved.get(typedKey(f)); if (value !== undefined) f.value = value; }
}
/** Load (or reload) the admin page the open section shows into #admin-panel. */
export async function reloadAdminPage() {
  const panel = el('admin-panel'), key = panel?.dataset.page; if (!panel || !ADMIN_PAGES[key]) return;
  try {
    const html = await adminPage(key);
    const target = el('admin-panel');
    if (!target || target.dataset.page !== key) return;
    const typed = unsavedText(target);
    target.innerHTML = html;
    restoreText(target, typed);
  } catch (error) { el('admin-panel')?.replaceChildren(Object.assign(document.createElement('div'), {innerHTML: empty('Could not load this page', error.message || 'Unknown error')})); }
}

/* ---------- Company ---------- */

/** Company and Activity sit in the same frame as a bot's pages: a centred title under a round back button. */
const page = (title, inner) => `<section class="pg pr">${headBar(title, roundBtn('back', 'Back', 'back-to-list', {}))}<div class="pg-body pr-body">${inner}</div></section>`;

const STATUS_WORD = {working: 'working', waiting: 'waiting'};
function treeNode(n, counter) {
  const bot = findBot(n.id), status = botStatus(store.state, n.id), i = counter.n++;
  if (!bot) return '';
  const word = STATUS_WORD[status] ? `<span class="pill ${status}">${status}</span>` : '';
  const kids = n.children.length ? `<ul>${n.children.map(c => treeNode(c, counter)).join('')}</ul>` : '';
  return `<li style="--i:${i}"><div class="co-row"><button type="button" class="co-node" data-action="open-profile" data-id="${esc(n.id)}">${faceOf(bot, 40)}<span class="w"><b>${esc(n.name)}</b><small>${esc(n.role === 'Bot' ? n.job : n.role)}</small></span>${word}</button><button type="button" class="rbtn small" data-action="bot-menu" data-id="${esc(n.id)}" aria-haspopup="menu" aria-label="Options for ${esc(n.name)}">${icon('dots', 18)}</button></div>${kids}</li>`;
}
export function companyView() {
  const tree = companyTree(store.state);
  const sample = (name, settings, opts) => face({name, settings}, {size: 20, state: 'awake', motion: false, ...opts});
  const legend = `<div class="co-legend"><span>${sample('P', {lead: true}, {primary: true})}Primary</span><span>${sample('M', {}, {manager: true})}Manager</span><span>${sample('B', {})}Bot</span></div>`;
  const list = tree ? `<ul class="co-tree">${treeNode(tree, {n: 0})}</ul>` : '<p class="st-quiet">No bots yet.</p>';
  return page('Company', `${legend}${list}`);
}

/* ---------- Activity ---------- */

const ay = {filter: 'all', items: [], next: null, seq: 0};
const EMPTY = {outside: 'Nothing has been sent outside yet.', perm: 'No permission changes yet.', bots: 'No bots were made, moved or paused yet.', all: 'Nothing yet.'};
const activityBody = () => (ay.items.length ? `${activityBlocks(ay.items)}${ay.next ? '<button type="button" class="link ay-more" data-action="activity-more">Show more</button>' : ''}` : `<p class="st-quiet">${EMPTY[ay.filter]}</p>`);
/** Fetch a page of the log (the first one for this chip, or the next older one) and repaint the list. */
async function loadActivity(more = false) {
  const seq = ++ay.seq;
  try {
    const page = await api(activityUrl({filter: ay.filter, limit: 50, before: more ? ay.next : null}));
    if (seq !== ay.seq) return;
    ay.items = more ? [...ay.items, ...page.items] : page.items; ay.next = page.next;
  } catch (error) { if (seq !== ay.seq) return; ay.items = []; ay.next = null; const list = el('ay-list'); if (list) list.innerHTML = `<p class="st-quiet">${esc(error.message || 'Could not load activity.')}</p>`; return; }
  const list = el('ay-list'); if (list) list.innerHTML = activityBody();
}
export function activityView() {
  ay.filter = 'all'; ay.items = []; ay.next = null;
  setTimeout(() => loadActivity(), 0);
  const chips = ACTIVITY_FILTERS.map(([key, label]) => `<button type="button" role="tab" data-action="activity-filter" data-filter="${key}" aria-selected="${key === ay.filter}">${esc(label)}</button>`).join('');
  return page('Activity', `<div class="st-seg ay-chips" role="tablist" aria-label="Show">${chips}</div><div id="ay-list" class="pr-stack"><p class="st-quiet">Loading…</p></div>`);
}

/* ---------- what the buttons do ---------- */

export const settingsActions = {
  'settings-open': b => {
    const key = b.dataset.section;
    // Beside the sections (laptop) the dialog just changes its body; on a phone a section is a page of its own.
    if (isDesk()) go({settings: key}, {replace: true}); else go({settings: key});
  },
  'settings-back': () => back({settings: ''}),
  'settings-close': () => back({home: true}),
  'settings-theme': b => {
    applyTheme(b.dataset.theme);
    document.querySelectorAll('[data-action="settings-theme"]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
  },
  'settings-pause': async b => {
    if (!canPause()) throw new Error('Only the owner can pause the bots.');
    const next = !paused();
    await api('/api/guard', 'POST', {paused: next});
    await sync();
    document.querySelectorAll('[data-pause]').forEach(x => x.setAttribute('aria-checked', String(!paused())));
    document.querySelectorAll('[data-pause-sub]').forEach(x => { x.textContent = paused() ? 'Everything is paused' : 'Switch off to pause every bot at once'; });
  },
  'settings-basics': async () => {
    if (!canPause()) throw new Error('Only the owner can change this.');
    await api('/api/permissions/basics', 'POST', {ask: !store.state?.askBasics});
    await sync();
    const ask = Boolean(store.state?.askBasics);
    document.querySelectorAll('[data-basics]').forEach(x => x.setAttribute('aria-checked', String(!ask)));
    document.querySelectorAll('[data-basics-sub]').forEach(x => { x.textContent = basicsWords(ask); });
    document.querySelectorAll('[data-presets]').forEach(x => { x.innerHTML = presetCard(); });
  },
  'settings-limit': async b => {
    if (!canPause()) throw new Error('Only the owner can change this.');
    const key = b.dataset.key, value = b.dataset.value === '' ? null : Number(b.dataset.value);
    await api('/api/limits', 'POST', {[key]: value});
    await sync();
    document.querySelectorAll(`[data-action="settings-limit"][data-key="${key}"]`).forEach(x => x.setAttribute('aria-pressed', String(x === b)));
  },
  'settings-limit-check': async () => {
    if (!canPause()) throw new Error('Only the owner can change this.');
    await api('/api/limits', 'POST', {askCheckpoints: !limitsOf(store.state).askCheckpoints});
    await sync();
    const on = limitsOf(store.state).askCheckpoints;
    document.querySelectorAll('[data-limit-check]').forEach(x => x.setAttribute('aria-checked', String(on)));
  },
  // A safety preset: the confirm lists what changes (applyPreset on a copy), then the owner's route applies it.
  'settings-preset': async b => {
    if (!isOwner()) throw new Error('Only the owner can change the preset.');
    const preset = PRESETS.find(p => p.id === b.dataset.preset);
    const {changes} = applyPreset(structuredClone(store.state), preset.id);
    if (!changes.length) { toast(`${preset.name} is already on.`); return; }
    if (!await confirmSheet(`Switch to ${preset.name}?`, {confirm: `Use ${preset.name}`, detail: changes.join(' ')})) return;
    const out = await api('/api/permissions/preset', 'POST', {preset: preset.id});
    await sync();
    refreshPerm();
    undoToast(`${preset.name} is on.`, out?.undo);
  },
  // The filter chip on Permissions: back to every bot's rules, in place of the filtered page.
  'perm-all': () => go({settings: 'perm'}, {replace: true}),
  'account-revoke': async b => {
    await api(`/api/sessions/${encodeURIComponent(b.dataset.id)}`, 'DELETE', {});
    toast('Session revoked.');
    await loadSessions();
  },
  'account-revoke-all': async () => {
    if (!await confirmSheet('Sign out every other session?', {confirm: 'Sign out', danger: true})) return;
    await api('/api/sessions/revoke-all', 'POST', {});
    toast('Other sessions signed out.');
    await loadSessions();
  },
  'go-activity': () => go({activity: true}),
  'go-company': () => go({company: true}),
  'activity-filter': b => {
    ay.filter = b.dataset.filter;
    document.querySelectorAll('[data-action="activity-filter"]').forEach(x => x.setAttribute('aria-selected', String(x === b)));
    return loadActivity();
  },
  'activity-more': () => loadActivity(true),
};
export const settingsViews = {settings: settingsView, company: companyView, activity: activityView};
