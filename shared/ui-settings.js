/** Settings, the Company chart and Activity. Ported from mock v46.
 *
 * Settings is one page opened from the owner's initials. On a laptop it is a large
 * dialog with the sections on the left; on a phone it is a full page of grouped
 * cards, and each row with a chevron opens its section. The section bodies are
 * built here; Models and keys (and the live-server pages: workspaces, notifications,
 * team, agents, data) load the existing admin forms from ui-admin.js into the body.
 *
 * The lists behind it are pure and tested in ui-profile-model.js. */
import {face} from './ui-face.js';
import {botStatus} from './ui-company.js';
import {primaryOf} from './company.js';
import {esc, icon, btn, empty, note, roundBtn, switchBtn} from './ui-kit.js';
import {store, api, sync, go, back, findBot, isAdmin, isStaticDemo, loadLocal, applyTheme, themeChoice, THEMES} from './ui-store.js';
import {isDesk, initials, pageFrame, HIDDEN_KEY} from './ui-shell.js';
import {ADMIN_PAGES, adminPage} from './ui-admin.js';
import {faceOf, activityBlocks} from './ui-profile.js';
import {
  ACTIVITY_FILTERS, activityUrl, companyTree, permissionRows, weekUsage, settingsSections, resolveSection,
} from './ui-profile-model.js';
import {COLORS} from './ui-face.js';

const el = id => document.getElementById(id);
const ICONS = {general: 'gear', look: 'half', models: 'key', conn: 'plug', perm: 'shield', usage: 'chart', computer: 'monitor'};
const ADMIN_OF = {models: 'ai', notifications: 'notifications', workspaces: 'workspaces', team: 'team', agents: 'agents', data: 'data'};
const ownerName = () => store.state?.me?.name || String(store.state?.me?.email || '').split('@')[0] || 'You';
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const paused = () => Boolean(store.state?.guard?.paused);
const canPause = () => isAdmin() || isStaticDemo();
const hiddenCount = () => { const list = loadLocal(HIDDEN_KEY, []); return Array.isArray(list) ? list.filter(id => findBot(id)).length : 0; };

/** Which admin page (if any) a section loads from the server. */
const adminKeyOf = key => (ADMIN_OF[key] && (key === 'notifications' || key === 'workspaces' || isAdmin()) && !isStaticDemo() ? ADMIN_OF[key] : null);

/* ---------- rows and cards ---------- */

const card = (rows, label = '') => `<section class="st-g">${label ? `<h4 class="st-h">${esc(label)}</h4>` : ''}<div class="cd">${rows}</div></section>`;
const srow = (label, right = '', sub = '') => `<div class="rw"><span class="w">${label}${sub ? `<small>${sub}</small>` : ''}</span>${right}</div>`;
const link = (section, label, sub = '', value = '') => `<button type="button" class="rw" data-action="settings-open" data-section="${section}"><span class="w">${esc(label)}${sub ? `<small>${esc(sub)}</small>` : ''}</span>${value ? `<span class="pv">${esc(value)}</span>` : ''}${icon('chevron', 18)}</button>`;
const goRow = (action, label, sub) => `<button type="button" class="rw" data-action="${action}"><span class="w">${esc(label)}<small>${esc(sub)}</small></span>${icon('chevron', 18)}</button>`;

const pauseRow = () => {
  const on = !paused(), disabled = canPause() ? '' : ' disabled';
  return `<div class="rw"><span class="w">Bots running<small data-pause-sub>${on ? 'Switch off to pause every bot at once' : 'Everything is paused'}</small></span>${switchBtn(on, 'Bots running', ` data-action="settings-pause" data-pause${disabled}`)}</div>`;
};

function account() {
  const demo = isStaticDemo(), me = store.state?.me || {};
  const who = demo ? 'Browser-only demo · data stays in this browser' : `Signed in as ${me.role || 'member'}`;
  const actions = demo ? '' : `<div class="st-acts">${btn('Change password', 'change-password', {small: true})}${btn('Sign out', 'logout', {small: true})}</div>`;
  return `<div class="rw acct"><span class="ini av" aria-hidden="true">${esc(initials())}</span><span class="w">${esc(demo ? 'This browser' : ownerName())}<small>${esc(who)}</small></span></div>${actions}`;
}

/* ---------- the sections ---------- */

function general(sections) {
  const primary = primaryOf(store.state), hidden = hiddenCount();
  const more = sections.filter(s => s.extra).map(s => link(s.key, s.label)).join('');
  return card(account(), 'Account')
    + card(pauseRow() + srow('Primary bot', `<span class="pv">${esc(primary?.name || 'Atlas')}</span>`, 'Routes new threads and adds bots')
      + (hidden ? `<div class="rw"><span class="w">Hidden bots<small>${plural(hidden, 'bot')} out of your list</small></span><button type="button" class="btn small" data-action="show-hidden">Show</button></div>` : ''), 'Bots')
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
  return card(srow('Your own keys', '', isStaticDemo() ? 'The demo answers with built-in replies. Models and keys need the Node server.' : 'Only the owner or an admin can add model keys.'));
}

const conn = () => card(srow('Google', '<span class="pv">Coming in a later phase</span>', 'Gmail, Drive and Calendar') + srow('MCP servers', '<span class="pv">Coming in a later phase</span>', 'GitHub, Notion and more'), 'Connectors');

function perm() {
  const rows = permissionRows(store.state);
  const list = rows.map(r => { const bot = findBot(r.botId); return `<div class="rw">${bot ? faceOf(bot, 28, {state: 'asleep', motion: false}) : ''}<span class="w">${esc(r.label)}<small>${esc(r.botName)}</small></span><span class="pv">Allowed</span></div>`; }).join('');
  return `<p class="st-note">What each bot may do beyond chatting and handing work on. Paying or spending money never gets Always allow. Read-only for now.</p>`
    + card(list || '<div class="rw"><span class="w st-quiet">No bot has an extra permission yet.</span></div>', 'Granted');
}

function usage() {
  const {total, rows} = weekUsage(store.state);
  if (!total) return `<section class="st-g"><h4 class="st-h">This week</h4><div class="cd pad"><p class="st-quiet">No bot has done any work this week.</p></div></section><p class="st-note">Subscription limits show here once a subscription is connected.</p>`;
  const bar = rows.map(r => { const bot = findBot(r.botId), i = Math.max(0, (store.state.groups.find(g => g.id === 'home')?.bots || []).indexOf(bot)); const tint = Number.isInteger(bot?.settings?.tint) ? bot.settings.tint : i; return `<span style="width:${r.pct}%;background:${COLORS[Math.abs(tint) % COLORS.length]}"></span>`; }).join('');
  const who = rows.map(r => { const bot = findBot(r.botId); return `<span>${bot ? faceOf(bot, 20, {state: 'asleep', motion: false}) : ''}${esc(r.name)} <em>${r.pct}%</em></span>`; }).join('');
  return `<section class="st-g"><h4 class="st-h">This week</h4><div class="cd pad"><div class="st-big">${total}<small>bot ${total === 1 ? 'turn' : 'turns'}</small></div>
    <div class="st-stack" role="img" aria-label="${esc(rows.map(r => `${r.name} ${r.pct}%`).join(', '))} of this week's work">${bar}</div><div class="whoused">${who}</div></div></section>
    <p class="st-note">Counted from your runs. Subscription limits show here once a subscription is connected.</p>`;
}

function computer() {
  const demo = isStaticDemo();
  return card(srow('Server', `<span class="pv">${demo ? 'This browser' : 'This server'}</span>`, demo ? 'The demo runs in this page and stops when you close it.' : 'Bots run while it is awake.')
    + srow('Move to the Oracle VM', '<span class="pv">Planned</span>', 'Keeps bots running when the laptop sleeps')
    + srow('Shared browser', '', 'Bots use it only with your permission, and you can take over.')
    + (!demo && isAdmin() ? link('agents', 'Local agents', 'Devices that run work for your bots') : ''), 'Where bots run');
}

function about() {
  const state = store.state, demo = isStaticDemo(), ai = Boolean(state?.aiEnabled), model = state?.aiModel;
  const text = demo ? 'GitHub Pages serves only static files, so bots answer with built-in commands instead of a language model, and everything stays in this browser. Do not type secrets into a chat.'
    : ai ? 'A server-side AI provider is connected. Every bot answers with it. If a call fails, the chat says why.'
      : 'No AI provider is configured. Add one under Settings, Models and keys, or set AI_API_KEY on the server. Bots will say so instead of answering with the demo.';
  const fact = (label, value) => srow(label, `<span class="pv">${value}</span>`);
  return `<p class="st-note">${esc(text)}</p>` + card(fact('Storage', demo ? 'This browser' : 'Node server') + fact('Real AI', demo || !ai ? 'Not connected' : (model ? `Connected · ${esc(model)}` : 'Connected')) + fact('Sync across devices', demo ? 'Not available' : 'Yes, through the server'));
}

function body(key, sections) {
  if (key === 'general') return general(sections);
  if (key === 'look') return look();
  if (key === 'models') return models();
  if (key === 'conn') return conn();
  if (key === 'perm') return perm();
  if (key === 'usage') return usage();
  if (key === 'computer') return computer();
  if (key === 'about') return about();
  return adminKeyOf(key) ? adminHost(key) : general(sections);
}
const titleOf = (key, sections) => sections.find(s => s.key === key)?.label || 'Settings';

/* ---------- the dialog (laptop) and the cards (phone) ---------- */

const CLOSE = roundBtn('x', 'Close settings', 'settings-close');

function dialog(sections, key) {
  const main = sections.filter(s => !s.extra), extra = sections.find(s => s.key === key)?.extra;
  const nav = main.map(s => { const on = s.key === (extra ? 'general' : key); return `<button type="button" class="${on ? 'on' : ''}" data-action="settings-open" data-section="${s.key}"${on ? ' aria-current="page" autofocus' : ''}>${icon(ICONS[s.key], 17)}<span>${esc(s.label)}</span></button>`; }).join('');
  const lead = extra ? `<button type="button" class="rbtn" data-action="settings-open" data-section="general" aria-label="Back to General">${icon('back', 20)}</button>` : '';
  return `<div class="st-wrap"><div class="st-scrim" data-action="settings-close" aria-hidden="true"></div>
    <div class="st-dlg" role="dialog" aria-modal="true" aria-label="Settings">
      <nav class="st-nav" aria-label="Settings sections">${nav}<hr>
        <button type="button" data-action="go-activity">${icon('pulse', 17)}<span>Activity</span></button>
        <button type="button" data-action="go-company">${icon('people', 17)}<span>Company</span></button></nav>
      <div class="st-main"><header class="st-head">${lead}<h2>${esc(titleOf(key, sections))}</h2>${CLOSE}</header><div class="st-body">${body(key, sections)}</div></div>
    </div></div>`;
}

function phoneCards(sections) {
  const {total} = weekUsage(store.state), rules = permissionRows(store.state).length;
  const more = sections.filter(s => s.extra).map(s => link(s.key, s.label)).join('');
  const mode = themeChoice();
  return `<section class="pg st-phone"><header class="pr-bar">${roundBtn('x', 'Close settings', 'settings-close', {cls: 'big'})}</header>
    <div class="pg-body st-cards">
      <div class="cd"><button type="button" class="rw acct" data-action="settings-open" data-section="general"><span class="ini av" aria-hidden="true">${esc(initials())}</span><span class="w">${esc(isStaticDemo() ? 'This browser' : ownerName())}<small>${isStaticDemo() ? 'Browser-only demo' : `Signed in as ${esc(store.state?.me?.role || 'member')}`}</small></span>${icon('chevron', 18)}</button>
        ${link('usage', 'Usage', '', total ? plural(total, 'turn') : '')}${link('models', 'Models and keys', 'Providers, keys and the default model')}</div>
      <div class="cd">${link('conn', 'Connect apps', 'Google, MCP servers')}</div>
      <section><h4 class="st-h">Bots</h4><div class="cd">${pauseRow()}${link('perm', 'Permissions', rules ? `${plural(rules, 'rule')} · paying always asks` : 'None yet · paying always asks')}${link('computer', 'Computer', 'Where your bots run', isStaticDemo() ? 'This browser' : 'This server')}</div></section>
      <section><h4 class="st-h">Go to</h4><div class="cd">${goRow('go-activity', 'Activity', 'What your bots did outside the app')}${goRow('go-company', 'Company', 'Who reports to whom')}</div></section>
      <section><h4 class="st-h">App</h4><div class="cd">${link('look', 'Appearance', mode === 'system' ? 'Follows the system' : mode === 'cream' ? 'Light' : 'Dark')}</div></section>
      ${more ? `<section><h4 class="st-h">More</h4><div class="cd">${more}</div></section>` : ''}
    </div></section>`;
}

function phoneSection(sections, key) {
  return `<section class="pg st-phone"><header class="pr-bar pr-subbar"><button type="button" class="rbtn" data-action="settings-back" aria-label="Back to Settings">${icon('back', 20)}</button><h1>${esc(titleOf(key, sections))}</h1><span class="rbtn ghost" aria-hidden="true"></span></header>
    <div class="pg-body st-cards st-section">${body(key, sections)}</div></section>`;
}

const sectionsNow = () => settingsSections({admin: isAdmin(), demo: isStaticDemo()});
export function settingsView(route) {
  const sections = sectionsNow(), key = resolveSection(route.settings, sections);
  if (adminKeyOf(key)) setTimeout(reloadAdminPage, 0);
  if (isDesk()) return dialog(sections, key);
  return route.settings ? phoneSection(sections, key) : phoneCards(sections);
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
  return pageFrame({title: 'Company', body: `${legend}${list}`, backLabel: 'Back'});
}

/* ---------- Activity ---------- */

const ay = {filter: 'outside', items: [], next: null, seq: 0};
const EMPTY = {outside: 'Nothing has left the app yet.', perm: 'No permission changes yet.', bots: 'No bots were made, moved or paused yet.', all: 'Nothing yet.'};
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
  ay.filter = 'outside'; ay.items = []; ay.next = null;
  setTimeout(() => loadActivity(), 0);
  const chips = ACTIVITY_FILTERS.map(([key, label]) => `<button type="button" role="tab" data-action="activity-filter" data-filter="${key}" aria-selected="${key === ay.filter}">${esc(label)}</button>`).join('');
  return pageFrame({title: 'Activity', body: `<div class="st-seg ay-chips" role="tablist" aria-label="Show">${chips}</div><div id="ay-list" class="pr-stack"><p class="st-quiet">Loading…</p></div>`, backLabel: 'Back'});
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
