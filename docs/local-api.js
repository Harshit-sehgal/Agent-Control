/* Agent Control browser-local transport (used by the static GitHub Pages build).
 *
 * All data stays inside this browser via localStorage. The lifecycle rules are
 * not reimplemented here: they come from the same `workflow.js` + `core.js`
 * modules the Node server uses, so the demo and the real dashboard cannot drift.
 */
import {scoreCandidate, templateDraft, cleanText, initialState, markDue, activity, DEMO_SAMPLES} from './core.js?v=b22a42e620';
import {
  migrate, seedDemo, updateSettings, addCandidate, beginProcessing,
  finishProcessing, editDraft, findDraft, rewriteDraft, draftAction, addGroup,
  addBot, updateBot, addSchedule, removeSchedule, resetDemo,
} from './workflow.js?v=b22a42e620';

const KEY = 'agent-control-ghpages-v1';
const now = () => new Date().toISOString();

function read() {
  try {
    const value = localStorage.getItem(KEY);
    if (value) {
      const state = JSON.parse(value);
      // Always migrate: a stored version equal to SCHEMA_VERSION can still be
      // missing a field added later in the same version, and a legacy shape must
      // gain every collection the UI indexes into.
      if (state && typeof state === 'object' && Array.isArray(state.candidates)) return migrate(state);
    }
  } catch { throw new Error('Browser storage is unavailable. Enable local storage to use this demo.'); }
  return migrate(initialState());
}
function save(state) {
  try { localStorage.setItem(KEY, JSON.stringify(state)); }
  catch { throw new Error('Unable to save browser-local data. Check available storage and private browsing settings.'); }
}
const find = (items, key) => items.find(x => x.id === key) || (() => { throw new Error('Item not found.'); })();

/** Advance the local clock so scheduled drafts and reminders resolve.
 * This mirrors `src/scheduler.js` exactly and leans on the same `markDue`/
 * `activity` primitives, so a transition logged by the Node backend is logged
 * identically here. Reimplementing it inline was why the Pages Activity tab
 * stayed empty while the Node build recorded ready and reminder events. */
function due(state) {
  const time = Date.now();
  let changed = false;
  for (const d of state.drafts) {
    if (markDue(d, time)) { changed = true; activity(state, 'ready', `Draft for ${d.author} is ready for manual posting.`, {draftId: d.id}); }
  }
  for (const r of state.schedules) {
    if (r.enabled && r.nextAt && Date.parse(r.nextAt) <= time) {
      activity(state, 'reminder', r.label, {scheduleId: r.id});
      changed = true;
      if (r.kind === 'once') r.enabled = false;
      else r.nextAt = new Date(time + r.intervalMinutes * 60000).toISOString();
    }
  }
  if (changed) save(state);
}
async function localApi(path, method = 'GET', body = {}) {
  if (path === '/api/login' || path === '/api/logout') return {ok: true};
  const state = read();
  due(state);
  if (path === '/api/state' && method === 'GET') return {...state, aiEnabled: false, serverTime: now()};

  if (path === '/api/demo/seed' && method === 'POST') { const r = seedDemo(state, DEMO_SAMPLES); save(state); return r; }
  if (path === '/api/settings' && method === 'PATCH') { const r = updateSettings(state, body); save(state); return r; }
  if (path === '/api/candidates' && method === 'POST') { const r = addCandidate(state, body); save(state); return {...r.candidate, duplicate: r.duplicate}; }

  let m;
  if ((m = path.match(/^\/api\/candidates\/([a-z0-9-]+)\/process$/)) && method === 'POST') {
    const ctx = beginProcessing(state, m[1]);
    const result = {text: templateDraft(ctx.candidate, ctx.settings), mode: 'template', note: 'Static template only; not real AI, research or verified fact-checking.'};
    const draft = finishProcessing(state, m[1], scoreCandidate(ctx.candidate, ctx.settings.topics), result);
    save(state);
    return draft;
  }
  if ((m = path.match(/^\/api\/drafts\/([a-z0-9-]+)$/)) && method === 'PATCH') { const d = editDraft(state, m[1], body.text); save(state); return d; }
  if ((m = path.match(/^\/api\/drafts\/([a-z0-9-]+)\/(approve|reject|ready|posted|rewrite)$/)) && method === 'POST') {
    const draft = findDraft(state, m[1]);
    let result;
    if (m[2] === 'rewrite') {
      const candidate = find(state.candidates, draft.candidateId);
      const direction = cleanText(body?.direction, 240);
      result = rewriteDraft(state, m[1], {text: templateDraft(candidate, state.settings, direction), mode: 'template', note: direction ? 'Template draft. The requested direction is recorded but was not applied by an AI model.' : 'Template draft. Rewrite instructions have not been processed by an AI model.'});
    } else {
      result = draftAction(state, m[1], m[2]);
    }
    save(state);
    return result;
  }
  if (path === '/api/groups' && method === 'POST') { const g = addGroup(state, body); save(state); return g; }
  if ((m = path.match(/^\/api\/groups\/([a-z0-9-]+)\/bots$/)) && method === 'POST') { const b = addBot(state, m[1], body); save(state); return b; }
  // Keep lasting bot profile edits in the store so they survive a reload, exactly
  // like the Node backend, instead of living only in browser-local UI state.
  if ((m = path.match(/^\/api\/groups\/([a-z0-9-]+)\/bots\/([a-z0-9-]+)$/)) && method === 'PATCH') { const b = updateBot(state, m[1], m[2], body); save(state); return b; }
  if (path === '/api/bots/run') throw new Error('Running AI bots requires the separate Node backend, not GitHub Pages.');
  if (path === '/api/schedules' && method === 'POST') { const s = addSchedule(state, body); save(state); return s; }
  if ((m = path.match(/^\/api\/schedules\/([a-z0-9-]+)$/)) && method === 'DELETE') { const r = removeSchedule(state, m[1]); save(state); return r; }
  if (path === '/api/reset-demo' && method === 'POST') { const r = resetDemo(state); save(state); return r; }
  throw new Error(`Not available in the browser-local demo: ${method} ${path}`);
}

window.AGENT_LOCAL_API = localApi;
window.AGENT_PAGES_DEMO = localApi; // Backwards-compatible alias used by the test suite.