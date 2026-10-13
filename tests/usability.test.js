import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {filterCandidates,filterDrafts,normalizeUiPrefs} from '../shared/usability.js';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// The UI is app.js plus every ui-*.js module; assertions match across all of them.
const sharedDir=path.join(root,'shared');
const uiFiles=['app.js',...(await readdir(sharedDir)).filter(f=>/^ui-.+\.js$/.test(f)).sort()];
const [html,css]=await Promise.all(['index.html','app.css'].map(f=>readFile(path.join(sharedDir,f),'utf8')));
const js=(await Promise.all(uiFiles.map(f=>readFile(path.join(sharedDir,f),'utf8')))).join('\n');
const candidates=[
 {id:'old',author:'Robot',topic:'robotics',text:'old',url:'https://example.com/old/status/1',status:'new',createdAt:'2025-01-01T00:00:00Z'},
 {id:'new',author:'Alice',topic:'AI',text:'new benchmark',url:'https://example.com/new/status/2',status:'drafted',score:{score:91},createdAt:'2026-01-01T00:00:00Z'},
 {id:'medium',author:'Bob',topic:'machine learning',text:'ML',url:'https://example.com/medium/status/3',status:'drafted',score:{score:62},createdAt:'2026-02-01T00:00:00Z'}
];
const drafts=[
 {id:'x',status:'pending',score:80,createdAt:'2026-01-01T00:00:00Z'},
 {id:'y',status:'posted',score:90,createdAt:'2026-02-01T00:00:00Z'},
 {id:'z',status:'ready',score:45,createdAt:'2026-03-01T00:00:00Z'}
];
test('candidate search is case-insensitive across topic and author',()=>assert.deepEqual(filterCandidates(candidates,{query:'ai'}).map(x=>x.id),['new']));
test('candidate search also matches the source URL',()=>{
  // Users naturally paste the post link to find a capture, and the URL is the
  // only stable handle they have for it.
  assert.deepEqual(filterCandidates(candidates,{query:'example.com/old'}).map(x=>x.id),['old']);
  assert.deepEqual(filterCandidates(candidates,{query:'https://example.com'}).map(x=>x.id).length,3);
  assert.deepEqual(filterCandidates(candidates,{query:'example.com/none'}).map(x=>x.id),[]);
});
test('candidate filters include high-score and unprocessed views',()=>{
 assert.deepEqual(filterCandidates(candidates,{status:'high'}).map(x=>x.id),['new']);
 assert.deepEqual(filterCandidates(candidates,{status:'new'}).map(x=>x.id),['old']);
 assert.deepEqual(filterCandidates(candidates,{status:'drafted'}).map(x=>x.id),['medium','new']);
});
test('sorting does not mutate application state',()=>{
 const original=candidates.map(x=>x.id);
 assert.deepEqual(filterCandidates(candidates,{sort:'score-high'}).map(x=>x.id),['new','medium','old']);
 assert.deepEqual(filterCandidates(candidates,{sort:'oldest'}).map(x=>x.id),['old','new','medium']);
 assert.deepEqual(candidates.map(x=>x.id),original);
});
test('draft inbox filters and sorts precisely',()=>{
 assert.deepEqual(filterDrafts(drafts,{}).map(x=>x.id),['z','x']);
 assert.deepEqual(filterDrafts(drafts,{status:'posted'}).map(x=>x.id),['y']);
 assert.deepEqual(filterDrafts(drafts,{status:'all',sort:'score-high'}).map(x=>x.id),['y','x','z']);
});
test('bad persisted dropdown choices fall back to permitted values',()=>{
 assert.deepEqual(normalizeUiPrefs({candidateStatus:'<script>',draftSort:'invalid'}),{
  candidateStatus:'all',candidateSort:'newest',draftStatus:'active',draftSort:'newest'
 });
});
test('Pages exposes filters, native selects and bot creation templates',()=>{
 // Filters are plain native <select>s and a search box; the old custom
 // dropdown menus and mobile group tabs were removed by the chat redesign.
 assert.doesNotMatch(html,/usability\.css/);
 assert.match(js,/candidate-search/);
 assert.match(js,/draft-status/);
 assert.match(js,/<select id="\$\{id\}" class="input"/);
 assert.match(js,/bot-template/);
 assert.match(css,/focus-visible/);
});
test('chat clearing and sensitive changes require confirmation',()=>{
 // window.confirm was replaced by the in-app confirmSheet; it must still gate
 // every destructive or record-changing action.
 assert.match(js,/confirmSheet\('Clear this conversation/);
 assert.match(js,/confirmSheet\('Did you post this on X yourself\?'/);
 assert.match(js,/confirmSheet\('Remove this reminder/);
 assert.match(js,/confirmSheet\('Remove the sample posts/);
 assert.match(js,/confirmSheet\('Remove this source/);
 assert.match(js,/copy-chat/);
 assert.match(js,/duplicate-bot/);
 assert.match(js,/pin-bot/);
 // The confirming button is the only thing that resolves the sheet with `true`.
 assert.match(js,/'sheet-confirm': \(\) => closeSheet\(true\)/);
 assert.match(js,/settle = value => resolve\(value === true\)/);
});
test('the Node build runs real multi-bot coordination with a run timeline',()=>{
  assert.match(js,/async function runOnServer\(/);
  assert.match(js,/function streamGroupRun\(/);
  assert.match(js,/run-timeline/);
  assert.match(js,/'continue-run'/);
  assert.match(js,/'retry-run'/);
  assert.match(js,/id="checkpoint-toggle"/);
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
  // Admin surfaces are gated off on the static Pages demo and for non-admins:
  // the role check, the You-page entry, the quick-nav entries and the route parser.
  assert.match(js,/export const isAdmin = \(\) => !isStaticDemo\(\) && \['owner', 'admin'\]\.includes/);
  assert.match(js,/isAdmin\(\) \? box\(\['ai', 'team', 'agents', 'data'\]/);
  assert.match(js,/if \(isAdmin\(\)\) items\.push\(/);
  assert.match(js,/parseRoute\(location\.hash, store\.state, \{server: !isStaticDemo\(\), admin: isAdmin\(\)\}\)/);
});
test('destructive admin actions ask first and say what they do',()=>{
  for (const message of ['Sign out every other session','Remove this user from the workspace','Revoke this local agent','Delete this credential','Prune exhaust older than the retention policy','Replace this workspace with the pasted backup'])
    assert.match(js,new RegExp(`confirmSheet\\('${message}`),`${message} must be confirmed`);
});
test('the bot editor exposes contract and permission controls (Phase E UI)',()=>{
  assert.match(js,/id="edit-bot-form"/);
  assert.match(js,/name="outputKind"/);
  assert.match(js,/name="permissions"/);
  assert.match(js,/contract-fieldset/);
  assert.match(js,/Publishing is never automated/);
});
test('draft cards expose the evidence review surface',()=>{
  // Phase D UI: the reviewer can see, verify, dispute, drop and add the source
  // evidence a draft relies on, straight from the approval card.
  assert.match(js,/evidence-panel/);
  assert.match(js,/'verify-evidence'/);
  assert.match(js,/'drop-evidence'/);
  assert.match(js,/class="evidence-form"/);
});
test('the shell is integrated: one search, animated routes, one progress bar',()=>{
  assert.match(html,/id="progress"/);
  assert.match(html,/class="splash"/);
  assert.match(html,/id="main" tabindex="-1"/);
  // One search entry point per job: the chat-list filter and Ctrl+K quick nav.
  assert.match(js,/id="chat-search"/);
  assert.match(js,/ev\.key\.toLowerCase\(\) === 'k'/);
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
  // The 30s poll used to re-render unconditionally, discarding whatever the user
  // had typed, and rebuilding the sign-in dialog (clearing the password) on every 401.
  assert.match(js,/const typingIn = node =>/);
  assert.match(js,/if \(!typingIn\(el\('chat-space'\)\)\) renderThread\(\)/);
  assert.match(js,/scope === 'all' && !typingIn\(el\('inspector'\)\)\) renderInfo\(\)/);
  assert.match(js,/clearInterval\(syncTimer\)/);
  assert.match(js,/const visible = Boolean\(layer\)/);
  // Sheets live in their own layer that a repaint never touches.
  assert.doesNotMatch(js,/el\('modal'\)\.innerHTML = (?!'')/);
});
test('the UI distinguishes a duplicate capture from a new one',()=>{
  // /api/candidates now returns `duplicate`; the toast must reflect it rather
  // than always claiming a new post was added.
  assert.match(js,/r\?\.duplicate \?/);
  assert.match(js,/already here/);
});
test('the UI adapts its copy and adds sign-out for the Node server build',()=>{
 assert.match(js,/isStaticDemo = \(\) =>/);
 assert.match(js,/agent-backend/);
 assert.match(js,/actions\.logout = async \(\) =>/);
 assert.match(js,/Connected to Node server/);
 assert.match(js,/Your session expired/);
 assert.match(js,/rewrite-draft/);
 // Sign-out also stops the poll and drops the cached state.
 assert.match(js,/lockScreen\('Signed out\.'\)/);
});
