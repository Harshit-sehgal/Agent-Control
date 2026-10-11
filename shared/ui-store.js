/** Single source of UI state: the server snapshot, the route, the browser-local
 * conversation log and cosmetic preferences. Views read from `store` and never
 * keep their own copies, so one `sync()` + one render keeps every pane current. */
import {normalizeUiPrefs, UI_PREFS_KEY} from './usability.js';
import {routeHash} from './ui-model.js';

const CHAT_KEY = 'agent-control-bot-chats-v2';
const META_KEY = 'agent-control-bot-profiles-v2';
const RUNS_KEY = 'agent-control-coordination-runs-v1';
const GATE_KEY = 'ac-checkpoint-gate';
const THEME_KEY = 'ac-theme';
/** Colour choices. `system` follows the device. The ids are storage keys (kept
 * from the first warm palette); `dots` previews ground, you, waiting, done. */
export const THEMES = [
  {id: 'system', name: 'System', sub: 'Light by day, dark by night', dots: ['#fbfaf8', '#1a1a1d']},
  {id: 'cream', name: 'Light', sub: 'Clean and bright', dots: ['#fbfaf8', '#36c391', '#6a4bd6', '#f9ecb8']},
  {id: 'cocoa', name: 'Dark', sub: 'Deep grey, easy at night', dots: ['#1a1a1d', '#86cfae', '#c4b7f5', '#e6d383']},
];

export function loadLocal(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } }
/** Returns false when the browser refused the write so callers can warn once. */
export function saveLocal(key, data) { try { localStorage.setItem(key, JSON.stringify(data)); return true; } catch { return false; } }

export const store = {
  state: null,
  /** chat: conversation id (`team-<groupId>` or a bot id). page: a "You" page.
   * info: null | 'home' | a section name for the open chat's info panel. */
  route: {chat: null, page: null, info: null},
  messages: loadLocal(CHAT_KEY, {}),
  profiles: loadLocal(META_KEY, {}),
  prefs: normalizeUiPrefs(loadLocal(UI_PREFS_KEY, {})),
  checkpoints: Boolean(loadLocal(GATE_KEY, false)),
  listFilter: 'all',
  listQuery: '',
  postQuery: '',
  editDraft: null,
  /** Unsaved text of the draft being edited, so a repaint cannot lose it. */
  editText: null,
  /** Draft ids whose sources panel is open; survives repaints. */
  openEvidence: new Set(),
  /** Conversation ids with a reply in flight; drives the typing indicator. */
  typing: new Set(),
};
// `profiles` is cosmetic UI state only (tint, pin). An earlier build also wrote
// name/instructions here, which would shadow the server's values forever.
for (const id of Object.keys(store.profiles)) { delete store.profiles[id].name; delete store.profiles[id].instructions; }

export const isStaticDemo = () => { const m = document.querySelector('meta[name="agent-backend"]'); return !m || m.getAttribute('content') === 'static'; };
export const isAdmin = () => !isStaticDemo() && ['owner', 'admin'].includes(store.state?.me?.role);
/** True when the Node build has a model provider, so bots really run. */
export const isLive = () => !isStaticDemo() && Boolean(store.state?.aiEnabled);

// Every request flows through one wrapper so the shell shows a single in-flight
// bar, delayed enough that instant local reads never flash it.
let inflight = 0, busyTimer = null;
function setBusy(on) {
  const bar = document.getElementById('progress'); if (!bar) return;
  if (on) { if (!busyTimer) busyTimer = setTimeout(() => bar.classList.remove('hidden'), 160); }
  else { clearTimeout(busyTimer); busyTimer = null; bar.classList.add('hidden'); }
}
export async function api(path, method = 'GET', body = {}) {
  inflight++; if (inflight === 1) setBusy(true);
  try { return await window.AGENT_API(path, method, body); }
  finally { inflight--; if (inflight === 0) setBusy(false); }
}

const listeners = new Set();
/** Subscribe to "something changed, repaint". Scope hints which pane: 'all' | 'thread' | 'list'. */
export const onChange = fn => { listeners.add(fn); return () => listeners.delete(fn); };
export const changed = (scope = 'all') => { for (const fn of listeners) fn(scope); };

export async function sync(scope = 'all') { store.state = await api('/api/state'); changed(scope); return store.state; }

export const groups = () => store.state?.groups || [];
export const teamKey = groupId => `team-${groupId}`;
export const findGroup = id => groups().find(g => g.id === id);
export const groupOfBot = botId => groups().find(g => g.bots.some(b => b.id === botId));
export const isXGroup = group => group?.id === 'x-engage';
export const botTint = (group, botId) => store.profiles[botId]?.avatarIndex ?? Math.max(0, group?.bots.findIndex(b => b.id === botId) ?? 0);

/** Resolve a conversation id to what the views need, or null if it is gone. */
export function conversation(id = store.route.chat) {
  if (!id) return null;
  if (id.startsWith('team-')) {
    const group = groups().find(g => teamKey(g.id) === id);
    return group ? {id, isTeam: true, group, name: group.name, bot: null} : null;
  }
  const group = groupOfBot(id); if (!group) return null;
  const bot = group.bots.find(b => b.id === id);
  return {id, isTeam: false, group, bot, name: bot.name, tint: botTint(group, id)};
}

export function appendMessage(key, entry) {
  (store.messages[key] ??= []).push({id: crypto.randomUUID(), at: new Date().toISOString(), ...entry});
  saveLocal(CHAT_KEY, store.messages);
  changed('thread');
}
export function clearMessages(key) { delete store.messages[key]; saveLocal(CHAT_KEY, store.messages); changed(); }
export function setTyping(key, on) { on ? store.typing.add(key) : store.typing.delete(key); changed('thread'); }
export function setProfile(botId, patch) { store.profiles[botId] = {...(store.profiles[botId] || {}), ...patch}; saveLocal(META_KEY, store.profiles); }
export function setPref(key, value) { Object.assign(store.prefs, normalizeUiPrefs({...store.prefs, [key]: value})); saveLocal(UI_PREFS_KEY, store.prefs); }
/** What the user picked: 'system' (default), 'cream' or 'cocoa'. */
export const themeChoice = () => { const id = loadLocal(THEME_KEY, 'system'); return THEMES.some(t => t.id === id) ? id : 'system'; };
const nightQuery = () => matchMedia('(prefers-color-scheme: dark)');
/** Apply the choice to the page and keep the browser chrome colour in step. */
export function applyTheme(choice = themeChoice()) {
  const id = THEMES.some(t => t.id === choice) ? choice : 'system';
  const resolved = id === 'system' ? (nightQuery().matches ? 'cocoa' : 'cream') : id;
  document.documentElement.dataset.theme = resolved;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEMES.find(t => t.id === resolved).dots[0]);
  saveLocal(THEME_KEY, id);
}
/** Re-resolve when the device flips between light and dark. */
export function watchSystemTheme() { nightQuery().addEventListener('change', () => { if (themeChoice() === 'system') applyTheme('system'); }); }
export function setCheckpoints(on) { store.checkpoints = Boolean(on); saveLocal(GATE_KEY, store.checkpoints); }

/** Coordination runs, newest first: server runs merged with the local
 * simulation log so the timeline is populated on both builds. */
export function recentRuns(groupId) {
  const server = (store.state?.groupRuns || []).filter(r => r.groupId === groupId);
  const local = loadLocal(RUNS_KEY, []).filter(r => r.groupId === groupId);
  const byId = new Map([...local, ...server].map(r => [r.id, r]));
  return [...byId.values()].sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}
export function logLocalRun(run) { saveLocal(RUNS_KEY, [run, ...loadLocal(RUNS_KEY, [])].slice(0, 50)); }

/** Entries this session pushed, so an in-app back arrow can pop one instead of
 * stacking a new entry that the system Back button would bounce off. */
let depth = 0;
export const popped = () => { depth = Math.max(0, depth - 1); };
/** In-app back: pop our own history entry when there is one, else go to `fallback`. */
export function back(fallback = {}) { if (depth > 0) history.back(); else go(fallback, {replace: true}); }

/** Navigate. Every pane repaints from `store.route`, and the hash keeps
 * browser Back/Forward and reload working. */
export function go({chat = null, page = null, info = null} = {}, {replace = false} = {}) {
  // An edit in progress survives opening the info panel, not leaving the chat.
  if (chat !== store.route.chat) { store.editDraft = null; store.editText = null; }
  store.route = {chat, page, info};
  const hash = `#${routeHash(store.route)}`;
  if (location.hash !== hash) { history[replace ? 'replaceState' : 'pushState'](null, '', hash); if (!replace) depth++; }
  changed('route');
}
