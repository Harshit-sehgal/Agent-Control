/** Single source of UI state: the server snapshot, the route, the conversations
 * it carries and cosmetic preferences. Views read from `store` and never
 * keep their own copies, so one `sync()` + one render keeps every pane current. */
import {routeHash, tintOf} from './ui-model.js?v=b55825ff2c';
import {createOutbox} from './chats.js?v=b55825ff2c';

// Where an earlier build kept conversations; read once by importLocalChats().
const CHAT_KEY = 'agent-control-bot-chats-v2';
const META_KEY = 'agent-control-bot-profiles-v2';
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
  /** Conversations by id: the workspace's copy plus anything still being sent. */
  messages: {},
  profiles: loadLocal(META_KEY, {}),
  listFilter: 'all',
  listQuery: '',
  /** Conversation ids with a reply in flight; drives the typing indicator. */
  typing: new Set(),
  /** The group settings pipeline being reordered: {groupId, rows}, unsaved. */
  pipelineDraft: null,
};
// `profiles` is cosmetic UI state only (tint, pin). An earlier build also wrote
// name/instructions here, which would shadow the server's values forever.
const cleanProfiles = profiles => {
  let changed = false;
  for (const id of Object.keys(profiles)) {
    const entry = profiles[id];
    if (!entry || typeof entry !== 'object') { delete profiles[id]; changed = true; continue; }
    for (const legacy of ['name', 'instructions']) {
      if (legacy in entry) { delete entry[legacy]; changed = true; }
    }
  }
  return changed;
};
if (!store.profiles || typeof store.profiles !== 'object' || Array.isArray(store.profiles)) store.profiles = {};
// Stripping in memory only re-ran on every load against the same stored object,
// so the keys came straight back. Write the cleaned copy once instead, and the
// legacy shape never comes back after the first boot on this build.
if (cleanProfiles(store.profiles)) saveLocal(META_KEY, store.profiles);

export const isStaticDemo = () => { const m = document.querySelector('meta[name="agent-backend"]'); return !m || m.getAttribute('content') === 'static'; };
export const isAdmin = () => !isStaticDemo() && ['owner', 'admin'].includes(store.state?.me?.role);
export const canWrite = () => isStaticDemo() || ['owner', 'admin', 'member'].includes(store.state?.me?.role);
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

// Sent in the background, without the busy bar: a message is on screen already.
const outbox = createOutbox((key, messages) => window.AGENT_API(`/api/chats/${key}/messages`, 'POST', {messages}));
// A group run polls /api/state on its own while the workspace poll does too.
// Whichever response returns last used to win, so an older snapshot could wipe
// a browser card or a follow-up line and leave the slow poll in charge.
let epoch = 0, appliedFetch = 0;
/** Bumped on sign-out. An in-flight snapshot must not restore the workspace. */
export const sessionEpoch = () => epoch;
export const retireSession = () => { epoch += 1; };
/** Fetch the workspace and fold its conversations into what is on screen. */
export async function loadState() {
  const ticket = epoch;
  await outbox.settle();
  if (ticket !== epoch) return store.state;
  const fetch = outbox.beginFetch();
  const snap = await api('/api/state');
  if (ticket !== epoch || fetch < appliedFetch) return store.state;
  appliedFetch = fetch;
  store.state = snap;
  store.messages = outbox.adopt(store.state.chats || {}, store.messages, fetch);
  return store.state;
}
export async function sync(scope = 'all') { await loadState(); changed(scope); return store.state; }
/** Conversations an earlier build kept in this browser move to the workspace
 * once, so they follow the account. A conversation the workspace already has
 * is left alone. */
export async function importLocalChats() {
  const legacy = loadLocal(CHAT_KEY, null);
  if (!legacy || typeof legacy !== 'object' || store.state?.me?.role === 'viewer') return;
  let offline = false;
  // What still has to travel. A refusal is this key's own news (the bot is gone,
  // or the role is read-only) and would be refused again on every boot, so it is
  // dropped; a network failure keeps the key for the next try. Deleting the
  // whole blob after one refused key used to throw away every other transcript.
  const unsent = {};
  for (const [key, list] of Object.entries(legacy)) {
    if (!Array.isArray(list) || store.messages[key]?.length || !conversation(key)) continue;
    const messages = list.slice(-300).filter(m => m?.text && ['user', 'bot', 'system'].includes(m.role)).map(m => ({...m, id: m.id || crypto.randomUUID()}));
    if (!messages.length) continue;
    try { await window.AGENT_API(`/api/chats/${key}/messages`, 'POST', {messages}); }
    catch (error) {
      if (error?.status) continue;
      offline = true;
      unsent[key] = list;
    }
  }
  if (offline && Object.keys(unsent).length) { saveLocal(CHAT_KEY, unsent); return; }
  try { localStorage.removeItem(CHAT_KEY); } catch { /* Storage is unavailable; nothing to remove. */ }
  await loadState();
}

export const groups = () => store.state?.groups || [];
export const teamKey = groupId => `team-${groupId}`;
export const findGroup = id => groups().find(g => g.id === id);
export const groupOfBot = botId => groups().find(g => g.bots.some(b => b.id === botId));
export const botTint = (group, botId) => {
  const index = group?.bots.findIndex(b => b.id === botId) ?? 0;
  return tintOf(group?.bots[index] || {id: botId}, index, store.profiles);
};
/** A bot of any group, for @mentioned guests that answer outside their own group. */
export const findBot = botId => groupOfBot(botId)?.bots.find(b => b.id === botId) || null;

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
  const message = {id: crypto.randomUUID(), at: new Date().toISOString(), ...entry};
  (store.messages[key] ??= []).push(message);
  outbox.add(key, message);
  changed('thread');
}
export async function clearMessages(key) {
  // Let queued sends land before the DELETE: a send that was already queued
  // would otherwise POST after the clear and repopulate the conversation. The
  // DELETE also cancels the runs this chat was waiting on, in both backends.
  await outbox.settle();
  await api(`/api/chats/${key}`, 'DELETE');
  outbox.forget(key); delete store.messages[key]; changed();
}
export function setTyping(key, on) { on ? store.typing.add(key) : store.typing.delete(key); changed('thread'); }
export function setProfile(botId, patch) { store.profiles[botId] = {...(store.profiles[botId] || {}), ...patch}; saveLocal(META_KEY, store.profiles); }
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

/** Coordination runs, newest first. Both backends keep them in the workspace
 * snapshot, so a leftover demo pause can never show Approve on a live server. */
export function recentRuns(groupId) {
  return (store.state?.groupRuns || []).filter(r => r.groupId === groupId)
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

/** Entries this session pushed, so an in-app back arrow can pop one instead of
 * stacking a new entry that the system Back button would bounce off. */
let depth = 0;
/** Sync our depth from the history entry we are landing on. Back and Forward
 * both fire `popstate`, so the entry's stored depth is the source of truth;
 * decrementing blindly corrupted the count on Forward. */
export const syncDepth = event => { depth = (event && event.state && typeof event.state.depth === 'number') ? event.state.depth : 0; };
/** In-app back: pop our own history entry when there is one, else go to `fallback`. */
export function back(fallback = {}) { if (depth > 0) history.back(); else go(fallback, {replace: true}); }

/** Navigate. Every pane repaints from `store.route`, and the hash keeps
 * browser Back/Forward and reload working. */
export function go({chat = null, page = null, info = null} = {}, {replace = false} = {}) {
  store.route = {chat, page, info};
  const hash = `#${routeHash(store.route)}`;
  if (location.hash !== hash) {
    depth = replace ? depth : depth + 1;
    history[replace ? 'replaceState' : 'pushState']({depth}, '', hash);
  }
  changed('route');
}
