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
import {parseRoute} from './ui-model.js?v=3dfd17aba5';
import {store, api, sync, loadState, importLocalChats, onChange, changed, go, syncDepth, conversation, isStaticDemo, isAdmin, canWrite, applyTheme, watchSystemTheme, retireSession, resetChatState, sessionEpoch} from './ui-store.js?v=3dfd17aba5';
import {toast, closeSheet, sheetOpen, trapTab, confirmSheet, askSheet} from './ui-dialogs.js?v=3dfd17aba5';
import {listShell, renderList, threadShell, renderThread, homeView, renderMentions} from './ui-views.js?v=3dfd17aba5';
import {renderInfo, refreshLists, renderPage} from './ui-panel.js?v=3dfd17aba5';
import {showLogin, hideLogin, openCommandPalette, closeCommandPalette, paletteOpen, updateCommandResults, chooseCommand, moveCommand} from './ui-sheets.js?v=3dfd17aba5';
import {actions, forms, onControlChange, onControlInput} from './ui-actions.js?v=3dfd17aba5';
import {bringBotsToLife} from './ui-fx.js?v=3dfd17aba5';

const el = id => document.getElementById(id);
const hashRoute = () => parseRoute(location.hash, store.state, {server: !isStaticDemo(), admin: isAdmin(), write: canWrite()});
/** True while the user is typing inside `node`, so a repaint must not replace it. */
const typingIn = node => { const a = document.activeElement; return Boolean(a && node?.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)); };
let lastView = '', syncTimer = null, syncDue = 0, refreshing = false;
const LIVE_RUN = new Set(['running', 'queued', 'awaiting_feed', 'awaiting_browser']);
/** Refresh failures already shown. A dashboard stuck on a stale snapshot must
 * say so, but a poll every few seconds must not repeat the same toast. */
const syncFailures = new Set();
/** One request per press, keyed by what was pressed. The guard cannot live on
 * the button: most actions repaint and replace the node, so the next press lands
 * on a fresh button and a slow DELETE or approval would be sent twice. */
const running = new Set();
const pressKey = button => [button.dataset.action, button.dataset.id, button.dataset.text, button.dataset.section, button.dataset.page, button.dataset.theme].map(part => part ?? '').join('|');

/** A repaint replaces nodes, so remember which control had focus by its stable
 * attributes and give focus back to its replacement. */
const FOCUS_KEYS = ['action', 'id', 'filter', 'section', 'page', 'status', 'index', 'theme'];
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

/** A page request or a live group run finishes outside this tab, and a
 * scheduled task fires on the server. Look again every few seconds while one
 * of those is open, or due within this same window; an idle workspace stays
 * on the slow poll. A keystroke must not push that poll back. */
function dueWithin(when, windowMs = 30000) {
  const at = Date.parse(when);
  return Number.isFinite(at) && at <= Date.now() + windowMs;
}
function workspaceBusy() {
  const state = store.state;
  if (!state) return false;
  if ((state.browserRequests || []).some(r => r.status === 'pending' || r.status === 'dispatched')) return true;
  if ((state.groupRuns || []).some(r => LIVE_RUN.has(r.status))) return true;
  if ((state.tasks || []).some(t => t.status === 'queued' && (t.kind === 'bot-task' || t.kind === 'reminder') && dueWithin(t.runAt))) return true;
  return (state.drafts || []).some(d => d.status === 'scheduled' && dueWithin(d.dueAt));
}
function scheduleSync() {
  if (!store.state || refreshing) return;
  const wait = workspaceBusy() ? 3000 : 30000;
  const due = Date.now() + wait;
  if (syncTimer && syncDue <= due) return;
  // Browsers keep one timer list, so this also clears the timeout below.
  clearInterval(syncTimer);
  syncDue = due;
  syncTimer = setTimeout(async () => {
    const ticket = sessionEpoch();
    syncTimer = null;
    refreshing = true;
    try { await sync(); syncFailures.clear(); }
    catch (e) {
      if (ticket === sessionEpoch() && e?.status === 401) { lockScreen('Your session expired. Sign in again.'); return; }
      if (ticket !== sessionEpoch()) return;
      // Anything else (403, 500, offline) leaves the last snapshot on screen, so
      // the dashboard silently goes stale. Say it once per distinct failure and
      // keep polling: the loop below re-arms, and a recovery needs no click.
      const detail = e?.message || 'The server did not answer.';
      const message = e?.status ? `${detail} (${e.status})` : detail;
      if (syncFailures.has(message)) return;
      syncFailures.add(message);
      toast(`Showing the last saved state: ${message}`, true);
    }
    finally {
      // Sign-out bumps the epoch and may already have armed nothing. Do not
      // clear a newer session's refresh, and do not start this one again.
      if (ticket !== sessionEpoch()) return;
      refreshing = false;
      if (store.state) scheduleSync();
    }
  }, wait);
}

onChange(scope => {
  if (!store.state) return;
  scheduleSync();
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
    clearInterval(syncTimer); syncTimer = null; syncDue = 0;
    store.route = hashRoute(); changed('route');
  } catch (e) {
    if (e.status === 401) return showLogin(e.message);
    el('main').innerHTML = `<section class="home"><h1>Could not start</h1><p></p><p>${isStaticDemo() ? 'Enable browser local storage and reload. If the page was cached from an older deploy, hard-refresh once.' : 'Check that the Node server is running and reload.'}</p></section>`;
    el('main').querySelector('p').textContent = e.message;
  }
}
/** Leave nothing of the signed-out workspace in the DOM behind the sign-in. */
function lockScreen(message) {
  retireSession();
  refreshing = false;
  clearInterval(syncTimer); syncTimer = null; syncDue = 0;
  closeSheet(); closeCommandPalette();
  store.state = null; store.messages = {}; lastView = '';
  for (const id of ['sidebar', 'main', 'inspector']) el(id).innerHTML = '';
  showLogin(message);
}
actions.logout = async () => {
  try { await api('/api/logout', 'POST', {}); } catch { /* Sign out regardless. */ }
  lockScreen('Signed out.');
};
actions['delete-account'] = async () => {
  if (!await confirmSheet('Delete your account?', {confirm: 'Delete account', danger: true, detail: 'You are signed out. This cannot be undone.'})) return;
  const password = await askSheet('Your password', {sub: 'Type your password to delete this account.', submit: 'Delete account'});
  if (password == null || !String(password).trim()) return;
  await api('/api/account', 'DELETE', {password});
  lockScreen('Account deleted.');
};
forms['login-form'] = async (form, f) => {
  try { await api('/api/login', 'POST', f); hideLogin(); await boot(); }
  catch (error) { const node = el('login-error'); if (node) node.textContent = error.message; }
};
actions['login-forgot'] = () => showLogin('', 'forgot');
actions['login-reset'] = () => showLogin('', 'reset');
actions['login-back'] = () => showLogin('', 'sign-in');
forms['forgot-form'] = async (form, f) => {
  try {
    await api('/api/auth/forgot', 'POST', {email: f.email});
    showLogin('If that account exists, the server log has a one-time token. Paste it below.', 'reset');
  } catch (error) { const node = el('login-error'); if (node) node.textContent = error.message; }
};
forms['reset-form'] = async (form, f) => {
  try {
    await api('/api/auth/reset', 'POST', {token: f.token, password: f.password});
    showLogin('Password updated. Sign in with the new one.');
  } catch (error) { const node = el('login-error'); if (node) node.textContent = error.message; }
};

/** Register the worker at boot, not only when push is turned on: it is what
 * lets the installed app open offline, and until a user opted into
 * notifications there was no registration at all, so an installed icon opened
 * to a blank error page. An unsupported browser, an insecure origin or a failed
 * install only costs this console line; the app itself does not need it. */
function registerWorker() {
  if (!window.isSecureContext || !('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('./sw.js').catch(error => console.warn('Service worker not registered:', error?.message));
}

const fail = error => toast(error?.message || 'That did not work.', true);
const autoGrow = node => { node.style.height = 'auto'; node.style.height = `${Math.min(node.scrollHeight, 180)}px`; };

document.body.addEventListener('click', ev => {
  const button = ev.target.closest('[data-action]');
  if (button) {
    if (button.tagName === 'SELECT' || button.tagName === 'INPUT') return; // handled on change
    ev.preventDefault();
    const run = actions[button.dataset.action];
    if (!run) return;
    // One request per press: a second click while it runs is ignored, even when
    // a repaint has already replaced the button it was pressed on.
    const key = pressKey(button);
    if (running.has(key)) return;
    running.add(key);
    button.dataset.busy = '1';
    Promise.resolve().then(() => run(button)).catch(fail).finally(() => { running.delete(key); delete button.dataset.busy; });
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
  if (ev.target.matches('.composer textarea')) { if (ev.target.closest('#chat-form')) renderMentions(ev.target.value); return autoGrow(ev.target); }
  onControlInput(ev.target);
});
document.body.addEventListener('keydown', ev => {
  trapTab(ev);
  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'k') { ev.preventDefault(); paletteOpen() ? closeCommandPalette() : openCommandPalette(); return; }
  if (ev.key === 'Escape') {
    if (paletteOpen()) { ev.preventDefault(); closeCommandPalette(); }
    else if (sheetOpen()) { ev.preventDefault(); closeSheet(); }
    // Escape closes the whole info panel back to the thread, not one section.
    else if (store.route.info) { ev.preventDefault(); go({chat: store.route.chat}, {replace: true}); }
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
window.addEventListener('popstate', event => { syncDepth(event); if (!store.state) return; closeSheet(); closeCommandPalette(); const next = hashRoute(); if (next.chat !== store.route.chat) resetChatState(); store.route = next; changed('route'); });
window.addEventListener('resize', () => { if (store.state) setInert(); });
// `toggle` does not bubble, so listen in the capture phase to remember open source panels.
document.addEventListener('toggle', ev => { const id = ev.target.dataset?.evidence; if (!id) return; if (ev.target.open) { store.openEvidence.add(id); if (store.openEvidence.size > 50) store.openEvidence.delete(store.openEvidence.values().next().value); } else store.openEvidence.delete(id); }, true);

applyTheme(); watchSystemTheme(); bringBotsToLife(); registerWorker();
boot();
