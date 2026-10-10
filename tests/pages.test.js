import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const html=await readFile(path.join(root,'shared/index.html'),'utf8');

// The browser-local transport imports the same workflow rules the Node server
// uses. It expects browser globals, so provide minimal stand-ins before loading.
let storage={getItem:()=>null,setItem:()=>{}};
globalThis.window=globalThis.window||{};
Object.defineProperty(globalThis,'localStorage',{configurable:true,get:()=>storage,set:value=>{storage=value;}});
await import(path.join(root,'shared/local-api.js'));

function makeStorage(){const map=new Map();return {map,getItem:key=>map.get(key)??null,setItem:(key,value)=>map.set(key,String(value))};}
function setup(target=makeStorage()){storage=target;return {request:globalThis.window.AGENT_LOCAL_API,storage:target};}

const seed=async request=>{await request('/api/demo/seed','POST',{});const s=await request('/api/state');const item=s.candidates.find(x=>x.topic==='AI');return request(`/api/candidates/${item.id}/process`,'POST',{});};

test('demo page uses path-relative assets and clearly discloses browser-local data',()=>{
  assert.match(html,/\.\/app\.css/);assert.match(html,/\.\/app\.js/);assert.match(html,/type="module" src="\.\/local-api\.js"/);assert.match(html,/\.\/transport\.js/);
  assert.match(html,/Data is saved only in this browser/);
  assert.doesNotMatch(html,/<script[^>]+src="\/app\.js/);
});
test('candidate process, edit invalidates approval, and manual posting flow persists',async()=>{
  const store=makeStorage();
  const {request}=setup(store);
  let d=await seed(request);assert.equal(d.status,'pending');assert.equal(d.mode,'template');
  await request('/api/settings','PATCH',{topics:['AI'],style:'short',opinions:'',minDelay:0,maxDelay:0});
  d=await request(`/api/drafts/${d.id}/approve`,'POST',{});assert.equal(d.status,'scheduled');
  d=await request(`/api/drafts/${d.id}`,'PATCH',{text:'A revised draft with my opinion.'});assert.equal(d.status,'pending');assert.equal(d.revision,2);assert.equal(d.approvedText,undefined);
  await assert.rejects(request(`/api/drafts/${d.id}/posted`,'POST',{}),/Only ready/);
  await request(`/api/drafts/${d.id}/approve`,'POST',{});
  let s=await request('/api/state');d=s.drafts.find(x=>x.id===d.id);assert.equal(d.status,'ready');
  d=await request(`/api/drafts/${d.id}/posted`,'POST',{});assert.equal(d.status,'posted');
  const reopened=setup(store).request;
  assert.equal((await reopened('/api/state')).drafts[0].status,'posted');
});
test('custom groups, bots, local reminders and unsupported AI execution',async()=>{
  const {request}=setup();
  const g=await request('/api/groups','POST',{name:'Insights',description:'Research notes'});assert.equal(g.name,'Insights');
  const b=await request(`/api/groups/${g.id}/bots`,'POST',{name:'Summarizer',instructions:'Summarize the input.'});
  assert.equal(b.name,'Summarizer');
  await assert.rejects(request('/api/bots/run','POST',{botId:b.id,input:'hello'}),/Node backend/);
  const rem=await request('/api/schedules','POST',{label:'Check queue',kind:'interval',intervalMinutes:60});
  assert.equal(rem.enabled,true);
  await request(`/api/schedules/${rem.id}`,'DELETE');assert.equal((await request('/api/state')).schedules.length,0);
});
test('reject invalid input and impossible approval delays',async()=>{
  const {request}=setup();
  await assert.rejects(request('/api/candidates','POST',{url:'javascript:alert(1)',text:'an adequately long candidate'}),/valid public http/);
  await assert.rejects(request('/api/candidates','POST',{url:'https://example.com',text:'short'}),/at least 12/);
  await assert.rejects(request('/api/settings','PATCH',{topics:['AI'],minDelay:11,maxDelay:3}),/Invalid delay window/);
});