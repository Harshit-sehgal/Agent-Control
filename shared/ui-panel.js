/** Everything that used to be a dashboard tab now hangs off a conversation:
 * the info panel of the open chat (drafts, posts, reminders, runs, voice, the
 * bot's profile) and the "You" pages (account, admin, about). */
import {filterCandidates, filterDrafts} from './usability.js';
import {ACTIONS, OUTPUT_KINDS} from './contracts.js';
import {BOT_DEFAULTS, MAX_CONTEXT_MESSAGES, MAX_STEPS_LIMIT, botSettings, groupSettings, pipelineOf} from './bot-settings.js';
import {BUSY_STATUSES} from './coordination.js';
import {ACTIVE_DRAFTS, chatTasks, pipelineRows, retryTarget, runBelongsToChat} from './ui-model.js';
import {esc, icon, avatar, groupAvatar, tintClass, TINT_COUNT, btn, iconBtn, row, box, field, note, empty, tag, pageHead, fullDate} from './ui-kit.js';
import {store, conversation, isStaticDemo, isAdmin, canWrite, isXGroup, botTint, recentRuns, THEMES, themeChoice} from './ui-store.js';
import {draftCard, postCard} from './ui-views.js';
import {ADMIN_PAGES, adminPage} from './ui-admin.js';

const el = id => document.getElementById(id);
const options = (pairs, current) => pairs.map(([value, label]) => `<option value="${esc(value)}"${value === current ? ' selected' : ''}>${esc(label)}</option>`).join('');
const checkRow = (name, label, help, on, lock = '') => `<label class="check-row"><input type="checkbox" name="${name}"${on ? ' checked' : ''}${lock}><span>${esc(label)}${help ? `<small>${esc(help)}</small>` : ''}</span></label>`;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const select = (id, label, pairs, current) => `<label class="pick"><span>${esc(label)}</span><select id="${id}" class="input" aria-label="${esc(label)}">${options(pairs, current)}</select></label>`;

/* ---------- group info ---------- */

const ROUTING = [
  ['pipeline', 'Take turns', 'Bots take turns in order'],
  ['mentions', 'Only when asked', 'Only the first bot answers unless you @mention others'],
  ['everyone', 'Everyone', 'Every bot answers'],
];
/** One line on what a message without a mention does in this group. */
function routingNote(group) {
  const s = groupSettings(group), first = group.bots.find(b => b.id === pipelineOf(group)[0])?.name;
  const plain = s.routing === 'mentions' ? (first ? `only ${esc(first)} answers` : 'nobody answers') : s.routing === 'everyone' ? 'every bot that is on answers' : 'the bots take turns in order';
  return `Mention a bot with @name to pick who answers, or @everyone. Bots from other groups can be @mentioned too. Without a mention ${plain}, ${plural(s.maxSteps, 'step')} at most.`;
}
const offTag = bot => botSettings(bot).enabled ? (botSettings(bot).lead ? tag('Primary') : '') : tag('Off');

function groupHome(conv) {
  const {group} = conv, {state} = store, x = isXGroup(group), runs = recentRuns(group.id);
  const draftWait = x ? (state.drafts || []).filter(d => d.status === 'pending' || d.status === 'ready').length : 0;
  const paused = runs.filter(r => r.status === 'awaiting_checkpoint' && runBelongsToChat(r, conv.id)).length;
  const plans = runs.filter(r => r.status === 'awaiting_plan' && runBelongsToChat(r, conv.id)).length;
  const pages = runs.filter(r => (r.status === 'awaiting_feed' || r.status === 'awaiting_browser') && runBelongsToChat(r, conv.id)).length;
  const runRight = paused ? `${paused} paused` : plans ? (plans === 1 ? 'A plan is waiting' : `${plans} plans waiting`) : pages ? 'Waiting on a page' : (runs.length ? `Last ${fullDate(runs[0].createdAt)}` : 'None yet');
  const reminders = (state.tasks || []).filter(t => t.kind === 'reminder' && !['done', 'cancelled'].includes(t.status)).length;
  const scheduled = chatTasks(state.tasks, group.id, null).length;
  const members = group.bots.map(b => ({name: b.name, tint: botTint(group, b.id)}));
  const tools = [
    x && row({title: 'Drafts', right: draftWait ? `${draftWait} waiting on you` : `${state.drafts.length}`, tone: draftWait ? 'warn' : '', action: 'open-section', data: {section: 'drafts'}}),
    x && row({title: 'Posts found', right: String(state.candidates.length), action: 'open-section', data: {section: 'posts'}}),
    x && row({title: 'Reminders', right: reminders ? String(reminders) : 'None', action: 'open-section', data: {section: 'reminders'}}),
    row({title: 'Runs', right: runRight, tone: (paused || plans || pages) ? 'warn' : '', action: 'open-section', data: {section: 'runs'}}),
    row({title: 'Scheduled tasks', right: scheduled ? String(scheduled) : 'None', action: 'open-section', data: {section: 'tasks'}}),
    row({title: 'Group settings', right: esc(ROUTING.find(r => r[0] === groupSettings(group).routing)?.[1] || ''), action: 'open-section', data: {section: 'group-settings'}}),
    x && row({title: 'Voice and timing', right: `${state.settings.minDelay} to ${state.settings.maxDelay} min delay`, action: 'open-section', data: {section: 'voice'}}),
  ].filter(Boolean).join('');
  const write = canWrite();
  const bots = group.bots.map(b => row({lead: avatar(b.name, botTint(group, b.id), 38), title: esc(b.name), sub: esc((b.instructions || '').slice(0, 70)), right: offTag(b), action: 'open-chat', id: b.id})).join('')
    + (write ? `<button type="button" class="row" data-action="add-bot-to-group" data-id="${esc(group.id)}"><span class="avatar avatar-plain small">${icon('plus', 18)}</span><span class="row-main"><span class="row-title">Add a bot</span></span></button>` : '');
  return `${pageHead('Group info', {back: 'close-info'})}
    <div class="hero"><button type="button" class="poke" data-action="poke" aria-label="Say hi">${groupAvatar(members, 84)}</button><h2>${esc(group.name)}</h2><p>${esc(group.description || 'A group of bots that hand work to each other.')}</p></div>
    ${box(tools)}${box(bots, plural(group.bots.length, 'bot'))}
    ${box(row({title: 'Copy conversation', action: 'copy-chat', id: conv.id}) + (write ? row({title: 'Clear conversation', action: 'clear-chat', id: conv.id, tone: 'bad'}) : ''))}
    ${note(routingNote(group))}`;
}

/** The pipeline editor rows, repainted alone when a bot moves so the rest of
 * the form keeps what was typed. */
export function pipelineList(group) {
  const rows = store.pipelineDraft?.rows || [], name = id => group.bots.find(b => b.id === id)?.name || id;
  if (!rows.length) return empty('No bots yet', 'Add a bot to this group first.');
  const write = canWrite();
  const move = (i, delta, label, who) => write ? `<button type="button" class="btn quiet small" data-action="pipeline-move" data-index="${i}" data-delta="${delta}" aria-label="Move ${esc(who)} ${label.toLowerCase()}"${i + delta < 0 || i + delta >= rows.length ? ' disabled' : ''}><span>${label}</span></button>` : '';
  return rows.map((r, i) => `<div class="pipe-row"><label class="check-row"><input type="checkbox" name="pipeline-include" data-index="${i}"${r.included ? ' checked' : ''}${write ? '' : ' disabled'}><span>${i + 1}. ${esc(name(r.id))} ${offTag(group.bots.find(b => b.id === r.id))}</span></label><span class="row-actions">${move(i, -1, 'Up', name(r.id))}${move(i, 1, 'Down', name(r.id))}</span></div>`).join('');
}
function groupSettingsSection(conv) {
  const {group} = conv, s = groupSettings(group);
  if (store.pipelineDraft?.groupId !== group.id) store.pipelineDraft = {groupId: group.id, rows: pipelineRows(group, s.pipeline)};
  const writable = canWrite();
  const lock = writable ? '' : ' disabled';
  const routing = ROUTING.map(([value, label, help]) => `<label class="check-row"><input type="radio" name="routing" value="${value}"${s.routing === value ? ' checked' : ''}${lock}><span>${esc(label)}<small>${esc(help)}</small></span></label>`).join('');
  const removable = !isXGroup(group) && (isAdmin() || isStaticDemo());
  return `${pageHead('Group settings', {sub: 'How this group shares out work.', back: 'open-info'})}
    <form id="group-settings-form" class="form">
      ${field('Name', `<input class="input" name="name" value="${esc(group.name)}" maxlength="80" required${lock}>`)}
      ${field('What is it for?', `<textarea class="input" name="description" rows="2" maxlength="300"${lock}>${esc(group.description || '')}</textarea>`)}
      <fieldset class="contract-fieldset"><legend>When a message has no @mention</legend>${routing}</fieldset>
      <fieldset class="contract-fieldset"><legend>Order of turns</legend><div id="pipeline-rows">${pipelineList(group)}</div><p class="field-help">Untick a bot to leave it out of the turns. You can still @mention it.</p></fieldset>
      ${field('Most steps in one run', `<input class="input" type="number" name="maxSteps" min="1" max="${MAX_STEPS_LIMIT}" step="1" value="${Number(s.maxSteps)}" required inputmode="numeric"${lock}>`, `1 to ${MAX_STEPS_LIMIT}. A step is one bot answering.`)}
      <fieldset class="contract-fieldset"><legend>Who keeps the task on track</legend>
        <label class="check-row"><input type="radio" name="coordination" value="direct"${s.coordination === 'direct' ? ' checked' : ''}${lock}><span>I'll direct them<small>You @mention who you want, or the pipeline runs. Nobody checks the outcome.</small></span></label>
        <label class="check-row"><input type="radio" name="coordination" value="tracked"${s.coordination === 'tracked' ? ' checked' : ''}${lock}><span>One bot keeps it on track<small>A plain message to the primary bot plans who is needed and checks that it got done.</small></span></label>
      </fieldset>
      ${checkRow('confirmPlan', 'Show me the plan first', 'When one bot keeps it on track, wait until you press Start.', s.confirmPlan, lock)}
      ${checkRow('checkpoints', 'Approve between steps', 'Pause after each bot until you say continue.', s.checkpoints, lock)}
      ${checkRow('botHandoffs', 'Bots may hand off to each other', 'A bot can @mention another bot to pass work on.', s.botHandoffs, lock)}
      ${writable ? btn('Save settings', null, {kind: 'primary', type: 'submit', wide: true}) : note('A member can change group settings.')}
    </form>
    ${removable ? box(row({title: 'Delete group', sub: 'Removes its bots and their chats.', action: 'delete-group', id: group.id, tone: 'bad'})) : ''}`;
}

const TASK_STATE = {done: 'Done', failed: 'Failed', running: 'Running now'};
function tasksSection(conv) {
  const write = canWrite();
  const list = chatTasks(store.state.tasks, conv.group.id, conv.isTeam ? null : conv.bot.id);
  const rows = list.map(t => {
    const every = Number(t.intervalMinutes ?? t.payload?.intervalMinutes);
    const when = TASK_STATE[t.status] || `Next ${fullDate(t.runAt)}`;
    const retry = write && ['failed', 'cancelled'].includes(t.status) ? btn('Retry', 'retry-bot-task', {id: t.id, small: true}) : '';
    const remove = write && t.status !== 'running' ? btn('Remove', 'remove-bot-task', {id: t.id, small: true, kind: 'danger'}) : '';
    return `<div class="row"><span class="row-main"><span class="row-title">${esc(t.payload?.label || String(t.payload?.message || t.title || '').slice(0, 90))}</span><span class="row-sub">${t.payload?.kind === 'interval' ? `Every ${every} min` : 'Once'} · ${esc(when)}${t.lastError ? ` · ${esc(t.lastError)}` : ''}</span></span>${write && (retry || remove) ? `<span class="row-actions">${retry}${remove}</span>` : ''}</div>`;
  }).join('') || empty('Nothing scheduled', `Ask ${conv.isTeam ? 'the group' : conv.name} to do something on a timer.`);
  return `${pageHead('Scheduled tasks', {sub: 'The answers arrive in this chat.', back: 'open-info', right: canWrite() ? iconBtn('plus', 'New scheduled task', 'new-bot-task') : ''})}
    ${box(rows)}
    ${note(isStaticDemo() ? 'This demo runs tasks only while the page is open.' : 'Tasks run with retries while the Node server is up.')}`;
}

function draftsBody() {
  const list = filterDrafts(store.state.drafts, {status: store.prefs.draftStatus, sort: store.prefs.draftSort});
  if (!list.length) return empty('No drafts here', 'Change the filter, or ask the group to draft a reply.');
  return list.map(d => ACTIVE_DRAFTS.includes(d.status) ? draftCard(d) : `<div class="row"><span class="row-main"><span class="row-title">${esc(d.author)}</span><span class="row-sub">${esc(String(d.text).slice(0, 160))}</span></span>${tag(d.status === 'posted' ? 'Posted' : 'Skipped', d.status === 'posted' ? 'good' : '')}</div>`).join('');
}
function draftsSection() {
  const pending = store.state.drafts.filter(d => d.status === 'pending').length;
  return `${pageHead('Waiting on you', {sub: `${pending} to decide. Nothing posts by itself.`, back: 'open-info'})}
    <div class="toolbar">${select('draft-status', 'Show', [['active', 'Active'], ['pending', 'To decide'], ['scheduled', 'Scheduled'], ['ready', 'Ready to post'], ['posted', 'Posted'], ['rejected', 'Skipped'], ['all', 'Everything']], store.prefs.draftStatus)}${select('draft-sort', 'Sort', [['newest', 'Newest'], ['oldest', 'Oldest'], ['score-high', 'Top score']], store.prefs.draftSort)}</div>
    <div class="stack" id="approval-results">${draftsBody()}</div>`;
}

const visiblePosts = () => filterCandidates(store.state.candidates, {status: store.prefs.candidateStatus, sort: store.prefs.candidateSort, query: store.postQuery});
function postsBody() {
  const {state} = store, list = visiblePosts();
  const count = el('candidate-count'); if (count) count.textContent = `${list.length} of ${state.candidates.length}`;
  return list.map(c => `<div class="bubble card">${postCard(c, state.drafts.some(d => d.candidateId === c.id))}</div>`).join('') || empty('No posts match', 'Change the filters, or share a new post.');
}
function postsSection() {
  const {state} = store;
  const write = canWrite();
  return `${pageHead('Posts found', {sub: 'Posts you shared or captured with the extension.', back: 'open-info', right: write ? iconBtn('plus', 'Share a post', 'share-post') : ''})}
    <label class="search">${icon('search', 18)}<input id="candidate-search" type="search" placeholder="Search posts, topics, authors, links" aria-label="Search posts" value="${esc(store.postQuery)}"></label>
    <div class="toolbar">${select('candidate-status', 'Show', [['all', 'All posts'], ['new', 'Not drafted'], ['drafted', 'Drafted'], ['high', 'Score 70+']], store.prefs.candidateStatus)}${select('candidate-sort', 'Sort', [['newest', 'Newest'], ['oldest', 'Oldest'], ['score-high', 'Top score'], ['score-low', 'Low score']], store.prefs.candidateSort)}</div>
    <p class="count"><span id="candidate-count">${visiblePosts().length} of ${state.candidates.length}</span>${write ? `<span class="row-actions">${btn('Load samples', 'load-samples', {small: true})}${state.candidates.some(c => c.demo) ? btn('Remove samples', 'reset-demo', {small: true, kind: 'ghost'}) : ''}</span>` : ''}</p>
    <div class="stack" id="candidate-results">${postsBody()}</div>`;
}

const taskLine = t => t.status === 'done' ? 'Completed' : t.status === 'failed' ? 'Failed' : t.status === 'cancelled' ? 'Removed' : t.status === 'running' ? 'Running' : `Due ${fullDate(t.runAt)}`;
function remindersSection() {
  const {state} = store, reminders = (state.tasks || []).filter(t => t.kind === 'reminder' && t.status !== 'cancelled'), scheduled = state.drafts.filter(d => d.status === 'scheduled');
  const write = canWrite();
  const list = reminders.map(t => `<div class="row"><span class="row-main"><span class="row-title">${esc(t.payload?.label || t.title)}</span><span class="row-sub">${t.payload?.kind === 'interval' ? `Every ${Number(t.intervalMinutes)} min` : 'One time'} · ${esc(taskLine(t))}${t.lastError ? ` · ${esc(t.lastError)}` : ''}</span></span>${write && t.status !== 'running' ? `<span class="row-actions">${btn('Remove', 'remove-task', {id: t.id, small: true, kind: 'danger'})}</span>` : ''}</div>`).join('') || empty('No reminders', 'Set one to be nudged to check new posts.');
  const handoffs = scheduled.map(d => `<div class="row"><span class="row-main"><span class="row-title">${esc(d.author)}</span><span class="row-sub">Ready ${esc(fullDate(d.dueAt))}</span></span>${tag('Scheduled')}</div>`).join('') || empty('Nothing scheduled', 'Approve a draft and it waits here until it is ready.');
  return `${pageHead('Reminders', {back: 'open-info', right: write ? iconBtn('plus', 'New reminder', 'new-reminder') : ''})}
    ${box(list)}${box(handoffs, 'Approved, waiting to be ready')}
    ${note(isStaticDemo() ? 'This demo checks timers only while the page is open.' : 'Reminders run as tasks with retries while the Node server is up.')}`;
}

const RUN_TONE = {completed: 'good', failed: 'bad', interrupted: 'bad', running: 'warn', queued: 'warn', awaiting_checkpoint: 'warn', awaiting_plan: 'warn', awaiting_feed: 'warn', awaiting_browser: 'warn'};
function runCard(group, run) {
  const name = id => group.bots.find(b => b.id === id)?.name || id, steps = run.recipients || [], live = !isStaticDemo(), status = String(run.status || 'unknown');
  const plan = status === 'awaiting_plan' ? `${btn('Start', 'approve-plan', {id: group.id, small: true, kind: 'primary', data: {run: run.id}})}${btn('Cancel', 'cancel-plan', {id: group.id, small: true, data: {run: run.id}})}` : '';
  const stuck = !plan && isStaticDemo() && BUSY_STATUSES.includes(status) && status !== 'awaiting_checkpoint';
  const action = !canWrite() ? '' : plan || (status === 'awaiting_checkpoint' ? btn('Approve next step', 'continue-run', {id: group.id, small: true, kind: 'primary', data: {run: run.id}})
    : stuck ? btn('Cancel', 'cancel-plan', {id: group.id, small: true, data: {run: run.id}})
    : live && ['failed', 'interrupted'].includes(status) ? btn('Retry', 'retry-run', {id: group.id, small: true, data: {run: run.id, message: run.input || '', ...retryTarget(group, run)}}) : '');
  const trace = (run.trace || []).map(t => `<li class="run-step"><strong>${esc(name(t.botId))}${t.toBotId ? ` ${icon('arrow', 12)} ${esc(name(t.toBotId))}` : ''}</strong><span>${esc((t.output || '').slice(0, 240))}</span></li>`).join('');
  return `<article class="run-card"><header><span class="row-main"><span class="row-title">${esc((run.input || 'Run').slice(0, 90))}</span><span class="row-sub">${esc(run.mode || 'run')} · step ${Number(run.currentStep || 0)} of ${steps.length} · ${esc(fullDate(run.createdAt))}${run.error ? ` · ${esc(run.error)}` : ''}</span></span>${tag(status.replace('_', ' '), RUN_TONE[status] || '')}</header>${trace ? `<ol class="run-timeline">${trace}</ol>` : ''}${action ? `<div class="card-actions">${action}</div>` : ''}</article>`;
}
function runsSection(conv) {
  const runs = recentRuns(conv.group.id), events = (store.state.events || []).slice(0, 40);
  return `${pageHead('Runs', {sub: isStaticDemo() ? 'Simulated in this browser.' : 'Run by the server orchestrator.', back: 'open-info'})}
    <div class="stack">${runs.slice(0, 12).map(r => runCard(conv.group, r)).join('') || empty('No runs yet', 'Message the group and each handoff is recorded here.')}</div>
    ${box(events.map(e => `<div class="row"><span class="row-main"><span class="row-title">${esc(e.message)}</span><span class="row-sub">${esc(fullDate(e.at))}</span></span></div>`).join('') || empty('No activity yet'), 'Activity log')}`;
}

function voiceSection() {
  const s = store.state.settings;
  const canEdit = isAdmin() || isStaticDemo();
  const lock = canEdit ? '' : ' disabled';
  return `${pageHead('Voice and timing', {sub: 'How drafts sound and how long they wait after you approve.', back: 'open-info'})}
    <form id="settings-form" class="form">
      ${field('Topics you care about', `<input class="input" name="topics" value="${esc(s.topics.join(', '))}" required${lock}>`, 'Separate with commas.')}
      ${field('Writing style', `<textarea class="input" name="style" rows="3"${lock}>${esc(s.style)}</textarea>`)}
      ${field('Opinions you approve of', `<textarea class="input" name="opinions" rows="3"${lock}>${esc(s.opinions)}</textarea>`, 'Optional. Bots never invent your opinions.')}
      <div class="form-grid">${field('Shortest wait (min)', `<input class="input" type="number" name="minDelay" min="0" max="1440" value="${Number(s.minDelay)}" required${lock}>`)}${field('Longest wait (min)', `<input class="input" type="number" name="maxDelay" min="0" max="1440" value="${Number(s.maxDelay)}" required${lock}>`)}</div>
      ${canEdit ? btn('Save', null, {kind: 'primary', type: 'submit', wide: true}) : note('An admin sets voice and timing for this workspace.')}
    </form>`;
}

/* ---------- bot info ---------- */

function botHome(conv) {
  const {bot, group} = conv, pinned = Boolean(store.profiles[bot.id]?.pinned), on = botSettings(bot).enabled;
  const scheduled = chatTasks(store.state.tasks, group.id, bot.id).length;
  const write = canWrite();
  return `${pageHead('Bot info', {back: 'close-info'})}
    <div class="hero"><button type="button" class="poke" data-action="poke" aria-label="Say hi to ${esc(bot.name)}">${avatar(bot.name, conv.tint, 84)}</button><h2>${esc(bot.name)} ${offTag(bot)}</h2><p>${esc(group.name)}</p></div>
    ${box(`<p class="prose">${esc(bot.instructions || 'No job set yet.')}</p>`, 'Job')}
    ${box((write ? row({title: 'Edit profile', action: 'open-section', data: {section: 'edit'}}) + row({title: on ? 'Switch off' : 'Switch on', sub: on ? 'It stops answering until you turn it back on.' : 'It is off and will not answer.', action: 'toggle-bot', id: bot.id}) : '') + row({title: 'Scheduled tasks', right: scheduled ? String(scheduled) : 'None', action: 'open-section', data: {section: 'tasks'}}) + row({title: pinned ? 'Unpin from top' : 'Pin to top', action: 'pin-bot', id: bot.id}) + (write ? row({title: 'Duplicate bot', action: 'duplicate-bot', id: bot.id}) : '') + row({title: 'Copy instructions', action: 'copy-bot-instructions', id: bot.id}))}
    ${box(row({title: 'Copy conversation', action: 'copy-chat', id: conv.id}) + (write ? row({title: 'Clear conversation', action: 'clear-chat', id: conv.id, tone: 'bad'}) + row({title: 'Remove from group', action: 'remove-bot', id: bot.id, tone: 'bad'}) : ''))}`;
}
export const tintPicker = current => `<div class="tints" role="group" aria-label="Color">${Array.from({length: TINT_COUNT}, (_, i) => `<button type="button" class="tint ${tintClass(i)}${i === current ? ' on' : ''}" data-action="avatar" data-index="${i}" aria-label="Color ${i + 1}" aria-pressed="${i === current}">${icon('check', 18)}</button>`).join('')}</div>`;
const BROWSER_CHOICES = [['ask', 'Ask me before each page'], ['auto', 'Run on my local agent without asking']];
const PERMISSION_LABELS = {'browser.use': 'browser.use · open pages with my local browser agent'};
const LENGTHS = [['short', 'Short, a few lines'], ['medium', 'Medium'], ['long', 'Long and detailed']];
function behaviourFields(bot) {
  const s = botSettings(bot);
  return `<fieldset class="contract-fieldset behaviour"><legend>Behaviour</legend>
    ${checkRow('enabled', 'Switched on', 'When off it does not answer, even when @mentioned.', s.enabled)}
    <div class="form-grid">${field('Reply length', `<select class="input" name="replyLength">${options(LENGTHS, s.replyLength)}</select>`)}${field('Creativity', `<input class="input" type="number" name="temperature" min="0" max="2" step="0.1" inputmode="decimal" value="${s.temperature ?? ''}" placeholder="Default">`, '0 to 2. Blank uses the model default.')}</div>
    ${field('Tone and style', `<textarea class="input" name="style" rows="2" maxlength="600" placeholder="Friendly, no jargon">${esc(s.style)}</textarea>`, 'Optional. Added to its job.')}
    ${field('Remembers the last messages', `<input class="input" type="number" name="contextMessages" min="0" max="${MAX_CONTEXT_MESSAGES}" step="1" inputmode="numeric" value="${Number(s.contextMessages ?? BOT_DEFAULTS.contextMessages)}" required>`, `0 to ${MAX_CONTEXT_MESSAGES} messages of this chat.`)}
    ${checkRow('summonable', 'Can be @mentioned from other chats', 'Bots in other groups and their chats can ask it.', s.summonable)}
    ${checkRow('canHandoff', 'Can pass work to other bots', 'It may @mention another bot in its reply.', s.canHandoff)}
    ${checkRow('lead', 'Primary bot', 'Tell this one what to do. It switches the others in the group on and they take the job. Only one primary per group.', s.lead)}
    ${field('Browser requests', `<select class="input" name="browserApproval">${options(BROWSER_CHOICES, s.browserApproval)}</select>`, 'Needs the browser.use permission below and a paired local agent. It can never click or type on X.')}
  </fieldset>`;
}
function botEdit(conv) {
  if (!canWrite()) return botHome(conv);
  const {bot} = conv, kind = bot.contract?.output?.kind || 'text';
  const ai = store.state?.ai || {}, providers = ai.providers || [], override = ai.bots?.[bot.id] || {};
  // Only offer a model picker when at least one provider exists (or the server
  // has an env key), so the form is not shown with nothing to choose.
  const modelBlock = (providers.length || store.state?.aiEnabled)
    ? `<div class="form-grid">${field('Model provider', `<select class="input" name="providerId"><option value="">Workspace default</option>${providers.map(p => `<option value="${esc(p.id)}" ${override.providerId === p.id ? 'selected' : ''}>${esc(p.label)}</option>`).join('')}</select>`)}${field('Model', `<input class="input" name="model" value="${esc(override.model || '')}" placeholder="auto, gpt-4o-mini…" autocomplete="off">`)}</div>`
    : '';
  return `${pageHead(`Edit ${bot.name}`, {sub: 'The job lasts. One-off requests go in the chat.', back: 'open-info'})}
    <form id="edit-bot-form" class="form">
      ${tintPicker(conv.tint)}
      ${field('Name', `<input class="input" name="name" value="${esc(bot.name)}" maxlength="80" required>`)}
      ${field('Job', `<textarea class="input" name="instructions" rows="5" maxlength="3000" required>${esc(bot.instructions)}</textarea>`)}
      ${modelBlock}
      <div class="form-grid">${field('Answers in', `<select class="input" name="outputKind">${options(OUTPUT_KINDS.map(k => [k, k === 'structured' ? 'Structured JSON' : 'Plain text']), kind)}</select>`)}${field('Required fields', `<input class="input" name="fields" value="${esc((bot.contract?.output?.fields || []).map(x => x.name).join(', '))}" placeholder="verdict, reason">`)}</div>
      ${behaviourFields(bot)}
      <fieldset class="contract-fieldset"><legend>What it may do</legend>${ACTIONS.map(a => `<label class="check-row"><input type="checkbox" name="permissions" value="${esc(a)}" ${(bot.permissions || []).includes(a) ? 'checked' : ''}><span>${esc(PERMISSION_LABELS[a] || a)}</span></label>`).join('')}<p class="field-help">Publishing is never automated and cannot be granted here.</p></fieldset>
      ${btn('Save profile', null, {kind: 'primary', type: 'submit', wide: true})}
    </form>`;
}

/** Paint the info panel for the open chat, or empty it when closed. */
export function renderInfo() {
  const node = el('inspector'), conv = conversation(), section = store.route.info;
  if (!conv || !section) { node.innerHTML = ''; return; }
  node.innerHTML = conv.isTeam
    ? ({drafts: draftsSection, posts: postsSection, reminders: remindersSection, runs: runsSection, voice: voiceSection, 'group-settings': groupSettingsSection, tasks: tasksSection}[section] || groupHome)(conv)
    : ({edit: botEdit, tasks: tasksSection}[section] || botHome)(conv);
}
/** Refresh only the filtered lists, so the search box keeps its focus. */
export function refreshLists() {
  if (el('candidate-results')) el('candidate-results').innerHTML = postsBody();
  if (el('approval-results')) el('approval-results').innerHTML = draftsBody();
}

/* ---------- "You" pages ---------- */

function youPage() {
  const {state} = store, demo = isStaticDemo(), me = state.me, workspace = (state.workspaces || []).find(w => w.current);
  const admin = isAdmin() ? box(['ai', 'team', 'agents', 'data'].map(p => row({title: ADMIN_PAGES[p].title, sub: esc(ADMIN_PAGES[p].sub), action: 'open-page', data: {page: p}})).join(''), 'Admin') : '';
  const write = canWrite();
  return `${pageHead('You', {back: 'back-to-list'})}
    <div class="page-body">
      <div class="hero"><span class="avatar avatar-plain" style="width:84px;height:84px">${icon('lock', 34)}</span><h2>${esc(me?.email || 'This browser')}</h2><p>${esc(me?.role ? `Signed in as ${me.role}${workspace ? ` in ${workspace.name}` : ''}` : 'Local demo. Nothing leaves this browser.')}</p></div>
      ${box((demo ? '' : row({title: 'Workspace', right: esc(workspace?.name || ''), action: 'open-page', data: {page: 'workspaces'}}) + row({title: 'Notifications', right: state.unread ? `${state.unread} unread` : '', tone: state.unread ? 'warn' : '', action: 'open-page', data: {page: 'notifications'}}) + (me?.email ? row({title: 'Change password', action: 'change-password'}) : '')) + (write ? row({title: 'New bot', action: 'new-bot'}) + row({title: 'New group', action: 'new-group'}) : '') + row({title: 'Jump to anything', right: 'Ctrl K', action: 'command-open'}) + (!demo && state.captureToken ? row({title: 'Copy capture token', sub: 'Paste it into the browser extension to capture posts.', action: 'copy-capture-token'}) : ''))}
      ${box(`<div class="themes" role="group" aria-label="Colour theme">${THEMES.map(t => `<button type="button" class="theme${t.id === themeChoice() ? ' on' : ''}" data-action="set-theme" data-theme="${t.id}" aria-pressed="${t.id === themeChoice()}"><span class="theme-dots">${t.dots.map(c => `<i style="background:${c}"></i>`).join('')}</span><strong>${esc(t.name)}</strong><small>${esc(t.sub)}</small></button>`).join('')}</div>`, 'Colours')}
      ${admin}
      ${box(row({title: 'About this build', action: 'open-page', data: {page: 'about'}}) + (demo ? '' : row({title: 'Sign out', action: 'logout', tone: 'bad'}) + (me?.email ? row({title: 'Delete my account', action: 'delete-account', tone: 'bad'}) : '')))}
    </div>`;
}
function aboutPage() {
  const {state} = store, demo = isStaticDemo(), ai = Boolean(state.aiEnabled), model = state?.aiModel;
  const text = demo ? 'GitHub Pages serves only static files, so bots answer with built-in commands instead of a language model, and everything stays in this browser. Do not type secrets into a chat.'
    : ai ? 'A server-side AI provider is connected. Every bot answers with it. If a call fails, the chat says why. Model output still needs your review, and the final Post click is always yours.'
      : 'No AI provider is configured. Add one under You → AI and models, or set AI_API_KEY on the server. Bots will say so instead of answering with the demo.';
  const fact = (label, value) => `<div class="row"><span class="row-main"><span class="row-title">${label}</span></span><span class="row-right">${value}</span></div>`;
  return `${pageHead('About this build', {back: 'open-page-you'})}
    <div class="page-body">${note(esc(text))}
      ${box(fact('Storage', demo ? 'This browser' : 'Node server') + fact('Real AI', demo || !ai ? 'Not connected' : (model ? `Connected · ${esc(model)}` : 'Connected')) + fact('Posting to X', 'Manual, by you') + fact('Sync across devices', demo ? 'Not available' : 'Server state'))}
    </div>`;
}

/** Paint a "You" page into the main pane. Admin pages load their data after. */
export async function renderPage() {
  const main = el('main'), page = store.route.page;
  if (page === 'you') { main.innerHTML = youPage(); return; }
  if (page === 'about') { main.innerHTML = aboutPage(); return; }
  const meta = ADMIN_PAGES[page];
  main.innerHTML = `${pageHead(meta.title, {sub: meta.sub, back: 'open-page-you'})}<div class="page-body" id="admin-panel">${note('Loading…')}</div>`;
  await reloadAdminPage();
}
export async function reloadAdminPage() {
  const page = store.route.page, panel = el('admin-panel'); if (!panel || !ADMIN_PAGES[page]) return;
  try { const html = await adminPage(page); if (store.route.page === page && el('admin-panel')) el('admin-panel').innerHTML = html; }
  catch (error) { panel.innerHTML = empty('Could not load this page', error.message || 'Unknown error'); }
}
