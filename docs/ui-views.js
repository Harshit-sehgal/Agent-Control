/** The two always-present panes: the chat list and the open thread.
 * Both are thin renderers over ui-model.js. The list shell and the composer are
 * painted once and then only their contents change, so a background refresh can
 * never wipe what the user is typing. */
import {botSuggestions} from './chat-engine.js?v=ec265c1708';
import {chatRows, timeline, needsYou, draftStage, ACTIVE_DRAFTS} from './ui-model.js?v=ec265c1708';
import {esc, icon, avatar, groupAvatar, tintClass, clock, stamp, dayLabel, btn, iconBtn, tag, mascot} from './ui-kit.js?v=ec265c1708';
import {store, conversation, isStaticDemo, isLive, isXGroup, botTint, recentRuns} from './ui-store.js?v=ec265c1708';

const el = id => document.getElementById(id);
const FILTERS = [['all', 'All'], ['needs', 'Needs you'], ['groups', 'Groups'], ['bots', 'Bots']];

/* ---------- chat list ---------- */

/** Painted once at boot; `renderList` then fills the dynamic parts. */
export function listShell() {
  const server = !isStaticDemo();
  el('sidebar').innerHTML = `
    <header class="list-head">
      <h1>Chats</h1>
      <div class="list-tools">
        ${server ? `<span id="bell-slot"></span>` : ''}
        ${iconBtn('plus', 'New chat', 'new-chat', {cls: 'new-chat'})}
        <button type="button" class="icon-btn you" data-action="open-page" data-page="you" aria-label="You and settings" title="You and settings">${icon('dots', 22)}</button>
      </div>
    </header>
    <label class="search">${icon('search', 18)}<input id="chat-search" type="search" placeholder="Search bots and groups" aria-label="Search chats" autocomplete="off"></label>
    <div class="filters" id="list-filters" role="group" aria-label="Filter chats"></div>
    <nav class="chat-list" id="chat-list" aria-label="Chats"></nav>
    <footer class="list-foot">
      <span class="promise">${icon('lock', 14)} Bots draft. You post. Always.</span>
      <span class="backend">${server ? 'Connected to Node server' : 'Browser-only prototype · data stays in this browser'}</span>
    </footer>
    <button type="button" class="fab" data-action="new-chat" aria-label="New chat">${icon('plus', 24)}</button>`;
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

export function renderList() {
  const {state} = store; if (!state || !el('chat-list')) return;
  const waiting = (state.groups || []).reduce((n, g) => n + needsYou(state, g), 0);
  el('list-filters').innerHTML = FILTERS.map(([key, label]) => `<button type="button" class="filter${store.listFilter === key ? ' on' : ''}" data-action="list-filter" data-filter="${key}" aria-pressed="${store.listFilter === key}">${label}${key === 'needs' && waiting ? `<span class="badge">${waiting}</span>` : ''}</button>`).join('');
  const rows = chatRows({state, messages: store.messages, profiles: store.profiles, typing: store.typing, filter: store.listFilter, query: store.listQuery});
  el('chat-list').innerHTML = rows.map(chatRow).join('') || `<div class="empty"><strong>${store.listFilter === 'needs' ? 'Nothing is waiting on you' : 'No chats match'}</strong><span>${store.listFilter === 'needs' ? 'Drafts that need a decision show up here.' : 'Try another name, or start a new chat.'}</span></div>`;
  const bell = el('bell-slot');
  if (bell) bell.innerHTML = `<button type="button" class="icon-btn" data-action="open-page" data-page="notifications" aria-label="Notifications${state.unread ? ` (${state.unread} unread)` : ''}" title="Notifications">${icon('bell', 22)}${state.unread ? `<span class="badge-dot">${state.unread > 9 ? '9+' : state.unread}</span>` : ''}</button>`;
}

/* ---------- message parts ---------- */

/** The signature element: a draft is a message you answer in place, and its
 * footer always says who the next move belongs to. */
export function draftCard(draft) {
  const stage = draftStage(draft), open = ACTIVE_DRAFTS.includes(draft.status), editing = store.editDraft === draft.id;
  const id = esc(draft.id);
  const body = editing
    ? `<form class="edit-form" data-id="${id}"><textarea class="input" name="text" rows="4" required aria-label="Edit this draft">${esc(store.editText ?? draft.text)}</textarea><div class="card-actions">${btn('Save', null, {kind: 'primary', type: 'submit'})}${btn('Cancel', 'cancel-edit')}</div></form>`
    : `<p class="draft-text">${esc(draft.text)}</p>`;
  const actions = editing ? '' : {
    pending: btn('Approve', 'approve-draft', {kind: 'primary', id: draft.id}) + btn('Edit', 'edit-draft', {id: draft.id}) + btn('Skip', 'reject-draft', {id: draft.id}),
    scheduled: btn('Edit', 'edit-draft', {id: draft.id}) + btn('Cancel', 'reject-draft', {id: draft.id}),
    ready: btn('Copy text', 'copy-draft', {kind: 'primary', id: draft.id}) + `<a class="btn quiet" href="${esc(draft.url)}" target="_blank" rel="noopener noreferrer"><span>Open post</span></a>`,
  }[draft.status] || '';
  const side = {scheduled: btn('Ready now', 'ready-draft', {id: draft.id, small: true}), ready: btn('I posted it', 'posted-draft', {id: draft.id, kind: 'good', small: true})}[draft.status] || '';
  const mark = {wait: '<i class="dot"></i>', ok: icon(draft.status === 'ready' ? 'checks' : 'check', 15), done: icon('checks', 15), off: ''}[stage.tone];
  return `<article class="draft tone-${stage.tone}" data-draft="${id}">
    <header><span class="draft-to">Reply to ${esc(draft.author)}</span><span class="draft-score">${Number(draft.score || 0)}/100${draft.mode === 'template' ? ' · template' : ''}${draft.revision > 1 ? ` · rev ${Number(draft.revision)}` : ''}</span></header>
    ${body}
    ${open ? evidencePanel(draft) : ''}
    ${actions ? `<div class="card-actions">${actions}${open && !editing ? btn('Rewrite', 'rewrite-draft', {id: draft.id, kind: 'ghost'}) : ''}</div>` : ''}
    <footer class="draft-state">${mark}<span>${esc(stage.line)}</span>${side}</footer>
  </article>`;
}

/** Review and attach the source evidence a draft relies on. */
function evidencePanel(draft) {
  const items = (store.state.evidence || []).filter(e => e.draftId === draft.id || (draft.candidateId && e.candidateId === draft.candidateId));
  const disputed = items.filter(e => e.verification === 'disputed').length, verified = items.filter(e => e.verification === 'user_verified').length;
  const summary = items.length ? `${items.length} source(s)${verified ? ` · ${verified} verified` : ''}${disputed ? ` · ${disputed} disputed` : ''}` : 'No sources yet';
  const list = items.map(e => `<div class="evidence-item"><span class="row-main"><span class="row-title">${esc(e.claim)}</span><span class="row-sub">${e.link ? `<a href="${esc(e.link)}" target="_blank" rel="noopener noreferrer">Source</a> · ` : ''}${Math.round((e.confidence || 0) * 100)}% sure · ${esc(String(e.verification || '').replace('_', ' '))}</span></span><span class="row-actions">${e.verification !== 'user_verified' ? btn('Verify', 'verify-evidence', {id: e.id, small: true, data: {status: 'user_verified'}}) : ''}${e.verification !== 'disputed' ? btn('Dispute', 'verify-evidence', {id: e.id, small: true, data: {status: 'disputed'}}) : ''}${btn('Drop', 'drop-evidence', {id: e.id, small: true, kind: 'danger'})}</span></div>`).join('');
  return `<details class="evidence-panel" data-evidence="${esc(draft.id)}"${store.openEvidence.has(draft.id) ? ' open' : ''}><summary><span>${icon('link', 14)} ${esc(summary)}</span></summary>${list}
    <form class="evidence-form" data-id="${esc(draft.id)}">
      <input class="input" name="claim" placeholder="What does this source support?" required maxlength="600" aria-label="Claim">
      <div class="form-grid"><select class="input" name="kind" aria-label="Kind"><option value="link">Link</option><option value="quote">Quote</option><option value="claim">Claim</option></select><input class="input" name="confidence" type="number" min="0" max="1" step="0.05" value="0.6" aria-label="Confidence from 0 to 1"></div>
      <input class="input" name="link" type="url" placeholder="https://… (needed for a link)" aria-label="Link">
      ${btn('Add source', null, {type: 'submit', small: true})}
    </form></details>`;
}

export function postCard(post, drafted) {
  return `<div class="post">
    <a class="post-quote" href="${esc(post.url)}" target="_blank" rel="noopener noreferrer"><strong>${esc(post.author || 'Post')} on X</strong><span>${esc(post.text)}</span></a>
    <div class="post-meta"><span>${esc(post.topic || 'No topic')}${post.score?.score != null ? ` · ${Number(post.score.score)}/100` : ''}${post.demo ? ' · sample' : ''}</span>${drafted ? tag('Drafted', 'good') : btn('Draft reply', 'draft-candidate', {id: post.id, small: true, kind: 'primary'})}</div>
  </div>`;
}

function botFace(conv, senderId, name) {
  const index = senderId && conv.group.bots.some(b => b.id === senderId) ? botTint(conv.group, senderId) : (conv.isTeam ? 0 : conv.tint);
  return {face: avatar(name, index, 30), color: tintClass(index)};
}

function messageHtml(item, conv, latestRunNote) {
  const m = item.message;
  if (m.role === 'system') {
    // Only the newest note of a run carries its action, so a button never repeats.
    const runs = recentRuns(conv.group.id), live = !isStaticDemo();
    const run = m.runId && latestRunNote.get(m.runId) === m.id ? runs.find(r => r.id === m.runId) : null;
    const action = !run || !live ? '' : run.status === 'awaiting_checkpoint' ? btn('Approve next step', 'continue-run', {id: conv.group.id, small: true, kind: 'primary', data: {run: run.id}})
      // Retry only the latest run: once a newer one exists, the old failure is history.
      : ['failed', 'interrupted'].includes(run.status) && runs[0]?.id === run.id ? btn('Retry', 'retry-run', {id: conv.group.id, small: true, data: {run: run.id, message: run.input || '', direct: run.mode === 'direct' ? (run.recipients[0] || '') : ''}}) : '';
    return `<div class="event"><span>${esc(m.text)}</span>${action}</div>`;
  }
  if (m.role === 'user') return `<div class="msg me${item.lead ? ' lead' : ''}"><div class="bubble"><span class="text">${esc(m.text)}</span><time>${esc(clock(m.at))}</time></div></div>`;
  const name = m.senderName || conv.name, {face, color} = botFace(conv, m.senderId, name);
  const next = m.toBotId ? conv.group.bots.find(b => b.id === m.toBotId)?.name : null;
  return `<div class="msg them ${color}${item.lead ? ' lead' : ''}">${item.lead ? face : '<span class="avatar-gap"></span>'}<div class="bubble">${conv.isTeam && item.lead ? `<span class="sender ${color}">${esc(name)}</span>` : ''}<span class="text">${esc(m.text)}</span>${next ? `<span class="handoff">${icon('arrow', 12)} ${esc(next)}</span>` : ''}<time>${esc(clock(m.at))}</time></div></div>`;
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
  const live = isLive(), custom = !conv.isTeam && conv.bot.type === 'custom';
  const about = conv.isTeam ? (conv.group.description || 'Message the whole team. Mention a bot with @name to pick who answers.') : (conv.bot.instructions || 'A bot, ready for instructions.');
  const mode = conv.isTeam ? (live ? 'The bots hand work to each other on your server model.' : 'Offline demo: the handoffs are simulated, no live AI.')
    : live && custom ? 'This bot runs its instructions through the server AI provider.' : 'Offline demo: this bot answers a small set of built-in commands.';
  return `<div class="welcome"><button type="button" class="poke" data-action="poke" aria-label="Say hi to ${esc(conv.name)}">${conv.isTeam ? groupAvatar(conv.group.bots.map(b => ({name: b.name, tint: botTint(conv.group, b.id)})), 84) : avatar(conv.name, conv.tint, 84)}</button><h2>${esc(conv.name)}</h2><p>${esc(about)}</p><p class="quiet">${esc(mode)}</p></div>`;
}

function threadHead(conv) {
  const needs = conv.isTeam ? needsYou(store.state, conv.group) : 0;
  const face = conv.isTeam ? groupAvatar(conv.group.bots.map(b => ({name: b.name, tint: botTint(conv.group, b.id)})), 42) : avatar(conv.name, conv.tint, 42);
  const sub = store.typing.has(conv.id) ? 'typing…' : conv.isTeam ? (conv.group.bots.map(b => b.name).join(', ') || 'No bots yet') : conv.group.name;
  return `${iconBtn('back', 'Back to chats', 'back-to-list', {cls: 'back'})}
    <button type="button" class="thread-title" data-action="open-info" aria-label="${esc(conv.name)}, open details">${face}<span class="thread-title-text"><strong>${esc(conv.name)}</strong><span>${esc(sub)}</span></span></button>
    ${needs && isXGroup(conv.group) ? `<button type="button" class="needs-pill" data-action="open-section" data-section="drafts">${needs} need${needs === 1 ? 's' : ''} you</button>` : ''}`;
}

function suggestions(conv) {
  const list = conv.isTeam && isXGroup(conv.group) ? ['Draft a reply', 'What needs me?', 'Show status'] : botSuggestions(conv.name, conv.group.name);
  return list.map(s => `<button type="button" class="chip" data-action="quick-chat" data-text="${esc(s)}">${esc(s)}</button>`).join('');
}

/** Paint the thread frame for a newly opened conversation. */
export function threadShell(conv) {
  el('main').innerHTML = `
    <header class="thread-head" id="thread-head"></header>
    <div class="thread-log" id="chat-space" role="log" aria-live="off" aria-label="Conversation"></div>
    <div class="chips" id="thread-chips"></div>
    <form id="chat-form" class="composer" autocomplete="off">
      ${iconBtn('plus', 'Share a post, set a reminder, add a bot', 'attach', {cls: 'attach'})}
      <textarea name="message" rows="1" placeholder="Message ${esc(conv.name)}" aria-label="Message ${esc(conv.name)}" maxlength="4000" required></textarea>
      <button type="submit" class="icon-btn send" aria-label="Send message">${icon('send', 20)}</button>
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
  const latestRunNote = new Map(items.filter(i => i.kind === 'message' && i.message.role === 'system' && i.message.runId).map(i => [i.message.runId, i.message.id]));
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

/** Desktop landing when no chat is open: say what you want, the group takes it. */
export function homeView() {
  const prompts = ['Draft a reply to the top post', 'What needs my approval?', 'Summarize the latest post', 'Show status'];
  return `<section class="home">
    <button type="button" class="poke" data-action="poke" aria-label="Say hi">${mascot()}</button>
    <h1>What should your bots work on?</h1>
    <p>Message a bot or the whole group. They hand work to each other, and the final Post click stays with you.</p>
    <form id="home-prompt" class="composer" autocomplete="off">
      <textarea name="prompt" rows="1" placeholder="Ask your group to research, draft or review something" aria-label="Ask your bot group" maxlength="4000" required></textarea>
      <button type="submit" class="icon-btn send" aria-label="Send to group chat">${icon('send', 20)}</button>
    </form>
    <div class="chips center">${prompts.map(s => `<button type="button" class="chip" data-action="home-ask" data-text="${esc(s)}">${esc(s)}</button>`).join('')}</div>
  </section>`;
}
