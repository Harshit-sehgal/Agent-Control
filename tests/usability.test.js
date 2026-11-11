import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// The UI is app.js plus every ui-*.js module; assertions match across all of them.
const sharedDir=path.join(root,'shared');
const uiFiles=['app.js',...(await readdir(sharedDir)).filter(f=>/^ui-.+\.js$/.test(f)).sort()];
const [html,css]=await Promise.all(['index.html','app.css'].map(f=>readFile(path.join(sharedDir,f),'utf8')));
const js=(await Promise.all(uiFiles.map(f=>readFile(path.join(sharedDir,f),'utf8')))).join('\n');
test('bot creation templates and focus styles are present',()=>{
 // Filters are plain native controls; the old custom dropdown menus were removed by the chat redesign.
 assert.doesNotMatch(html,/usability\.css/);
 assert.match(js,/bot-template/);
 assert.match(css,/focus-visible/);
});
test('chat clearing and sensitive changes require confirmation',()=>{
 // window.confirm was replaced by the in-app confirmSheet; it must still gate
 // every destructive or record-changing action.
 assert.match(js,/confirmSheet\('Clear this conversation/);
 assert.match(js,/copy-chat/);
 assert.match(js,/duplicate-bot/);
 assert.match(js,/pin-bot/);
 // The confirming button is the only thing that resolves the sheet with `true`.
 assert.match(js,/'sheet-confirm': \(\) => closeSheet\(true\)/);
 assert.match(js,/settle = value => resolve\(value === true\)/);
});
test('the Node build runs real multi-bot coordination with a run timeline',()=>{
 assert.match(js,/\/api\/auth\/forgot/);
 assert.match(js,/\/api\/auth\/reset/);
 assert.match(js,/id="forgot-form"/);
 assert.match(js,/id="reset-form"/);
 assert.match(js,/'login-forgot'/);
  assert.match(js,/async function runOnServer\(/);
  assert.match(js,/function streamGroupRun\(/);
  assert.match(js,/run-timeline/);
  assert.match(js,/'continue-run'/);
  assert.match(js,/'retry-run'/);
  // Approve-between-steps is the group's server-side setting, edited in Group settings.
  assert.match(js,/checkRow\('checkpoints', 'Approve between steps'/);
  // A paused run can only be continued by the human, via the server API.
  assert.match(js,/\/runs\/\$\{b\.dataset\.run\}\/continue/);
});
test('the Node build exposes a notifications feed and preferences',()=>{
  assert.match(js,/function notificationsPanel\(/);
  assert.match(js,/data-action="open-page" data-page="notifications"/);
  assert.match(js,/notif-prefs-form/);
  assert.match(js,/badge-dot/);
  // Not offered on the static demo (no server to hold notifications).
  assert.match(js,/\$\{server \? `<span id="bell-slot">/);
});
test('the Node build exposes Data & security admin surfaces',()=>{
  assert.match(js,/function credentialsPanel\(/);
  assert.match(js,/data: \{\s*title: 'Data and security'/);
  assert.match(js,/credential-form/);
  assert.match(js,/'backup-export'/);
  assert.match(js,/'prune-retention'/);
});
test('the Node build exposes Team and Local agents admin surfaces',()=>{
  assert.match(js,/ADMIN_PAGES/);
  assert.match(js,/function teamPanel\(/);
  assert.match(js,/function agentsPanel\(/);
  assert.match(js,/create-user-form/);
  assert.match(js,/toggle-agent-permission/);
  assert.match(js,/'toggle-user-disabled'/);
  assert.match(js,/Temporary password \(min 8 chars\)/);
  // Admin surfaces are gated off on the static Pages demo and for non-admins:
  // the role check, the You-page entry, the quick-nav entries and the route parser.
  assert.match(js,/export const isAdmin = \(\) => !isStaticDemo\(\) && \['owner', 'admin'\]\.includes/);
  assert.match(js,/export const canWrite = \(\) => isStaticDemo\(\) \|\| \['owner', 'admin', 'member'\]\.includes/);
  assert.match(js,/isAdmin\(\) \? box\(\['ai', 'team', 'agents', 'data'\]/);
  assert.match(js,/if \(isAdmin\(\)\) items\.push\(/);
  assert.match(js,/parseRoute\(location\.hash, store\.state, \{server: !isStaticDemo\(\), admin: isAdmin\(\), write: canWrite\(\)\}\)/);
});
test('destructive admin actions ask first and say what they do',()=>{
  for (const message of ['Sign out every other session','Remove this user from the workspace','Disable this account','Delete your account','Revoke this local agent','Delete this credential','Prune exhaust older than the retention policy','Replace this workspace with the pasted backup'])
    assert.match(js,new RegExp(`confirmSheet\\('${message}`),`${message} must be confirmed`);
});
test('the bot editor exposes contract and permission controls (Phase E UI)',()=>{
  assert.match(js,/id="edit-bot-form"/);
  assert.match(js,/name="outputKind"/);
  assert.match(js,/name="permissions"/);
  assert.match(js,/contract-fieldset/);
  assert.match(js,/Publishing is never automated/);
});
test('the shell is integrated: one search, animated routes, one progress bar',()=>{
  assert.match(html,/id="progress"/);
  assert.match(html,/class="splash"/);
  assert.match(html,/id="main" tabindex="-1"/);
  // One search entry point per job: the chat-list filter and Ctrl+K quick nav.
  assert.match(js,/id="chat-search"/);
  assert.match(js,/ev\.key\.toLowerCase\(\) === 'k'/);
  assert.match(js,/label: 'AI and models'/);
  assert.match(js,/lastView/);
  assert.match(js,/classList\.add\('view-enter'\)/);
  assert.match(js,/function setBusy\(/);
});
test('hash routes respond to browser Back and Forward',()=>{
  assert.match(js,/function renderRoute\(/);
  assert.match(js,/addEventListener\('popstate'/);
  assert.match(js,/pushState/);
  // Opening a sheet or the palette is dismissed by Back rather than stranded,
  // and the history depth is read from the entry (Back and Forward both fire it).
  assert.match(js,/popstate', event => \{ syncDepth\(event\); if \(!store\.state\) return; closeSheet\(\); closeCommandPalette\(\)/);
});
test('a background refresh never wipes an in-progress form or the sign-in',()=>{
  // Idle data refreshes every 30s. A page request or a live group run shortens
  // that to 3s, and a keystroke must not push the poll back. The poll used to
  // re-render unconditionally, discarding whatever the user had typed, and
  // rebuilding the sign-in dialog (clearing the password) on every 401.
  assert.match(js,/const typingIn = node =>/);
  assert.match(js,/if \(!typingIn\(el\('chat-space'\)\)\) renderThread\(\)/);
  assert.match(js,/scope === 'all' && !typingIn\(el\('inspector'\)\)\) renderInfo\(\)/);
  assert.match(js,/clearInterval\(syncTimer\)/);
  assert.match(js,/workspaceBusy\(\) \? 3000 : 30000/);
  assert.match(js,/syncTimer && syncDue <= due/);
  // An older in-flight snapshot must not overwrite a newer one, and sign-out
  // must drop both the timer and any refresh that was already on the wire.
  assert.match(js,/ticket !== epoch \|\| fetch < appliedFetch/);
  assert.match(js,/retireSession\(\)/);
  assert.match(js,/ticket === sessionEpoch\(\)/);
  assert.match(js,/if \(ticket !== sessionEpoch\(\)\) return/);
  // A queued bot task about to fire also speeds the poll up.
  assert.match(js,/t\.status === 'queued' && t\.kind === 'bot-task' && dueWithin\(t\.runAt\)/);
  assert.match(js,/const visible = Boolean\(layer\)/);
  // Sheets live in their own layer that a repaint never touches.
  assert.doesNotMatch(js,/el\('modal'\)\.innerHTML = (?!'')/);
});
test('the UI adapts its copy and adds sign-out for the Node server build',()=>{
 assert.match(js,/isStaticDemo = \(\) =>/);
 assert.match(js,/agent-backend/);
 assert.match(js,/actions\.logout = async \(\) =>/);
 assert.match(js,/Connected to Node server/);
 assert.match(js,/Your session expired/);
 // Sign-out also stops the poll and drops the cached state.
 assert.match(js,/lockScreen\('Signed out\.'\)/);
});

/* ---------- UI state: preferences and saved profiles ---------- */

// ui-store reads localStorage while it loads, so every case gets its own module
// instance (a distinct specifier) over its own fake storage.
let storeCase=0;
async function freshStore(seed={}){
 const data=new Map(Object.entries(seed));
 globalThis.localStorage={getItem:k=>data.has(k)?data.get(k):null,setItem:(k,v)=>data.set(k,String(v)),removeItem:k=>data.delete(k)};
 return {data,ui:await import(`../shared/ui-store.js?case=${storeCase++}`)};
}

test('legacy name/instructions are stripped from saved profiles once', async()=>{
 const key='agent-control-bot-profiles-v2';
 const {data,ui}=await freshStore({[key]:JSON.stringify({bot1:{tint:2,pinned:true,name:'Old name',instructions:'Old job'}})});
 assert.deepEqual(ui.store.profiles,{bot1:{tint:2,pinned:true}});
 // Deleting from the object loaded out of localStorage only cleaned it in
 // memory, so the keys were back on the next load: the result is written back.
 assert.deepEqual(JSON.parse(data.get(key)),{bot1:{tint:2,pinned:true}});
 const second=await freshStore(Object.fromEntries(data));
 assert.deepEqual(second.ui.store.profiles,{bot1:{tint:2,pinned:true}});
});
/* ---------- accessibility of the shared chrome ---------- */

test('a failed action is announced as an alert, not queued politely',()=>{
 // index.html ships one #toast for success and failure alike, as role=status.
 assert.match(html,/id="toast"[^>]*role="status"[^>]*aria-live="polite"/);
 assert.match(js,/node\.setAttribute\('role', error \? 'alert' : 'status'\)/);
 assert.match(js,/node\.setAttribute\('aria-live', error \? 'assertive' : 'polite'\)/);
});

test('the command palette is a combobox pointing at the highlighted row',()=>{
 // Focus never leaves the input: the arrows only move a class, so the listbox
 // role promised a relationship nothing maintained until there was an
 // aria-activedescendant on the combobox.
 assert.match(js,/id="command-input" role="combobox"/);
 assert.match(js,/aria-controls="command-results"/);
 assert.match(js,/aria-autocomplete="list"/);
 assert.match(js,/id="command-item-\$\{i\}"/);
 assert.match(js,/input\.setAttribute\('aria-activedescendant', active\.id\)/);
 assert.match(js,/next\.scrollIntoView\(\{block: 'nearest'\}\);\s*syncCommandActive\(\)/);
});

test('an admin refresh carries unsaved typing over the repaint',()=>{
 // Reveal on one row blurs the credential field on another, so a focus check
 // would not notice and the wholesale repaint used to drop the secret.
 assert.match(js,/function unsavedText\(root\)/);
 assert.match(js,/const typed = unsavedText\(target\);/);
 assert.match(js,/restoreText\(target, typed\)/);
 assert.match(js,/field\.value !== field\.defaultValue/);
 // A select commits on change, so it has to follow the repaint, not overwrite it.
 assert.match(js,/\['checkbox', 'radio', 'hidden', 'file', 'submit', 'button'\]\.includes\(f\.type\)/);
});

test('ambient motion cleans up after itself and follows a reduced-motion change',()=>{
 // A tab hidden mid-throw may never fire animationend, and those dots are fixed
 // children of <body>: the timer is what guarantees they go away.
 assert.match(js,/setTimeout\(\(\) => dot\.remove\(\), 1200\)/);
 // The ambient listeners are wired in one place so they can be removed again,
 // and the reduced-motion preference is read live instead of once at boot.
 assert.match(js,/function wireBots\(\)/);
 assert.match(js,/query\.addEventListener\('change', sync\)/);
 assert.match(js,/for \(const \[target, type, fn\] of listeners\) target\.removeEventListener\(type, fn\)/);
 assert.match(js,/document\.hidden \|\| !document\.querySelector\(big\)/);
});
