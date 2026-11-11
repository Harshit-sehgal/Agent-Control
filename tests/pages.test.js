import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {installWebLocks} from './web-locks.js';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const html=await readFile(path.join(root,'shared/index.html'),'utf8');

// The browser-local transport imports the same workflow rules the Node server
// uses. It expects browser globals, so provide minimal stand-ins before loading.
let storage={getItem:()=>null,setItem:()=>{}};
globalThis.window=globalThis.window||{};
Object.defineProperty(globalThis,'localStorage',{configurable:true,get:()=>storage,set:value=>{storage=value;}});
// The demo coordinates tabs through Web Locks, which Node 22 (what CI runs)
// does not expose. tests/web-locks.js installs the contract `withLocalLock`
// relies on, so this suite no longer depends on the Node version.
installWebLocks();
await import(path.join(root,'shared/local-api.js'));

function makeStorage(){const map=new Map();return {map,getItem:key=>map.get(key)??null,setItem:(key,value)=>map.set(key,String(value))};}
function setup(target=makeStorage()){storage=target;return {request:globalThis.window.AGENT_LOCAL_API,storage:target};}
// The starting workspace is one bot, which finishes in a single step. A run that
// pauses between steps needs a second bot to hand to.
const addPeer=request=>request('/api/groups/home/bots','POST',{name:'Scout',instructions:'Look things up for the team.'});


test('demo page uses path-relative assets and clearly discloses browser-local data',()=>{
  assert.match(html,/\.\/app\.css/);assert.match(html,/\.\/app\.js/);assert.match(html,/type="module" src="\.\/local-api\.js"/);assert.match(html,/\.\/transport\.js/);
  assert.match(html,/Data is saved only in this browser/);
  assert.doesNotMatch(html,/<script[^>]+src="\/app\.js/);
});
test('custom groups, bots and unsupported AI execution',async()=>{
  const {request}=setup();
  const g=await request('/api/groups','POST',{name:'Insights',description:'Research notes'});assert.equal(g.name,'Insights');
  const b=await request(`/api/groups/${g.id}/bots`,'POST',{name:'Summarizer',instructions:'Summarize the input.'});
  assert.equal(b.name,'Summarizer');
  await assert.rejects(request('/api/bots/run','POST',{botId:b.id,input:'hello'}),/Node backend/);
});
test('a due scheduled task runs on Pages even when the group shows its plan first',async()=>{
  const store=makeStorage();
  const {request}=setup(store);
  // The plan gate only applies to a tracked group; the home group starts direct.
  await request('/api/groups/home','PATCH',{settings:{confirmPlan:true,coordination:'tracked'}});
  const task=await request('/api/tasks','POST',{kind:'bot-task',payload:{groupId:'home',botId:'atlas',message:'draft a reply',label:'Draft check',kind:'once',nextAt:new Date(Date.now()+3600000).toISOString()}});
  const saved=JSON.parse(store.map.get('agent-control-ghpages-v1'));
  saved.tasks.find(t=>t.id===task.id).runAt=new Date(Date.now()-1000).toISOString();
  store.map.set('agent-control-ghpages-v1',JSON.stringify(saved));
  const after=await request('/api/state');
  const text=(after.chats?.atlas||[]).map(m=>m.text).join('\n');
  assert.match(text,/Scheduled task: draft a reply/);
  assert.match(text,/Passing this through/);
  assert.doesNotMatch(text,/Start it when you are ready/);
  assert.equal(after.groups.find(g=>g.id==='home').settings.coordination,'tracked');
  assert.equal(after.groups.find(g=>g.id==='home').settings.confirmPlan,true);
  assert.ok((after.chats?.atlas||[]).some(m=>m.role==='bot'&&m.senderId),'A scheduled reply keeps the bot that wrote it.');
  assert.equal(after.tasks.find(t=>t.id===task.id).status,'done');
  const runs=after.groupRuns||[];
  assert.ok(runs.some(r=>r.groupId==='home'&&r.status==='completed'),'A scheduled task occupies the group, then frees it.');
  assert.ok(runs.every(r=>r.groupId!=='home'||!['running','queued','awaiting_plan','awaiting_browser','awaiting_feed','awaiting_checkpoint'].includes(r.status)));
});
test('a due scheduled Pages task with checkpoints leaves the group paused',async()=>{
  const store=makeStorage();
  const {request}=setup(store);
  await addPeer(request);
  await request('/api/groups/home','PATCH',{settings:{checkpoints:true,coordination:'direct'}});
  const task=await request('/api/tasks','POST',{kind:'bot-task',payload:{groupId:'home',botId:null,message:'go',label:'All bots',kind:'once',nextAt:new Date(Date.now()+3600000).toISOString()}});
  const saved=JSON.parse(store.map.get('agent-control-ghpages-v1'));
  saved.tasks.find(t=>t.id===task.id).runAt=new Date(Date.now()-1000).toISOString();
  store.map.set('agent-control-ghpages-v1',JSON.stringify(saved));
  const after=await request('/api/state');
  const runs=after.groupRuns||[];
  const paused=runs.find(r=>r.groupId==='home');
  assert.equal(paused?.status,'awaiting_checkpoint');
  assert.equal(paused.checkpointsEnabled,true);
  assert.ok(paused.input);
  assert.ok(paused.checkpoint?.nextStep);
});
test('the Pages engine answers the same run routes the server serves',async()=>{
  const store=makeStorage();
  const {request}=setup(store);
  // Pause the run so there is something a person can still stop.
  await addPeer(request);
  await request('/api/groups/home','PATCH',{settings:{checkpoints:true,coordination:'tracked'}});
  const run=await request('/api/groups/home/chat','POST',{message:'go',chatKey:'team-home'});
  assert.ok(run.runId,'POST /chat returns a run id, like the server');
  assert.equal(run.status,'awaiting_checkpoint');
  const log=await request('/api/groups/home/chat');
  assert.ok(Array.isArray(log.messages)&&Array.isArray(log.runs),'GET /chat returns messages and runs');
  assert.ok(log.runs.some(r=>r.id===run.runId),'the run is read back from the workspace snapshot');
  const cancelled=await request(`/api/groups/home/runs/${run.runId}/cancel`,'POST',{});
  assert.equal(cancelled.status,'cancelled');
  assert.equal((await request('/api/state')).groupRuns.find(r=>r.id===run.runId).status,'cancelled','the cancel is stored, not only returned');
  const local=await readFile(path.join(root,'shared/local-api.js'),'utf8');
  const ui=await readFile(path.join(root,'shared/ui-store.js'),'utf8');
  assert.doesNotMatch(local,/claimLocalRun|finishLocalRun|localRunCancelled/,'the demo no longer keeps a second run store');
  assert.doesNotMatch(ui,/local-runs\.js/);
});
test('clearing a Pages chat cancels the run that was blocking the group',async()=>{
  const store=makeStorage();
  const {request}=setup(store);
  const before=await request('/api/state');
  store.map.set('agent-control-ghpages-v1',JSON.stringify({...before,groupRuns:[{id:'h',groupId:'home',chatKey:'team-home',status:'awaiting_plan',createdAt:new Date().toISOString()}]}));
  await request('/api/chats/team-home','DELETE');
  const after=await request('/api/state');
  assert.equal(after.groupRuns.find(r=>r.id==='h').status,'cancelled');
});
test('a due scheduled Pages task waits while a plan is already on screen',async()=>{
  const store=makeStorage();
  const {request}=setup(store);
  const base=await request('/api/state');
  store.map.set('agent-control-ghpages-v1',JSON.stringify({...base,groupRuns:[{id:'plan-1',groupId:'home',chatKey:'atlas',status:'awaiting_plan',createdAt:new Date().toISOString()}]}));
  const task=await request('/api/tasks','POST',{kind:'bot-task',payload:{groupId:'home',botId:'atlas',message:'draft a reply',label:'Draft check',kind:'once',nextAt:new Date(Date.now()+3600000).toISOString()}});
  const saved=JSON.parse(store.map.get('agent-control-ghpages-v1'));
  saved.tasks.find(t=>t.id===task.id).runAt=new Date(Date.now()-1000).toISOString();
  store.map.set('agent-control-ghpages-v1',JSON.stringify(saved));
  const after=await request('/api/state');
  const row=after.tasks.find(t=>t.id===task.id);
  assert.equal(row.status,'queued');
  assert.match(row.lastError,/already active/i);
  assert.ok(Date.parse(row.runAt)>Date.now()-2000);
  assert.doesNotMatch((after.chats?.atlas||[]).map(m=>m.text).join('\n'),/Scheduled task:/);
});
test('Pages due() does not re-enter and double-fire scheduled tasks',async()=>{
  const store=makeStorage();
  const {request}=setup(store);
  const a=await request('/api/tasks','POST',{kind:'bot-task',payload:{groupId:'home',botId:'atlas',message:'first',label:'A',kind:'once',nextAt:new Date(Date.now()+3600000).toISOString()}});
  const b=await request('/api/tasks','POST',{kind:'bot-task',payload:{groupId:'home',botId:'atlas',message:'second',label:'B',kind:'once',nextAt:new Date(Date.now()+3600000).toISOString()}});
  const saved=JSON.parse(store.map.get('agent-control-ghpages-v1'));
  for(const id of [a.id,b.id])saved.tasks.find(t=>t.id===id).runAt=new Date(Date.now()-1000).toISOString();
  store.map.set('agent-control-ghpages-v1',JSON.stringify(saved));
  const after=await request('/api/state');
  assert.equal(after.tasks.find(t=>t.id===a.id).status,'done');
  assert.equal(after.tasks.find(t=>t.id===b.id).status,'done');
  const lines=(after.chats?.atlas||[]).map(m=>m.text);
  assert.equal(lines.filter(t=>t==='Scheduled task: first').length,1);
  assert.equal(lines.filter(t=>t==='Scheduled task: second').length,1);
});
test('a scheduled Pages task that cannot run is failed, not stored as done',async()=>{
  const store=makeStorage();
  const {request}=setup(store);
  const other=await request('/api/groups','POST',{name:'Other',description:'Guests'});
  const guest=await request(`/api/groups/${other.id}/bots`,'POST',{name:'Expert',instructions:'Help when asked.'});
  await request(`/api/groups/${other.id}/bots/${guest.id}`,'PATCH',{settings:{enabled:false,summonable:true}});
  const task=await request('/api/tasks','POST',{kind:'bot-task',payload:{groupId:'home',botId:'atlas',message:'@Expert draft a reply',label:'Ask expert',kind:'once',nextAt:new Date(Date.now()+3600000).toISOString()}});
  const saved=JSON.parse(store.map.get('agent-control-ghpages-v1'));
  saved.tasks.find(t=>t.id===task.id).runAt=new Date(Date.now()-1000).toISOString();
  store.map.set('agent-control-ghpages-v1',JSON.stringify(saved));
  const after=await request('/api/state');
  const row=after.tasks.find(t=>t.id===task.id);
  assert.equal(row.status,'failed');
  assert.match(row.lastError,/switched off/i);
  assert.match((after.chats?.atlas||[]).map(m=>m.text).join('\n'),/did not run/);
});

test('the Pages demo refuses a notification task exactly like the Node server',async()=>{
  // src/routes-workflow.js answers 403: a delivery task comes from a person's own
  // notification preferences, never from a request body.
  const store=makeStorage();
  const {request}=setup(store);
  await request('/api/state');
  await assert.rejects(request('/api/tasks','POST',{kind:'notification',payload:{notificationId:'n1'}}),error=>error.status===403&&/server, not by request/.test(error.message));
  const after=await request('/api/state');
  assert.equal(after.tasks.length,0,'A refused delivery task is not stored either.');
});

test('the Pages backend has no X routes',async()=>{
  const {request}=setup();
  for(const [path,method] of [['/api/candidates','POST'],['/api/drafts/x/approve','POST'],['/api/demo/seed','POST'],['/api/schedules','POST'],['/api/settings','PATCH']])
    await assert.rejects(request(path,method,{}),error=>error.status===404,`${method} ${path}`);
});
test('first Pages boot seeds the starting workspace',async()=>{
  const {request}=setup();
  const {initialState}=await import(path.join(root,'shared/core.js'));
  const {migrate}=await import(path.join(root,'shared/workflow.js'));
  await request('/api/reset-workspace','POST',{});
  const s=await request('/api/state');
  // Loading backfills bot contracts, so compare with the seed as it loads.
  assert.deepEqual(s.groups,migrate(initialState()).groups);
});

test('Pages saves a retention policy the same way the server does',async()=>{
  const {request}=setup();
  const saved=await request('/api/retention','PATCH',{events:30,doneTasks:7,runs:14});
  assert.deepEqual([saved.events,saved.doneTasks,saved.runs],[30,7,14]);
  assert.equal((await request('/api/state')).settings.retention.events,30);
});

test('Pause all works in the demo: the same route and flag as the server',async()=>{
  const {request}=setup();
  assert.equal((await request('/api/state')).guard.paused,false,'a fresh demo is not paused and says so');
  const on=await request('/api/guard','POST',{paused:true});
  assert.equal(on.guard.paused,true);
  assert.equal((await request('/api/state')).guard.paused,true,'the state carries the flag for the sidebar');
  await assert.rejects(request('/api/guard','POST',{}),error=>error.status===400);
  const off=await request('/api/guard','POST',{paused:false});
  assert.deepEqual([off.guard.paused,off.resumed,off.cancelled],[false,0,0]);
});
