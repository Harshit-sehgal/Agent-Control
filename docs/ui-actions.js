/** What the UI can do, as three lookup tables keyed by `data-action`, form id and
 * control id. app.js owns the DOM events and dispatches here; handlers throw on
 * failure and the dispatcher turns that into one toast. */
import {store, api, sync, setTyping, conversation, findGroup, teamKey, recentRuns, chatKeyOf} from './ui-store.js?v=cbbedc32a9';
import {groupSettings} from './bot-settings.js?v=cbbedc32a9';
import {toast, closeSheet} from './ui-dialogs.js?v=cbbedc32a9';
import {sendChat, streamGroupRun, rerun} from './ui-chat.js?v=cbbedc32a9';
import {runWithTyping} from './run-follow.js?v=cbbedc32a9';
import {whoosh, react} from './ui-fx.js?v=cbbedc32a9';
import {shellActions} from './ui-shell.js?v=cbbedc32a9';
import {conversationActions, conversationForms} from './ui-conversation.js?v=cbbedc32a9';
import {profileActions, profileForms, profileChanges, lookChanged, nameTyped, adoptFirstMessage} from './ui-profile.js?v=cbbedc32a9';
import {settingsActions, reloadAdminPage} from './ui-settings.js?v=cbbedc32a9';
import {changePasswordSheet} from './ui-sheets.js?v=cbbedc32a9';
import {adminActions, adminForms, adminChanges} from './ui-admin.js?v=cbbedc32a9';
import {takeoverActions, takeoverForms} from './ui-takeover.js?v=cbbedc32a9';
import {computerActions, computerForms} from './ui-computer-view.js?v=cbbedc32a9';
import {catalogSearch} from './ui-connect.js?v=cbbedc32a9';

const adminCtx = {reload: reloadAdminPage};
const chatId = () => chatKeyOf(store.route);

export const actions = {
  // navigation: the shell's, the conversation's, the profile's and Settings' own tables come first
  ...shellActions,
  ...conversationActions,
  ...profileActions,
  ...settingsActions,
  'change-password': () => changePasswordSheet(),
  'close-sheet': () => closeSheet(),
  'sheet-confirm': () => closeSheet(true),

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
    const chat = b.dataset.chat || chatId() || teamKey(b.dataset.id);
    if (await rerun(b.dataset.id, {message: b.dataset.message, direct: b.dataset.direct, chat}) === 'ran') toast('Run queued again.');
  },

  ...Object.fromEntries(Object.entries(adminActions).map(([name, run]) => [name, b => run(b, adminCtx)])),
  ...takeoverActions,
  ...computerActions,
};

/** Submit handlers by form id. */
export const forms = {
  'chat-form': async form => {
    const input = form.elements.namedItem('message'), text = input.value;
    input.value = ''; input.style.height = '';
    whoosh(form.querySelector('.cv-send')); react('nod', 700);
    // The first message to a bot made without a job is its job.
    await adoptFirstMessage(chatId(), text);
    await sendChat(chatId(), text);
  },
  ...conversationForms,
  ...profileForms,
  'ask-form': (form, f) => closeSheet(String(f.answer || '')),
  'password-form': async (form, f) => {
    await api('/api/auth/password', 'POST', {currentPassword: f.currentPassword, newPassword: f.newPassword});
    closeSheet(); toast('Password updated. Other sessions are signed out.');
  },
  ...Object.fromEntries(Object.entries(adminForms).map(([id, run]) => [id, (form, f) => run(form, f, adminCtx)])),
  ...takeoverForms,
  ...computerForms,
};

/** `change` events: the shape and colour pickers, then the admin tables. */
export function onControlChange(control) {
  if (lookChanged(control)) return;
  const run = profileChanges[control.dataset.action];
  if (run) return run(control);
  const admin = adminChanges[control.dataset.action];
  if (admin) return admin(control, adminCtx);
}
/** `input` events: the Connect apps search filters live; the New bot name switches Create on. */
export function onControlInput(control) { if (catalogSearch(control)) return; nameTyped(control); }
