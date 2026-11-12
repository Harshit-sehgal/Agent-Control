/** A bot's profile (a hero, a card of rows, one page behind each row), the Edit page,
 * the New bot page and the bot options menu that opens from ⋯ (and, in Task 11, from
 * a right-click or long press). Ported from mock v46. The view models are pure and
 * tested in ui-profile-model.js; this file is markup, events and the API calls.
 *
 * Pages repaint only when the route changes, so each in-place change (a switch, a
 * forgotten note, a picked colour) updates its own node instead. */
import {SHAPES, COLORS, face} from './ui-face.js?v=d6e4136826';
import {botStatus, botIsManager} from './ui-company.js?v=d6e4136826';
import {primaryOf} from './company.js?v=d6e4136826';
import {esc, icon, field, textInput, clock, roundBtn, groupedModelSelect, effortPicker, COLOR_NAMES, fullDate} from './ui-kit.js?v=d6e4136826';
import {botModelChoices, pickedModel, effortChoices} from './ui-connect-model.js?v=d6e4136826';
import {scheduleRows, scheduleTaskBody, SCHEDULE_OFTEN, scheduleChoice} from './schedules.js?v=d6e4136826';
import {store, api, sync, go, back, changed, onChange, findBot, groupOfBot, canWrite, isAdmin, isStaticDemo, loadLocal, saveLocal} from './ui-store.js?v=d6e4136826';
import {GRANT_LABELS} from './asks.js?v=d6e4136826';
import {grantRows, allGrantRows, grantUrl} from './ui-asks.js?v=d6e4136826';
import {PINS_KEY, HIDDEN_KEY, ORDER_KEY} from './ui-shell.js?v=d6e4136826';
import {toast, confirmSheet, openSheet, closeSheet} from './ui-dialogs.js?v=d6e4136826';
import {sendChat} from './ui-chat.js?v=d6e4136826';
import {computerPage as computerView, computerLabel, keysOwned, thumbSlot} from './ui-computer-view.js?v=d6e4136826';
import {
  MAX_NAME, MAX_JOB, hasJob, roleLine, teamLine, managerOptions, menuItems, deleteCopy, profileRows, profileBackRoute, memoryNotes, lookOf, newBotDefaults,
  newBotPayload, canCreate, editChanges, activityUrl, activityTarget, activityDays, closeTarget,
} from './ui-profile-model.js?v=d6e4136826';

const el = id => document.getElementById(id);
const SHAPE_LABELS = {rounded: 'Rounded square', circle: 'Circle', hexagon: 'Hexagon', pebble: 'Pebble', drop: 'Drop', shield: 'Shield', arch: 'Arch', egg: 'Egg', blob: 'Blob', bean: 'Bean'};

/* ---------- small helpers ---------- */

const roster = () => (store.state?.groups || []).find(g => g.id === 'home')?.bots || [];
/** A bot's face. Resting bots look awake on their own profile; only work or a wait changes that. */
export function faceOf(bot, size, {state, hop = false, motion = true} = {}) {
  const live = botStatus(store.state, bot.id);
  return face(bot, {size, state: state ?? (live === 'asleep' ? 'awake' : live), primary: bot.settings?.lead === true, manager: botIsManager(store.state, bot.id), index: Math.max(0, roster().indexOf(bot)), hop, motion});
}
const svg = (inner, size = 22) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
/** Pages sit in the stage with the same fade a route change gets: bump `v` so the same route paints again. */
export const repaint = () => go({...store.route, v: (store.route.v || 0) + 1}, {replace: true});

const savedList = (key, fallback = []) => { const v = loadLocal(key, null); return Array.isArray(v) ? v : fallback; };
/** Pins as the list sees them: the saved ones, else Atlas (pinned by default for everyone). */
function currentPins() {
  const saved = loadLocal(PINS_KEY, null), primary = primaryOf(store.state);
  return Array.isArray(saved) ? saved : primary ? [primary.id] : [];
}
export const isPinned = id => currentPins().includes(id);
export function togglePin(id) {
  const pins = currentPins(), on = pins.includes(id);
  saveLocal(PINS_KEY, on ? pins.filter(x => x !== id) : [...pins, id]);
  changed();
  return !on;
}
/** Forget a bot that is gone from the per-person lists. */
function forget(id) {
  for (const key of [PINS_KEY, HIDDEN_KEY, ORDER_KEY]) { const list = loadLocal(key, null); if (Array.isArray(list) && list.includes(id)) saveLocal(key, list.filter(x => x !== id)); }
}

/** Where a profile was opened from: Back goes to that thread, else to the bot's chat. */
let prevRoute = store.route, fromThread = null;
onChange(scope => {
  if (scope !== 'route') return;
  const route = store.route;
  if (route.profile) { if (!prevRoute.profile) fromThread = prevRoute.thread || null; } else fromThread = null;
  prevRoute = route;
  closeBotMenu();
});

/* ---------- the options menu ---------- */

let menu = null;
const phoneMenu = () => matchMedia('(max-width:640px), (pointer:coarse)').matches;
export function closeBotMenu({restore = true} = {}) {
  if (!menu) return;
  const {node, scrim, opener} = menu; menu = null;
  node.remove(); scrim?.remove();
  if (restore && opener && document.contains(opener)) opener.focus({preventScroll: true});
}
export const botMenuOpen = () => Boolean(menu);

const menuButton = (action, id, label, extra = '', cls = '') => `<button type="button" role="menuitem" class="${cls}" data-action="${action}" data-id="${esc(id)}"${extra}>${label}</button>`;
/** Open the options menu for a bot. `x`/`y` place it at a pointer (a right-click);
 * otherwise it hangs from `opener`. A phone gets a sheet from the bottom. */
export function openBotMenu(botId, {opener = null, x = null, y = null, touch = null} = {}) {
  closeBotMenu({restore: false});
  const bot = findBot(botId); if (!bot) return;
  const items = menuItems(store.state, botId, {pinned: isPinned(botId)}), sheet = touch ?? phoneMenu();
  const body = items.map(item => {
    if (item.id === 'move') {
      const kids = item.targets.map(t => `<button type="button" role="menuitem" data-action="menu-move-to" data-id="${esc(botId)}" data-to="${esc(t.id ?? '')}">${t.id ? faceOf(findBot(t.id) || {id: t.id, name: t.label, settings: {}}, 20, {state: 'asleep', motion: false}) : ''}<span>${esc(t.label)}</span></button>`).join('');
      return `<button type="button" role="menuitem" aria-expanded="false" data-action="menu-move" data-id="${esc(botId)}">${esc(item.label)}</button><div class="mn-move" hidden>${kids}</div>`;
    }
    const act = {message: 'menu-message', pin: 'menu-pin', hide: 'menu-hide', delete: 'menu-delete'}[item.id];
    return `${item.id === 'hide' ? '<hr>' : ''}${menuButton(act, botId, esc(item.label), '', item.danger ? 'danger' : '')}`;
  }).join('');
  const node = document.createElement('div');
  node.id = 'cmenu'; node.className = `mn${sheet ? ' sheet' : ''}`; node.setAttribute('role', 'menu'); node.setAttribute('aria-label', `Options for ${bot.name}`);
  node.innerHTML = `<div class="mn-h">${faceOf(bot, 32, {state: 'awake', motion: false})}<span><b>${esc(bot.name)}</b><small>${esc(teamLine(store.state, botId))}</small></span></div>${body}`;
  const scrim = sheet ? Object.assign(document.createElement('div'), {className: 'mn-scrim'}) : null;
  if (scrim) { scrim.addEventListener('click', () => closeBotMenu()); document.body.append(scrim); }
  document.body.append(node);
  if (!sheet) {
    const at = opener?.getBoundingClientRect(), w = node.offsetWidth, h = node.offsetHeight;
    const px = x ?? (at ? at.right - w : 8), py = y ?? (at ? at.bottom + 6 : 8);
    node.style.left = `${Math.max(8, Math.min(px, innerWidth - w - 8))}px`; node.style.top = `${Math.max(8, Math.min(py, innerHeight - h - 8))}px`;
  }
  menu = {node, scrim, opener: opener || document.activeElement};
  node.querySelector('button')?.focus({preventScroll: true});
}

/* ---------- the profile ---------- */

const MORE = svg('<circle cx="5.5" cy="12" r="1.4" fill="currentColor"/><circle cx="12" cy="12" r="1.4" fill="currentColor"/><circle cx="18.5" cy="12" r="1.4" fill="currentColor"/>', 20);
const ROW_ICONS = {memory: 'note', activity: 'pulse', permissions: 'shield', model: 'chip', computer: 'monitor', team: 'people'};
const SUB_TITLES = {memory: 'Memory', activity: 'Activity', schedule: 'Schedule', model: 'Model', computer: 'Computer', edit: 'Edit'};

const bar = (left, right = '') => `<header class="pr-bar">${left}<span class="pr-grow"></span>${right}</header>`;
/** The header every inner page shares: a round back button, a centred title. */
export const headBar = (title, back) => `<header class="pr-bar pr-subbar">${back}<h1>${esc(title)}</h1><span class="rbtn ghost" aria-hidden="true"></span></header>`;
const subBar = (bot, title) => headBar(title, roundBtn('back', `Back to ${bot.name}`, 'profile-up', {id: bot.id}));

function hero(bot) {
  const state = store.state, job = hasJob(bot) ? esc(roleLine(bot)) : `No job yet. Tell ${esc(bot.name)} what to do in its chat.`;
  const view = hasJob(bot) ? `<button type="button" class="link pr-view" data-action="profile-instructions" data-id="${esc(bot.id)}">View instructions</button>` : '';
  return `<div class="pr-hero">
    <button type="button" class="pr-face" data-action="hop" aria-label="Say hi to ${esc(bot.name)}">${faceOf(bot, 84, {hop: false})}</button>
    <h1>${esc(bot.name)}</h1><small>${esc(teamLine(state, bot.id))}</small><p class="pr-role" data-role="${esc(bot.id)}">${job}</p>${view}
    ${canWrite() ? `<button type="button" class="pill-btn" data-action="profile-sub" data-id="${esc(bot.id)}" data-sub="edit">Edit</button>` : ''}
  </div>`;
}

/** Permissions and Team have no page here: their one home is Settings > Permissions (filtered to this bot) and the Company chart. */
const ROW_ACTION = {permissions: 'profile-perm', team: 'go-company'};
function profileMain(bot) {
  // The log is not in the snapshot, so the Activity count is filled in after the page paints.
  const value = r => (r.key === 'activity' ? `<span class="pv" data-activity-count="${esc(bot.id)}"></span>`
    : r.key === 'computer' ? `<span class="pv" data-computer-row="${esc(bot.id)}">${esc(computerLabel(bot.id))}</span>`
      : r.value ? `<span class="pv">${esc(r.value)}</span>` : '');
  const rows = profileRows(store.state, bot.id, {canPickModel: !isStaticDemo() && canWrite()}).map(r => {
    const inner = `<span class="rw-i">${icon(ROW_ICONS[r.key], 22)}</span><span class="w">${esc(r.label)}</span>${value(r)}`;
    return r.plain ? `<div class="rw">${inner}</div>`
      : `<button type="button" class="rw" data-action="${ROW_ACTION[r.key] || 'profile-sub'}" data-id="${esc(bot.id)}" data-sub="${r.key}">${inner}${icon('chevron', 18)}</button>`;
  }).join('');
  return `${bar(roundBtn('back', `Back to ${bot.name}'s chat`, 'profile-back', {id: bot.id}), `<button type="button" class="rbtn" data-action="bot-menu" data-id="${esc(bot.id)}" aria-haspopup="menu" aria-label="More for ${esc(bot.name)}">${MORE}</button>`)}
    <div class="pg-body pr-body">
      ${hero(bot)}
      ${thumbSlot(bot.id)}
      <div class="cd">${rows}</div>
    </div>`;
}

/* ----- the pages behind the rows ----- */

function memoryList(bot) {
  const notes = memoryNotes(store.state, bot.id), write = canWrite();
  if (!notes.length) return `<p class="pr-note">Nothing yet. Tell ${esc(bot.name)} to remember something, or add a note below.</p>`;
  return `<div class="cd">${notes.map(n => `<div class="rw memo"><span class="w">${esc(n.text)}</span>${write ? `<button type="button" class="memo-x" data-action="memory-forget" data-id="${esc(bot.id)}" data-rule="${esc(n.id)}" aria-label="Forget this note">Forget</button>` : ''}</div>`).join('')}</div>`;
}
/** A bot's timers: each one says what and when, with Stop; below, one line to add another. The bot sets these
 * from chat too ("every morning at 8, sum up my inbox"), so the form is the fallback, not the way in. */
function scheduleList(bot) {
  const rows = scheduleRows(store.state, bot.id), write = canWrite();
  if (!rows.length) return `<p class="pr-note">Nothing on a timer. Tell ${esc(bot.name)} something like “every morning at 8, sum up my inbox”, or add one below.</p>`;
  const next = at => { const d = new Date(at); return Number.isNaN(d.getTime()) ? '' : ` · next ${d.toLocaleString([], {weekday: 'short', hour: '2-digit', minute: '2-digit'})}`; };
  return `<div class="cd">${rows.map(r => `<div class="rw memo"><span class="w">${esc(r.what)}<small>${esc(r.when)}${esc(next(r.nextAt))}</small>${r.lastError ? `<small class="sc-err">Last try failed: ${esc(r.lastError)}</small>` : ''}</span>${write ? `<button type="button" class="memo-x" data-action="schedule-stop" data-id="${esc(bot.id)}" data-task="${esc(r.id)}" aria-label="Stop this schedule">Stop</button>` : ''}</div>`).join('')}</div>`;
}
function schedulePage(bot) {
  const write = canWrite();
  const often = `<select class="input" name="every" aria-label="How often">${SCHEDULE_OFTEN.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>`;
  return `<p class="pr-note">${esc(bot.name)} runs each one in its own chat, and the answer waits for you there.</p>
    <div id="pr-schedule">${scheduleList(bot)}</div>
    ${write ? `<form id="schedule-form" class="pr-form" data-bot="${esc(bot.id)}" autocomplete="off">${field('What to do', `<input class="input" name="message" minlength="3" maxlength="2000" placeholder="Sum up my unread email in five lines" required>`)}<div class="sc-when">${field('How often', often)}${field('At', '<input class="input" name="at" type="time" value="08:00">')}</div><button type="submit" class="btn primary wide">Add to schedule</button></form>` : ''}`;
}
function memoryPage(bot) {
  const write = canWrite();
  return `<p class="pr-note">Private to ${esc(bot.name)}. It reads these when they help.</p>
    <div id="pr-memory">${memoryList(bot)}</div>
    ${write ? `<form id="memory-form" class="pr-add" data-bot="${esc(bot.id)}" autocomplete="off"><input class="input" name="text" minlength="4" maxlength="240" placeholder="Tell ${esc(bot.name)} something to remember" aria-label="New memory" required><button type="submit" class="btn primary">Add</button></form>` : ''}`;
}

/** One activity entry: the bot's face (a dot when it is gone), one sentence, the time; tapping opens its thread. */
export function activityRowHtml(entry) {
  const bot = entry.botId ? findBot(entry.botId) : null, to = activityTarget(entry);
  const lead = bot ? faceOf(bot, 28, {state: 'asleep', motion: false}) : `<span class="ay-dot">${icon('pulse', 14)}</span>`;
  const inner = `${lead}<span class="w">${esc(entry.text)}</span><time>${esc(clock(entry.at))}</time>`;
  if (!to) return `<div class="rw ay-row">${inner}</div>`;
  return `<button type="button" class="rw ay-row" data-action="${to.thread ? 'open-thread' : 'open-bot'}" data-id="${esc(to.thread || to.bot)}">${inner}</button>`;
}
/** Entries under Today, Yesterday and dates, each day one card. */
export const activityBlocks = items => activityDays(items).map(d => `<div class="ay-day">${esc(d.label)}</div><div class="cd">${d.rows.map(activityRowHtml).join('')}</div>`).join('');

let showAll = null;
const SHOWN = 5;
async function loadBotActivity(botId) {
  const node = el('pr-activity'); if (!node) return;
  const open = showAll === botId;
  try {
    const page = await api(activityUrl({filter: 'all', botId, limit: open ? 200 : SHOWN}));
    if (!node.isConnected) return;
    node.innerHTML = !page.items.length ? '<p class="pr-note">Nothing yet.</p>'
      : `${activityBlocks(page.items)}${page.total > SHOWN ? `<button type="button" class="link" data-action="profile-activity-all" data-id="${esc(botId)}">${open ? 'Show less' : `Show all ${page.total}`}</button>` : ''}`;
  } catch (error) { if (node.isConnected) node.innerHTML = `<p class="pr-note">${esc(error.message || 'Could not load activity.')}</p>`; }
}
async function fillActivityCount(botId) {
  try {
    const page = await api(activityUrl({filter: 'all', botId, limit: 1}));
    const node = document.querySelector('[data-activity-count]');
    if (node && node.dataset.activityCount === botId && page.total) node.textContent = String(page.total);
  } catch { /* The count is a nicety; the page works without it. */ }
}
const activityPage = bot => { setTimeout(() => loadBotActivity(bot.id), 0); return '<div id="pr-activity" class="pr-stack"><p class="pr-note">Loading…</p></div>'; };

/* ----- permissions: what each bot may do, and the answers you gave ----- */

/** Only an admin (or the one person of the demo) changes a rule. */
const canGrant = () => isAdmin() || isStaticDemo();
function grantRow(r) {
  const off = canGrant() ? '' : ' disabled';
  const seg = `<div class="gr-seg" role="group" aria-label="${esc(`${r.label} for ${r.botName}`)}">${r.choices.map(c => `<button type="button" data-action="set-grant" data-id="${esc(r.botId)}" data-text="${esc(`${r.action} ${r.scope}`)}" data-act="${esc(r.action)}" data-scope="${esc(r.scope)}" data-choice="${c.id}" aria-pressed="${c.on}"${off}>${esc(c.label)}</button>`).join('')}</div>`;
  // An Always allow with an end says when it ends; after that the row is gone and the bot asks again.
  return `<div class="gr"><div class="gr-top"><span class="w">${esc(r.label)}${r.until ? `<small>Until ${esc(fullDate(r.until))}</small>` : ''}</span></div>${seg}</div>`;
}
/** One bot's rules as a card, or every bot's in a card each. Lives in Settings > Permissions only. The node is repainted in place when a choice is made. */
export function grantsHtml(botId = null) {
  if (botId) {
    const rows = grantRows(store.state, botId), name = findBot(botId)?.name || 'This bot';
    return rows.length ? `<div class="cd">${rows.map(grantRow).join('')}</div>`
      : `<p class="st-note">No rules for ${esc(name)} yet. One appears here when you pick Always allow on its ask, or set one with Ask each time or Don't allow.</p>`;
  }
  const rows = allGrantRows(store.state);
  if (!rows.length) return '<div class="cd"><div class="rw"><span class="w st-quiet">No rules yet. One appears here when you pick Always allow on a bot\'s ask.</span></div></div>';
  const by = new Map();
  for (const r of rows) by.set(r.botId, [...(by.get(r.botId) || []), r]);
  return [...by].map(([id, list]) => `<section class="st-g"><h4 class="st-h">${esc(list[0].botName)}</h4><div class="cd">${list.map(grantRow).join('')}</div></section>`).join('');
}
/** The note under the list of rules (shown once, in Settings). */
export const grantNote = (cls = 'st-note') => `<p class="${cls}">${canGrant() ? 'Payments ask every time unless you set Always allow for a site.' : 'Only the owner or an admin can change these.'}</p>`;

/** A bot's Model page: one list of every model it can run on (grouped by provider, the workspace default
 * first, "Another … model…" to type any id) and how hard it thinks. One Save. */
function modelPage(bot) {
  const ai = store.state?.ai || {}, own = ai.bots?.[bot.id] || {}, providers = ai.providers || [];
  const picker = !isStaticDemo() && canWrite() && (providers.length || store.state?.aiEnabled)
    ? `<form id="bot-model-form" class="pr-form" data-bot="${esc(bot.id)}" autocomplete="off">${field('Model', groupedModelSelect(botModelChoices(ai, own)), 'Pick from any connected provider, or Another… to type a model id.')}${effortPicker(effortChoices(own.effort || ''))}<button type="submit" class="btn primary wide">Save</button></form>` : '';
  if (picker) setTimeout(loadBotModels, 0);
  return picker || '<p class="pr-note">Add a model provider under Settings, then pick one here.</p>';
}
/** A key provider whose list is empty reads it by itself (an admin only: the route needs one), then the dropdown
 * fills in. No button to press. */
async function loadBotModels() {
  const empty = (store.state?.ai?.providers || []).filter(p => p.kind !== 'local-cli' && !p.chatModels?.length);
  if (!empty.length || !isAdmin()) return;
  let read = false;
  for (const provider of empty) { try { await api(`/api/ai/providers/${provider.id}/models`, 'POST', {}); read = true; } catch { /* Keep the rest of the list. */ } }
  if (!read) return;
  await sync();
  refillBotModels();
}
function refillSchedule(botId) { const box = el('pr-schedule'), bot = findBot(botId); if (box && bot) box.innerHTML = scheduleList(bot); }
function refillBotModels() {
  const form = el('bot-model-form'); if (!form) return;
  const select = form.elements.namedItem('model'), keep = select.value;
  const own = store.state?.ai?.bots?.[form.dataset.bot] || {};
  // The same markup the page drew, minus its outer <select> and the typed-id box beside it.
  select.innerHTML = groupedModelSelect(botModelChoices(store.state?.ai || {}, own)).replace(/^<select[^>]*>|<\/select>[\s\S]*$/g, '');
  const fresh = select;
  // Keep a pick the list still has, except "Another…": after a save the typed id is a row of its own.
  if (!keep.endsWith('|__other') && [...fresh.options].some(o => o.value === keep)) fresh.value = keep;
  const box = form.querySelector('.model-other'); if (box) { box.hidden = !fresh.value.endsWith('|__other'); box.disabled = box.hidden; if (box.hidden) box.value = ''; }
}
/** `change` handlers for the profile pages, keyed by data-action. */
export const profileChanges = {
};

const computerPage = bot => computerView(bot, {faceOf: state => faceOf(bot, 22, {state, motion: state !== 'awake'})});

/* ----- shape and colour: shared by Edit and New bot ----- */

const stand = (shape, tint, name = 'x') => ({id: '_pick', name, settings: {shape, tint}});
/** The shape grid and the colour dots. The inputs are native radios, so the keyboard works. */
export function lookPicker({shape, tint}) {
  const shapes = SHAPES.map(s => `<label class="lk-shape" title="${SHAPE_LABELS[s]}"><input type="radio" name="shape" value="${s}"${s === shape ? ' checked' : ''} aria-label="${SHAPE_LABELS[s]}"><span>${face(stand(s, tint), {size: 32, state: 'awake', motion: false})}</span></label>`).join('');
  const dots = COLORS.map((c, i) => `<label class="lk-dot" style="--c:${c}"><input type="radio" name="tint" value="${i}"${i === tint ? ' checked' : ''} aria-label="${COLOR_NAMES[i] ? COLOR_NAMES[i][0].toUpperCase() + COLOR_NAMES[i].slice(1) : `Colour ${i + 1}`}"><span></span></label>`).join('');
  return `<fieldset class="lk"><legend class="sr-only">Shape</legend><div class="lk-shapes">${shapes}</div></fieldset><fieldset class="lk"><legend class="sr-only">Colour</legend><div class="lk-dots">${dots}</div></fieldset>`;
}
const previewFace = (form, base = {}) => {
  const shape = form.elements.shape?.value || 'rounded', tint = Number(form.elements.tint?.value) || 0;
  return face({...base, settings: {...(base.settings || {}), shape, tint}}, {size: 84, state: 'awake', primary: base.settings?.lead === true});
};
/** A radio changed in an Edit or New bot form: redraw the big preview, and the
 * shape faces when the colour changed. The inputs themselves stay put, so focus does too. */
export function lookChanged(control) {
  const form = control.form;
  if (!form || !['shape', 'tint'].includes(control.name) || !form.matches('#edit-bot-form, #new-bot-form')) return false;
  const base = form.id === 'edit-bot-form' ? findBot(form.dataset.bot) || {} : {name: 'x', settings: {}};
  const preview = form.querySelector('.lk-preview'); if (preview) preview.innerHTML = previewFace(form, base);
  if (control.name === 'tint') for (const label of form.querySelectorAll('.lk-shape')) label.querySelector('span').innerHTML = face(stand(label.querySelector('input').value, Number(control.value)), {size: 32, state: 'awake', motion: false});
  return true;
}

function managerSelect(botId, current) {
  const options = managerOptions(store.state, botId), group = (label, kind) => { const list = options.filter(o => o.kind === kind); return list.length ? `<optgroup label="${label}">${list.map(o => `<option value="${esc(o.id)}"${o.id === current ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}</optgroup>` : ''; };
  const primary = primaryOf(store.state)?.name || 'Atlas';
  return `<select class="input" name="reportsTo"><option value="">${esc(primary)} (default)</option>${group('Managers', 'manager')}${group('Other bots', 'bot')}</select>`;
}

/** The one form behind Edit and New bot: a preview face, a big name, the shape and colour
 * pickers, a manager row, a note and one pill button. Edit passes the bot's own values and
 * data-was (what Save compares against); New passes empty ones and Create stays off until
 * there is a name. */
function botForm({id, attrs = '', bot = null, look, primary = false, note, extra = '', submit, off = false}) {
  const write = canWrite();
  const preview = face({...(bot || {name: 'x'}), settings: {...(bot?.settings || {}), shape: look.shape, tint: look.tint}}, {size: 84, state: 'awake', primary});
  const name = `<input class="nb-name" name="name" required maxlength="${MAX_NAME}" aria-label="Bot name" autocomplete="off"${bot ? ` value="${esc(bot.name)}"` : ' placeholder="Name your bot" autofocus'}${write ? '' : ' disabled'}>`;
  const boss = primary ? '' : `<label class="nb-boss"><span>Manager</span>${managerSelect(bot?.id ?? null, look.reportsTo || '')}</label>`;
  return `<form id="${id}" class="pg-body nb-body" ${attrs} autocomplete="off">
    <div class="lk-preview">${preview}</div>
    ${name}
    ${lookPicker(look)}
    ${boss}
    <p class="pr-note nb-note">${note}</p>
    ${extra}
    ${off ? '<p class="nb-hint" data-nb-hint>Name it to create</p>' : ''}
    <button type="submit" class="nb-go"${off ? ' disabled' : ''}>${submit}</button>
  </form>`;
}

function editPage(bot) {
  const look = lookOf(store.state, bot.id), primary = primaryOf(store.state)?.id === bot.id;
  return botForm({id: 'edit-bot-form', attrs: `data-bot="${esc(bot.id)}" data-was="${esc(JSON.stringify(look))}"`, bot, look, primary,
    note: `To change what ${esc(bot.name)} does, tell it in its chat.`, submit: 'Save'});
}

const SUBS = {memory: memoryPage, activity: activityPage, schedule: schedulePage, model: modelPage, computer: computerPage, edit: editPage};

export function profileView(route) {
  const bot = findBot(route.profile);
  if (!bot) return `<section class="pg pr">${bar(roundBtn('back', 'Back', 'back-to-list', {}))}<div class="pg-body pr-body"><p class="pr-note">That bot is no longer here.</p></div></section>`;
  const page = SUBS[route.sub];
  if (!page || (route.sub === 'edit' && !canWrite())) { setTimeout(() => fillActivityCount(bot.id), 0); return `<section class="pg pr" data-bot="${esc(bot.id)}">${profileMain(bot)}</section>`; }
  // The Edit form is its own page body (the New bot page's shape); the other pages sit in the plain one.
  const body = route.sub === 'edit' ? page(bot) : `<div class="pg-body pr-body">${page(bot)}</div>`;
  return `<section class="pg pr" data-bot="${esc(bot.id)}">${subBar(bot, SUB_TITLES[route.sub])}${body}</section>`;
}

/* ---------- the New bot page ---------- */

export function newBotView(route) {
  const defaults = newBotDefaults(store.state), job = String(route.job || '').trim();
  return `<section class="pg pr">${headBar('New bot', roundBtn('back', 'Close', 'back-to-list', {}))}${botForm({
    id: 'new-bot-form', look: {...defaults, reportsTo: ''}, note: 'You set its job in the chat.', submit: 'Create', off: true,
    extra: job ? `<p class="nb-job"><b>First job</b>${esc(job)}</p><input type="hidden" name="job" value="${esc(job)}">` : '',
  })}</section>`;
}
/** Create stays off until the bot has a name. */
export function nameTyped(control) {
  if (control.form?.id !== 'new-bot-form' || control.name !== 'name') return false;
  const create = control.form.querySelector('.nb-go'), ok = canCreate({name: control.value}); if (create) create.disabled = !ok;
  const hint = control.form.querySelector('[data-nb-hint]'); if (hint) hint.hidden = ok;
  return true;
}

/* ---------- what the buttons do ---------- */

const patchBot = (id, body) => {
  const group = groupOfBot(id);
  if (!group) throw new Error('That bot is no longer in the company.');
  return api(`/api/groups/${group.id}/bots/${id}`, 'PATCH', body);
};
const botName = id => findBot(id)?.name || 'The bot';
const close = () => closeBotMenu({restore: false});

/** Leave whatever page is open: back through history when this session put it
 * there, else to where the route goes. A profile never goes to the Company page. */
export function closePage() {
  const target = closeTarget(store.route, fromThread);
  if (target.pop) back(target.route); else go(target.route, {replace: true});
}

async function removeBot(id) {
  const bot = findBot(id); if (!bot) return;
  const copy = deleteCopy(store.state, id);
  if (!await confirmSheet(copy.title, {confirm: 'Delete', danger: true, detail: copy.detail})) return;
  await api(`/api/groups/${groupOfBot(id).id}/bots/${id}`, 'DELETE', {});
  forget(id); await sync();
  const route = store.route;
  if (route.bot === id || route.profile === id) go({home: true}, {replace: true}); else if (route.company) repaint();
  toast(`${bot.name} deleted.`);
}
export async function moveBot(id, to) {
  await patchBot(id, {settings: {reportsTo: to || null}});
  await sync();
  toast(to ? `${botName(id)} now reports to ${botName(to)}.` : `${botName(id)} reports to ${primaryOf(store.state)?.name || 'Atlas'} directly.`);
  if (store.route.profile === id || store.route.company) repaint();
}

export const profileActions = {
  'profile-back': b => go(profileBackRoute(b.dataset.id, fromThread), {replace: true}),
  'profile-up': b => go({profile: b.dataset.id}, {replace: true}),
  'profile-sub': b => go({profile: b.dataset.id, sub: b.dataset.sub}),
  'schedule-stop': async b => { await api(`/api/tasks/${encodeURIComponent(b.dataset.task)}`, 'DELETE'); await sync(); refillSchedule(b.dataset.id); toast('Stopped.'); },
  'bot-menu': b => (botMenuOpen() ? closeBotMenu() : openBotMenu(b.dataset.id, {opener: b})),
  // The whole job, to read and (for a member) to edit in place: the header shows only its first line.
  'profile-instructions': b => {
    const bot = findBot(b.dataset.id); if (!bot) return;
    const write = canWrite();
    openSheet(`<form id="instructions-form" data-bot="${esc(bot.id)}"><textarea class="input pr-instr" name="instructions" rows="10" maxlength="${MAX_JOB}" aria-label="${esc(bot.name)}'s instructions"${write ? '' : ' readonly'}>${esc(bot.instructions)}</textarea>${write ? `<div class="sheet-actions"><button type="submit" class="btn primary wide">Save</button></div>` : ''}</form>`,
      {title: `${bot.name}'s instructions`, sub: write ? 'What it is told before every task. Edit it here or tell it in its chat.' : 'What it is told before every task.'});
  },
  // The rules are listed once, in Settings > Permissions; a profile opens that list for this bot.
  'profile-perm': b => go({settings: `perm/${b.dataset.id}`}),
  'profile-activity-all': b => { showAll = showAll === b.dataset.id ? null : b.dataset.id; return loadBotActivity(b.dataset.id); },
  'memory-forget': async b => {
    await api(`/api/memory/rules/${encodeURIComponent(b.dataset.rule)}?bot=${encodeURIComponent(b.dataset.id)}`, 'DELETE');
    await sync();
    const node = el('pr-memory'), bot = findBot(b.dataset.id); if (node && bot) node.innerHTML = memoryList(bot);
    toast('Forgotten.');
  },
  'set-grant': async b => {
    const {id: botId, act: action, choice} = b.dataset, scope = b.dataset.scope || '';
    // Always allow on a payment lets this bot pay on that site without asking: confirm it first.
    if (action === 'spend' && choice === 'always' && !(await confirmSheet('Always allow payments here?', {confirm: 'Always allow', danger: true, detail: `${botName(botId)} will pay${scope ? ` on ${scope.replace(/^https?:\/\//, '')}` : ''} without asking you.`}))) return;
    const {url, body} = grantUrl({botId, action, scope}, choice);
    await api(url, 'POST', body);
    await sync();
    for (const node of document.querySelectorAll('[data-grants]')) node.innerHTML = grantsHtml(node.dataset.grants === 'all' ? null : node.dataset.grants);
    // The list was repainted, so keyboard focus goes to the same choice in the new copy.
    const same = [['id', botId], ['act', action], ['scope', scope], ['choice', choice]].map(([k, v]) => `[data-${k}="${CSS.escape(v)}"]`).join('');
    document.querySelector(`[data-grants] button${same}`)?.focus({preventScroll: true});
    toast(`${botName(botId)}: ${GRANT_LABELS[choice]}.`);
  },
  'menu-message': b => { close(); go({bot: b.dataset.id}); },
  'menu-pin': b => { close(); toast(togglePin(b.dataset.id) ? 'Pinned to the top' : 'Unpinned'); },
  'menu-hide': b => { close(); saveListAdd(HIDDEN_KEY, b.dataset.id); changed(); toast(`${botName(b.dataset.id)} is hidden. Show hidden bots from the list.`); },
  'menu-move': b => {
    const box = b.nextElementSibling; if (!box?.classList.contains('mn-move')) return;
    box.hidden = !box.hidden; b.setAttribute('aria-expanded', String(!box.hidden));
    if (!box.hidden) box.querySelector('button')?.focus();
  },
  'menu-move-to': async b => { close(); await moveBot(b.dataset.id, b.dataset.to); },
  'menu-delete': async b => { close(); await removeBot(b.dataset.id); },
  'show-hidden': () => { saveLocal(HIDDEN_KEY, []); changed(); },
};
const saveListAdd = (key, id) => { const list = savedList(key); if (!list.includes(id)) saveLocal(key, [...list, id]); };

export const profileForms = {
  'instructions-form': async (form, f) => {
    if (!canWrite()) throw new Error('Only a member can edit a bot.');
    const id = form.dataset.bot, text = String(f.instructions ?? '').trim();
    if (!text) throw new Error('Instructions cannot be empty.');
    await patchBot(id, {instructions: text.slice(0, MAX_JOB)});
    await sync(); closeSheet();
    const bot = findBot(id), line = document.querySelector(`[data-role="${CSS.escape(id)}"]`);
    if (bot && line) line.textContent = roleLine(bot);
    toast('Saved.');
  },
  'new-bot-form': async (form, f) => {
    if (!canCreate(f)) throw new Error('Give the bot a name first.');
    const payload = newBotPayload({name: f.name, job: f.job, tint: f.tint, shape: f.shape, reportsTo: f.reportsTo});
    const bot = await api('/api/groups/home/bots', 'POST', payload);
    await sync();
    go({bot: bot.id}, {replace: true});
    toast(`${bot.name} is ready. Tell it what to do.`);
    // From "Make a new bot": the request is its job and its first message.
    if (f.job) sendChat(bot.id, f.job).catch(error => toast(error?.message || 'That did not go through.', true));
  },
  'edit-bot-form': async (form, f) => {
    if (!canWrite()) throw new Error('Only a member can edit a bot.');
    const id = form.dataset.bot, change = editChanges(JSON.parse(form.dataset.was || '{}'), f);
    if (!change) { go({profile: id}, {replace: true}); return; }
    await patchBot(id, change);
    await sync(); go({profile: id}, {replace: true}); toast('Saved.');
  },
  'memory-form': async (form, f) => {
    const id = form.dataset.bot;
    await api('/api/memory/rules', 'POST', {bot: id, text: f.text});
    await sync(); form.reset();
    const node = el('pr-memory'), bot = findBot(id); if (node && bot) node.innerHTML = memoryList(bot);
    toast('Remembered.');
  },
  'schedule-form': async (form, f) => {
    const {every, on} = scheduleChoice(f.every), group = groupOfBot(form.dataset.bot);
    if (!group) throw new Error('That bot is no longer in the company.');
    if (!every && !f.at) throw new Error('Pick a time for a one-off.');
    await api('/api/tasks', 'POST', scheduleTaskBody({botId: form.dataset.bot, groupId: group.id, message: String(f.message || '').trim(), every, on, at: f.at || ''}));
    await sync(); form.reset(); refillSchedule(form.dataset.bot); toast('Added to the schedule.');
  },
  'bot-model-form': async (form, f) => {
    await api(`/api/ai/bots/${form.dataset.bot}`, 'PATCH', {...pickedModel(f), effort: f.effort || ''});
    await sync(); refillBotModels(); toast('Model saved.');
  },
};

/** The first message in a new bot's chat is its job. Called before the message is
 * sent; a failure leaves the bot as it was and the message still goes. */
export async function adoptFirstMessage(botId, text) {
  const bot = findBot(botId), job = String(text ?? '').trim();
  if (!bot || hasJob(bot) || !job) return;
  try { await patchBot(botId, {instructions: job.slice(0, 3000)}); bot.instructions = job.slice(0, 3000); }
  catch (error) { toast(error?.message || 'Could not save its job.', true); }
}

/** Document-level wiring: Esc and a click outside close the menu, and Esc closes an
 * open page. Called once from app.js. */
export function wirePages() {
  document.addEventListener('keydown', ev => {
    if (menu) {
      if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); closeBotMenu(); return; }
      const items = [...menu.node.querySelectorAll('button')].filter(b => b.offsetParent), at = items.indexOf(document.activeElement);
      if (ev.key === 'ArrowDown') { ev.preventDefault(); items[(at + 1) % items.length]?.focus(); }
      else if (ev.key === 'ArrowUp') { ev.preventDefault(); items[(at - 1 + items.length) % items.length]?.focus(); }
      else if (ev.key === 'Tab') closeBotMenu({restore: false});
      return;
    }
    // The Settings dialog is aria-modal: Tab stays inside it, like the sheets (ui-dialogs trapTab).
    const dlg = ev.key === 'Tab' ? document.querySelector('.st-dlg') : null;
    if (dlg && document.getElementById('modal')?.classList.contains('hidden') !== false) {
      const nodes = [...dlg.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])')].filter(n => n.offsetParent !== null);
      const first = nodes[0], last = nodes[nodes.length - 1], at = document.activeElement;
      if (first && ((ev.shiftKey && (at === first || !dlg.contains(at))) || (!ev.shiftKey && (at === last || !dlg.contains(at))))) { ev.preventDefault(); (ev.shiftKey ? last : first).focus(); }
      return;
    }
    // While you drive a bot's tab, Esc is the page's key.
    if (keysOwned(ev.target)) return;
    if (ev.key !== 'Escape' || ev.defaultPrevented || !store.state || document.getElementById('modal')?.classList.contains('hidden') === false) return;
    const route = store.route;
    if (!(route.profile || route.newBot || route.company || route.activity || typeof route.settings === 'string')) return;
    // A half-typed name stays: Esc in a field with text only leaves the field.
    const t = ev.target;
    if (/^(INPUT|TEXTAREA)$/.test(t?.tagName || '') && t.value && t.type !== 'radio') { t.blur(); return; }
    ev.preventDefault(); closePage();
  }, true);
  document.addEventListener('pointerdown', ev => { if (menu && !ev.target.closest('#cmenu') && !ev.target.closest('[data-action="bot-menu"]')) closeBotMenu({restore: false}); }, true);
}
export const profileViews = {profile: profileView, newBot: newBotView};
