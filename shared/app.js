/** Agent Control UI entry point. Boots the store, paints the three panes from
 * the route, and turns DOM events into the lookups in ui-actions.js.
 *
 * Module map (all browser-safe, all in shared/):
 *   ui-kit      string builders: icons, avatars, rows, time labels
 *   ui-model    pure view models: chat list, timeline, needs-you, routes
 *   ui-store    the one state object, API wrapper, navigation
 *   ui-chat     what happens after send (server run, simulator, commands)
 *   ui-views    chat list + thread          ui-panel   chat info + You pages
 *   ui-sheets   sheets, quick nav, sign-in  ui-admin   admin pages
 *   ui-dialogs  toast, sheet, confirm/ask   ui-actions action/form tables
 *   ui-fx       confetti, the send arrow, and when the bots react
 */
import {parseRoute} from './ui-model.js';
import {store, api, sync, loadState, importLocalChats, onChange, changed, go, back, popped, conversation, isStaticDemo, isAdmin, applyTheme, watchSystemTheme} from './ui-store.js';
import {toast, closeSheet, sheetOpen, trapTab} from './ui-dialogs.js';
import {listShell, renderList, threadShell, renderThread, homeView} from './ui-views.js';
import {renderInfo, refreshLists, renderPage} from './ui-panel.js';
import {showLogin, hideLogin, openCommandPalette, closeCommandPalette, paletteOpen, updateCommandResults, chooseCommand, moveCommand} from './ui-sheets.js';
import {actions, forms, onControlChange, onControlInput} from './ui-actions.js';
import {bringBotsToLife} from './ui-fx.js';

const el = id => document.getElementById(id);
const hashRoute = () => parseRoute(location.hash, store.state, {server: !isStaticDemo(), admin: isAdmin()});
/** True while the user is typing inside `node`, so a repaint must not replace it. */
const typingIn = node => { const a = document.activeElement; return Boolean(a && node?.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)); };
let lastView = '', syncTimer = null;

/** A repaint replaces nodes, so remember which control had focus by its stable
 * attributes and give focus back to its replacement. */
const FOCUS_KEYS = ['action', 'id', 'filter', 'section', 'page', 'status', 'index'];
function keepFocus(paint) {
  const a = document.activeElement, pane = a?.closest?.('.pane');
  const selector = pane && a.dataset?.action ? `#${pane.id} ${a.tagName.toLowerCase()}` + FOCUS_KEYS.filter(k => a.dataset[k] !== undefined).map(k => `[data-${k}="${CSS.escape(a.dataset[k])}"]`).join('') : null;
  paint();
  if (selector && !document.contains(a)) document.querySelector(selector)?.focus({preventScroll: true});
}
/** While the info panel covers the thread (narrow screens), keep Tab and
 * assistive tech out of what is underneath. */
function setInert() {
  const {info, chat, page} = store.route, phone = matchMedia('(max-width:850px)').matches;
  el('main').inert = Boolean(info) && matchMedia('(max-width:1180px)').matches;
  el('sidebar').inert = phone && Boolean(info || chat || page);
}

/** Repaint everything for the current route. One view key drives the
 * transition and focus move, so reopening the same screen never jumps. */
function renderRoute() {
  const {chat, page, info} = store.route, main = el('main');
  if (chat && !conversation()) return go({}, {replace: true});
  document.body.dataset.pane = info ? 'info' : (chat || page) ? 'main' : 'list';
  document.body.classList.toggle('has-info', Boolean(info));
  const view = page ? `page:${page}` : chat ? `chat:${chat}` : 'home';
  if (view !== lastView) {
    if (page) renderPage(); else if (chat) threadShell(conversation()); else main.innerHTML = homeView();
    main.classList.remove('view-enter'); void main.offsetWidth; main.classList.add('view-enter');
    // Only pull focus where it will not pop a phone keyboard open.
    if (matchMedia('(pointer:fine)').matches) (main.querySelector('.composer textarea') || main.querySelector('h2'))?.focus?.({preventScroll: true});
  }
  lastView = view;
  setInert();
  renderList(); renderThread(); renderInfo();
  if (info) el('inspector').querySelector('.back')?.focus({preventScroll: true});
}

onChange(scope => {
  if (!store.state) return;
  if (scope === 'route') return renderRoute();
  keepFocus(() => {
    renderList();
    if (scope === 'list') return;
    if (!typingIn(el('chat-space'))) renderThread();
    // Never repaint the panel under the user's cursor; it catches up on the next change.
    if (scope === 'all' && !typingIn(el('inspector'))) renderInfo();
  });
});

async function boot() {
  try {
    await loadState();
    if (isStaticDemo() && !localStorage.getItem('ac-v2-welcome')) {
      await api('/api/demo/seed', 'POST', {}); localStorage.setItem('ac-v2-welcome', '1');
      await loadState();
    }
    await importLocalChats();
    listShell(); lastView = '';
    // First paint only: the chat rows arrive one after another.
    document.body.classList.add('booting'); setTimeout(() => document.body.classList.remove('booting'), 900);
    store.route = hashRoute(); changed('route');
    clearInterval(syncTimer);
    syncTimer = setInterval(async () => {
      try { await sync(); }
      catch (e) { if (e.status === 401) lockScreen('Your session expired. Sign in again.'); }
    }, 30000);
  } catch (e) {
    if (e.status === 401) return showLogin(e.message);
    el('main').innerHTML = `<section class="home"><h1>Could not start</h1><p></p><p>${isStaticDemo() ? 'Enable browser local storage and reload. If the page was cached from an older deploy, hard-refresh once.' : 'Check that the Node server is running and reload.'}</p></section>`;
    el('main').querySelector('p').textContent = e.message;
  }
}
/** Leave nothing of the signed-out workspace in the DOM behind the sign-in. */
function lockScreen(message) {
  clearInterval(syncTimer); syncTimer = null;
  closeSheet(); closeCommandPalette();
  store.state = null; store.messages = {}; lastView = '';
  for (const id of ['sidebar', 'main', 'inspector']) el(id).innerHTML = '';
  showLogin(message);
}
actions.logout = async () => {
  try { await api('/api/logout', 'POST', {}); } catch { /* Sign out regardless. */ }
  lockScreen('Signed out.');
};
forms['login-form'] = async (form, f) => {
  try { await api('/api/login', 'POST', f); hideLogin(); await boot(); }
  catch (error) { const node = el('login-error'); if (node) node.textContent = error.message; }
};

const fail = error => toast(error?.message || 'That did not work.', true);
const autoGrow = node => { node.style.height = 'auto'; node.style.height = `${Math.min(node.scrollHeight, 180)}px`; };

document.body.addEventListener('click', ev => {
  const button = ev.target.closest('[data-action]');
  if (button) {
    if (button.tagName === 'SELECT' || button.tagName === 'INPUT') return; // handled on change
    ev.preventDefault();
    const run = actions[button.dataset.action];
    // One request per press: a second click while it runs is ignored.
    if (!run || button.dataset.busy) return;
    button.dataset.busy = '1';
    Promise.resolve().then(() => run(button)).catch(fail).finally(() => { delete button.dataset.busy; });
  } else if (ev.target.id === 'modal') closeSheet();
  else if (ev.target.id === 'command') closeCommandPalette();
});
document.body.addEventListener('submit', ev => {
  const form = ev.target, key = forms[form.id] ? form.id : ['.edit-form', '.evidence-form'].find(k => form.classList.contains(k.slice(1)));
  if (!key) return;
  ev.preventDefault();
  if (form.dataset.busy) return;
  const values = Object.fromEntries(new FormData(form).entries()), submits = [...form.querySelectorAll('[type=submit]')];
  form.dataset.busy = '1'; submits.forEach(b => { b.disabled = true; });
  Promise.resolve().then(() => forms[key](form, values)).catch(fail).finally(() => { delete form.dataset.busy; submits.forEach(b => { b.disabled = false; }); });
});
document.body.addEventListener('change', ev => { Promise.resolve().then(() => onControlChange(ev.target)).catch(fail); });
document.body.addEventListener('input', ev => {
  if (ev.target.id === 'command-input') return updateCommandResults(ev.target.value);
  if (ev.target.matches('.composer textarea')) return autoGrow(ev.target);
  onControlInput(ev.target);
});
document.body.addEventListener('keydown', ev => {
  trapTab(ev);
  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'k') { ev.preventDefault(); paletteOpen() ? closeCommandPalette() : openCommandPalette(); return; }
  if (ev.key === 'Escape') {
    if (paletteOpen()) { ev.preventDefault(); closeCommandPalette(); }
    else if (sheetOpen()) { ev.preventDefault(); closeSheet(); }
    else if (store.route.info) { ev.preventDefault(); back({chat: store.route.chat}); }
    return;
  }
  if (ev.target.id === 'command-input') {
    if (ev.key === 'Enter') { ev.preventDefault(); chooseCommand(Number(el('command-results')?.querySelector('.selected')?.dataset.index ?? 0)); }
    else if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') { ev.preventDefault(); moveCommand(ev.key === 'ArrowDown' ? 1 : -1); }
    return;
  }
  // Enter sends, Shift+Enter makes a new line.
  // keyCode 229: Safari reports the Enter that commits an IME candidate without isComposing.
  if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing && ev.keyCode !== 229 && ev.target.matches('.composer textarea')) { ev.preventDefault(); if (ev.target.value.trim()) ev.target.form.requestSubmit(); }
});
window.addEventListener('popstate', () => { popped(); if (!store.state) return; closeSheet(); closeCommandPalette(); const next = hashRoute(); if (next.chat !== store.route.chat) { store.editDraft = null; store.editText = null; } store.route = next; changed('route'); });
window.addEventListener('resize', () => { if (store.state) setInert(); });
// `toggle` does not bubble, so listen in the capture phase to remember open source panels.
document.addEventListener('toggle', ev => { const id = ev.target.dataset?.evidence; if (id) ev.target.open ? store.openEvidence.add(id) : store.openEvidence.delete(id); }, true);

applyTheme(); watchSystemTheme(); bringBotsToLife();
boot();
