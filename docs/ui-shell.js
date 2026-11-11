/** The frame around every screen: the desktop sidebar, the phone chrome (avatar,
 * Bots | Threads indicator, +, search and New thread), the phone home, search and
 * its shortcuts, and the page frame the other screens sit in.
 *
 * Home is the Chats layout only. On a phone it is two sections, Bots and Threads,
 * switched by swiping; on a laptop the sidebar holds both and the chat opens on the
 * right. The lists come from ui-company.js (pure); this file is markup and events. */
import {botRows, threadRows} from './ui-company.js?v=b2a252f47f';
import {face} from './ui-face.js?v=b2a252f47f';
import {esc, icon, stamp} from './ui-kit.js?v=b2a252f47f';
import {store, go, back, groups, findBot, canWrite, loadLocal, isStaticDemo} from './ui-store.js?v=b2a252f47f';

const el = id => document.getElementById(id);
const DESK = '(min-width:1024px)';
export const isDesk = () => matchMedia(DESK).matches;
const calm = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const SECTIONS = ['bots', 'threads'];

const BOOK = '<path d="M6 3.5h9.5A2.5 2.5 0 0 1 18 6v12.5a2 2 0 0 1-2 2H6z"/><path d="M6 3.5v17M9.5 8h5M9.5 11.5h3"/><path d="m20.5 9.5-6.2 6.2-2.3.6.6-2.3 6.2-6.2a1.2 1.2 0 0 1 1.7 1.7z"/>';
const svg = (inner, size = 20) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
const newThreadIcon = size => svg(BOOK, size);

/** Initials for the round owner button: the name or the part of the email before
 * the @; "You" when the workspace does not say. */
export function initials(state = store.state) {
  const label = state?.me?.name || String(state?.me?.email || '').split('@')[0] || 'You';
  return label.split(/[\s._-]+/).filter(Boolean).map(w => w[0]).slice(0, 2).join('').toUpperCase() || 'Y';
}
const ownerName = () => store.state?.me?.name || String(store.state?.me?.email || '').split('@')[0] || 'You';

/* ---------- rows ---------- */

const bots = () => groups().find(g => g.id === 'home')?.bots || [];
/** The bots in the pinned row. Atlas starts pinned for everyone; a person's own
 * pins and order, once they make any, are saved under this key (see ui-gestures). */
export const PINS_KEY = 'ac-pins';
/** The order the person arranged their list in (ids, a bot's place among the bots on its team); see ui-gestures. */
export const ORDER_KEY = 'ac-order';
/** Bots the person hid from their list (the profile menu's Hide); a link under the list brings them back. */
export const HIDDEN_KEY = 'ac-hidden';
const hiddenBots = () => { const list = loadLocal(HIDDEN_KEY, []); return Array.isArray(list) ? list.filter(id => bots().some(b => b.id === id && b.settings?.lead !== true)) : []; };
function chatRows(query = '') {
  const saved = loadLocal(PINS_KEY, null), primary = bots().find(b => b.settings?.lead === true);
  const order = loadLocal(ORDER_KEY, []);
  return botRows(store.state, {query, pins: Array.isArray(saved) ? saved : primary ? [primary.id] : [], order: Array.isArray(order) ? order : [], hidden: hiddenBots()});
}
const hiddenLink = () => { const n = hiddenBots().length; return n ? `<button type="button" class="link hv-hidden" data-action="show-hidden">Show ${n} hidden</button>` : ''; };
const bigFace = (row, size) => { const bot = findBot(row.id); return bot ? face(bot, {size, state: row.status, primary: row.isPrimary, manager: row.isManager, index: bots().indexOf(bot)}) : ''; };

function botRow(row) {
  const current = store.route.bot === row.id;
  const prev = row.status === 'working' ? '<span class="crow-prev live">working<span class="dots" aria-hidden="true"><i></i><i></i><i></i></span></span>'
    : row.needs ? '<span class="crow-prev wt">Waiting on you</span>' : `<span class="crow-prev">${esc(row.preview || row.job)}</span>`;
  return `<button type="button" class="crow${current ? ' on' : ''}" data-action="open-bot" data-id="${esc(row.id)}" data-team="${esc(row.team ?? '')}"${row.isManager ? ' data-manager="true"' : ''}${current ? ' aria-current="page"' : ''}>${row.face}<span class="crow-w"><span class="crow-top"><b>${esc(row.name)}</b><time>${esc(stamp(row.at))}</time></span>${prev}</span>${row.needs ? `<span class="badge" aria-label="${row.needs} waiting on you">${row.needs}</span>` : ''}</button>`;
}
function pinnedRow(row, size) {
  const current = store.route.bot === row.id;
  return `<button type="button" class="pin${current ? ' on' : ''}" data-action="open-bot" data-id="${esc(row.id)}"${current ? ' aria-current="page"' : ''}>${bigFace(row, size)}<span>${esc(row.name)}</span>${row.needs ? `<span class="badge" aria-label="${row.needs} waiting on you">${row.needs}</span>` : ''}</button>`;
}
function threadRow(row) {
  const current = store.route.thread === row.id;
  const wait = row.waiting ? '<span class="wt">Waiting on you · </span>' : '';
  return `<button type="button" class="trow${current ? ' on' : ''}" data-action="open-thread" data-id="${esc(row.id)}"${current ? ' aria-current="page"' : ''}>${row.face}<span class="trow-w"><b>${esc(row.title)}</b><small>${wait}${esc(row.preview || 'No replies yet')}</small></span><time>${esc(stamp(row.at))}</time></button>`;
}
const GROUPS = [['waiting', 'Waiting on you'], ['today', 'Today'], ['earlier', 'Earlier']];
/** Threads matching `query`, under Waiting on you, Today and Earlier headings, or
 * as one flat list (the sidebar has a Threads heading of its own). */
function threadGroups(query = '', {headings = true} = {}) {
  const q = query.trim().toLowerCase(), rows = threadRows(store.state);
  const keep = list => list.filter(r => !q || `${r.title} ${r.preview}`.toLowerCase().includes(q));
  if (!headings) return GROUPS.flatMap(([key]) => keep(rows[key])).map(threadRow).join('');
  return GROUPS.map(([key, label]) => [label, keep(rows[key])]).filter(([, list]) => list.length)
    .map(([label, list]) => `<div class="tgrp"><h4>${label}</h4>${list.map(threadRow).join('')}</div>`).join('');
}
const waitingThreads = () => threadRows(store.state).waiting.length;

/* ---------- phone home ---------- */

/** The phone home for the current section: Bots (pinned row, then the chat rows)
 * or Threads (waiting on you, today, earlier). */
export function homeView() {
  if (store.section === 'threads') {
    const list = threadGroups();
    return `<div class="hv" data-section="threads"><div class="hv-in">${list || '<p class="hv-empty"><strong>No threads yet</strong>Start one with the New thread button.</p>'}</div></div>`;
  }
  const rows = chatRows(), pinned = rows.filter(r => r.pinned), rest = rows.filter(r => !r.pinned);
  const shelf = pinned.length ? `<div class="shelf" aria-label="Pinned bots">${pinned.map(r => pinnedRow(r, 76)).join('')}</div>` : '';
  const list = rest.length ? `<div class="crows">${rest.map(botRow).join('')}</div>` : (pinned.length === rows.length && rows.length < 2 ? '<p class="hv-empty"><strong>Atlas is your only bot</strong>Make another with the + button.</p>' : '');
  return `<div class="hv" data-section="bots"><div class="hv-in">${shelf}${list}${hiddenLink()}</div></div>`;
}

/** Switch the phone home between Bots and Threads. The page slides a short way,
 * or just switches under reduced motion. */
export function switchSection(next, dir = 0) {
  if (!SECTIONS.includes(next) || store.section === next || !store.route.home || isDesk()) return;
  store.section = next;
  const main = el('main');
  main.innerHTML = homeView();
  renderChrome();
  const view = main.querySelector('.hv');
  if (view && dir && !calm()) view.animate([{transform: `translateX(${dir * 32}px)`, opacity: .35}, {transform: 'none', opacity: 1}], {duration: 260, easing: 'cubic-bezier(.2,.8,.2,1)'});
}

/* ---------- desktop sidebar ---------- */

/** Painted once at boot: search, + New bot, the list body and the owner row. */
export function mountRail() {
  el('sidebar').innerHTML = `
    <div class="rail-top">
      <label class="rail-find">${icon('search', 17)}<input id="rail-q" type="search" placeholder="Search bots and threads" aria-label="Search bots and threads" autocomplete="off"></label>
      ${canWrite() ? `<button type="button" class="rail-btn" data-action="new-bot" aria-label="New bot" title="New bot">${icon('plus', 18)}</button>` : ''}
    </div>
    <div class="rail-list" id="rail-body"></div>
    <div class="rail-foot">
      <button type="button" class="rail-me" data-action="open-settings" aria-label="Your account and settings"><span class="ini" id="rail-ini"></span><span id="rail-name"></span></button>
      ${canWrite() ? `<button type="button" class="rail-btn rail-new" data-action="new-thread" aria-label="New thread" title="New thread">${newThreadIcon(18)}<span id="rail-badge"></span></button>` : ''}
    </div>`;
}

/** Refill the sidebar list from the snapshot. Typing in the search box is never
 * disturbed: only #rail-body is replaced. */
export function renderRail() {
  const body = el('rail-body'); if (!body || !store.state) return;
  // Hidden on a phone: leave it empty rather than draw every face twice.
  if (!isDesk()) { body.innerHTML = ''; return; }
  const query = store.listQuery.trim(), rows = chatRows(query);
  const status = rows.filter(r => r.status === 'working').length, hasRows = rows.length;
  const primary = chatRows().find(r => r.isPrimary)?.name || 'Atlas';
  const line = status ? `${status} working · others asleep` : `${primary} on watch · others asleep`;
  const pinned = rows.filter(r => r.pinned), rest = rows.filter(r => !r.pinned), threads = threadGroups(query, {headings: false});
  const demo = isStaticDemo() ? '<p class="rail-demo">Browser-only demo · data stays in this browser</p>' : '';
  body.innerHTML = `${query ? '' : `<div class="rail-status"><i aria-hidden="true"></i>${esc(line)}</div>${demo}`}
    ${pinned.length ? `<div class="shelf">${pinned.map(r => pinnedRow(r, 72)).join('')}</div>` : ''}
    <div class="crows">${rest.map(botRow).join('')}</div>${query ? '' : hiddenLink()}
    ${threads ? `<div class="rail-h">Threads</div>${threads}` : ''}
    ${query && !hasRows && !threads ? '<p class="hv-empty"><strong>No match</strong>No bot or thread has that.</p>' : ''}`;
  el('rail-ini').textContent = initials(); el('rail-name').textContent = ownerName();
  const waiting = waitingThreads(); el('rail-badge').innerHTML = waiting ? `<span class="badge" aria-label="${waiting} waiting on you">${waiting}</span>` : '';
}

/* ---------- phone chrome ---------- */

/** Painted once at boot, shown only on the phone home. */
export function mountChrome() {
  const write = canWrite();
  el('chrome').innerHTML = `
    <button type="button" class="ch-me" data-action="open-settings" aria-label="Your account and settings"><span class="ini" id="ch-ini"></span></button>
    <div class="ch-ind" id="ch-ind" data-on="bots" role="status"><span class="thumb" aria-hidden="true"></span><span>Bots</span><span>Threads</span></div>
    ${write ? `<button type="button" class="ch-new" data-action="new-bot" aria-label="New bot" title="New bot">${icon('plus', 20)}</button>` : ''}
    <div class="ch-bar">
      <div class="ch-res" id="ch-res" hidden></div>
      ${write ? `<button type="button" class="ch-thread" data-action="new-thread" aria-label="New thread" title="New thread">${newThreadIcon(21)}<span id="ch-badge"></span></button>` : ''}
      <label class="ch-find">${icon('search', 20)}<input id="sq" type="search" placeholder="Search" aria-label="Search bots and threads" autocomplete="off"></label>
    </div>`;
}

/** Show or hide the chrome and bring its indicator and badge up to date. */
export function renderChrome() {
  const chrome = el('chrome'); if (!chrome || !store.state) return;
  const show = Boolean(store.route.home) && !isDesk();
  chrome.hidden = !show;
  if (!show) return closeSearch();
  el('ch-ini').textContent = initials();
  const ind = el('ch-ind');
  ind.dataset.on = store.section;
  ind.setAttribute('aria-label', store.section === 'threads' ? 'Threads. Swipe right for Bots.' : 'Bots. Swipe left for Threads.');
  const waiting = waitingThreads(), badge = el('ch-badge');
  if (badge) badge.innerHTML = waiting ? `<span class="badge" aria-label="${waiting} waiting on you">${waiting}</span>` : '';
}

/* ---------- search ---------- */

/** The phone results: bots whose name or job match (nothing until you type), then
 * threads (all of them while the box is empty). */
export function searchHtml(query = '') {
  const q = query.trim(), matched = q ? chatRows(q) : [];
  const found = matched.length ? `<div class="tgrp"><h4>Bots</h4><div class="res-bots">${matched.map(r => `<button type="button" data-action="open-bot" data-id="${esc(r.id)}">${bigFace(r, 44)}<span>${esc(r.name)}</span></button>`).join('')}</div></div>` : '';
  const threads = threadGroups(q);
  return found + threads || '<p class="hv-empty"><strong>No match</strong>No bot or thread has that.</p>';
}
export function openSearch() {
  const box = el('ch-res'), input = el('sq'); if (!box || !input) return;
  box.innerHTML = searchHtml(input.value); box.hidden = false;
}
export function closeSearch() { const box = el('ch-res'); if (box) box.hidden = true; }
const searchOpen = () => { const box = el('ch-res'); return Boolean(box && !box.hidden); };

/** Put the cursor in the search that is on screen: the sidebar's, or the phone's
 * bottom bar (which only shows on home, so a chat goes home first). */
export function focusSearch() {
  if (isDesk()) { const input = el('rail-q'); input?.focus(); input?.select(); return; }
  if (!store.route.home) go({home: true});
  setTimeout(() => el('sq')?.focus(), 0);
}

const typing = target => target?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target?.tagName || '');

/** Document-level wiring: shortcuts, the search boxes, swipes. Called once. */
export function wireShell() {
  document.addEventListener('keydown', ev => {
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'k') { ev.preventDefault(); return focusSearch(); }
    if (ev.altKey || ev.ctrlKey || ev.metaKey || typing(ev.target) || !store.state) return;
    if (ev.key === 't' || ev.key === 'T' || ev.key === '/') { ev.preventDefault(); return focusSearch(); }
    // No swipe on a keyboard: the arrows switch the phone home between its two halves.
    if (store.route.home && !isDesk() && (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight')) switchSection(ev.key === 'ArrowLeft' ? 'bots' : 'threads', ev.key === 'ArrowLeft' ? -1 : 1);
  });
  document.addEventListener('keydown', ev => {
    if (ev.key !== 'Escape') return;
    if (searchOpen()) { ev.preventDefault(); closeSearch(); el('sq')?.blur(); }
    else if (ev.target?.id === 'rail-q' || ev.target?.id === 'sq') { ev.target.value = ''; store.listQuery = ''; renderRail(); ev.target.blur(); }
  });
  document.addEventListener('input', ev => {
    if (ev.target.id === 'rail-q') { store.listQuery = ev.target.value; renderRail(); }
    else if (ev.target.id === 'sq') openSearch();
  });
  // A hop is one-off: the class that plays it comes off when it ends, so the face goes back to swaying.
  document.addEventListener('animationend', ev => { if (ev.animationName === 'hop') ev.target.classList.remove('face--hop'); });
  document.addEventListener('focusin', ev => { if (ev.target.id === 'sq') openSearch(); });
  document.addEventListener('click', ev => { if (searchOpen() && !ev.target.closest('.ch-bar')) closeSearch(); });
  // Swipe left on Bots for Threads, right on Threads for Bots. A swipe that starts
  // on the pinned row scrolls that row instead.
  let start = null;
  const main = el('main');
  main.addEventListener('pointerdown', ev => { start = store.route.home && !isDesk() && !ev.target.closest('.shelf') ? {x: ev.clientX, y: ev.clientY} : null; });
  main.addEventListener('pointercancel', () => { start = null; });
  main.addEventListener('pointerup', ev => {
    // A bot being dragged sideways is not a swipe between Bots and Threads.
    if (!start || document.body.dataset.dragging) { start = null; return; }
    const dx = ev.clientX - start.x, dy = ev.clientY - start.y; start = null;
    if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    if (dx < 0 && store.section === 'bots') switchSection('threads', 1);
    else if (dx > 0 && store.section === 'threads') switchSection('bots', -1);
  });
}

/* ---------- the page frame ---------- */

/** A page opened from the shell: a round back button, a title, then `body`. The
 * profile, settings, new bot, company and activity screens sit in this. */
export function pageFrame({title, body = '', back = 'back-to-list', backId = '', backLabel = 'Back'}) {
  return `<section class="pg"><header class="pg-head"><button type="button" class="rbtn" data-action="${esc(back)}"${backId ? ` data-id="${esc(backId)}"` : ''} aria-label="${esc(backLabel)}">${icon('back', 20)}</button><h1>${esc(title)}</h1></header><div class="pg-body">${body}</div></section>`;
}

export const shellActions = {
  'open-bot': b => go({bot: b.dataset.id}),
  'open-thread': b => go({thread: b.dataset.id}),
  'open-settings': () => go({settings: ''}),
  'new-bot': () => go({newBot: true}),
  'new-thread': () => go({newThread: true}),
  'back-to-list': () => back({home: true}),
};

