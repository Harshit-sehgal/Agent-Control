import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {filterCandidates,filterDrafts,normalizeUiPrefs} from '../shared/usability.js';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const [html,js,css]=await Promise.all(['shared/index.html','shared/app.js','shared/usability.css'].map(f=>readFile(path.join(root,f),'utf8')));
const candidates=[
 {id:'old',author:'Robot',topic:'robotics',text:'old',status:'new',createdAt:'2025-01-01T00:00:00Z'},
 {id:'new',author:'Alice',topic:'AI',text:'new benchmark',status:'drafted',score:{score:91},createdAt:'2026-01-01T00:00:00Z'},
 {id:'medium',author:'Bob',topic:'machine learning',text:'ML',status:'drafted',score:{score:62},createdAt:'2026-02-01T00:00:00Z'}
];
const drafts=[
 {id:'x',status:'pending',score:80,createdAt:'2026-01-01T00:00:00Z'},
 {id:'y',status:'posted',score:90,createdAt:'2026-02-01T00:00:00Z'},
 {id:'z',status:'ready',score:45,createdAt:'2026-03-01T00:00:00Z'}
];
test('candidate search is case-insensitive across topic and author',()=>assert.deepEqual(filterCandidates(candidates,{query:'ai'}).map(x=>x.id),['new']));
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
test('Pages exposes filters, native dropdowns and bot creation templates',()=>{
 assert.match(html,/\.\/usability\.css/);
 assert.match(js,/actionMenu\(/);
 assert.match(js,/candidate-search/);
 assert.match(js,/draft-status/);
 assert.match(js,/bot-template/);
 assert.match(js,/mobile-group-tab/);
 assert.match(css,/\.dropdown-panel/);
 assert.match(css,/focus-visible/);
});
test('chat clearing and sensitive changes require confirmation',()=>{
 assert.match(js,/window\.confirm\('Clear this conversation/);
 assert.match(js,/window\.confirm\('Confirm that you personally published/);
 assert.match(js,/window\.confirm\('Remove this reminder/);
 assert.match(js,/copy-chat/);
 assert.match(js,/duplicate-bot/);
 assert.match(js,/pin-bot/);
});
test('the UI adapts its copy and adds sign-out for the Node server build',()=>{
 assert.match(js,/function isStaticDemo\(/);
 assert.match(js,/agent-backend/);
 assert.match(js,/case 'logout'/);
 assert.match(js,/async function logout\(/);
 assert.match(js,/Connected to Node server/);
 assert.match(js,/Your session expired/);
 assert.match(js,/rewrite-draft/);
});
