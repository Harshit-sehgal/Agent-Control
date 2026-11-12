/** Agent Control UI entry point. Boots the store, paints the chats shell from
 * the route, and turns DOM events into the lookups in ui-actions.js.
 *
 * Module map (all browser-safe, all in shared/):
 *   ui-kit          string builders: icons, rows, buttons, time labels
 *   ui-model        pure view models: timeline, needs-you, run buttons
 *   ui-company      pure view models: bot and thread rows, pill, handoffs, routes
 *   ui-feed         pure: what a conversation shows, in order
 *   ui-face         a bot's face, as one inline svg
 *   ui-store        the one state object, API wrapper, navigation
 *   ui-chat         what happens after send (server run, threads, checkpoints)
 *   ui-shell        sidebar, phone chrome and home, search, the page frame
 *   ui-conversation a bot chat or a thread: header, feed, cards, composer
 *   ui-profile      a bot's profile, Edit, the New bot page and the bot options menu
 *   ui-gestures     pin and reorder: drag, long press, right-click, Alt+arrows
 *   ui-reorder      pure rules behind those gestures
 *   ui-settings     Settings, the Company chart and Activity
 *   ui-profile-model pure view models behind those screens
 *   ui-computer     pure rules of a bot's Computer view   ui-computer-view  that view, the profile row and the site chip
 *   ui-connect      Settings → Connectors   ui-connect-model  the pure rules for it, the subscription rows and the connector chat lines
 *   ui-sheets       sign-in and password sheets   ui-admin   admin pages
 *   ui-dialogs      toast, sheet, confirm/ask      ui-actions action/form tables
 *   ui-fx           confetti, the send arrow and the bots' ambient life
 */
import {companyRoute} from './ui-company.js?v=e7ef376d24';
import {store, api, sync, loadState, importLocalChats, onChange, changed, go, syncDepth, conversation, isStaticDemo, applyTheme, watchSystemTheme, retireSession, sessionEpoch, normalizeRoute, groups} from './ui-store.js?v=e7ef376d24';
import {toast, closeSheet, sheetOpen, trapTab, confirmSheet, askSheet} from './ui-dialogs.js?v=e7ef376d24';
import {isDesk, mountRail, mountChrome, wireShell, renderRail, renderChrome, renderPause, closeSearch, homeView, setupCardHtml} from './ui-shell.js?v=e7ef376d24';
import {conversationShell, renderConversation, newThreadView, trackOpen} from './ui-conversation.js?v=e7ef376d24';
import {profileViews, wirePages} from './ui-profile.js?v=e7ef376d24';
import {wireGestures, gesturesBusy} from './ui-gestures.js?v=e7ef376d24';
import {settingsViews} from './ui-settings.js?v=e7ef376d24';
import {showLogin, hideLogin} from './ui-sheets.js?v=e7ef376d24';
import {actions, forms, onControlChange, onControlInput} from './ui-actions.js?v=e7ef376d24';
import {bringBotsToLife} from './ui-fx.js?v=e7ef376d24';
import {wireComputer} from './ui-computer-view.js?v=e7ef376d24';
import {googleReturn, withoutGoogleParams} from './ui-connect-model.js?v=e7ef376d24';

const el = id => document.getElementById(id);
const hashRoute = () => normalizeRoute(companyRoute(location.hash, store.state));
let lastView = '', syncTimer = null, syncDue = 0, refreshing = false;
// Runs that move on their own, so the poll is quick. awaiting_ask is not here: it waits on the owner's answer (like a
// checkpoint), and the answer itself is what starts the run again and brings the quick poll back.
const LIVE_RUN = new Set(['running', 'queued', 'awaiting_browser']);
/** Refresh failures already shown. A dashboard stuck on a stale snapshot must
 * say so, but a poll every few seconds must not repeat the same toast. */
const syncFailures = new Set();
/** One request per press, keyed by what was pressed. The guard cannot live on
 * the button: most actions repaint and replace the node, so the next press lands
 * on a fresh button and a slow DELETE or approval would be sent twice. */
const running = new Set();
const pressKey = button => [button.dataset.action, button.dataset.id, button.dataset.text, button.dataset.section, button.dataset.page, button.dataset.theme, button.dataset.message, button.dataset.choice, button.dataset.run].map(part => part ?? '').join('|');

/** A repaint replaces nodes, so remember which control had focus by its stable
 * attributes and give focus back to its replacement. */
const FOCUS_KEYS = ['action', 'id', 'filter', 'section', 'page', 'status', 'index', 'theme'];
function keepFocus(paint) {
  const a = document.activeElement, pane = a?.closest?.('#sidebar, #main, #chrome');
  const selector = pane && a.dataset?.action ? `#${pane.id} ${a.tagName.toLowerCase()}` + FOCUS_KEYS.filter(k => a.dataset[k] !== undefined).map(k => `[data-${k}="${CSS.escape(a.dataset[k])}"]`).join('') : null;
  paint();
  if (selector && !document.contains(a)) document.querySelector(selector)?.focus({preventScroll: true});
}
/** One renderer per route key: it gets the route and returns the page's markup. */
export const PAGE_VIEWS = {...profileViews, ...settingsViews};
const PAGE_KEYS = ['profile', 'settings', 'newBot', 'company', 'activity'];
const pageView = route => PAGE_VIEWS[PAGE_KEYS.find(k => (k === 'settings' ? typeof route.settings === 'string' : route[k]))](route);

let lastDesk = null, lastHome = '';
/** Repaint everything for the current route. One view key drives the
 * transition and focus move, so reopening the same screen never jumps. */
function renderRoute() {
  const route = store.route, main = el('main'), desk = isDesk();
  // A chat that was deleted in another tab falls back home, not to a blank thread.
  if ((route.bot || route.thread) && !conversation()) return go({}, {replace: true});
  // A laptop home is never an empty pane: it opens the primary bot's chat (the empty "Select a chat" is for a company with no primary).
  const primary = route.home && desk ? groups().find(g => g.id === 'home')?.bots?.find(b => b.settings?.lead) : null;
  if (primary) return go({bot: primary.id}, {replace: true});
  document.body.dataset.view = route.bot || route.thread ? 'chat' : route.home ? 'home' : 'page';
  const view = `${JSON.stringify(route)}|${desk}`;
  if (view !== lastView) {
    lastDesk = desk;
    if (route.bot || route.thread) conversationShell(conversation());
    else if (route.newThread) main.innerHTML = newThreadView();
    else if (route.home) main.innerHTML = desk ? `<div class="rail-none">${setupCardHtml()}<p>Select a chat</p><button type="button" class="link rail-none-go" data-action="new-thread">or start a new thread</button></div>` : homeView();
    else main.innerHTML = pageView(route);
    lastHome = main.innerHTML;
    main.classList.remove('view-enter'); void main.offsetWidth; main.classList.add('view-enter');
    // Only pull focus where it will not pop a phone keyboard open.
    if (matchMedia('(pointer:fine)').matches) (main.querySelector('[autofocus]') || main.querySelector('textarea') || main.querySelector('input'))?.focus?.({preventScroll: true});
  }
  lastView = view;
  renderRail(); renderChrome(); renderPause(); renderConversation();
}

/** The phone home follows the snapshot: new replies, a bot waking up. The scroll
 * position stays where the person left it. */
function refreshHome() {
  const main = el('main'); if (!store.route.home || isDesk() || !main) return;
  const html = homeView();
  if (html === lastHome) return;
  const scroll = main.querySelector('.hv')?.scrollTop || 0, shelf = main.querySelector('.shelf')?.scrollLeft || 0;
  main.innerHTML = html; lastHome = html;
  const view = main.querySelector('.hv'); if (view) view.scrollTop = scroll;
  const row = main.querySelector('.shelf'); if (row) row.scrollLeft = shelf;
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
  // A message waiting for the bot (src/follow-ups.js) starts as soon as the run before it ends.
  if ((state.groupRuns || []).some(r => LIVE_RUN.has(r.status) || r.followUps?.length)) return true;
  if ((state.tasks || []).some(t => t.status === 'queued' && t.kind === 'bot-task' && dueWithin(t.runAt))) return true;
  return false;
}
/** A hidden tab does not poll: the loop parks itself and the tab looks once
 * as soon as it is shown again. */
let hiddenPark = false;
document.addEventListener('visibilitychange', () => {
  if (document.hidden || !hiddenPark || !store.state) return;
  hiddenPark = false;
  scheduleSync(0);
});
function scheduleSync(soon = null) {
  if (!store.state || refreshing) return;
  const wait = soon ?? (workspaceBusy() ? 3000 : 30000);
  const due = Date.now() + wait;
  if (syncTimer && syncDue <= due) return;
  // Browsers keep one timer list, so this also clears the timeout below.
  clearInterval(syncTimer);
  syncDue = due;
  syncTimer = setTimeout(async () => {
    const ticket = sessionEpoch();
    syncTimer = null;
    if (document.hidden) { hiddenPark = true; return; }
    refreshing = true;
    try { await sync('all', {quiet: true}); syncFailures.clear(); }
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
  // A bot is lifted: the list under it stays put until it lands, which repaints.
  if (gesturesBusy()) return;
  keepFocus(() => {
    renderRail(); renderChrome(); renderPause();
    if (scope === 'list') return refreshHome();
    renderConversation(); refreshHome();
  });
});

async function boot() {
  try {
    await loadState();
    // First visit to the demo: start from the workspace the server seeds. A
    // browser that already holds groups keeps them.
    if (isStaticDemo() && !localStorage.getItem('ac-v2-welcome')) {
      if (!store.state?.groups?.length) { await api('/api/reset-workspace', 'POST', {}); await loadState(); }
      localStorage.setItem('ac-v2-welcome', '1');
    }
    await importLocalChats();
    mountRail(); mountChrome(); lastView = '';
    clearInterval(syncTimer); syncTimer = null; syncDue = 0;
    store.route = hashRoute();
    // A laptop opens on the primary bot's chat; a phone opens on the home.
    const primary = (groups().find(g => g.id === 'home')?.bots || []).find(b => b.settings?.lead === true);
    if (isDesk() && store.route.home && !location.hash && primary) go({bot: primary.id}, {replace: true}); else changed('route');
    finishGoogleSignIn();
  } catch (e) {
    if (e.status === 401) return showLogin(e.message);
    el('main').innerHTML = `<section class="home"><h1>Could not start</h1><p></p><p>${isStaticDemo() ? 'Enable browser local storage and reload. If the page was cached from an older deploy, hard-refresh once.' : 'Check that the Node server is running and reload.'}</p></section>`;
    el('main').querySelector('p').textContent = e.message;
  }
}
/** Google sent the owner back to `/?google=connected` or `?google=error&reason=...`: say how it went, take the
 * parameters out of the address so a reload does not say it again, and open Settings → Connectors. Only after the
 * app is signed in and painted, so a sign-in screen in between keeps the parameters for the next boot. */
function finishGoogleSignIn() {
  const result = googleReturn(location.search);
  if (!result) return;
  history.replaceState(history.state, '', `${location.pathname}${withoutGoogleParams(location.search)}${location.hash}`);
  toast(result.text, !result.ok);
  go({settings: 'conn'});
}
/** Leave nothing of the signed-out workspace in the DOM behind the sign-in. */
function lockScreen(message) {
  retireSession();
  refreshing = false;
  clearInterval(syncTimer); syncTimer = null; syncDue = 0;
  closeSheet(); closeSearch();
  store.state = null; store.messages = {}; lastView = '';
  for (const id of ['sidebar', 'main', 'chrome']) el(id).innerHTML = '';
  renderPause();
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
});
document.body.addEventListener('submit', ev => {
  const form = ev.target, key = forms[form.id] ? form.id : null;
  if (!key) return;
  ev.preventDefault();
  if (form.dataset.busy) return;
  const values = Object.fromEntries(new FormData(form).entries()), submits = [...form.querySelectorAll('[type=submit]')];
  form.dataset.busy = '1'; submits.forEach(b => { b.disabled = true; });
  Promise.resolve().then(() => forms[key](form, values)).catch(fail).finally(() => { delete form.dataset.busy; submits.forEach(b => { b.disabled = false; }); });
});
document.body.addEventListener('change', ev => { Promise.resolve().then(() => onControlChange(ev.target)).catch(fail); });
document.body.addEventListener('input', ev => {
  if (ev.target.matches('.cv-box textarea')) return autoGrow(ev.target);
  onControlInput(ev.target);
});
document.body.addEventListener('keydown', ev => {
  trapTab(ev);
  if (ev.key === 'Escape') { if (sheetOpen()) { ev.preventDefault(); closeSheet(); } return; }
  // Enter sends, Shift+Enter makes a new line.
  // keyCode 229: Safari reports the Enter that commits an IME candidate without isComposing.
  if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing && ev.keyCode !== 229 && ev.target.matches('.cv-box textarea')) { ev.preventDefault(); if (ev.target.value.trim()) ev.target.form.requestSubmit(); }
});
window.addEventListener('popstate', event => { syncDepth(event); if (!store.state) return; closeSheet(); closeSearch(); const next = hashRoute(); store.route = next; changed('route'); });
// Crossing 1024px swaps the phone layout for the sidebar layout.
window.addEventListener('resize', () => { if (store.state && isDesk() !== lastDesk) changed('route'); });
// `toggle` does not bubble, so listen in the capture phase to remember which handoff cards are open.
document.addEventListener('toggle', trackOpen, true);
wireShell(); wirePages(); wireGestures(); wireComputer();

applyTheme(); watchSystemTheme(); bringBotsToLife(); registerWorker();
boot();
