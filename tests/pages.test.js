import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createContext,runInContext} from 'node:vm';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const source=await readFile(path.join(root,'docs/demo-api.js'),'utf8');
const html=await readFile(path.join(root,'docs/index.html'),'utf8');
function setup(storage=new Map()) {
  const window={};
  const localStorage={getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value)};
  runInContext(source,createContext({window,localStorage,crypto:{randomUUID},Date,URL,Math,Number,String,Array,JSON,Error,RegExp}));
  return {request:window.AGENT_PAGES_DEMO,storage};
}
const seed = async request => {await request('/api/demo/seed','POST',{});const s=await request('/api/state');const item=s.candidates.find(x=>x.topic==='AI');return (await request(`/api/candidates/${item.id}/process`,'POST',{}));};
test('Pages site uses path-relative assets and clearly discloses demo',()=>{
  assert.match(html,/\.\/app\.css/);assert.match(html,/\.\/app\.js/);assert.match(html,/\.\/demo-api\.js/);
  assert.match(html,/Data is saved only in this browser/);
  assert.doesNotMatch(html,/<script[^>]+src="\/app\.js/);
});
test('candidate process, edit invalidates approval, and manual posting flow persists',async()=>{
  const {request,storage}=setup();
  let d=await seed(request);assert.equal(d.status,'pending');assert.equal(d.mode,'template');
  await request('/api/settings','PATCH',{topics:['AI'],style:'short',opinions:'',minDelay:0,maxDelay:0});
  d=await request(`/api/drafts/${d.id}/approve`,'POST',{});assert.equal(d.status,'scheduled');
  d=await request(`/api/drafts/${d.id}`,'PATCH',{text:'A revised draft with my opinion.'});assert.equal(d.status,'pending');assert.equal(d.revision,2);assert.equal(d.approvedText,undefined);
  await assert.rejects(request(`/api/drafts/${d.id}/posted`,'POST',{}),/Only ready/);
  await request(`/api/drafts/${d.id}/approve`,'POST',{});
  let s=await request('/api/state');d=s.drafts.find(x=>x.id===d.id);assert.equal(d.status,'ready');
  d=await request(`/api/drafts/${d.id}/posted`,'POST',{});assert.equal(d.status,'posted');
  const again=setup(storage).request;assert.equal((await again('/api/state')).drafts[0].status,'posted');
});
test('custom groups, bots, local reminders and unsupported AI execution',async()=>{
  const {request}=setup();
  const g=await request('/api/groups','POST',{name:'Insights',description:'Research notes'});assert.equal(g.name,'Insights');
  const b=await request(`/api/groups/${g.id}/bots`,'POST',{name:'Summarizer',instructions:'Summarize the input.'});
  assert.equal(b.name,'Summarizer');
  await assert.rejects(request('/api/bots/run','POST',{botId:b.id,input:'hello'}),/requires the separate Node backend/);
  const rem=await request('/api/schedules','POST',{label:'Check queue',kind:'interval',intervalMinutes:60});
  assert.equal(rem.enabled,true);
  await request(`/api/schedules/${rem.id}`,'DELETE');assert.equal((await request('/api/state')).schedules.length,0);
});
test('reject invalid input and impossible approval delays',async()=>{
  const {request}=setup();
  await assert.rejects(request('/api/candidates','POST',{url:'javascript:alert(1)',text:'an adequately long candidate'}),/valid http/);
  await assert.rejects(request('/api/candidates','POST',{url:'https://example.com',text:'short'}),/at least 12/);
  await assert.rejects(request('/api/settings','PATCH',{topics:['AI'],minDelay:11,maxDelay:3}),/Delay must/);
});
