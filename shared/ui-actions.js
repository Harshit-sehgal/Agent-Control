/** What the UI can do, as three lookup tables keyed by `data-action`, form id and
 * control id. app.js owns the DOM events and dispatches here; handlers throw on
 * failure and the dispatcher turns that into one toast. */
import {store, api, sync, changed, go, back, setTyping, applyTheme, conversation, groupOfBot, teamKey, groups, setProfile, setPref, setCheckpoints, clearMessages} from './ui-store.js';
import {toast, closeSheet, confirmSheet, askSheet} from './ui-dialogs.js';
import {sendChat, streamGroupRun} from './ui-chat.js';
import {confetti, whoosh, react, poke} from './ui-fx.js';
import {renderList} from './ui-views.js';
import {refreshLists, reloadAdminPage} from './ui-panel.js';
import {BOT_TEMPLATES, pickedTint, pickTint, newChatSheet, newBotSheet, newGroupSheet, attachSheet, sharePostSheet, reminderSheet, toggleReminderFields, openCommandPalette, closeCommandPalette, chooseCommand} from './ui-sheets.js';
import {adminActions, adminForms, adminChanges} from './ui-admin.js';

const adminCtx = {reload: reloadAdminPage};
const chatId = () => store.route.chat;
const findBot = id => groupOfBot(id)?.bots.find(b => b.id === id) || (() => { throw new Error('Bot not found'); })();

async function copyText(text, done) {
  if (!navigator.clipboard?.writeText) throw new Error('Clipboard is not available here.');
  await navigator.clipboard.writeText(text); toast(done);
}
/** Home prompt: open the first group chat and hand the message to the group. */
export async function startGroupChat(text) {
  const message = String(text || '').trim(); if (!message) return;
  const group = groups()[0]; if (!group) throw new Error('Create a bot group first.');
  go({chat: teamKey(group.id)});
  await sendChat(teamKey(group.id), message);
}
async function draftOp(id, op, done) { await api(`/api/drafts/${id}/${op}`, 'POST', {}); toast(done); await sync(); }

export const actions = {
  // navigation
  'open-chat': b => go({chat: b.dataset.id}),
  'back-to-list': () => back({}),
  // The same arrow opens the panel from the thread and steps back from a section.
  'open-info': () => store.route.info && store.route.info !== 'home' ? back({chat: chatId(), info: 'home'}) : go({chat: chatId(), info: 'home'}),
  'close-info': () => back({chat: chatId()}),
  'open-section': b => go({chat: chatId(), info: b.dataset.section}),
  'open-page': b => go({page: b.dataset.page}),
  'open-page-you': () => back({page: 'you'}),
  'poke': b => poke(b),
  'list-filter': b => { store.listFilter = b.dataset.filter; renderList(); },
  'set-theme': b => { applyTheme(b.dataset.theme); changed('route'); },
  'command-open': () => openCommandPalette(),
  'command-dismiss': () => closeCommandPalette(),
  'command-choice': b => chooseCommand(Number(b.dataset.index)),

  // sheets
  'new-chat': () => newChatSheet(),
  'new-bot': () => newBotSheet(),
  'new-group': () => newGroupSheet(),
  'add-bot-to-group': b => newBotSheet(b.dataset.id),
  'attach': () => attachSheet(),
  'share-post': () => sharePostSheet(),
  'new-reminder': () => reminderSheet(),
  'close-sheet': () => closeSheet(),
  'sheet-confirm': () => closeSheet(true),

  // conversation
  'quick-chat': b => sendChat(chatId(), b.dataset.text),
  'home-ask': b => startGroupChat(b.dataset.text),
  'copy-chat': async b => {
    const rows = store.messages[b.dataset.id] || []; if (!rows.length) throw new Error('This conversation is empty.');
    const name = conversation(b.dataset.id)?.name || 'Bot';
    await copyText(rows.map(m => `[${m.at || ''}] ${m.role === 'user' ? 'You' : (m.senderName || (m.role === 'system' ? 'Event' : name))}: ${m.text}`).join('\n\n'), 'Conversation copied');
  },
  'clear-chat': async b => {
    if (!store.messages[b.dataset.id]?.length) return toast('This conversation is already empty');
    if (!await confirmSheet('Clear this conversation?', {confirm: 'Clear', danger: true, detail: 'Messages are removed for everyone in this workspace. Drafts and posts stay.'})) return;
    await clearMessages(b.dataset.id); toast('Conversation cleared');
  },

  // bots
  'avatar': b => {
    const index = Number(b.dataset.index); pickTint(index);
    if (b.closest('#edit-bot-form')) { setProfile(chatId(), {avatarIndex: index}); changed('thread'); }
  },
  'pin-bot': b => { findBot(b.dataset.id); const pinned = !store.profiles[b.dataset.id]?.pinned; setProfile(b.dataset.id, {pinned}); changed(); toast(pinned ? 'Pinned to the top' : 'Unpinned'); },
  'duplicate-bot': async b => {
    const id = b.dataset.id, group = groupOfBot(id), base = findBot(id);
    const copy = await api(`/api/groups/${group.id}/bots`, 'POST', {name: `${base.name} copy`.slice(0, 80), instructions: base.instructions});
    setProfile(copy.id, {avatarIndex: store.profiles[id]?.avatarIndex ?? 0});
    await sync(); go({chat: copy.id}); toast('Bot duplicated. Its chat starts empty.');
  },
  'copy-capture-token': () => copyText(store.state.captureToken || '', 'Capture token copied'),
  'copy-bot-instructions': b => copyText(findBot(b.dataset.id).instructions || '', 'Instructions copied'),

  // posts and drafts
  'load-samples': async () => { closeSheet(); const r = await api('/api/demo/seed', 'POST', {}); toast(`Loaded ${r.added} sample post(s).`); await sync(); },
  'reset-demo': async () => {
    if (!await confirmSheet('Remove the sample posts?', {confirm: 'Remove', danger: true, detail: 'Their drafts go too.'})) return;
    await api('/api/reset-demo', 'POST', {}); toast('Sample posts removed.'); await sync();
  },
  'draft-candidate': async b => { const d = await api(`/api/candidates/${b.dataset.id}/process`, 'POST', {}); toast(`Draft ready (${d.score}/100). It is waiting on you.`); await sync(); },
  'approve-draft': b => { react('cheer', 1400); return draftOp(b.dataset.id, 'approve', 'Approved. Manual posting handoff scheduled.'); },
  'reject-draft': b => { react('aww', 1200); return draftOp(b.dataset.id, 'reject', 'Draft skipped.'); },
  'ready-draft': b => draftOp(b.dataset.id, 'ready', 'Ready to post.'),
  'posted-draft': async b => {
    if (!await confirmSheet('Did you post this on X yourself?', {confirm: 'Yes, I posted it', detail: 'This only records it. Agent Control never posts for you.'})) return;
    confetti(document.querySelector(`[data-draft="${CSS.escape(b.dataset.id)}"] .draft-state`));
    react('cheer', 1600);
    await draftOp(b.dataset.id, 'posted', 'Marked as posted.');
  },
  'edit-draft': b => {
    store.editDraft = b.dataset.id; store.editText = null; changed();
    document.querySelector(`[data-draft="${CSS.escape(b.dataset.id)}"] .edit-form textarea`)?.focus();
  },
  'cancel-edit': () => { store.editDraft = null; store.editText = null; changed(); },
  'rewrite-draft': async b => {
    const direction = await askSheet('Rewrite this draft', {sub: 'Optional: say what to change.', placeholder: 'Shorter, less hype', submit: 'Rewrite'});
    if (direction === null) return;
    await api(`/api/drafts/${b.dataset.id}/rewrite`, 'POST', {direction}); toast('Draft rewritten.'); await sync();
  },
  'copy-draft': async b => {
    const draft = store.state.drafts.find(d => d.id === b.dataset.id); if (!draft) throw new Error('Draft not found');
    await copyText(draft.text, 'Copied. Post it on X yourself.');
  },
  'verify-evidence': async b => { await api(`/api/evidence/${b.dataset.id}/verify`, 'POST', {status: b.dataset.status}); toast('Source updated.'); await sync(); },
  'drop-evidence': async b => {
    if (!await confirmSheet('Remove this source?', {confirm: 'Remove', danger: true})) return;
    await api(`/api/evidence/${b.dataset.id}`, 'DELETE', {}); toast('Source removed.'); await sync();
  },
  'remove-task': async b => {
    if (!await confirmSheet('Remove this reminder?', {confirm: 'Remove', danger: true})) return;
    await api(`/api/tasks/${b.dataset.id}`, 'DELETE', {}); toast('Reminder removed'); await sync();
  },

  // runs (Node build)
  'continue-run': async b => {
    // The POST only returns when the next bot is done, so stream alongside it.
    const key = chatId() || teamKey(b.dataset.id);
    setTyping(key, true);
    try {
      const post = api(`/api/groups/${b.dataset.id}/runs/${b.dataset.run}/continue`, 'POST', {});
      await Promise.all([post, streamGroupRun(b.dataset.id, key, b.dataset.run)]);
    } finally { setTyping(key, false); }
    await sync();
  },
  'retry-run': async b => {
    const key = chatId() || teamKey(b.dataset.id);
    const run = await api(`/api/groups/${b.dataset.id}/chat`, 'POST', {message: b.dataset.message, directBotId: b.dataset.direct || null, checkpoints: store.checkpoints, chatKey: key});
    toast('Run queued again.');
    await streamGroupRun(b.dataset.id, key, run?.runId || null); await sync();
  },

  ...Object.fromEntries(Object.entries(adminActions).map(([name, run]) => [name, b => run(b, adminCtx)])),
};

/** Submit handlers by form id; `.edit-form` and `.evidence-form` repeat per draft so they key on class. */
export const forms = {
  'chat-form': async form => {
    const input = form.elements.namedItem('message'), text = input.value;
    input.value = ''; input.style.height = '';
    whoosh(form.querySelector('.send')); react('nod', 700);
    await sendChat(chatId(), text);
  },
  'home-prompt': (form, f) => startGroupChat(f.prompt),
  'ask-form': (form, f) => closeSheet(String(f.answer || '')),
  'new-bot-form': async (form, f) => {
    const bot = await api(`/api/groups/${f.group}/bots`, 'POST', {name: f.name, instructions: f.instructions});
    setProfile(bot.id, {avatarIndex: pickedTint});
    closeSheet(); await sync(); go({chat: bot.id}); toast(`${bot.name} is ready.`);
  },
  'new-group-form': async (form, f) => {
    const group = await api('/api/groups', 'POST', {name: f.name, description: f.description});
    closeSheet(); await sync(); go({chat: teamKey(group.id), info: 'home'}); toast('Group created. Add a bot to get started.');
  },
  'edit-bot-form': async (form, f) => {
    const b = conversation()?.bot; if (!b) throw new Error('Bot not found');
    // The lasting profile goes through the API so it survives a reload and is
    // shared across devices. Only the cosmetic tint stays in localStorage.
    const permissions = [...form.querySelectorAll('input[name="permissions"]:checked')].map(x => x.value);
    const kind = f.outputKind === 'structured' ? 'structured' : 'text';
    const inputs = b.contract?.inputs?.length ? b.contract.inputs : ['objective', 'previous_output', 'evidence', 'source_post', 'settings', 'identity'];
    const fields = kind === 'structured' ? String(f.fields || '').split(',').map(s => s.trim()).filter(Boolean).map(name => ({name, type: 'text', required: true})) : [];
    await api(`/api/groups/${groupOfBot(b.id).id}/bots/${b.id}`, 'PATCH', {name: f.name, instructions: f.instructions, contract: {version: 1, inputs, output: {kind, fields}}, permissions});
    // Per-bot model override (bring your own key); only when the picker is shown.
    if (form.querySelector('[name="model"]')) await api(`/api/ai/bots/${b.id}`, 'PATCH', {providerId: f.providerId || null, model: f.model || ''});
    await sync(); go({chat: b.id, info: 'home'}); toast('Profile saved.');
  },
  'candidate-form': async (form, f) => {
    const r = await api('/api/candidates', 'POST', f);
    closeSheet(); await sync(); toast(r?.duplicate ? 'That post is already here.' : 'Post shared with the group.');
  },
  'settings-form': async (form, f) => {
    await api('/api/settings', 'PATCH', {topics: f.topics.split(',').map(s => s.trim()).filter(Boolean), style: f.style, opinions: f.opinions, minDelay: Number(f.minDelay), maxDelay: Number(f.maxDelay)});
    await sync(); toast('Saved.');
  },
  'schedule-form': async (form, f) => {
    await api('/api/schedules', 'POST', {label: f.label, kind: f.kind, intervalMinutes: Number(f.intervalMinutes), nextAt: f.nextAt ? new Date(f.nextAt).toISOString() : undefined});
    closeSheet(); await sync(); toast('Reminder set.');
  },
  '.edit-form': async (form, f) => { await api(`/api/drafts/${form.dataset.id}`, 'PATCH', {text: f.text}); store.editDraft = null; store.editText = null; await sync(); toast('Draft updated. It needs your approval again.'); },
  '.evidence-form': async (form, f) => { await api(`/api/drafts/${form.dataset.id}/evidence`, 'POST', {kind: f.kind, claim: f.claim, confidence: Number(f.confidence), link: (f.link || '').trim() || null}); await sync(); toast('Source added.'); },
  ...Object.fromEntries(Object.entries(adminForms).map(([id, run]) => [id, (form, f) => run(form, f, adminCtx)])),
};

const PREF_BY_CONTROL = {'candidate-status': 'candidateStatus', 'candidate-sort': 'candidateSort', 'draft-status': 'draftStatus', 'draft-sort': 'draftSort'};
/** `change` events, by control id (or data-action for the admin tables). */
export function onControlChange(control) {
  const pref = PREF_BY_CONTROL[control.id];
  if (pref) { setPref(pref, control.value); return refreshLists(); }
  if (control.id === 'bot-template') {
    const template = BOT_TEMPLATES[control.value] || BOT_TEMPLATES.blank, form = control.form;
    form.elements.namedItem('name').value = template.name; form.elements.namedItem('instructions').value = template.instructions;
  }
  if (control.id === 'checkpoint-toggle') setCheckpoints(control.checked);
  if (control.matches('#schedule-form [name=kind]')) toggleReminderFields();
  const admin = adminChanges[control.dataset.action];
  if (admin) return admin(control, adminCtx);
}
/** `input` events for the live filters. */
export function onControlInput(control) {
  if (control.id === 'chat-search') { store.listQuery = control.value; renderList(); }
  if (control.id === 'candidate-search') { store.postQuery = control.value; refreshLists(); }
  if (control.matches('.edit-form textarea')) store.editText = control.value;
}
