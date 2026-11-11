/** A bot's own chat and a thread: header, the feed, the composer, and the cards
 * that wait on the owner (an ask, a checkpoint, out-of-job, a page request). What the feed
 * holds is decided by ui-feed.js; this file turns those entries into markup and
 * keeps the open chat's DOM current.
 *
 * The frame (header, log, composer) is painted once per opened chat and only the
 * log and the status line are repainted after that, so a background refresh can
 * never wipe what is being typed. The log is only replaced when its markup
 * changed, which keeps a scrolled-up reader where they are. */
import {OFFJOB_CHOICES} from './off-job.js?v=a818ff62f8';
import {LIMIT_CHOICES, limitText} from './ask-limits.js?v=a818ff62f8';
import {requestOfMessage} from './bot-browser.js?v=a818ff62f8';
import {validHttpUrl} from './core.js?v=a818ff62f8';
import {timeline, threadLineActions, retryTarget, waitingOnYou, totalWaitingOnYou} from './ui-model.js?v=a818ff62f8';
import {botStatus, botIsManager, chatStatus, jobOf} from './ui-company.js?v=a818ff62f8';
import {hasJob} from './ui-profile-model.js?v=a818ff62f8';
import {feed} from './ui-feed.js?v=a818ff62f8';
import {askCard} from './ui-asks.js?v=a818ff62f8';
import {face, botColor} from './ui-face.js?v=a818ff62f8';
import {esc, icon, btn, dayLabel, tag, md, plain} from './ui-kit.js?v=a818ff62f8';
import {store, conversation, findBot, groups, isStaticDemo, isLive, canWrite, recentRuns, go, api, sync} from './ui-store.js?v=a818ff62f8';
import {runAnyway, startThread, answerLimit} from './ui-chat.js?v=a818ff62f8';
import {toast} from './ui-dialogs.js?v=a818ff62f8';
import {siteChip} from './ui-computer-view.js?v=a818ff62f8';

const el = id => document.getElementById(id);
/** esc() only makes a value markup-safe: a `javascript:` URL comes out of it
 * unchanged, so an href always goes through validHttpUrl. */
const safeHref = value => validHttpUrl(value) || '#';
const NEW_THREAD_CHIPS = ['What can you do?', 'Create a bot that checks my drafts'];

/* ---------- faces and names ---------- */

/** An open chat's bot is up, so an idle one is drawn awake and not asleep. */
const awake = id => { const state = botStatus(store.state, id); return state === 'asleep' ? 'awake' : state; };
const company = () => groups().find(g => g.id === 'home')?.bots || [];
/** A bot's face at `size`. A bot that is gone still gets a neutral one, by name. */
function botFace(bot, name, size, opts = {}) {
  const bots = company(), index = Math.max(0, bots.indexOf(bot)), stored = bot || {id: '', name, settings: {}};
  return face(stored, {size, index, manager: bot ? botIsManager(store.state, bot.id) : false, ...opts});
}
const tintOf = (bot, name) => botColor(bot || {name, settings: {}}, Math.max(0, company().indexOf(bot)));
/** The bot a chat is talking to: the bot itself, or Atlas for a thread. */
const askerOf = conv => conv.bot || findBot(conv.group.settings?.ownerId) || company().find(b => b.settings?.lead === true) || null;

/* ---------- the frame ---------- */

/** Paint the header, an empty log and the composer for a newly opened chat. */
export function conversationShell(conv) {
  const write = canWrite(), thread = conv.isTeam, bot = conv.bot;
  const label = store.section === 'threads' ? 'Threads' : 'Bots';
  const who = bot ? `<button type="button" class="cv-who" data-action="open-profile" data-id="${esc(bot.id)}" data-state="${awake(bot.id)}" aria-label="${esc(bot.name)}'s profile">${botFace(bot, bot.name, 36, {state: awake(bot.id), hop: true})}</button>` : '';
  const hint = write ? (thread ? 'Reply to Atlas' : `Message ${conv.name}`) : 'Viewers cannot send messages';
  el('main').innerHTML = `<section class="cv" aria-label="${esc(conv.name)}">
    <header class="cv-head">
      <button type="button" class="rbtn" data-action="back-to-list" aria-label="Back to ${label}">${icon('back', 20)}</button>
      ${who}
      <div class="cv-title"><h1>${esc(conv.name)}</h1><span id="cv-line"></span></div>
    </header>
    <div class="cv-scroll" id="cv-scroll"><div class="cv-col" id="cv-log" role="log" aria-live="off" aria-label="Conversation"></div></div>
    <form id="chat-form" class="cv-composer" autocomplete="off"><div class="cv-box">
      <textarea name="message" rows="1" placeholder="${esc(hint)}" aria-label="${esc(hint)}" maxlength="4000" required${write ? '' : ' disabled'}></textarea>
      <button type="submit" class="cv-send" aria-label="Send message"${write ? '' : ' disabled'}>${icon('send', 20)}</button>
    </div></form>
  </section>`;
  lastHtml = null; born.conv = null; pillSeen.clear();
}

/** The line under the title: what the chat is doing right now, else what it is. */
function statusLine(conv) {
  const {state} = store, runs = recentRuns(conv.group.id).filter(r => !r.chatKey || r.chatKey === conv.id);
  const waiting = totalWaitingOnYou(waitingOnYou(state, conv.id)) > 0 || runs.some(r => String(r.status).startsWith('awaiting'));
  if (waiting) return {text: 'Waiting on you', waiting: true};
  const live = runs.find(r => r.status === 'running' || r.status === 'queued');
  if (live || store.typing.has(conv.id)) {
    const name = askerOf(conv)?.name || conv.name;
    return {text: `${name} working`, waiting: false};
  }
  return {text: conv.isTeam ? 'Atlas runs this thread' : chatStatus(state, conv.bot.id), waiting: false};
}

/* ---------- entries ---------- */

const BROWSER_STATUS = {pending: ['Waiting on you', 'warn'], dispatched: ['Running', 'warn'], done: ['Done', 'good'], failed: ['Failed', 'bad'], denied: ['Declined', '']};
/** A bot's request to open a page. It says where it runs (this server or a paired
 * device), so "nothing happened" has an obvious cause. */
function browserEntry(m, conv) {
  const request = requestOfMessage(store.state, m.id);
  if (!request) return `<div class="cv-note"><span>${esc(m.text)}</span></div>`;
  const [label, tone] = BROWSER_STATUS[request.status] || [request.status, ''];
  const where = request.status === 'pending' ? '' : ` · ${request.via === 'server' ? 'this server' : 'your device'}`;
  const steps = request.steps?.length ? `<ol class="cv-steps">${request.steps.map(s => `<li>${esc(s.op)} ${esc(s.url || (s.index ? `#${s.index}` : s.selector) || '')}${s.text ? ` · "${esc(String(s.text).slice(0, 60))}"` : ''}</li>`).join('')}</ol>` : '';
  const decline = btn('Decline', 'deny-browser', {id: request.id, small: true});
  // A page behind a sign-in: the person can drive it. Only the Node build has a server browser.
  const takeover = !isStaticDemo() && request.status === 'pending' ? btn('Take over', 'takeover-browser', {id: request.id, small: true}) : '';
  const acts = !canWrite() ? '' : request.status === 'pending' ? `<div class="acts">${btn('Approve', 'approve-browser', {id: request.id, small: true, kind: 'primary'})}${takeover}${decline}</div>`
    : request.status === 'dispatched' ? `<div class="acts">${decline}</div>` : '';
  const bot = findBot(request.botId) || askerOf(conv);
  const waiting = request.status === 'pending' ? `<div class="cv-wait">${botFace(bot, request.botName || 'A bot', 30, {state: 'waiting'})}<span>${esc(request.botName || bot?.name || 'A bot')} is waiting on you<span class="dots" aria-hidden="true"><i></i><i></i><i></i></span></span></div>` : '';
  return `${waiting}<div class="cv-card${request.status === 'pending' ? '' : ' flat'}"><p>${esc(m.text)} ${tag(`${label}${where}`, tone)}</p><a href="${esc(safeHref(request.url))}" target="_blank" rel="noopener noreferrer">${esc(request.url)}</a>${steps}${request.error ? `<small>${esc(request.error)}</small>` : ''}${acts}</div>`;
}

/** An ask: a bot needs the owner's yes before it goes on. Open, it keeps the asking bot's waiting face above one
 * sentence and its buttons (Decline, Allow, Always allow for this bot; a payment has no Always). Answered, it
 * collapses to one muted line. Its status is read from state.asks, so the line itself never changes. */
function askEntry({message: m}, conv) {
  const card = askCard(store.state, m);
  if (!card.open) return `<div class="cv-note cv-asked" data-ask="${esc(m.askId)}"><span>${esc(card.text)}</span></div>`;
  const bot = findBot(card.botId) || askerOf(conv), name = card.botName;
  const choose = ({id, label, primary}) => btn(label, 'ask-answer', {id: card.askId, small: true, kind: primary ? 'primary' : 'quiet', data: {choice: id}});
  const acts = canWrite() ? `<div class="acts">${card.choices.map(choose).join('')}</div>` : '<small>Only a member can answer.</small>';
  const target = card.target ? `<a href="${esc(safeHref(card.target))}" target="_blank" rel="noopener noreferrer">${esc(card.target)}</a>` : '';
  // The whole message a send or draft would carry, folded under the sentence so the owner can read every word before saying yes.
  const body = card.body ? `<details class="cv-ask-body"><summary>Full message${icon('chevron', 13)}</summary><pre>${esc(card.body)}</pre></details>` : '';
  return `<div class="cv-wait">${botFace(bot, name, 36, {state: 'waiting'})}<span>${esc(name)} is waiting on you<span class="dots" aria-hidden="true"><i></i><i></i><i></i></span></span></div><div class="cv-card" data-ask="${esc(m.askId)}"><p>${esc(m.text)}</p>${target}${body}${card.note ? `<small>${esc(card.note)}</small>` : ''}${acts}</div>`;
}

/** A system line. The newest note of a run also carries what the run offers. */
function noteEntry(entry, conv) {
  const {message: m, run} = entry, write = canWrite();
  const runs = recentRuns(conv.group.id), flags = threadLineActions({status: run?.status, live: !isStaticDemo(), note: Boolean(run), latest: Boolean(run) && runs[0]?.id === run.id});
  const group = {id: conv.group.id, small: true};
  const parts = run && write ? [
    flags.plan && btn('Start', 'approve-plan', {...group, kind: 'primary', data: {run: run.id}}) + btn('Cancel', 'cancel-plan', {...group, data: {run: run.id}}),
    flags.checkpoint && btn('Approve next step', 'continue-run', {...group, kind: 'primary', data: {run: run.id}}),
    flags.retry && btn('Retry', 'retry-run', {...group, data: {run: run.id, message: run.input || '', ...retryTarget(conv.group, run)}}),
    flags.stop && btn('Stop', 'cancel-run', {...group, data: {run: run.id}}),
  ] : [];
  return `<div class="cv-note"><span>${esc(m.text)}</span>${parts.filter(Boolean).join('')}</div>`;
}

/** The pill: live while work is under way, then quiet, opening the handoffs. */
const openRuns = new Set();
const pillSeen = new Map();
function pillEntry({run, pill, handoffs}, conv) {
  const bots = company(), nameOf = id => bots.find(b => b.id === id)?.name || 'A bot';
  if (pill.done) {
    const log = handoffs.map(h => `<li><span class="who"><b>${esc(nameOf(h.from))}</b><span>to ${esc(nameOf(h.to))}</span></span><div class="md">${md(h.text)}</div></li>`).join('');
    return `<details class="cv-prog cv-done" data-pid="${esc(run.id)}"${openRuns.has(run.id) ? ' open' : ''}><summary><span>${esc(pill.text)}</span>${icon('chevron', 13)}</summary><ol class="cv-plog">${log}</ol></details>`;
  }
  const bot = bots.find(b => b.id === pill.botId) || askerOf(conv), waiting = String(run.status).startsWith('awaiting');
  // While a bot browses the pill carries the site, which opens the live view; while you hold the browser it says so.
  const chip = siteChip({runId: run.id, botId: pill.botId}), text = chip?.driving ? 'You are driving' : pill.text;
  return `<div class="cv-prog"><div class="cv-live" data-run="${esc(run.id)}">${botFace(bot, nameOf(pill.botId), 22, {state: waiting ? 'waiting' : 'working'})}<span class="cv-cur" data-text="${esc(text)}">${esc(text)}</span>${chip?.html || ''}</div></div>`;
}

/** What the runaway guard asks: Keep going or Stop, for everything bots started. */
const guardButtons = () => canWrite() ? `<div class="acts">${btn('Keep going', 'guard-resume', {kind: 'primary'})}${btn('Stop', 'guard-stop')}</div>` : '';

/** The card a paused run leaves: what happened in one sentence, then the choices.
 * A limit on bot-to-bot asks offers its three (answered on the run); the runaway
 * guard offers two (answered for every run the guard parked). */
function limitEntry({run}, conv) {
  const bot = askerOf(conv), name = bot?.name || 'A bot', guard = run.limit?.kind === 'guard';
  const choice = ({choice: id, label}) => btn(label, 'limit-choice', {kind: id === 'more' ? 'primary' : 'quiet', data: {choice: id, group: run.groupId || conv.group.id, run: run.id}});
  const acts = guard ? guardButtons() : canWrite() ? `<div class="acts">${LIMIT_CHOICES.map(choice).join('')}</div>` : '';
  const text = guard ? 'Bots are paused. This task goes on when you resume them.' : limitText(run);
  return `<div class="cv-wait">${botFace(bot, name, 30, {state: 'waiting'})}<span>${esc(name)} is waiting on you<span class="dots" aria-hidden="true"><i></i><i></i><i></i></span></span></div><div class="cv-card"><p>${esc(text)}</p>${acts}</div>`;
}

/** The primary's own line when the guard paused everything. Once answered it is a quiet note. */
function guardEntry({message: m, open}) {
  return open ? `<div class="cv-card flat"><p>${esc(m.text)}</p>${guardButtons()}</div>` : `<div class="cv-note"><span>${esc(m.text)}</span></div>`;
}

/** What a connector read or did, and on which account. A send held for Undo is a card with the button while its window
 * runs; after that, or once undone, it is one muted line like the rest. */
function connectorEntry({message: m, line}) {
  const acct = line.account ? `<em class="cn-acct">${esc(line.account)}</em>` : '';
  if (line.undo?.open && canWrite()) {
    return `<div class="cv-card flat cv-held" data-m="${esc(m.id)}"><p>${esc(line.text)}</p>${acct ? `<small>On ${acct}</small>` : ''}<div class="acts">${btn('Undo', 'undo-send', {id: line.undo.activityId, kind: 'primary', small: true})}</div></div>`;
  }
  return `<div class="cv-note cv-conn${line.tone === 'error' ? ' bad' : ''}" data-m="${esc(m.id)}"><span>${icon('plug', 13)}${esc(line.text)}</span>${acct}</div>`;
}

/** A usage limit: the server's sentence and, until the bot already uses it, a button to the provider it named. */
function modelLimitEntry({message: m, line}) {
  if (!line.open || !canWrite()) return `<div class="cv-note cv-conn" data-m="${esc(m.id)}"><span>${icon('chip', 13)}${esc(line.text)}</span></div>`;
  return `<div class="cv-card flat" data-m="${esc(m.id)}"><p>${esc(line.text)}</p><div class="acts">${btn(`Switch to ${line.switchTo.label}`, 'switch-model', {id: line.botId, kind: 'primary', small: true, data: {provider: line.switchTo.id, name: line.switchTo.label}})}</div></div>`;
}

function offjobEntry({message: m, open}, conv) {
  const bot = findBot(m.botId || m.senderId), name = bot?.name || m.senderName || conv.name;
  const choices = open && canWrite() ? `<div class="cv-card"><p>This is not ${esc(name)}'s job. What should happen to it?</p><div class="acts">${OFFJOB_CHOICES.map(c => btn(c.label, `offjob-${c.id}`, {kind: c.id === 'anyway' ? 'primary' : 'quiet', data: {message: m.id}})).join('')}</div></div>` : '';
  return `${botEntry(m, conv)}${choices}`;
}

function botEntry(m, conv) {
  const bot = m.senderId ? findBot(m.senderId) : conv.bot, name = bot?.name || m.senderName || conv.name;
  const job = conv.isTeam && bot ? `<small>${esc(jobOf(bot))}</small>` : '';
  return `<div class="cv-bot" data-m="${esc(m.id)}" style="--t:${tintOf(bot, name)}">${botFace(bot, name, 36)}<div class="cv-body"><div class="cv-name">${esc(name)}${job}</div><div class="md">${md(m.text)}</div></div></div>`;
}

function entryHtml(entry, conv) {
  switch (entry.kind) {
    case 'day': return `<div class="cv-day">${esc(dayLabel(entry.at))}</div>`;
    case 'me': return `<div class="cv-me">${esc(entry.message.text)}</div>`;
    case 'bot': return botEntry(entry.message, conv);
    case 'offjob': return offjobEntry(entry, conv);
    case 'browser': return browserEntry(entry.message, conv);
    case 'ask': return askEntry(entry, conv);
    case 'note': return noteEntry(entry, conv);
    case 'pill': return pillEntry(entry, conv);
    case 'limit': return limitEntry(entry, conv);
    case 'guard': return guardEntry(entry);
    case 'connector': return connectorEntry(entry);
    case 'model-limit': return modelLimitEntry(entry);
    default: return '';
  }
}

function welcome(conv) {
  const bot = conv.bot, server = !isStaticDemo();
  const about = conv.isTeam ? 'Atlas plans it and hands each part to the bot whose job it is.' : (hasJob(bot) ? bot.instructions : 'New, no job yet. Tell it what it should do.');
  const mode = isLive() ? 'Answers come from your AI provider. If a call fails, the chat says why.'
    : server ? 'No AI provider is configured. Add one under Settings, Models and keys. Until then this chat cannot answer.'
      : 'This is an offline demo: replies are built in, not from a live AI model.';
  return `<div class="cv-empty"><button type="button" class="hello" data-action="hop" aria-label="Say hi to ${esc(conv.name)}">${bot ? botFace(bot, bot.name, 84, {state: awake(bot.id)}) : ''}</button><h2>${esc(conv.name)}</h2><p>${esc(about)}</p><p class="sub">${esc(mode)}</p></div>`;
}

/* ---------- painting ---------- */

// Only NEW things animate: lines present when a chat opens are not "fresh", so
// the first reply after opening is the one that hops.
const born = {conv: null, seen: new Set()};
let lastHtml = null, spoken = null;

/** The log is rebuilt on every refresh, so it is not a live region itself: only a
 * genuinely new reply is spoken, through the hidden #announce node. */
function announce(conv, entries) {
  const last = [...entries].reverse().find(e => e.kind === 'bot' || e.kind === 'offjob')?.message, node = el('announce');
  if (!last || !node) return;
  const key = `${conv.id}:${last.id}`, first = spoken === null || !spoken.startsWith(`${conv.id}:`);
  if (key !== spoken && !first) node.textContent = `${last.senderName || conv.name}: ${plain(last.text).slice(0, 300)}`;
  spoken = key;
}

/** Add the one-off moments after a paint: a first reply hops, and a step of the
 * live pill pops its bot in. Classes are added to the DOM and never to the markup,
 * so an identical repaint is skipped and the animation is not restarted. */
function moments(entries) {
  const log = el('cv-log'); if (!log) return;
  for (const e of entries) {
    if (e.kind === 'bot' && !born.seen.has(e.message.id)) {
      born.seen.add(e.message.id);
      if (born.fresh) log.querySelector(`.cv-bot[data-m="${CSS.escape(e.message.id)}"] .face`)?.classList.add('face--hop');
    }
    if (e.kind === 'pill' && !e.pill.done) {
      const node = log.querySelector(`.cv-live[data-run="${CSS.escape(e.run.id)}"]`);
      if (node && pillSeen.get(e.run.id) !== e.pill.text) {
        if (pillSeen.has(e.run.id)) { node.querySelector('.cv-cur')?.classList.add('enter'); node.querySelector('.face')?.classList.add('face--hop'); }
        pillSeen.set(e.run.id, e.pill.text);
      }
    }
  }
  born.fresh = true;
}

/** A held send's Undo button must go when its window ends even if nothing else repaints the chat. */
let undoTimer = null;
function watchUndo(entries) {
  clearTimeout(undoTimer);
  const ends = entries.filter(e => e.kind === 'connector' && e.line.undo?.open).map(e => e.line.undo.until);
  if (!ends.length) return;
  undoTimer = setTimeout(renderConversation, Math.min(Math.max(Math.min(...ends) - Date.now(), 0) + 60, 60000));
}

/** Refresh the open chat's status line and log without touching the composer. */
export function renderConversation() {
  const conv = conversation(), log = el('cv-log'); if (!conv || !log) return;
  const line = statusLine(conv), node = el('cv-line');
  if (node) { node.textContent = line.text; node.classList.toggle('wt', line.waiting); }
  const who = document.querySelector('.cv-who');
  if (who && conv.bot && who.dataset.state !== awake(conv.bot.id)) { who.dataset.state = awake(conv.bot.id); who.innerHTML = botFace(conv.bot, conv.name, 36, {state: who.dataset.state}); }
  if (born.conv !== conv.id) { born.conv = conv.id; born.seen = new Set(); born.fresh = false; }
  const entries = feed({items: timeline({conv, state: store.state, messages: store.messages}), state: store.state, key: conv.id, now: Date.now()});
  announce(conv, entries);
  watchUndo(entries);
  const asker = askerOf(conv), live = entries.some(e => e.kind === 'pill' && !e.pill.done) || entries.some(e => e.kind === 'limit');
  const chip = store.typing.has(conv.id) && !live ? siteChip({botId: asker?.id}) : null;
  const working = store.typing.has(conv.id) && !live
    ? `<div class="cv-working">${botFace(asker, asker?.name || conv.name, 30, {state: 'working'})}<span>${chip?.driving ? 'You are driving' : `${esc(asker?.name || conv.name)} is working`}</span>${chip?.html || ''}</div>` : '';
  const html = (entries.length ? entries.map(e => entryHtml(e, conv)).join('') : welcome(conv)) + working;
  if (html === lastHtml) return;
  lastHtml = html;
  const scroller = el('cv-scroll'), pinned = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80, opened = log.dataset.conv !== conv.id;
  log.innerHTML = html;
  moments(entries);
  if (pinned || opened) scroller.scrollTop = scroller.scrollHeight;
  log.dataset.conv = conv.id;
}

/** Remember which handoff cards are open: `toggle` does not bubble, so app.js
 * listens for it in the capture phase. */
export function trackOpen(ev) {
  const pid = ev.target?.dataset?.pid; if (!pid || !ev.target.matches('details')) return;
  if (ev.target.open) openRuns.add(pid); else openRuns.delete(pid);
}

/** The new thread page: Atlas awake, everyone else asleep, one box. */
export function newThreadView() {
  const write = canWrite(), bots = company(), primary = bots.find(b => b.settings?.lead === true), others = bots.filter(b => b !== primary).slice(0, 12);
  const line = [primary, ...others].filter(Boolean).map(b => `<div>${botFace(b, b.name, b === primary ? 64 : 44, {state: b === primary ? 'awake' : 'asleep'})}<span>${esc(b.name)}</span></div>`).join('');
  const label = store.section === 'threads' ? 'Threads' : 'Bots';
  return `<section class="nv" aria-label="New thread">
    <header class="cv-head"><button type="button" class="rbtn" data-action="back-to-list" aria-label="Back to ${label}">${icon('back', 20)}</button></header>
    <div class="nv-in">
      <div class="nv-line" aria-hidden="true">${line}</div>
      <h2>What should the company get done?</h2>
      <p>Atlas plans it and hands each part to the bot whose job it is.</p>
      <form id="new-thread-form" class="cv-box" autocomplete="off">
        <textarea name="message" rows="1" placeholder="What should get done?" aria-label="What should get done?" maxlength="4000" required autofocus${write ? '' : ' disabled'}></textarea>
        <button type="submit" class="cv-send" aria-label="Start thread"${write ? '' : ' disabled'}>${icon('send', 20)}</button>
      </form>
      ${write ? `<div class="nv-chips">${NEW_THREAD_CHIPS.map(text => `<button type="button" data-action="quick-thread" data-text="${esc(text)}">${esc(text)}</button>`).join('')}</div>` : '<p>Viewers can read chats. A member can send.</p>'}
    </div>
  </section>`;
}

/* ---------- what the buttons do ---------- */

/** The out-of-job reply a button belongs to, looked up by id: its request is the
 * owner's own text, kept on the line by the server. */
const offjobOf = button => {
  const m = (store.messages[store.route.bot] || []).find(x => x.id === button.dataset.message);
  if (!m?.request || !m.botId) throw new Error('That request is no longer here. Say it again in the chat.');
  return m;
};
const hop = node => { const f = node?.querySelector('.face'); if (f) { f.classList.remove('face--hop'); void f.getBoundingClientRect(); f.classList.add('face--hop'); } };

/** The owner's answer to an ask card. The run that was parked on it carries on from the server, so the poll
 * (and the pill) follow it from here. */
async function answerAsk(id, answer) {
  const {ask} = await api(`/api/asks/${encodeURIComponent(id)}`, 'POST', {answer});
  await sync();
  toast(answer === 'decline' ? 'Declined.' : answer === 'always' ? `${findBot(ask?.botId)?.name || 'The bot'} may always do this.` : 'Allowed once.');
}

export const conversationActions = {
  'ask-answer': b => answerAsk(b.dataset.id, b.dataset.choice),
  'open-profile': b => go({profile: b.dataset.id}),
  hop: b => hop(b),
  'offjob-anyway': b => { const m = offjobOf(b); return runAnyway(m.botId, m.request); },
  'offjob-atlas': b => startThread(offjobOf(b).request),
  'offjob-new-bot': b => go({newBot: true, job: offjobOf(b).request}),
  'limit-choice': async b => { await answerLimit(b.dataset.group, b.dataset.run, b.dataset.choice); if (b.dataset.choice === 'stop') toast('Stopped. The bot reports what it has.'); },
  'quick-thread': b => startThread(b.dataset.text),
  // A send held for Undo: the server cancels it while its window is open (409 once it has gone out, which the toast says).
  'undo-send': async b => {
    try { await api(`/api/activity/${encodeURIComponent(b.dataset.id)}/undo`, 'POST', {}); toast('Undone. The email was not sent.'); }
    finally { await sync(); }
  },
  // The bot that hit a usage limit moves to the provider the server named; '' clears the model that would not fit it.
  'switch-model': async b => {
    await api(`/api/ai/bots/${encodeURIComponent(b.dataset.id)}`, 'PATCH', {providerId: b.dataset.provider, model: ''});
    toast(`Switched to ${b.dataset.name}.`);
    await sync();
  },
  // Keep going or Stop after the runaway guard paused what bots started: one switch for all of it.
  'guard-resume': async () => { await api('/api/guard', 'POST', {paused: false}); await sync(); toast('Bots are running again.'); },
  'guard-stop': async () => { await api('/api/guard', 'POST', {paused: false, stop: true}); await sync(); toast('Stopped what bots had started.'); },
};
export const conversationForms = {
  'new-thread-form': (form, f) => startThread(f.message),
};
