/** The two always-present panes: the chat list and the open thread.
 * Both are thin renderers over ui-model.js. The list shell and the composer are
 * painted once and then only their contents change, so a background refresh can
 * never wipe what the user is typing. */
import {botSuggestions} from './chat-engine.js';
import {summonableGuests} from './coordination.js';
import {botSettings, groupSettings} from './bot-settings.js';
import {requestOfMessage} from './bot-browser.js';
import {validHttpUrl} from './core.js';
import {chatRows, timeline, pendingBrowser, stuckFeedReads, draftStage, draftLength, lengthLabel, mentionSuggestions, retryTarget, threadLineActions, isRunNote, runBelongsToChat, ACTIVE_DRAFTS} from './ui-model.js';
import {esc, icon, avatar, groupAvatar, tintClass, clock, stamp, dayLabel, btn, iconBtn, tag, mascot} from './ui-kit.js';
import {store, conversation, groups, groupOfBot, findBot, isStaticDemo, isLive, canWrite, isXGroup, botTint, recentRuns} from './ui-store.js';

const el = id => document.getElementById(id);
const FILTERS = [['all', 'All'], ['needs', 'Needs you'], ['groups', 'Groups'], ['bots', 'Bots']];
/** esc() only makes a value markup-safe: a `javascript:` URL comes out of it
 * unchanged, so it is never enough for an href. Untrusted URLs are validated
 * here; where the anchor is the card itself it falls back to '#' rather than
 * disappearing, and where it is optional decoration the caller drops it. */
const safeHref = value => validHttpUrl(value) || '#';

/* ---------- chat list ---------- */

/** Painted once at boot; `renderList` then fills the dynamic parts. */
export function listShell() {
  const server = !isStaticDemo();
  const write = canWrite();
  el('sidebar').innerHTML = `
    <header class="list-head">
      <h1>Chats</h1>
      <div class="list-tools">
        ${server ? `<span id="bell-slot"></span>` : ''}
        ${write ? iconBtn('plus', 'New chat', 'new-chat', {cls: 'new-chat'}) : ''}
        <button type="button" class="icon-btn you" data-action="open-page" data-page="you" aria-label="You and settings" title="You and settings">${icon('dots', 22)}</button>
      </div>
    </header>
    <label class="search">${icon('search', 18)}<input id="chat-search" type="search" placeholder="Search bots and groups" aria-label="Search chats" autocomplete="off"></label>
    <div class="filters" id="list-filters" role="group" aria-label="Filter chats"></div>
    <nav class="chat-list" id="chat-list" aria-label="Chats"></nav>
    <footer class="list-foot">
      <span class="promise">${icon('lock', 14)} Bots draft. You post. Always.</span>
      <span class="backend">${server ? 'Connected to Node server' : 'Browser-only prototype · data stays in this browser'}</span>
      ${write ? `<button type="button" class="fab" data-action="new-chat" aria-label="New chat">${icon('plus', 24)}</button>` : ''}
    </footer>`;
}

function chatRow(row) {
  const current = store.route.chat === row.id;
  const face = row.isTeam ? groupAvatar(row.members, 50) : avatar(row.name, row.tint, 50);
  const text = row.typing ? '<span class="typing-text">typing…</span>' : `${row.sender ? `<span class="who">${esc(row.sender)}:</span> ` : ''}${esc(row.text)}`;
  return `<button type="button" class="chat-row${current ? ' current' : ''}" data-action="open-chat" data-id="${esc(row.id)}" ${current ? 'aria-current="page"' : ''}>
    ${face}
    <span class="chat-row-main">
      <span class="chat-row-top"><span class="chat-row-name">${esc(row.name)}${row.pinned ? icon('pin', 13) : ''}</span><time class="${row.needs ? 'warn' : ''}">${esc(stamp(row.at))}</time></span>
      <span class="chat-row-bottom"><span class="chat-row-preview">${text}</span>${row.needs ? `<span class="badge" aria-label="${row.needs} waiting on you">${row.needs}</span>` : ''}</span>
    </span>
  </button>`;
}

/** Demo plans live in the local run log, not on the workspace snapshot. The
 * list still has to count them, and a workspace copy of the same id wins. */
function localOnlyRuns(state) {
  if (!isStaticDemo()) return [];
  const seen = new Set((state?.groupRuns || []).map(r => r.id));
  const extra = [];
  for (const group of state?.groups || []) {
    for (const run of recentRuns(group.id)) {
      if (!run?.id || seen.has(run.id)) continue;
      seen.add(run.id);
      extra.push(run);
    }
  }
  return extra;
}

export function renderList() {
  const {state} = store; if (!state || !el('chat-list')) return;
  const listed = {state, messages: store.messages, profiles: store.profiles, typing: store.typing, localRuns: localOnlyRuns(state)};
  const waiting = chatRows({...listed, filter: 'all'}).reduce((n, r) => n + r.needs, 0);
  el('list-filters').innerHTML = FILTERS.map(([key, label]) => `<button type="button" class="filter${store.listFilter === key ? ' on' : ''}" data-action="list-filter" data-filter="${key}" aria-pressed="${store.listFilter === key}">${label}${key === 'needs' && waiting ? `<span class="badge">${waiting}</span>` : ''}</button>`).join('');
  const rows = chatRows({...listed, filter: store.listFilter, query: store.listQuery});
  el('chat-list').innerHTML = rows.map(chatRow).join('') || `<div class="empty"><strong>${store.listFilter === 'needs' ? 'Nothing is waiting on you' : 'No chats match'}</strong><span>${store.listFilter === 'needs' ? 'Drafts and page requests that need a decision show up here.' : 'Try another name, or start a new chat.'}</span></div>`;
  const bell = el('bell-slot');
  if (bell) bell.innerHTML = `<button type="button" class="icon-btn" data-action="open-page" data-page="notifications" aria-label="Notifications${state.unread ? ` (${state.unread} unread)` : ''}" title="Notifications">${icon('bell', 22)}${state.unread ? `<span class="badge-dot">${state.unread > 9 ? '9+' : state.unread}</span>` : ''}</button>`;
}

/* ---------- message parts ---------- */

/** The signature element: a draft is a message you answer in place, and its
 * footer always says who the next move belongs to. */
export function draftCard(draft) {
  const stage = draftStage(draft), open = ACTIVE_DRAFTS.includes(draft.status), editing = store.editDraft === draft.id;
  const write = canWrite(), id = esc(draft.id), postHref = validHttpUrl(draft.url);
  // The text on screen is the edit when there is one, so the count follows the
  // caret and the card header tells the same truth about the same draft.
  const shown = store.editText ?? draft.text, over = draftLength(shown).over;
  const body = editing
    ? `<form class="edit-form" data-id="${id}"><textarea class="input" name="text" rows="4" required aria-label="Edit this draft">${esc(shown)}</textarea><p class="draft-count${over ? ' over' : ''}" aria-live="polite">${esc(lengthLabel(shown))}</p><div class="card-actions">${btn('Save', null, {kind: 'primary', type: 'submit'})}${btn('Cancel', 'cancel-edit')}</div></form>`
    : `<p class="draft-text">${esc(draft.text)}</p>`;
  // No validated URL means no link at all: an <a href=""> called "Open post"
  // either navigates to this page or, with an empty url, does nothing at all.
  const copyReady = draft.status === 'ready' ? btn('Copy text', 'copy-draft', {kind: 'primary', id: draft.id}) + (postHref ? `<a class="btn quiet" href="${esc(postHref)}" target="_blank" rel="noopener noreferrer"><span>Open post</span></a>` : '') : '';
  const actions = editing ? '' : copyReady || (write ? {
    pending: btn('Approve', 'approve-draft', {kind: 'primary', id: draft.id}) + btn('Edit', 'edit-draft', {id: draft.id}) + btn('Skip', 'reject-draft', {id: draft.id}),
    scheduled: btn('Edit', 'edit-draft', {id: draft.id}) + btn('Cancel', 'reject-draft', {id: draft.id}),
  }[draft.status] || '' : '');
  const side = write ? {scheduled: btn('Ready now', 'ready-draft', {id: draft.id, small: true}), ready: btn('I posted it', 'posted-draft', {id: draft.id, kind: 'good', small: true})}[draft.status] || '' : '';
  const mark = {wait: '<i class="dot"></i>', ok: icon(draft.status === 'ready' ? 'checks' : 'check', 15), done: icon('checks', 15), off: ''}[stage.tone];
  return `<article class="draft tone-${stage.tone}" data-draft="${id}">
    <header><span class="draft-to">Reply to ${esc(draft.author)}</span><span class="draft-score">${Number(draft.score || 0)}/100${draft.mode === 'template' ? ' · template' : ''}${draft.revision > 1 ? ` · rev ${Number(draft.revision)}` : ''}${over ? ' · long for X' : ''}</span></header>
    ${body}
    ${open ? evidencePanel(draft) : ''}
    ${actions ? `<div class="card-actions">${actions}${open && !editing && write ? btn('Rewrite', 'rewrite-draft', {id: draft.id, kind: 'ghost'}) : ''}</div>` : ''}
    <footer class="draft-state">${mark}<span>${esc(stage.line)}</span>${side}</footer>
  </article>`;
}

/** Review and attach the source evidence a draft relies on. */
function evidencePanel(draft) {
  const write = canWrite();
  const items = (store.state.evidence || []).filter(e => e.draftId === draft.id || (draft.candidateId && e.candidateId === draft.candidateId));
  const disputed = items.filter(e => e.verification === 'disputed').length, verified = items.filter(e => e.verification === 'user_verified').length;
  const summary = items.length ? `${items.length} source(s)${verified ? ` · ${verified} verified` : ''}${disputed ? ` · ${disputed} disputed` : ''}` : 'No sources yet';
  const list = items.map(e => {
    const sourceHref = validHttpUrl(e.link);
    return `<div class="evidence-item"><span class="row-main"><span class="row-title">${esc(e.claim)}</span><span class="row-sub">${sourceHref ? `<a href="${esc(sourceHref)}" target="_blank" rel="noopener noreferrer">Source</a> · ` : ''}${Math.round((e.confidence || 0) * 100)}% sure · ${esc(String(e.verification || '').replace('_', ' '))}</span></span>${write ? `<span class="row-actions">${e.verification !== 'user_verified' ? btn('Verify', 'verify-evidence', {id: e.id, small: true, data: {status: 'user_verified'}}) : ''}${e.verification !== 'disputed' ? btn('Dispute', 'verify-evidence', {id: e.id, small: true, data: {status: 'disputed'}}) : ''}${btn('Drop', 'drop-evidence', {id: e.id, small: true, kind: 'danger'})}</span>` : ''}</div>`;
  }).join('');
  return `<details class="evidence-panel" data-evidence="${esc(draft.id)}"${store.openEvidence.has(draft.id) ? ' open' : ''}><summary><span>${icon('link', 14)} ${esc(summary)}</span></summary>${list}
    ${write ? `<form class="evidence-form" data-id="${esc(draft.id)}">
      <input class="input" name="claim" placeholder="What does this source support?" required maxlength="600" aria-label="Claim">
      <div class="form-grid"><select class="input" name="kind" aria-label="Kind"><option value="link">Link</option><option value="quote">Quote</option><option value="claim">Claim</option></select><input class="input" name="confidence" type="number" min="0" max="1" step="0.05" value="0.6" aria-label="Confidence from 0 to 1"></div>
      <input class="input" name="link" type="url" placeholder="https://… (needed for a link)" aria-label="Link">
      ${btn('Add source', null, {type: 'submit', small: true})}
    </form>` : ''}</details>`;
}

export function postCard(post, drafted) {
  return `<div class="post">
    <a class="post-quote" href="${esc(safeHref(post.url))}" target="_blank" rel="noopener noreferrer"><strong>${esc(post.author || 'Post')} on X</strong><span>${esc(post.text)}</span></a>
    <div class="post-meta"><span>${esc(post.topic || 'No topic')}${post.score?.score != null ? ` · ${Number(post.score.score)}/100` : ''}${post.demo ? ' · sample' : ''}</span>${drafted ? tag('Drafted', 'good') : canWrite() ? btn('Draft reply', 'draft-candidate', {id: post.id, small: true, kind: 'primary'}) : ''}</div>
  </div>`;
}

// A sender may be a guest: a bot from another group that was @mentioned here.
function botFace(conv, senderId, name) {
  const home = senderId && (conv.group.bots.some(b => b.id === senderId) ? conv.group : groupOfBot(senderId));
  const index = home ? botTint(home, senderId) : (conv.isTeam ? 0 : conv.tint);
  return {face: avatar(name, index, 30), color: tintClass(index)};
}

const BROWSER_STATUS = {pending: ['Waiting on you', 'warn'], dispatched: ['On your local agent', 'warn'], done: ['Done', 'good'], failed: ['Failed', 'bad'], denied: ['Declined', '']};
/** A bot's request to open a page with the user's local browser agent. */
function browserCard(m) {
  const request = requestOfMessage(store.state, m.id);
  if (!request) return `<div class="event"><span>${esc(m.text)}</span></div>`;
  const [label, tone] = BROWSER_STATUS[request.status] || [request.status, ''];
  const steps = request.steps?.length ? `<ol class="browser-steps">${request.steps.map(s => `<li>${esc(s.op)} ${esc(s.url || s.selector || '')}${s.text ? ` · "${esc(String(s.text).slice(0, 60))}"` : ''}</li>`).join('')}</ol>` : '';
  const decline = btn('Decline', 'deny-browser', {id: request.id, small: true});
  const actions = !canWrite() ? '' : request.status === 'pending' ? `<div class="card-actions">${btn('Approve', 'approve-browser', {id: request.id, small: true, kind: 'primary'})}${decline}</div>`
    : request.status === 'dispatched' ? `<div class="card-actions">${decline}</div>` : '';
  return `<div class="event browser-request"><span>${esc(m.text)} ${tag(label, tone)}</span><a href="${esc(safeHref(request.url))}" target="_blank" rel="noopener noreferrer">${esc(request.url)}</a>${steps}${request.error ? `<small>${esc(request.error)}</small>` : ''}${actions}</div>`;
}

function messageHtml(item, conv, latestRunNote) {
  const m = item.message;
  if (m.role === 'system') {
    // A card or a run note carries buttons, so only the server's own line may
    // paint one: a browser-written `kind:'browser'` was a way to grow an Approve
    // card with the writer's own heading, wired to somebody else's request. The
    // Pages build has no server, so there the browser *is* the writer.
    if (m.kind === 'browser' && (m.origin !== 'browser' || isStaticDemo())) return browserCard(m);
    // Only the newest note of a run carries its action, so a button never repeats.
    // Browser cards are not notes: they return above, and counting them here
    // would throw the Start or Retry button away.
    const runs = recentRuns(conv.group.id), live = !isStaticDemo();
    const noted = Boolean(m.runId && latestRunNote.get(m.runId) === m.id && (m.origin !== 'browser' || isStaticDemo()));
    const run = noted ? runs.find(r => r.id === m.runId) : null;
    const flags = threadLineActions({kind: m.kind, senderId: m.senderId, status: run?.status, live, note: Boolean(run), latest: Boolean(run) && runs[0]?.id === run.id});
    const write = canWrite();
    const grant = write && flags.grant ? btn('Grant browser access', 'grant-browser', {id: m.senderId, small: true, kind: 'primary'}) : '';
    const plan = write && flags.plan ? `${btn('Start', 'approve-plan', {id: conv.group.id, small: true, kind: 'primary', data: {run: run.id}})}${btn('Cancel', 'cancel-plan', {id: conv.group.id, small: true, data: {run: run.id}})}` : '';
    const checkpoint = write && flags.checkpoint ? btn('Approve next step', 'continue-run', {id: conv.group.id, small: true, kind: 'primary', data: {run: run.id}}) : '';
    // Retry only the latest run: once a newer one exists, the old failure is history.
    const retry = write && flags.retry ? btn('Retry', 'retry-run', {id: conv.group.id, small: true, data: {run: run.id, message: run.input || '', ...retryTarget(conv.group, run)}}) : '';
    return `<div class="event"><span>${esc(m.text)}</span>${grant}${plan}${checkpoint}${retry}</div>`;
  }
  if (m.role === 'user') return `<div class="msg me${item.lead ? ' lead' : ''}"><div class="bubble"><span class="text">${esc(m.text)}</span><time>${esc(clock(m.at))}</time></div></div>`;
  const sender = m.senderId ? findBot(m.senderId) : null, guest = Boolean(sender) && !conv.group.bots.some(b => b.id === m.senderId);
  const name = sender?.name || m.senderName || conv.name, {face, color} = botFace(conv, m.senderId, name);
  const next = m.toBotId ? findBot(m.toBotId)?.name : null;
  return `<div class="msg them ${color}${item.lead ? ' lead' : ''}">${item.lead ? face : '<span class="avatar-gap"></span>'}<div class="bubble">${(conv.isTeam || guest || (sender && sender.id !== conv.bot?.id)) && item.lead ? `<span class="sender ${color}">${esc(name)}${guest ? ` <small>from ${esc(groupOfBot(m.senderId)?.name || 'another group')}</small>` : ''}</span>` : ''}<span class="text">${esc(m.text)}</span>${next ? `<span class="handoff">${icon('arrow', 12)} ${esc(next)}</span>` : ''}<time>${m.mode === 'ai' ? '<span class="by-model" title="Written by the AI model on the server">AI</span> ' : ''}${esc(clock(m.at))}</time></div></div>`;
}

function itemHtml(item, conv, latestRunNote) {
  if (item.kind === 'day') return `<div class="day">${esc(dayLabel(item.at))}</div>`;
  if (item.kind === 'message') return messageHtml(item, conv, latestRunNote);
  if (item.kind === 'post') {
    // Samples and extension captures arrive from Scout; a post you add is yours.
    if (!item.post.demo) return `<div class="msg me lead"><div class="bubble card">${postCard(item.post, item.drafted)}</div></div>`;
    const scout = conv.group.bots.find(b => b.type === 'source') || conv.group.bots[0], {face, color} = botFace(conv, scout?.id, scout?.name || 'Scout');
    return `<div class="msg them lead ${color}">${face}<div class="bubble card"><span class="sender ${color}">${esc(scout?.name || 'Scout')}</span>${postCard(item.post, item.drafted)}</div></div>`;
  }
  const writer = conv.group.bots.find(b => b.type === 'writing') || conv.group.bots[0], {face} = botFace(conv, writer?.id, writer?.name || 'Writer');
  return `<div class="msg them lead">${face}${draftCard(item.draft)}</div>`;
}

/* ---------- thread ---------- */

function welcome(conv) {
  const live = isLive(), server = !isStaticDemo();
  const about = conv.isTeam ? (conv.group.description || 'Message the whole team. Mention a bot with @name to pick who answers.') : (conv.bot.instructions || 'A bot, ready for instructions.');
  const mode = conv.isTeam ? (live ? 'The bots hand work to each other on your server model.' : server ? 'No AI provider is configured. Add one under You → AI and models. This chat will not answer with the demo.' : 'Offline demo: the handoffs are simulated, no live AI.')
    : botSettings(conv.bot).lead && groupSettings(conv.group).coordination === 'tracked' && live ? 'Tell this bot what you need. It picks who should work, checks that it got done, and leaves posting to you.'
    : botSettings(conv.bot).lead && !server ? 'This is the primary bot. In group settings, choose “One bot keeps it on track” to have it run the others.'
    : live ? 'This bot answers with your AI provider. If that call fails, the error is shown here.'
    : server ? 'No AI provider is configured. Add one under You → AI and models. This bot will not answer with the demo.'
    : 'Offline demo: this bot answers a small set of built-in commands.';
  return `<div class="welcome"><button type="button" class="poke" data-action="poke" aria-label="Say hi to ${esc(conv.name)}">${conv.isTeam ? groupAvatar(conv.group.bots.map(b => ({name: b.name, tint: botTint(conv.group, b.id)})), 84) : avatar(conv.name, conv.tint, 84)}</button><h2>${esc(conv.name)}</h2><p>${esc(about)}</p><p class="quiet">${esc(mode)}</p></div>`;
}

function threadHead(conv) {
  const drafts = isXGroup(conv.group) ? (store.state.drafts || []).filter(d => d.status === 'pending' || d.status === 'ready').length : 0;
  const pages = pendingBrowser(store.state, conv.id), feeds = stuckFeedReads(store.state, conv.id);
  const held = recentRuns(conv.group.id);
  const plans = held.filter(r => r.status === 'awaiting_plan' && runBelongsToChat(r, conv.id)).length;
  const pauses = held.filter(r => r.status === 'awaiting_checkpoint' && runBelongsToChat(r, conv.id)).length;
  const face = conv.isTeam ? groupAvatar(conv.group.bots.map(b => ({name: b.name, tint: botTint(conv.group, b.id)})), 42) : avatar(conv.name, conv.tint, 42);
  const sub = store.typing.has(conv.id) ? 'typing…' : conv.isTeam ? (conv.group.bots.map(b => b.name).join(', ') || 'No bots yet') : conv.group.name;
  const pagePill = pages === 1 ? 'Wants to open a page' : `${pages} pages waiting on you`;
  const planPill = plans === 1 ? 'A plan is waiting' : `${plans} plans waiting`;
  const pausePill = pauses === 1 ? 'Approve the next step' : `${pauses} steps waiting`;
  return `${iconBtn('back', 'Back to chats', 'back-to-list', {cls: 'back'})}
    <button type="button" class="thread-title" data-action="open-info" aria-expanded="${Boolean(store.route.info)}" aria-controls="inspector" aria-label="${esc(conv.name)}, open details">${face}<span class="thread-title-text"><strong>${esc(conv.name)}</strong><span>${esc(sub)}</span></span></button>
    ${pages ? `<span class="needs-pill">${pagePill}</span>` : feeds ? `<span class="needs-pill">Feed read still open</span>` : ''}${plans ? `<span class="needs-pill">${planPill}</span>` : ''}${pauses ? `<span class="needs-pill">${pausePill}</span>` : ''}${drafts ? `<button type="button" class="needs-pill" data-action="open-section" data-section="drafts">${drafts} need${drafts === 1 ? 's' : ''} you</button>` : ''}`;
}

function suggestions(conv) {
  if (!canWrite()) return '';
  const list = conv.isTeam && isXGroup(conv.group) ? ['Draft a reply', 'What needs me?', 'Show status'] : botSuggestions(conv.name, conv.group.name);
  return list.map(s => `<button type="button" class="chip" data-action="quick-chat" data-text="${esc(s)}">${esc(s)}</button>`).join('');
}

/** Who can be @mentioned from this chat: its group's bots that are on, then
 * guests from other groups. A 1:1 chat leaves out the bot you are talking to. */
export function mentionRoster(conv) {
  const own = conv.group.bots.filter(b => botSettings(b).enabled && b.id !== conv.bot?.id);
  return [...own, ...summonableGuests(groups(), conv.group.id)].map(b => ({id: b.id, name: b.name}));
}
/** Offer names while the last word typed starts with '@'. */
export function renderMentions(text = el('chat-form')?.elements.namedItem('message').value || '') {
  const strip = el('mention-strip'), conv = conversation(); if (!strip || !conv) return;
  const list = mentionSuggestions(mentionRoster(conv), text, {team: conv.isTeam});
  strip.hidden = !list.length;
  strip.innerHTML = list.map(m => `<button type="button" class="chip" data-action="mention-pick" data-name="${esc(m.name)}" aria-label="Mention ${esc(m.name)}">@${esc(m.name)}</button>`).join('');
}

/** Paint the thread frame for a newly opened conversation. */
export function threadShell(conv) {
  const write = canWrite();
  el('main').innerHTML = `
    <header class="thread-head" id="thread-head"></header>
    <div class="thread-log" id="chat-space" role="log" aria-live="off" aria-label="Conversation"></div>
    <div class="chips" id="thread-chips"></div>
    <div class="chips mentions" id="mention-strip" role="group" aria-label="Mention a bot" hidden></div>
    <form id="chat-form" class="composer" autocomplete="off">
      ${write ? iconBtn('plus', 'Add to this chat: a bot, a scheduled task and more', 'attach', {cls: 'attach'}) : ''}
      <textarea name="message" rows="1" placeholder="${write ? `Message ${esc(conv.name)}` : 'Viewers cannot send messages'}" aria-label="${write ? `Message ${esc(conv.name)}` : 'Viewers cannot send messages'}" maxlength="4000" required${write ? '' : ' disabled'}></textarea>
      <button type="submit" class="icon-btn send" aria-label="Send message"${write ? '' : ' disabled'}>${icon('send', 20)}</button>
    </form>`;
}

// Entrance motion is for NEW things only. The log is rebuilt on every refresh,
// so remember when each item (and each draft status) first appeared and mark it
// fresh for a moment, with a negative delay so a rebuild resumes the animation.
const FRESH_MS = 520;
const born = {conv: null, items: new Map(), status: new Map()};
const itemKey = item => item.kind === 'message' ? `m:${item.message.id}` : item.kind === 'draft' ? `d:${item.draft.id}` : item.kind === 'post' ? `p:${item.post.id}` : null;
function markFresh(html, item, conv, now) {
  const key = itemKey(item); if (!key) return html;
  if (!born.items.has(key)) born.items.set(key, born.conv === conv.id ? now : 0);
  const age = now - born.items.get(key);
  let out = age < FRESH_MS ? html.replace('<div class="', `<div data-fresh style="--age:-${age}ms" class="`) : html;
  if (item.kind === 'draft') {
    const seen = born.status.get(key);
    if (!seen || seen.status !== item.draft.status) born.status.set(key, {status: item.draft.status, at: seen && born.conv === conv.id ? now : 0});
    const changed = now - born.status.get(key).at;
    if (changed < FRESH_MS + 300) out = out.replace('<article class="', `<article data-changed style="--age:-${changed}ms" class="`);
  }
  return out;
}

// The log is rebuilt on every refresh, so it is not a live region itself: only
// a genuinely new reply is spoken, through the hidden #announce node.
let spoken = null;
function announce(conv, items) {
  const last = [...items].reverse().find(i => i.kind === 'message' && i.message.role !== 'user')?.message, node = el('announce');
  if (!last || !node) return;
  const key = `${conv.id}:${last.id}`, first = spoken === null || !spoken.startsWith(`${conv.id}:`);
  if (key !== spoken && !first) node.textContent = `${last.senderName || (last.role === 'system' ? 'Update' : conv.name)}: ${String(last.text).slice(0, 300)}`;
  spoken = key;
}

/** Refresh the open thread's header, log and chips without touching the composer. */
export function renderThread() {
  const conv = conversation(), log = el('chat-space'); if (!conv || !log) return;
  el('thread-head').innerHTML = threadHead(conv);
  el('thread-head').classList.toggle('thinking', store.typing.has(conv.id));
  const pinned = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
  const items = timeline({conv, state: store.state, messages: store.messages});
  const latestRunNote = new Map(items.filter(i => i.kind === 'message' && isRunNote(i.message)).map(i => [i.message.runId, i.message.id]));
  announce(conv, items);
  const now = Date.now();
  if (born.conv !== conv.id) { born.items.clear(); born.status.clear(); }
  const html = items.map(item => markFresh(itemHtml(item, conv, latestRunNote), item, conv, now)).join('');
  born.conv = conv.id;
  log.innerHTML = (items.length ? html : welcome(conv))
    + (store.typing.has(conv.id) ? `<div class="msg them lead thinking${conv.isTeam ? '' : ` ${tintClass(conv.tint)}`}">${conv.isTeam ? '<span class="avatar-gap"></span>' : avatar(conv.name, conv.tint, 30)}<div class="bubble typing" aria-label="Typing"><i></i><i></i><i></i></div></div>` : '');
  if (pinned || log.dataset.conv !== conv.id) log.scrollTop = log.scrollHeight;
  log.dataset.conv = conv.id;
  el('thread-chips').innerHTML = suggestions(conv);
}

/** Desktop landing when no chat is open: say what you want, the group takes it.
 * The chips belong to the group the form sends to, so a workspace with more than
 * one group does not get X-engage prompts that quietly run in the first group. */
function homePrompts(group) {
  if (!group) return [];
  if (isXGroup(group)) return ['Draft a reply to the top post', 'What needs my approval?', 'Summarize the latest post', 'Show status'];
  const bot = group.bots.find(b => botSettings(b).lead) || group.bots[0];
  return botSuggestions(bot?.name || group.name, group.name);
}

export function homeView() {
  const write = canWrite(), group = groups()[0], prompts = homePrompts(group);
  const who = group ? `Message ${esc(group.name)} or a bot in it.` : 'Message a bot or the whole group.';
  return `<section class="home">
    <button type="button" class="poke" data-action="poke" aria-label="Say hi">${mascot()}</button>
    <h1>What should your bots work on?</h1>
    <p>${who} They hand work to each other, and the final Post click stays with you.</p>
    ${write ? `<form id="home-prompt" class="composer" autocomplete="off">
      <textarea name="prompt" rows="1" placeholder="Ask your group to research, draft or review something" aria-label="Ask your bot group" maxlength="4000" required></textarea>
      <button type="submit" class="icon-btn send" aria-label="Send to group chat">${icon('send', 20)}</button>
    </form>
    <div class="chips center">${prompts.map(s => `<button type="button" class="chip" data-action="home-ask" data-id="${esc(group?.id || '')}" data-text="${esc(s)}">${esc(s)}</button>`).join('')}</div>` : '<p class="quiet">Viewers can read chats. A member can send.</p>'}
  </section>`;
}
