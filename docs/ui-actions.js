/** What the UI can do, as three lookup tables keyed by `data-action`, form id and
 * control id. app.js owns the DOM events and dispatches here; handlers throw on
 * failure and the dispatcher turns that into one toast. */
import {store, api, sync, changed, go, back, setTyping, applyTheme, conversation, findGroup, groupOfBot, teamKey, groups, setProfile, clearMessages, isStaticDemo, isAdmin, canWrite, recentRuns} from './ui-store.js?v=b55825ff2c';
import {botSettings, groupSettings} from './bot-settings.js?v=b55825ff2c';
import {completeMention, moveRow, pipelineValue} from './ui-model.js?v=b55825ff2c';
import {toast, closeSheet, confirmSheet, askSheet} from './ui-dialogs.js?v=b55825ff2c';
import {sendChat, streamGroupRun, watchQueuedRun} from './ui-chat.js?v=b55825ff2c';
import {runWithTyping} from './run-follow.js?v=b55825ff2c';
import {confetti, whoosh, react, poke} from './ui-fx.js?v=b55825ff2c';
import {renderList, renderMentions} from './ui-views.js?v=b55825ff2c';
import {reloadAdminPage, pipelineList} from './ui-panel.js?v=b55825ff2c';
import {BOT_TEMPLATES, pickedTint, pickTint, newChatSheet, newBotSheet, newGroupSheet, attachSheet, botTaskSheet, toggleReminderFields, openCommandPalette, closeCommandPalette, chooseCommand, changePasswordSheet} from './ui-sheets.js?v=b55825ff2c';
import {adminActions, adminForms, adminChanges} from './ui-admin.js?v=b55825ff2c';
import {takeoverActions, takeoverForms} from './ui-takeover.js?v=b55825ff2c';

const adminCtx = {reload: reloadAdminPage};
const chatId = () => store.route.chat;
const findBot = id => groupOfBot(id)?.bots.find(b => b.id === id) || (() => { throw new Error('Bot not found'); })();
/** Patch a bot by id. A bot removed in another tab fails with a sentence the
 * toast can show, not "Cannot read properties of undefined". */
const patchBot = (id, body) => {
  const group = groupOfBot(id);
  if (!group) throw new Error('That bot is no longer in a group.');
  return api(`/api/groups/${group.id}/bots/${id}`, 'PATCH', body);
};

async function copyText(text, done) {
  if (!navigator.clipboard?.writeText) throw new Error('Clipboard is not available here.');
  await navigator.clipboard.writeText(text); toast(done);
}
/** Home prompt: open the group chat the prompt belongs to and hand the message
 * to the group. Without an id it is the first group, which is where the landing
 * page's own chips and form point. */
export async function startGroupChat(text, groupId) {
  const message = String(text || '').trim(); if (!message) return;
  const group = (groupId ? findGroup(groupId) : null) || groups()[0]; if (!group) throw new Error('Create a bot group first.');
  go({chat: teamKey(group.id)});
  await sendChat(teamKey(group.id), message);
}

export const actions = {
  // navigation
  'open-chat': b => go({chat: b.dataset.id}),
  'back-to-list': () => back({}),
  // The same arrow opens the panel from the thread and steps back from a section.
  'open-info': () => store.route.info && store.route.info !== 'home' ? back({chat: chatId(), info: 'home'}) : go({chat: chatId(), info: 'home'}),
  'close-info': () => back({chat: chatId()}),
  'open-section': b => { if (b.dataset.section === 'group-settings') store.pipelineDraft = null; go({chat: chatId(), info: b.dataset.section}); },
  'open-page': b => go({page: b.dataset.page}),
  'open-page-you': () => back({page: 'you'}),
  'change-password': () => changePasswordSheet(),
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
  'new-bot-task': () => botTaskSheet(),
  'close-sheet': () => closeSheet(),
  'sheet-confirm': () => closeSheet(true),

  // conversation
  'quick-chat': b => sendChat(chatId(), b.dataset.text),
  'mention-pick': b => {
    const input = document.querySelector('#chat-form textarea'); if (!input) return;
    input.value = completeMention(input.value, b.dataset.name); input.focus(); renderMentions(input.value);
  },
  'home-ask': b => startGroupChat(b.dataset.text, b.dataset.id),
  'copy-chat': async b => {
    const rows = store.messages[b.dataset.id] || []; if (!rows.length) throw new Error('This conversation is empty.');
    const name = conversation(b.dataset.id)?.name || 'Bot';
    await copyText(rows.map(m => `[${m.at || ''}] ${m.role === 'user' ? 'You' : (m.senderName || (m.role === 'system' ? 'Event' : name))}: ${m.text}`).join('\n\n'), 'Conversation copied');
  },
  'clear-chat': async b => {
    if (!store.messages[b.dataset.id]?.length) return toast('This conversation is already empty');
    if (!await confirmSheet('Clear this conversation?', {confirm: 'Clear', danger: true, detail: 'Messages are removed for everyone in this workspace.'})) return;
    await clearMessages(b.dataset.id); toast('Conversation cleared');
  },

  // bots
  'avatar': async b => {
    const index = Number(b.dataset.index); pickTint(index);
    if (!b.closest('#edit-bot-form')) return;
    if (!canWrite()) throw new Error('Only a member can edit a bot; this account can read it.');
    // The colour syncs through the server; the local pick paints it at once.
    const bot = findBot(chatId());
    setProfile(bot.id, {avatarIndex: index}); bot.settings = {...(bot.settings || {}), tint: index}; changed('thread');
    await patchBot(bot.id, {settings: {tint: index}});
  },
  'toggle-bot': async b => {
    const bot = findBot(b.dataset.id), enabled = !botSettings(bot).enabled;
    await patchBot(bot.id, {settings: {enabled}}); await sync(); toast(enabled ? `${bot.name} is on.` : `${bot.name} is switched off.`);
  },
  'remove-bot': async b => {
    const bot = findBot(b.dataset.id), group = groupOfBot(bot.id);
    if (!await confirmSheet(`Remove ${bot.name} from ${group.name}?`, {confirm: 'Remove', danger: true, detail: 'Its chat and scheduled tasks stop. Past group messages stay.'})) return;
    await api(`/api/groups/${group.id}/bots/${bot.id}`, 'DELETE', {});
    await sync(); go({chat: teamKey(group.id)}, {replace: true}); toast(`${bot.name} removed.`);
  },
  'pin-bot': b => { findBot(b.dataset.id); const pinned = !store.profiles[b.dataset.id]?.pinned; setProfile(b.dataset.id, {pinned}); changed(); toast(pinned ? 'Pinned to the top' : 'Unpinned'); },
  'duplicate-bot': async b => {
    const id = b.dataset.id, group = groupOfBot(id), base = findBot(id);
    const copy = await api(`/api/groups/${group.id}/bots`, 'POST', {name: `${base.name} copy`.slice(0, 80), instructions: base.instructions, settings: {...botSettings(base), lead: false}});
    if (base.contract || base.permissions) await api(`/api/groups/${group.id}/bots/${copy.id}`, 'PATCH', {contract: base.contract, permissions: base.permissions || []});
    setProfile(copy.id, {avatarIndex: store.profiles[id]?.avatarIndex ?? 0});
    await sync(); go({chat: copy.id}); toast('Bot duplicated. Its chat starts empty.');
  },
  'copy-bot-instructions': b => copyText(findBot(b.dataset.id).instructions || '', 'Instructions copied'),

  // memory: per-model rulebook and per-chat recap
  'update-memory': async b => {
    if (isStaticDemo()) { toast('Updating memory needs the Node build and an AI provider.'); return; }
    const bot = findBot(b.dataset.id);
    const result = await api('/api/memory/consolidate', 'POST', {botId: bot.id, chat: b.dataset.chat || bot.id});
    await sync();
    toast(result.skipped ? 'Memory is already up to date.' : 'Memory updated.');
  },
  'forget-rule': async b => {
    await api(`/api/memory/rules/${encodeURIComponent(b.dataset.rule)}?model=${encodeURIComponent(b.dataset.model)}`, 'DELETE');
    await sync();
    toast('Rule forgotten.');
  },
  'forget-chat-memory': async b => {
    if (!await confirmSheet('Forget this chat for the model?', {confirm: 'Forget', danger: true, detail: 'The recap goes. Messages stay in the conversation.'})) return;
    await api('/api/memory/forget', 'POST', {chat: b.dataset.chat});
    await sync();
    toast('Chat memory forgotten.');
  },

  'remove-bot-task': async b => {
    if (!await confirmSheet('Remove this scheduled task?', {confirm: 'Remove', danger: true, detail: 'It stops running. Answers it already gave stay in the chat.'})) return;
    await api(`/api/tasks/${b.dataset.id}`, 'DELETE', {}); toast('Scheduled task removed'); await sync();
  },
  'retry-bot-task': async b => {
    await api(`/api/tasks/${b.dataset.id}/retry`, 'POST', {}); toast('Task queued again.'); await sync();
  },

  // groups
  'pipeline-move': b => {
    const draft = store.pipelineDraft, group = conversation()?.group; if (!draft || !group) return;
    const index = Number(b.dataset.index), delta = Number(b.dataset.delta), to = index + delta;
    draft.rows = moveRow(draft.rows, index, delta);
    const list = document.getElementById('pipeline-rows'); if (!list) return;
    list.innerHTML = pipelineList(group);
    // Keep the keyboard on the bot that moved, or on its other arrow at an end.
    const same = list.querySelector(`[data-action="pipeline-move"][data-index="${to}"][data-delta="${delta}"]`);
    (same && !same.disabled ? same : list.querySelector(`[data-action="pipeline-move"][data-index="${to}"][data-delta="${-delta}"]`))?.focus();
  },
  'delete-group': async b => {
    const group = findGroup(b.dataset.id); if (!group) throw new Error('Group not found');
    if (!await confirmSheet(`Delete ${group.name}?`, {confirm: 'Delete group', danger: true, detail: 'Its bots, their chats and its scheduled tasks are removed. This cannot be undone.'})) return;
    await api(`/api/groups/${group.id}`, 'DELETE', {});
    store.pipelineDraft = null; await sync(); go({}, {replace: true}); toast('Group deleted.');
  },

  // runs (Node build)
  'continue-run': async b => {
    const group = findGroup(b.dataset.id);
    const run = recentRuns(group?.id).find(r => r.id === b.dataset.run);
    const key = run?.chatKey || chatId() || teamKey(b.dataset.id);
    // The POST only returns when the next bot is done, so stream alongside it.
    await runWithTyping({key, setTyping, sync, concurrent: true,
      send: () => api(`/api/groups/${b.dataset.id}/runs/${b.dataset.run}/continue`, 'POST', {}),
      follow: () => streamGroupRun(b.dataset.id, key, b.dataset.run)});
  },
  // A bot asked to use the local browser agent.
  'approve-plan': async b => {
    const group = findGroup(b.dataset.id);
    const run = recentRuns(group?.id).find(r => r.id === b.dataset.run);
    const key = run?.chatKey || chatId() || teamKey(b.dataset.id);
    await runWithTyping({key, setTyping, sync,
      send: async () => { await api(`/api/groups/${b.dataset.id}/runs/${b.dataset.run}/plan`, 'POST', {approve: true}); await sync(); },
      follow: () => streamGroupRun(b.dataset.id, key, b.dataset.run)});
  },
  'cancel-run': async b => {
    await api(`/api/groups/${b.dataset.id}/runs/${b.dataset.run}/cancel`, 'POST', {}); toast('Run stopped.'); await sync();
  },
  'cancel-plan': async b => {
    await api(`/api/groups/${b.dataset.id}/runs/${b.dataset.run}/plan`, 'POST', {approve: false}); toast('Plan cancelled.'); await sync();
  },
  'approve-browser': async b => {
    const sent = await api(`/api/browser-requests/${b.dataset.id}/approve`, 'POST', {});
    toast(sent?.via === 'server' ? 'Running on this server. The result will appear here.' : 'Sent to your local agent. The result will appear here.');
    await sync();
    const request = (store.state.browserRequests || []).find(r => r.id === b.dataset.id);
    if (!request?.runId || !request.groupId) return;
    const key = request.chatKey || teamKey(request.groupId);
    await runWithTyping({key, setTyping, sync, follow: () => streamGroupRun(request.groupId, key, request.runId, {ignore: ['awaiting_browser']})});
  },
  'deny-browser': async b => {
    await api(`/api/browser-requests/${b.dataset.id}/deny`, 'POST', {});
    toast('Declined.');
    await sync();
    const request = (store.state.browserRequests || []).find(r => r.id === b.dataset.id);
    if (!request?.runId || !request.groupId) return;
    const key = request.chatKey || teamKey(request.groupId);
    await runWithTyping({key, setTyping, sync, follow: () => streamGroupRun(request.groupId, key, request.runId)});
  },
  'retry-run': async b => {
    const key = b.dataset.chat || chatId() || teamKey(b.dataset.id);
    const run = await api(`/api/groups/${b.dataset.id}/chat`, 'POST', {message: b.dataset.message, directBotId: b.dataset.direct || null, checkpoints: groupSettings(findGroup(b.dataset.id)).checkpoints, chatKey: key});
    if (await watchQueuedRun(b.dataset.id, key, run)) return;
    toast('Run queued again.');
    await streamGroupRun(b.dataset.id, key, run?.runId || null); await sync();
  },

  ...Object.fromEntries(Object.entries(adminActions).map(([name, run]) => [name, b => run(b, adminCtx)])),
  ...takeoverActions,
};

/** Submit handlers by form id. */
export const forms = {
  'chat-form': async form => {
    const input = form.elements.namedItem('message'), text = input.value;
    input.value = ''; input.style.height = ''; renderMentions('');
    whoosh(form.querySelector('.send')); react('nod', 700);
    await sendChat(chatId(), text);
  },
  'home-prompt': (form, f) => startGroupChat(f.prompt),
  'ask-form': (form, f) => closeSheet(String(f.answer || '')),
  'new-bot-form': async (form, f) => {
    const bot = await api(`/api/groups/${f.group}/bots`, 'POST', {name: f.name, instructions: f.instructions, settings: {tint: pickedTint}});
    setProfile(bot.id, {avatarIndex: pickedTint});
    closeSheet(); await sync(); go({chat: bot.id}); toast(`${bot.name} is ready.`);
  },
  'new-group-form': async (form, f) => {
    const group = await api('/api/groups', 'POST', {name: f.name, description: f.description});
    closeSheet(); await sync(); go({chat: teamKey(group.id), info: 'home'}); toast('Group created. Add a bot to get started.');
  },
  'edit-bot-form': async (form, f) => {
    if (!canWrite()) throw new Error('Only a member can edit a bot; this account can read it.');
    const b = conversation()?.bot; if (!b) throw new Error('Bot not found');
    // The lasting profile goes through the API so it survives a reload and is
    // shared across devices. Only the cosmetic tint stays in localStorage.
    const permissions = [...form.querySelectorAll('input[name="permissions"]:checked')].map(x => x.value);
    const kind = f.outputKind === 'structured' ? 'structured' : 'text';
    const inputs = b.contract?.inputs?.length ? b.contract.inputs : ['objective', 'previous_output', 'evidence', 'source_post', 'settings', 'identity'];
    const fields = kind === 'structured' ? String(f.fields || '').split(',').map(s => s.trim()).filter(Boolean).map(name => ({name, type: 'text', required: true})) : [];
    const on = name => Boolean(form.elements.namedItem(name)?.checked), picked = form.querySelector('.tint.on');
    const settings = {
      enabled: on('enabled'), replyLength: f.replyLength, style: f.style || '',
      temperature: String(f.temperature ?? '').trim() === '' ? null : Number(f.temperature),
      contextMessages: Number(f.contextMessages), memory: on('memory'), summonable: on('summonable'), canHandoff: on('canHandoff'), lead: on('lead'),
      ...(f.browserApproval ? {browserApproval: f.browserApproval} : {}),
      ...(picked ? {tint: Number(picked.dataset.index)} : {}),
    };
    await api(`/api/groups/${groupOfBot(b.id).id}/bots/${b.id}`, 'PATCH', {name: f.name, instructions: f.instructions, contract: {version: 1, inputs, output: {kind, fields}}, permissions, settings});
    // Per-bot model override (bring your own key); only when the picker is shown.
    if (form.querySelector('[name="model"]')) await api(`/api/ai/bots/${b.id}`, 'PATCH', {providerId: f.providerId || null, model: f.model || ''});
    await sync(); go({chat: b.id, info: 'home'}); toast('Profile saved.');
  },
  'group-settings-form': async (form, f) => {
    if (!canWrite()) throw new Error('A member can change group settings.');
    const group = conversation()?.group; if (!group) throw new Error('Group not found');
    const rows = store.pipelineDraft?.groupId === group.id ? store.pipelineDraft.rows : [];
    const pipeline = pipelineValue(rows, group);
    if (Array.isArray(pipeline) && !pipeline.length) throw new Error('Tick at least one bot to take turns.');
    const on = name => Boolean(form.elements.namedItem(name)?.checked);
    await api(`/api/groups/${group.id}`, 'PATCH', {name: f.name, description: f.description || '', settings: {routing: f.routing || groupSettings(group).routing, coordination: f.coordination || groupSettings(group).coordination, pipeline, maxSteps: Number(f.maxSteps), checkpoints: on('checkpoints'), confirmPlan: on('confirmPlan'), botHandoffs: on('botHandoffs')}});
    store.pipelineDraft = null; await sync(); toast('Group settings saved.');
  },
  'bot-task-form': async (form, f) => {
    const once = f.kind === 'once';
    const payload = {groupId: f.groupId, botId: f.botId || null, message: f.message, kind: once ? 'once' : 'interval', ...(once ? {nextAt: new Date(f.nextAt).toISOString()} : {intervalMinutes: Number(f.intervalMinutes)})};
    await api('/api/tasks', 'POST', {kind: 'bot-task', payload, ...(once ? {} : {intervalMinutes: payload.intervalMinutes})});
    closeSheet(); await sync(); toast(once ? 'Task scheduled.' : `Task scheduled every ${payload.intervalMinutes} min.`);
  },
  'password-form': async (form, f) => {
    await api('/api/auth/password', 'POST', {currentPassword: f.currentPassword, newPassword: f.newPassword});
    closeSheet(); toast('Password updated. Other sessions are signed out.');
  },
  ...Object.fromEntries(Object.entries(adminForms).map(([id, run]) => [id, (form, f) => run(form, f, adminCtx)])),
  ...takeoverForms,
};

/** `change` events, by control id (or data-action for the admin tables). */
export function onControlChange(control) {
  if (control.id === 'bot-template') {
    const template = BOT_TEMPLATES[control.value] || BOT_TEMPLATES.blank, form = control.form;
    form.elements.namedItem('name').value = template.name; form.elements.namedItem('instructions').value = template.instructions;
  }
  if (control.matches('#bot-task-form [name=kind]')) toggleReminderFields(control.form.id);
  if (control.matches('[name=pipeline-include]') && store.pipelineDraft) {
    const r = store.pipelineDraft.rows[Number(control.dataset.index)]; if (r) r.included = control.checked;
  }
  const admin = adminChanges[control.dataset.action];
  if (admin) return admin(control, adminCtx);
}
/** `input` events for the live filters. */
export function onControlInput(control) {
  if (control.id === 'chat-search') { store.listQuery = control.value; renderList(); }
}
