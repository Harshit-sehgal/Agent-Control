/** The sheets a conversation can raise (new chat, new bot, share a post, set a
 * reminder), plus the two full-screen layers: quick navigation and sign-in. */
import {esc, icon, btn, row, field, note} from './ui-kit.js?v=f6bd5ef1e8';
import {store, groups, conversation, isStaticDemo, isAdmin, isXGroup, teamKey, go} from './ui-store.js?v=f6bd5ef1e8';
import {openSheet, closeSheet, captureFocus, restoreFocus} from './ui-dialogs.js?v=f6bd5ef1e8';
import {tintPicker} from './ui-panel.js?v=f6bd5ef1e8';

const el = id => document.getElementById(id);

export const BOT_TEMPLATES = {
  blank: {name: '', instructions: ''},
  scout: {name: 'Scout', instructions: 'Collect relevant user-selected sources. Summarize the content and include direct links. Do not invent sources.'},
  research: {name: 'Researcher', instructions: 'Review evidence, distinguish facts from opinions, and flag claims that need verification. Provide citations when possible.'},
  writer: {name: 'Writer', instructions: 'Write clear, concise drafts in the user-approved tone. Do not invent their opinions. Return drafts for approval.'},
  review: {name: 'Reviewer', instructions: 'Check drafts for unsupported facts, unclear language, and permissions. Request revisions if needed. Never publish content.'},
  organize: {name: 'Coordinator', instructions: 'Route work to other bots in this group. Explain handoffs and summarize results. Require user approval before external actions.'},
};
/** The tint chosen in the open new-bot sheet. */
export let pickedTint = 0;
export const pickTint = index => { pickedTint = Number(index) || 0; document.querySelectorAll('.tint').forEach(b => { const on = Number(b.dataset.index) === pickedTint; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); }); };

export function newChatSheet() {
  openSheet(`<div class="box">${row({lead: `<span class="avatar avatar-plain small">${icon('bot', 20)}</span>`, title: 'New bot', sub: 'One job, one chat. Add it to a group.', action: 'new-bot'})}${row({lead: `<span class="avatar avatar-plain small">${icon('people', 20)}</span>`, title: 'New group', sub: 'Bots that hand work to each other.', action: 'new-group'})}</div>`, {title: 'New chat'});
}
export function newBotSheet(groupId = conversation()?.group.id) {
  pickedTint = 0;
  openSheet(`<form id="new-bot-form" class="form">
    ${tintPicker(0)}
    ${field('Start from', `<select class="input" id="bot-template" aria-label="Bot template"><option value="blank">Blank bot</option><option value="scout">Scout · finds sources</option><option value="research">Researcher · checks context</option><option value="writer">Writer · drafts content</option><option value="review">Reviewer · checks quality</option><option value="organize">Coordinator · routes tasks</option></select>`)}
    ${field('Name', `<input class="input" name="name" placeholder="Content strategist" maxlength="80" required autofocus>`)}
    ${field('Group', `<select class="input" name="group">${groups().map(g => `<option value="${esc(g.id)}"${g.id === groupId ? ' selected' : ''}>${esc(g.name)}</option>`).join('')}</select>`)}
    ${field('Job', `<textarea class="input" name="instructions" rows="4" placeholder="What is it good at? What must it never do?" maxlength="3000" required></textarea>`)}
    ${btn('Create bot and open chat', null, {kind: 'primary', type: 'submit', wide: true})}
  </form>`, {title: 'New bot', sub: 'Give it a name and one clear job.'});
}
export function newGroupSheet() {
  openSheet(`<form id="new-group-form" class="form">
    ${field('Name', `<input class="input" name="name" placeholder="Product research" maxlength="80" required autofocus>`)}
    ${field('What is it for?', `<textarea class="input" name="description" rows="3" maxlength="300"></textarea>`)}
    ${btn('Create group', null, {kind: 'primary', type: 'submit', wide: true})}
  </form>`, {title: 'New group', sub: 'Bots in a group share one chat and hand work to each other.'});
}
/** The composer's + button: what you can drop into this conversation. */
export function attachSheet() {
  const conv = conversation(); if (!conv) return;
  const x = isXGroup(conv.group);
  const lead = glyph => `<span class="avatar avatar-plain small">${icon(glyph, 20)}</span>`;
  openSheet(`<div class="box">
    ${x ? row({lead: lead('link'), title: 'Share a post', sub: 'Paste a post from X for the bots to work on.', action: 'share-post'}) : ''}
    ${x ? row({lead: lead('clock'), title: 'Set a reminder', sub: 'Get nudged to check new posts.', action: 'new-reminder'}) : ''}
    ${x ? row({lead: lead('spark'), title: 'Load sample posts', sub: 'Three example posts to try the flow.', action: 'load-samples'}) : ''}
    ${row({lead: lead('bot'), title: 'Add a bot', sub: `A new bot in ${esc(conv.group.name)}.`, action: 'add-bot-to-group', id: conv.group.id})}
  </div>`, {title: 'Add to this chat'});
}
export function sharePostSheet() {
  openSheet(`<form id="candidate-form" class="form">
    ${field('Post link', `<input class="input" type="url" name="url" placeholder="https://x.com/user/status/…" required autofocus>`)}
    ${field('What it says', `<textarea class="input" name="text" rows="4" minlength="12" placeholder="Paste the post text" required></textarea>`)}
    <div class="form-grid">${field('Author', `<input class="input" name="author" placeholder="Account name">`)}${field('Topic', `<input class="input" name="topic" placeholder="AI, robotics">`)}</div>
    ${btn('Share with the group', null, {kind: 'primary', type: 'submit', wide: true})}
  </form>${note(isStaticDemo() ? 'The browser extension captures posts for the Node build. This demo takes pasted posts only.' : 'Tip: the browser extension captures a post in one click.')}`, {title: 'Share a post'});
}
export function reminderSheet() {
  openSheet(`<form id="schedule-form" class="form">
    ${field('Remind me to', `<input class="input" name="label" placeholder="Review new discussions" required autofocus>`)}
    ${field('How often', `<select class="input" name="kind"><option value="interval">Repeat</option><option value="once">Once, at a set time</option></select>`)}
    ${field('Every (minutes)', `<input class="input" name="intervalMinutes" type="number" value="60" min="1" max="10080">`)}
    ${field('At', `<input class="input" name="nextAt" type="datetime-local">`)}
    ${btn('Set reminder', null, {kind: 'primary', type: 'submit', wide: true})}
  </form>`, {title: 'New reminder'});
  toggleReminderFields();
}
export function toggleReminderFields() {
  const form = el('schedule-form'); if (!form) return;
  const once = form.elements.namedItem('kind').value === 'once', every = form.elements.namedItem('intervalMinutes'), at = form.elements.namedItem('nextAt');
  every.disabled = once; at.disabled = !once; at.required = once;
  every.closest('label').hidden = once; at.closest('label').hidden = !once;
}

/* ---------- quick navigation (Ctrl+K). Local only: never runs a bot tool. ---------- */

let entries = [];
function commands() {
  const items = [
    {label: 'Chats', hint: 'Home', run: () => go({})},
    {label: 'You and settings', hint: 'Account', run: () => go({page: 'you'})},
    {label: 'About this build', hint: 'How it works', run: () => go({page: 'about'})},
  ];
  if (!isStaticDemo()) items.push({label: 'Notifications', hint: 'Account', run: () => go({page: 'notifications'})});
  if (isAdmin()) items.push({label: 'Team and access', hint: 'Admin', run: () => go({page: 'team'})}, {label: 'Local agents', hint: 'Admin', run: () => go({page: 'agents'})}, {label: 'Data and security', hint: 'Admin', run: () => go({page: 'data'})});
  for (const g of groups()) {
    const team = teamKey(g.id);
    items.push({label: g.name, hint: 'Group chat', run: () => go({chat: team})});
    if (isXGroup(g)) for (const [section, label] of [['drafts', 'Waiting on you'], ['posts', 'Posts found'], ['reminders', 'Reminders'], ['runs', 'Runs'], ['voice', 'Voice and timing']]) items.push({label: `${g.name} · ${label}`, hint: 'Group', run: () => go({chat: team, info: section})});
    for (const b of g.bots) items.push({label: b.name, hint: `${g.name} · bot`, run: () => go({chat: b.id})});
  }
  return items;
}
export const paletteOpen = () => !el('command').classList.contains('hidden');
export function updateCommandResults(value = '') {
  const q = value.trim().toLowerCase();
  entries = commands().filter(x => `${x.label} ${x.hint}`.toLowerCase().includes(q)).slice(0, 16);
  const area = el('command-results'); if (!area) return;
  area.innerHTML = entries.length ? entries.map((entry, i) => `<button type="button" class="command-item${i === 0 ? ' selected' : ''}" data-action="command-choice" data-index="${i}" role="option" aria-selected="${i === 0}"><span>${esc(entry.label)}</span><small>${esc(entry.hint)}</small></button>`).join('') : '<div class="empty"><strong>Nothing matches</strong></div>';
}
export function closeCommandPalette() { if (!paletteOpen()) return; el('command').classList.add('hidden'); el('command').innerHTML = ''; entries = []; restoreFocus(); }
export function openCommandPalette() {
  closeSheet(); captureFocus();
  const layer = el('command'); layer.classList.remove('hidden');
  layer.innerHTML = `<div class="command-card" role="dialog" aria-modal="true" aria-label="Quick navigation"><label class="search">${icon('search', 18)}<input id="command-input" aria-label="Search pages and bots" autocomplete="off" placeholder="Jump to a bot, group or page" maxlength="120"></label><div class="command-results" id="command-results" role="listbox"></div><p class="command-foot">Up and Down to move · Enter to open · Esc to close</p></div>`;
  updateCommandResults(); el('command-input').focus();
}
export function chooseCommand(index) { const entry = entries[index]; if (!entry) return; closeCommandPalette(); entry.run(); }
export function moveCommand(delta) {
  const nodes = [...el('command-results').querySelectorAll('.command-item')]; if (!nodes.length) return;
  const next = nodes[(nodes.findIndex(n => n.classList.contains('selected')) + delta + nodes.length) % nodes.length];
  nodes.forEach(n => { n.classList.remove('selected'); n.setAttribute('aria-selected', 'false'); });
  next.classList.add('selected'); next.setAttribute('aria-selected', 'true'); next.scrollIntoView({block: 'nearest'});
}

/* ---------- sign-in (Node build) ---------- */

export function showLogin(message = '') {
  let layer = el('login-layer');
  // A repeated session-expiry notice must not rebuild the dialog: doing so would
  // clear a password the user is mid-way through typing.
  const visible = Boolean(layer) && !layer.classList.contains('hidden');
  if (!layer) { layer = document.createElement('div'); layer.id = 'login-layer'; layer.className = 'modal-layer'; document.body.appendChild(layer); }
  if (visible) { const err = el('login-error'); if (err) err.textContent = message; return; }
  layer.innerHTML = `<div class="sheet" role="dialog" aria-modal="true" aria-label="Sign in"><div class="sheet-head"><div><h2>Sign in</h2><p>Enter the dashboard password printed by the server.</p></div></div><form id="login-form" class="form">${field('Dashboard password', `<input class="input" type="password" name="password" autocomplete="current-password" required autofocus>`)}${btn('Unlock', null, {kind: 'primary', type: 'submit', wide: true})}<p class="note" id="login-error" role="alert">${esc(message)}</p></form></div>`;
  layer.classList.remove('hidden');
  requestAnimationFrame(() => layer.querySelector('input[autofocus]')?.focus());
}
export const hideLogin = () => { const layer = el('login-layer'); if (layer) { layer.classList.add('hidden'); layer.innerHTML = ''; } };
