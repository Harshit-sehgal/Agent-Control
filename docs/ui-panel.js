/** Everything that used to be a dashboard tab now hangs off a conversation:
 * the info panel of the open chat (drafts, posts, reminders, runs, voice, the
 * bot's profile) and the "You" pages (account, admin, about). */
import {filterCandidates, filterDrafts} from './usability.js?v=aa40e42b9d';
import {ACTIONS, OUTPUT_KINDS} from './contracts.js?v=aa40e42b9d';
import {ACTIVE_DRAFTS, needsYou} from './ui-model.js?v=aa40e42b9d';
import {esc, icon, avatar, groupAvatar, tintClass, TINT_COUNT, btn, iconBtn, row, box, field, note, empty, tag, pageHead, fullDate} from './ui-kit.js?v=aa40e42b9d';
import {store, conversation, isStaticDemo, isAdmin, isLive, isXGroup, botTint, recentRuns, THEMES, themeChoice} from './ui-store.js?v=aa40e42b9d';
import {draftCard, postCard} from './ui-views.js?v=aa40e42b9d';
import {ADMIN_PAGES, adminPage} from './ui-admin.js?v=aa40e42b9d';

const el = id => document.getElementById(id);
const options = (pairs, current) => pairs.map(([value, label]) => `<option value="${esc(value)}"${value === current ? ' selected' : ''}>${esc(label)}</option>`).join('');
const select = (id, label, pairs, current) => `<label class="pick"><span>${esc(label)}</span><select id="${id}" class="input" aria-label="${esc(label)}">${options(pairs, current)}</select></label>`;

/* ---------- group info ---------- */

function groupHome(conv) {
  const {group} = conv, {state} = store, x = isXGroup(group), runs = recentRuns(group.id);
  const waiting = needsYou(state, group), reminders = (state.tasks || []).filter(t => t.kind === 'reminder' && !['done', 'cancelled'].includes(t.status)).length;
  const members = group.bots.map(b => ({name: b.name, tint: botTint(group, b.id)}));
  const tools = [
    x && row({title: 'Drafts', right: waiting ? `${waiting} waiting on you` : `${state.drafts.length}`, tone: waiting ? 'warn' : '', action: 'open-section', data: {section: 'drafts'}}),
    x && row({title: 'Posts found', right: String(state.candidates.length), action: 'open-section', data: {section: 'posts'}}),
    x && row({title: 'Reminders', right: reminders ? String(reminders) : 'None', action: 'open-section', data: {section: 'reminders'}}),
    row({title: 'Runs', right: runs.length ? `Last ${fullDate(runs[0].createdAt)}` : 'None yet', action: 'open-section', data: {section: 'runs'}}),
    x && row({title: 'Voice and timing', right: `${state.settings.minDelay} to ${state.settings.maxDelay} min delay`, action: 'open-section', data: {section: 'voice'}}),
  ].filter(Boolean).join('');
  const bots = group.bots.map(b => row({lead: avatar(b.name, botTint(group, b.id), 38), title: esc(b.name), sub: esc((b.instructions || '').slice(0, 70)), action: 'open-chat', id: b.id})).join('')
    + `<button type="button" class="row" data-action="add-bot-to-group" data-id="${esc(group.id)}"><span class="avatar avatar-plain small">${icon('plus', 18)}</span><span class="row-main"><span class="row-title">Add a bot</span></span></button>`;
  const gate = isLive() ? box(`<label class="check-row"><input type="checkbox" id="checkpoint-toggle" ${store.checkpoints ? 'checked' : ''}><span>Approve between steps<small>Pause the group after each bot until you say continue.</small></span></label>`) : '';
  return `${pageHead('Group info', {back: 'close-info'})}
    <div class="hero"><button type="button" class="poke" data-action="poke" aria-label="Say hi">${groupAvatar(members, 84)}</button><h2>${esc(group.name)}</h2><p>${esc(group.description || 'A group of bots that hand work to each other.')}</p></div>
    ${box(tools)}${box(bots, `${group.bots.length} bot${group.bots.length === 1 ? '' : 's'}`)}${gate}
    ${box(row({title: 'Copy conversation', action: 'copy-chat', id: conv.id}) + row({title: 'Clear conversation', action: 'clear-chat', id: conv.id, tone: 'bad'}))}
    ${note('Mention a bot with @name to pick who answers, or @everyone. Without a mention the group follows its pipeline, six handoffs at most.')}`;
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
  return `${pageHead('Posts found', {sub: 'Posts you shared or captured with the extension.', back: 'open-info', right: iconBtn('plus', 'Share a post', 'share-post')})}
    <label class="search">${icon('search', 18)}<input id="candidate-search" type="search" placeholder="Search posts, topics, authors, links" aria-label="Search posts" value="${esc(store.postQuery)}"></label>
    <div class="toolbar">${select('candidate-status', 'Show', [['all', 'All posts'], ['new', 'Not drafted'], ['drafted', 'Drafted'], ['high', 'Score 70+']], store.prefs.candidateStatus)}${select('candidate-sort', 'Sort', [['newest', 'Newest'], ['oldest', 'Oldest'], ['score-high', 'Top score'], ['score-low', 'Low score']], store.prefs.candidateSort)}</div>
    <p class="count"><span id="candidate-count">${visiblePosts().length} of ${state.candidates.length}</span><span class="row-actions">${btn('Load samples', 'load-samples', {small: true})}${state.candidates.some(c => c.demo) ? btn('Remove samples', 'reset-demo', {small: true, kind: 'ghost'}) : ''}</span></p>
    <div class="stack" id="candidate-results">${postsBody()}</div>`;
}

const taskLine = t => t.status === 'done' ? 'Completed' : t.status === 'failed' ? 'Failed' : t.status === 'cancelled' ? 'Removed' : t.status === 'running' ? 'Running' : `Due ${fullDate(t.runAt)}`;
function remindersSection() {
  const {state} = store, reminders = (state.tasks || []).filter(t => t.kind === 'reminder' && t.status !== 'cancelled'), scheduled = state.drafts.filter(d => d.status === 'scheduled');
  const list = reminders.map(t => `<div class="row"><span class="row-main"><span class="row-title">${esc(t.payload?.label || t.title)}</span><span class="row-sub">${t.payload?.kind === 'interval' ? `Every ${Number(t.intervalMinutes)} min` : 'One time'} · ${esc(taskLine(t))}${t.lastError ? ` · ${esc(t.lastError)}` : ''}</span></span><span class="row-actions">${btn('Remove', 'remove-task', {id: t.id, small: true, kind: 'danger'})}</span></div>`).join('') || empty('No reminders', 'Set one to be nudged to check new posts.');
  const handoffs = scheduled.map(d => `<div class="row"><span class="row-main"><span class="row-title">${esc(d.author)}</span><span class="row-sub">Ready ${esc(fullDate(d.dueAt))}</span></span>${tag('Scheduled')}</div>`).join('') || empty('Nothing scheduled', 'Approve a draft and it waits here until it is ready.');
  return `${pageHead('Reminders', {back: 'open-info', right: iconBtn('plus', 'New reminder', 'new-reminder')})}
    ${box(list)}${box(handoffs, 'Approved, waiting to be ready')}
    ${note(isStaticDemo() ? 'This demo checks timers only while the page is open.' : 'Reminders run as tasks with retries while the Node server is up.')}`;
}

const RUN_TONE = {completed: 'good', failed: 'bad', interrupted: 'bad', running: 'warn', queued: 'warn', awaiting_checkpoint: 'warn'};
function runCard(group, run) {
  const name = id => group.bots.find(b => b.id === id)?.name || id, steps = run.recipients || [], live = !isStaticDemo(), status = String(run.status || 'unknown');
  const action = !live ? '' : status === 'awaiting_checkpoint' ? btn('Approve next step', 'continue-run', {id: group.id, small: true, kind: 'primary', data: {run: run.id}})
    : ['failed', 'interrupted'].includes(status) ? btn('Retry', 'retry-run', {id: group.id, small: true, data: {run: run.id, message: run.input || '', direct: run.mode === 'direct' ? (steps[0] || '') : ''}}) : '';
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
  return `${pageHead('Voice and timing', {sub: 'How drafts sound and how long they wait after you approve.', back: 'open-info'})}
    <form id="settings-form" class="form">
      ${field('Topics you care about', `<input class="input" name="topics" value="${esc(s.topics.join(', '))}" required>`, 'Separate with commas.')}
      ${field('Writing style', `<textarea class="input" name="style" rows="3">${esc(s.style)}</textarea>`)}
      ${field('Opinions you approve of', `<textarea class="input" name="opinions" rows="3">${esc(s.opinions)}</textarea>`, 'Optional. Bots never invent your opinions.')}
      <div class="form-grid">${field('Shortest wait (min)', `<input class="input" type="number" name="minDelay" min="0" max="1440" value="${Number(s.minDelay)}" required>`)}${field('Longest wait (min)', `<input class="input" type="number" name="maxDelay" min="0" max="1440" value="${Number(s.maxDelay)}" required>`)}</div>
      ${btn('Save', null, {kind: 'primary', type: 'submit', wide: true})}
    </form>`;
}

/* ---------- bot info ---------- */

function botHome(conv) {
  const {bot, group} = conv, pinned = Boolean(store.profiles[bot.id]?.pinned);
  return `${pageHead('Bot info', {back: 'close-info'})}
    <div class="hero"><button type="button" class="poke" data-action="poke" aria-label="Say hi to ${esc(bot.name)}">${avatar(bot.name, conv.tint, 84)}</button><h2>${esc(bot.name)}</h2><p>${esc(group.name)}</p></div>
    ${box(`<p class="prose">${esc(bot.instructions || 'No job set yet.')}</p>`, 'Job')}
    ${box(row({title: 'Edit profile', action: 'open-section', data: {section: 'edit'}}) + row({title: pinned ? 'Unpin from top' : 'Pin to top', action: 'pin-bot', id: bot.id}) + row({title: 'Duplicate bot', action: 'duplicate-bot', id: bot.id}) + row({title: 'Copy instructions', action: 'copy-bot-instructions', id: bot.id}))}
    ${box(row({title: 'Copy conversation', action: 'copy-chat', id: conv.id}) + row({title: 'Clear conversation', action: 'clear-chat', id: conv.id, tone: 'bad'}))}`;
}
export const tintPicker = current => `<div class="tints" role="group" aria-label="Color">${Array.from({length: TINT_COUNT}, (_, i) => `<button type="button" class="tint ${tintClass(i)}${i === current ? ' on' : ''}" data-action="avatar" data-index="${i}" aria-label="Color ${i + 1}" aria-pressed="${i === current}">${icon('check', 18)}</button>`).join('')}</div>`;
function botEdit(conv) {
  const {bot} = conv, kind = bot.contract?.output?.kind || 'text';
  return `${pageHead(`Edit ${bot.name}`, {sub: 'The job lasts. One-off requests go in the chat.', back: 'open-info'})}
    <form id="edit-bot-form" class="form">
      ${tintPicker(conv.tint)}
      ${field('Name', `<input class="input" name="name" value="${esc(bot.name)}" maxlength="80" required>`)}
      ${field('Job', `<textarea class="input" name="instructions" rows="5" maxlength="3000" required>${esc(bot.instructions)}</textarea>`)}
      <div class="form-grid">${field('Answers in', `<select class="input" name="outputKind">${options(OUTPUT_KINDS.map(k => [k, k === 'structured' ? 'Structured JSON' : 'Plain text']), kind)}</select>`)}${field('Required fields', `<input class="input" name="fields" value="${esc((bot.contract?.output?.fields || []).map(x => x.name).join(', '))}" placeholder="verdict, reason">`)}</div>
      <fieldset class="contract-fieldset"><legend>What it may do</legend>${ACTIONS.map(a => `<label class="check-row"><input type="checkbox" name="permissions" value="${esc(a)}" ${(bot.permissions || []).includes(a) ? 'checked' : ''}><span>${esc(a)}</span></label>`).join('')}<p class="field-help">Publishing is never automated and cannot be granted here.</p></fieldset>
      ${btn('Save profile', null, {kind: 'primary', type: 'submit', wide: true})}
    </form>`;
}

/** Paint the info panel for the open chat, or empty it when closed. */
export function renderInfo() {
  const node = el('inspector'), conv = conversation(), section = store.route.info;
  if (!conv || !section) { node.innerHTML = ''; return; }
  node.innerHTML = conv.isTeam
    ? ({drafts: draftsSection, posts: postsSection, reminders: remindersSection, runs: runsSection, voice: voiceSection}[section] || groupHome)(conv)
    : (section === 'edit' ? botEdit : botHome)(conv);
}
/** Refresh only the filtered lists, so the search box keeps its focus. */
export function refreshLists() {
  if (el('candidate-results')) el('candidate-results').innerHTML = postsBody();
  if (el('approval-results')) el('approval-results').innerHTML = draftsBody();
}

/* ---------- "You" pages ---------- */

function youPage() {
  const {state} = store, demo = isStaticDemo(), me = state.me;
  const admin = isAdmin() ? box(['team', 'agents', 'data'].map(p => row({title: ADMIN_PAGES[p].title, sub: esc(ADMIN_PAGES[p].sub), action: 'open-page', data: {page: p}})).join(''), 'Admin') : '';
  return `${pageHead('You', {back: 'back-to-list'})}
    <div class="page-body">
      <div class="hero"><span class="avatar avatar-plain" style="width:84px;height:84px">${icon('lock', 34)}</span><h2>${esc(me?.email || 'This browser')}</h2><p>${esc(me?.role ? `Signed in as ${me.role}` : 'Local demo. Nothing leaves this browser.')}</p></div>
      ${box((demo ? '' : row({title: 'Notifications', right: state.unread ? `${state.unread} unread` : '', tone: state.unread ? 'warn' : '', action: 'open-page', data: {page: 'notifications'}})) + row({title: 'New bot', action: 'new-bot'}) + row({title: 'New group', action: 'new-group'}) + row({title: 'Jump to anything', right: 'Ctrl K', action: 'command-open'}) + (!demo && state.captureToken ? row({title: 'Copy capture token', sub: 'Paste it into the browser extension to capture posts.', action: 'copy-capture-token'}) : ''))}
      ${box(`<div class="themes" role="group" aria-label="Colour theme">${THEMES.map(t => `<button type="button" class="theme${t.id === themeChoice() ? ' on' : ''}" data-action="set-theme" data-theme="${t.id}" aria-pressed="${t.id === themeChoice()}"><span class="theme-dots">${t.dots.map(c => `<i style="background:${c}"></i>`).join('')}</span><strong>${esc(t.name)}</strong><small>${esc(t.sub)}</small></button>`).join('')}</div>`, 'Colours')}
      ${admin}
      ${box(row({title: 'About this build', action: 'open-page', data: {page: 'about'}}) + (demo ? '' : row({title: 'Sign out', action: 'logout', tone: 'bad'})))}
    </div>`;
}
function aboutPage() {
  const {state} = store, demo = isStaticDemo(), ai = Boolean(state.aiEnabled), model = state?.aiModel;
  const text = demo ? 'GitHub Pages serves only static files, so bots answer with built-in commands instead of a language model, and everything stays in this browser. Do not type secrets into a chat.'
    : ai ? 'A server-side AI provider is connected for drafting and custom bots. Model output still needs your review, and the final Post click is always yours.'
      : 'No AI provider is configured, so drafts use clearly labeled templates. Set AI_API_KEY (and AI_BASE_URL) on the server to enable real drafting.';
  const fact = (label, value) => `<div class="row"><span class="row-main"><span class="row-title">${label}</span></span><span class="row-right">${value}</span></div>`;
  return `${pageHead('About this build', {back: 'open-page-you'})}
    <div class="page-body">${note(esc(text))}
      ${box(fact('Storage', demo ? 'This browser' : 'Node server') + fact('Real AI', demo ? 'Not connected' : ai ? (model ? `Connected · ${esc(model)}` : 'Connected') : 'Template drafts') + fact('Posting to X', 'Manual, by you') + fact('Sync across devices', demo ? 'Not available' : 'Server state'))}
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
