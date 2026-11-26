/** View models for the chat UI. Pure functions from the stored snapshot to what
 * a pane shows: the chat list, a thread's timeline and the "needs you" count.
 * (The hash route lives in ui-company.js.) No DOM and no globals, so the product rules here are unit
 * tested directly (tests/ui-model.test.js). */
import {botSettings} from './bot-settings.js?v=29e5a7fba2';
import {STOPPABLE_STATUSES} from './run-state.js?v=29e5a7fba2';
import {primaryOf} from './company.js?v=29e5a7fba2';
import {plain} from './ui-kit.js?v=29e5a7fba2';

const teamKey = groupId => `team-${groupId}`;
const time = value => { const t = Date.parse(value || ''); return Number.isFinite(t) ? t : 0; };

/** A run with no chatKey is the group chat. Otherwise it is the conversation it started in. */
export function runBelongsToChat(run, chatKey) {
  return run?.chatKey ? run.chatKey === chatKey : chatKey === teamKey(run?.groupId);
}

/** How many things in a group are blocked on the human: runs paused at a
 * checkpoint. Plans, page
 * requests and 1:1 checkpoints are per chat, so the chat list adds those on
 * the row that holds them. */
export function needsYou(state, group) {
  if (!state || !group) return 0;
  return (state.groupRuns || []).filter(r => r.groupId === group.id && r.status === 'awaiting_checkpoint').length;
}

/** Pending browser requests in one chat that no ask covers (one made before asks existed). Dispatched and
 * finished ones are the device's, not the person's; a request with an ask is counted as that ask. */
export function pendingBrowser(state, chatKey) {
  return (state?.browserRequests || []).filter(r => r.status === 'pending' && !r.askId && r.chatKey === chatKey).length;
}

/** Asks waiting on the owner in one chat: the ones in it, and, in the primary's chat, every other one too
 * (its "Needs you" list holds a copy of each). */
export function pendingAsksIn(state, chatKey) {
  const pending = (state?.asks || []).filter(a => a?.status === 'pending');
  return pending.filter(a => a.chatKey === chatKey || (primaryOf(state)?.id === chatKey)).length;
}

/** Who a Retry should talk to, and which conversation it reports into.
 * A tracked run must name the primary bot again, or the retry becomes the whole pipeline. */
export function retryTarget(group, run) {
  const lead = (group?.bots || []).find(b => botSettings(b).lead);
  const direct = run?.mode === 'tracked' ? (lead?.id || '') : run?.mode === 'direct' ? (run.recipients?.[0] || '') : '';
  return {direct, chat: run?.chatKey || ''};
}

// System lines with a kind of their own paint a card, not a run note.
const RUN_LESS_KINDS = new Set(['browser', 'subagent', 'peer', 'bot-created', 'limit', 'guard', 'model-limit', 'learned']);

/** A system line that may carry Start, Retry or Approve. A browser card or a
 * sub-agent line has its own presentation and returns before those, so it must
 * not count as the note: otherwise the action is computed for a line that never
 * paints it, and the real note loses its button. */
export function isRunNote(message) {
  return Boolean(message && message.role === 'system' && message.runId && !RUN_LESS_KINDS.has(message.kind));
}


/** Run statuses that still have work ahead of them: about to start, between two
 * steps, or waiting on a person. The vocabulary lives in `shared/run-state.js`
 * with the server's, so the two cannot drift. `awaiting_plan` is left out on
 * purpose: that note already offers Cancel next to Start, and two buttons that
 * stop the same run in one row read as two different outcomes. */
const STOPPABLE = new Set(STOPPABLE_STATUSES.filter(status => status !== 'awaiting_plan'));

/** The buttons a run's status offers, from the status alone: Start and Cancel
 * at a plan, Approve at a checkpoint, Stop while it still has work, Retry once
 * it failed or was interrupted. Retry needs the Node build, so `live` gates it;
 * the rest are answered by the status. The thread's run note and the run card in
 * the info panel both read this, so the two cannot drift apart. */
export function runButtons({status, live = false} = {}) {
  return {
    plan: status === 'awaiting_plan',
    checkpoint: status === 'awaiting_checkpoint',
    stop: STOPPABLE.has(status),
    retry: Boolean(live) && (status === 'failed' || status === 'interrupted'),
  };
}

/** Buttons one system line may show at once. They stack. Plans and
 * checkpoints also show on the static demo; Stop and Retry act on the newest
 * note of the newest run, and Retry needs the Node build. */
export function threadLineActions({status, live = false, note = false, latest = false} = {}) {
  const newest = Boolean(note && live && latest);
  const buttons = runButtons({status, live: newest});
  return {
    // A plan and a checkpoint are answered on any build: the run stopped for a
    // person, and the demo pauses too.
    plan: Boolean(note && buttons.plan),
    checkpoint: Boolean(note && buttons.checkpoint),
    // Anything the run can still do is something a person can call off, and
    // Retry is its opposite, so a run never offers both.
    stop: newest && buttons.stop,
    retry: newest && buttons.retry,
  };
}

/** Workspace runs first, then any same-id local simulation record only when
 * the workspace has no copy. A stale local "waiting" plan must not outvote
 * the server, and a demo plan that was never stored on the workspace still counts. */
function mergedRuns(state, localRuns) {
  const seen = new Set(), runs = [];
  for (const run of [...(state?.groupRuns || []), ...(localRuns || [])]) {
    if (!run) continue;
    // A run with no id still counts (a checkpoint is one). Only a repeated id
    // is dropped, and the workspace copy is the one that was seen first.
    if (run.id && seen.has(run.id)) continue;
    if (run.id) seen.add(run.id);
    runs.push(run);
  }
  return runs;
}

/** Everything in one chat that is blocked on the human: runs paused at a plan or a checkpoint, browser
 * and pages still waiting on approval.
 * The chat list, the chat header and the info panel all read this one answer, so
 * the three cannot disagree about what needs a person.
 *
 * `runs` lets a caller pass the runs it merged against its own local copy (the
 * Pages demo keeps a run in localStorage); by default the state's own list. */
export function waitingOnYou(state, chatKey, runs = state?.groupRuns || []) {
  return {
    plans: runs.filter(r => r.status === 'awaiting_plan' && runBelongsToChat(r, chatKey)).length,
    pauses: runs.filter(r => r.status === 'awaiting_checkpoint' && runBelongsToChat(r, chatKey)).length,
    pages: pendingBrowser(state, chatKey),
    asks: pendingAsksIn(state, chatKey),
  };
}

/** How many things one chat's `waitingOnYou` answer adds up to: the badge the
 * chat list and the "needs you" filter count. */
export const totalWaitingOnYou = ({plans = 0, pauses = 0, pages = 0, asks = 0} = {}) => plans + pauses + pages + asks;

function preview(history, {isTeam, fallback}) {
  // A bot's working step (it went to fetch pages) is not what the chat says; the answer after it is.
  const last = history.filter(m => !m.step).at(-1);
  if (!last) return {text: fallback, sender: ''};
  const text = plain(last.text).slice(0, 120);
  if (last.role === 'user') return {text, sender: 'You'};
  if (last.role === 'bot' && isTeam) return {text, sender: last.senderName || ''};
  return {text, sender: ''};
}

/** Rows for the chat list: every group conversation and every bot, pinned
 * first, then most recent activity, otherwise in their natural order. */
export function chatRows({state, messages = {}, profiles = {}, typing = new Set(), filter = 'all', query = '', localRuns = []}) {
  const rows = [];
  const groupRuns = mergedRuns(state, localRuns);
  const view = {...(state || {}), groupRuns};
  for (const group of state?.groups || []) {
    const tint = bot => tintOf(bot, group.bots.indexOf(bot), profiles);
    const members = group.bots.map(bot => ({name: bot.name, tint: tint(bot)}));
    const teamId = teamKey(group.id), teamHistory = messages[teamId] || [];
    const team = waitingOnYou(view, teamId), needs = totalWaitingOnYou(team);
    rows.push({
      id: teamId, isTeam: true, name: group.name, members, needs, pinned: false, typing: typing.has(teamId),
      at: teamHistory[teamHistory.length - 1]?.at || '',
      ...(team.pages ? {text: team.pages === 1 ? 'Wants to open a page' : `${team.pages} pages waiting on you`, sender: ''} : preview(teamHistory, {isTeam: true, fallback: needs ? `${needs} waiting on you` : (group.description || 'Message the whole team')})),
    });
    for (const bot of group.bots) {
      const history = messages[bot.id] || [], mine = waitingOnYou(view, bot.id);
      rows.push({
        id: bot.id, isTeam: false, name: bot.name, tint: tint(bot), needs: totalWaitingOnYou(mine), groupName: group.name,
        pinned: Boolean(profiles[bot.id]?.pinned), typing: typing.has(bot.id),
        at: history[history.length - 1]?.at || '',
        ...(mine.pages ? {text: mine.pages === 1 ? 'Wants to open a page' : `${mine.pages} pages waiting on you`, sender: ''} : preview(history, {isTeam: false, fallback: bot.instructions || 'Say what you need'})),
      });
    }
  }
  const q = String(query).trim().toLowerCase();
  const kept = rows.filter(r => {
    if (filter === 'needs' && !r.needs) return false;
    if (filter === 'groups' && !r.isTeam) return false;
    if (filter === 'bots' && r.isTeam) return false;
    return !q || `${r.name} ${r.text} ${r.groupName || ''}`.toLowerCase().includes(q);
  });
  return kept.map((row, order) => ({row, order}))
    .sort((a, b) => Number(b.row.pinned) - Number(a.row.pinned) || time(b.row.at) - time(a.row.at) || a.order - b.order)
    .map(x => x.row);
}

/** A thread is the saved messages, in time order. */
export function timeline({conv, state, messages = {}}) {
  const items = (messages[conv.id] || []).map(message => ({kind: 'message', at: message.at, message}));
  const sorted = items.map((item, order) => ({item, order}))
    .sort((a, b) => time(a.item.at) - time(b.item.at) || a.order - b.order)
    .map(x => x.item);
  const out = [];
  let day = null, lastSender = null;
  for (const item of sorted) {
    const d = new Date(time(item.at)).toDateString();
    if (d !== day) { day = d; lastSender = null; out.push({kind: 'day', at: item.at}); }
    const sender = item.kind === 'message' ? `${item.message.role}:${item.message.senderId || item.message.senderName || ''}` : item.kind;
    out.push({...item, lead: sender !== lastSender});
    lastSender = item.kind === 'message' ? sender : null;
  }
  return out;
}

/** A bot's avatar colour: the synced setting, then this browser's pick, then
 * its position in the group. */
export function tintOf(bot, index = 0, profiles = {}) {
  const synced = bot?.settings?.tint;
  if (Number.isInteger(synced)) return synced;
  return profiles[bot?.id]?.avatarIndex ?? Math.max(0, index);
}

/** What a chat says when a message could not reach the server at all. */
export const OFFLINE_TEXT = 'You seem to be offline, so this was not sent.';
/** A send that never got an answer: the request timed out (shared/transport.js marks that) or the network refused
 * it (fetch rejects with a TypeError). An answer the server gave, even an error, is not this. */
export function isOfflineError(error) {
  if (!error || Number.isFinite(error.status)) return false;
  if (error.timeout === true || error.name === 'TimeoutError' || error.name === 'AbortError') return true;
  return error.name === 'TypeError' && /fetch|network|load failed|connection/i.test(String(error.message || ''));
}

/** Share to Agent Control: the manifest's `share_target` sends what the phone's Share sheet holds to `./?share-…`.
 * The parameter names, read here and named in shared/manifest.webmanifest. */
export const SHARE_PARAMS = {title: 'share-title', text: 'share-text', url: 'share-url'};

/** What was shared, as one draft for the message box: the title, the text, then the link unless the text already
 * holds it; null when nothing was shared. A draft only: the owner reads it and presses Send. */
export function sharedDraft(search) {
  const q = new URLSearchParams(String(search ?? ''));
  const get = key => String(q.get(SHARE_PARAMS[key]) ?? '').trim();
  const title = get('title'), text = get('text'), url = get('url');
  const parts = [];
  if (title && title !== text) parts.push(title);
  if (text) parts.push(text);
  if (url && !text.includes(url)) parts.push(url);
  const draft = parts.join('\n').slice(0, 4000);
  return draft || null;
}

/** The address with the shared words taken out, so a reload does not paste them again. */
export function withoutShareParams(search) {
  const q = new URLSearchParams(String(search ?? ''));
  for (const name of Object.values(SHARE_PARAMS)) q.delete(name);
  const rest = q.toString();
  return rest ? `?${rest}` : '';
}

/** The keys the app answers to, for the shortcuts sheet (press ? or Settings → Look). Each names a real listener:
 * the search and the sheet in ui-shell.js, Enter in app.js, Alt+arrows and the menu key in ui-gestures.js. */
const SHORTCUTS = [
  {keys: ['Ctrl', 'K'], what: 'Search bots, threads and messages'},
  {keys: ['/'], what: 'Search, when you are not typing in a box'},
  {keys: ['Enter'], what: 'Send the message'},
  {keys: ['Shift', 'Enter'], what: 'Start a new line in the message'},
  {keys: ['Esc'], what: 'Close a sheet or the search'},
  {keys: [','], what: 'Open Settings'},
  {keys: ['Alt', '↑ ↓'], what: 'Move a chat up or down the list, or pin it at the top'},
  {keys: ['Shift', 'F10'], what: 'Open the menu of the chat in focus'},
  {keys: ['?'], what: 'Show these shortcuts'},
];

/** The shortcuts as rows, with ⌘ for Ctrl on a Mac. */
export function shortcutRows(mac = false) {
  return SHORTCUTS.map(s => ({what: s.what, keys: s.keys.map(k => (mac && k === 'Ctrl' ? '⌘' : k))}));
}


/** What a control in the takeover sheet is for. `field` is a control the owner may choose to type into: a text
 * input, a textarea or a select. A button-type input (submit, button, reset, image) is clicked, never typed into.
 * `text` is a control a person types text in, the only kind a password or code goes to: not a select, a checkbox,
 * a radio, a file, a range or a colour picker. The device checks the same thing on the page (`isTextEntry`). */
export function takeoverControl(element) {
  const tag = String(element?.tag || '');
  const type = String(element?.type || '').toLowerCase();
  const button = tag === 'input' && ['submit', 'button', 'reset', 'image'].includes(type);
  const field = !button && ['input', 'textarea', 'select'].includes(tag);
  const text = field && (tag === 'textarea' || (tag === 'input' && !['checkbox', 'radio', 'file', 'range', 'color'].includes(type)));
  return {field, text};
}
