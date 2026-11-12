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
test('the New bot page asks for a name, and focus styles are present',()=>{
 // Filters are plain native controls; the old custom dropdown menus were removed by the chat redesign.
 assert.doesNotMatch(html,/usability\.css/);
 // A bot is made from a name, a shape, a colour and an optional manager; its job is set in its chat.
 assert.match(js,/placeholder="Name your bot"/);
 assert.match(js,/You set its job in the chat\./);
 // Edit and New bot are one form (botForm); Create starts off and Save does not.
 assert.match(js,/<button type="submit" class="nb-go"\$\{off \? ' disabled' : ''\}>\$\{submit\}<\/button>/);
 assert.match(js,/submit: 'Create', off: true/);
 assert.match(js,/submit: 'Save'\}/);
 assert.match(css,/focus-visible/);
});
test('deleting a bot and other sensitive changes require confirmation',()=>{
 // window.confirm was replaced by the in-app confirmSheet; it must still gate
 // every destructive or record-changing action.
 assert.match(js,/confirmSheet\(copy\.title/);
 assert.match(js,/'menu-delete': async b =>/);
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
  assert.match(js,/'continue-run'/);
  assert.match(js,/'retry-run'/);
  // A paused run can only be continued by the human, via the server API.
  assert.match(js,/\/runs\/\$\{b\.dataset\.run\}\/continue/);
});
test('the Node build exposes a notifications feed and preferences',()=>{
  assert.match(js,/function notificationsPanel\(/);
  // The feed is a Settings page reached from General, not offered on the static demo
  // (no server to hold notifications).
  // Each channel is a switch that saves at once (a native checkbox and a Save button used to carry all three), and the
  // webhook and email channels show only when something can deliver them.
  assert.match(js,/data-action="notif-pref" data-pref="inApp"/);
  assert.match(js,/'notif-pref': async/);
  assert.doesNotMatch(js,/type="checkbox"/);
  assert.match(js,/emailReady \|\| prefs\.email/);
  assert.match(js,/hooks\.length \|\| prefs\.webhook/);
  assert.match(js,/if \(!demo\) extra\.push\(\['notifications', 'Notifications'\], \['workspaces', 'Workspaces'\]\)/);
});
test('the Node build exposes Data & security admin surfaces',()=>{
  assert.match(js,/function credentialsPanel\(/);
  assert.match(js,/ADMIN_PAGES = \{[^}]*\bdata: true/);
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
  // the role check, the Settings section list and the loader that names an admin page.
  assert.match(js,/export const isAdmin = \(\) => !isStaticDemo\(\) && \['owner', 'admin'\]\.includes/);
  assert.match(js,/export const canWrite = \(\) => isStaticDemo\(\) \|\| \['owner', 'admin', 'member'\]\.includes/);
  assert.match(js,/if \(admin && !demo\) extra\.push\(\['team', 'Team and access'\], \['agents', 'Local agents'\], \['data', 'Data and security'\]\)/);
  assert.match(js,/\(key === 'notifications' \|\| key === 'workspaces' \|\| isAdmin\(\)\) && !isStaticDemo\(\)/);
});
test('destructive admin actions ask first and say what they do',()=>{
  for (const message of ['Sign out every other session','Remove this user from the workspace','Disable this account','Delete your account','Revoke this local agent','Delete this credential','Prune exhaust older than the retention policy','Replace this workspace with the pasted backup'])
    assert.match(js,new RegExp(`confirmSheet\\('${message}`),`${message} must be confirmed`);
});
test('the bot profile edits name, manager, shape and colour, and edits its permission rules in place',()=>{
  assert.match(js,/id: 'edit-bot-form'/);
  assert.match(js,/name="reportsTo"/);
  assert.match(js,/name="shape" value=/);
  assert.match(js,/name="tint" value=/);
  // The job is changed by telling the bot in its chat, not in this form.
  assert.match(js,/To change what \$\{esc\(bot\.name\)\} does, tell it in its chat\./);
  // Rules are edited in place with the three choices; paying never gets Always allow.
  assert.match(js,/data-action="set-grant"/);
  assert.match(js,/Payments ask every time unless you set Always allow for a site\./);
});
test('the shell is integrated: one search, animated routes, one progress bar',()=>{
  assert.match(html,/id="progress"/);
  assert.match(html,/class="splash"/);
  assert.match(html,/id="main" tabindex="-1"/);
  // One search per screen size, and Ctrl+K reaches whichever is on screen: the
  // sidebar's box on a laptop, the phone's bottom bar otherwise.
  assert.match(js,/id="rail-q"/);
  assert.match(js,/id="sq"/);
  assert.match(js,/ev\.key\.toLowerCase\(\) === 'k'/);
  // Settings loads an admin page by key only: the per-page title and sub-line were never shown, so they are gone.
  assert.match(js,/ADMIN_PAGES = \{[^}]*\bai: true/);
  assert.doesNotMatch(js,/sub: 'Reminders, failed tasks, revoked agents/);
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
  assert.match(js,/popstate', event => \{ syncDepth\(event\); if \(!store\.state\) return; closeSheet\(\); closeSearch\(\)/);
});
test('a background refresh never wipes an in-progress form or the sign-in',()=>{
  // Idle data refreshes every 30s. A page request or a live group run shortens
  // that to 3s, and a keystroke must not push the poll back. The poll used to
  // re-render unconditionally, discarding whatever the user had typed, and
  // rebuilding the sign-in dialog (clearing the password) on every 401.
  // The composer is painted once per opened chat; a refresh only rewrites the log
  // and the status line, and skips even that when the markup did not change.
  assert.match(js,/if \(html === lastHtml\) return;/);
  assert.match(js,/const scroller = el\('cv-scroll'\)/);
  assert.match(js,/renderRail\(\); renderChrome\(\); renderPause\(\);\s*\n?\s*if \(scope === 'list'\) return refreshHome\(\);\s*\n?\s*renderConversation\(\); refreshHome\(\);/);
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
 assert.match(js,/fact\('Storage', demo \? 'This browser' : 'Node server'\)/);
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

test('search is a labelled box with a results popover on the phone and a live filter on a laptop',()=>{
 // The quick-navigation combobox is gone: search covers it.
 assert.match(js,/<input id="rail-q" type="search" placeholder="Search everything" aria-label="Search bots, threads and messages"/);
 assert.match(js,/<input id="sq" type="search" placeholder="Search" aria-label="Search bots, threads and messages"/);
 assert.match(js,/<div class="ch-res" id="ch-res" hidden>/);
 assert.match(js,/if \(searchOpen\(\)\) \{ ev\.preventDefault\(\); closeSearch\(\); el\('sq'\)\?\.blur\(\); \}/);
});

test('an admin refresh carries unsaved typing over the repaint',()=>{
 // Reveal on one row blurs the credential field on another, so a focus check
 // would not notice and the wholesale repaint used to drop the secret.
 assert.match(js,/function unsavedText\(root\)/);
 assert.match(js,/const typed = unsavedText\(target\);/);
 assert.match(js,/restoreText\(target, typed\)/);
 assert.match(js,/f\.value !== f\.defaultValue/);
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
