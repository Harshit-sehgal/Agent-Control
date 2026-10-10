/* Agent Control browser-local transport (used by the static GitHub Pages build).
 *
 * All data stays inside this browser via localStorage. The lifecycle rules are
 * not reimplemented here: they come from the same `workflow.js` + `core.js`
 * modules the Node server uses, so the demo and the real dashboard cannot drift.
 */
import {scoreCandidate, templateDraft, cleanText, initialState} from './core.js?v=2dc3b6b680';
import {
  migrate, seedDemo, updateSettings, addCandidate, beginProcessing,
  finishProcessing, editDraft, findDraft, rewriteDraft, draftAction, addGroup,
  addBot, updateBot, addSchedule, removeSchedule, resetDemo,
} from './workflow.js?v=2dc3b6b680';

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

/** Advance the local clock so scheduled drafts and reminders resolve. */
function due(state) {
  const time = Date.now();
  let changed = false;
  for (const d of state.drafts) if (d.status === 'scheduled' && Date.parse(d.dueAt) <= time) { d.status = 'ready'; changed = true; }
  for (const r of state.schedules) if (r.enabled && Date.parse(r.nextAt) <= time) {
    if (r.kind === 'interval') r.nextAt = new Date(time + r.intervalMinutes * 60000).toISOString();
    else r.enabled = false;
    changed = true;
  }
  if (changed) save(state);
}

const samples = [
  {url: 'https://example.com/robotics-demo', author: 'Demo robotics account', topic: 'robotics', text: 'What would make robotics models genuinely useful outside a lab? I care more about reliability than demos.'},
  {url: 'https://example.com/ai-demo', author: 'Demo AI account', topic: 'AI', text: 'New AI coding benchmark released. Does a benchmark really tell you how the model performs on a messy production codebase?'},
  {url: 'https://example.com/misc-demo', author: 'Demo lifestyle account', topic: 'other', text: 'It is a nice day today.'}
];

async function localApi(path, method = 'GET', body = {}) {
  if (path === '/api/login' || path === '/api/logout') return {ok: true};
  const state = read();
  due(state);
  if (path === '/api/state' && method === 'GET') return {...state, aiEnabled: false, serverTime: now()};

  if (path === '/api/demo/seed' && method === 'POST') { const r = seedDemo(state, samples); save(state); return r; }
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