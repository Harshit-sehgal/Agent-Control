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
  await request(`/api/schedules/${rem.id}`,'DELETE');
  const tasks=(await request('/api/state')).tasks;
  assert.equal(tasks.length,1);
  assert.equal(tasks[0].status,'cancelled','Removing a reminder cancels its structured task record.');
});
test('reject invalid input and impossible approval delays',async()=>{
  const {request}=setup();
  await assert.rejects(request('/api/candidates','POST',{url:'javascript:alert(1)',text:'an adequately long candidate'}),/valid public http/);
  await assert.rejects(request('/api/candidates','POST',{url:'https://example.com',text:'short'}),/at least 12/);
  await assert.rejects(request('/api/settings','PATCH',{topics:['AI'],minDelay:11,maxDelay:3}),/Invalid delay window/);
});test('Pages resolves due drafts and reminders exactly like the Node scheduler',async()=>{
  // src/scheduler.js records a `ready` event when a scheduled draft comes due and
  // a `reminder` event when a schedule fires. The browser-local transport used to
  // reimplement that logic inline and record neither, so the Pages Activity tab
  // stayed empty while the Node build logged them.
  const store=makeStorage();
  const {request}=setup(store);
  await request('/api/settings','PATCH',{minDelay:0,maxDelay:0});
  const d=await seed(request);
  await request(`/api/drafts/${d.id}/approve`,'POST',{});
  const created=await request('/api/schedules','POST',{label:'Review the queue',kind:'once',nextAt:new Date(Date.now()+3600000).toISOString()});
  // Rewrite both into the past, exactly as if the page had been left open.
  const state=JSON.parse(store.map.get('agent-control-ghpages-v1'));
  const draft=state.drafts.find(x=>x.id===d.id);
  draft.dueAt=new Date(Date.now()-1000).toISOString();
  const reminder=state.tasks.find(x=>x.id===created.id);
  assert.ok(reminder,'A created reminder must persist as a structured task.');
  reminder.runAt=new Date(Date.now()-1000).toISOString();
  store.map.set('agent-control-ghpages-v1',JSON.stringify(state));
  const after=await request('/api/state');
  const resolved=after.drafts.find(x=>x.id===d.id);
  const fired=after.tasks.find(x=>x.id===created.id);
  assert.equal(resolved.status,'ready');
  assert.equal(fired.status,'done','A one-off reminder must complete once it fires.');
  assert.ok(after.events.some(e=>e.type==='ready'),'Pages must record the ready transition in the activity log.');
  assert.ok(after.events.some(e=>e.type==='reminder'&&e.message==='Review the queue'),'Pages must record fired reminders in the activity log.');
});
test('a due scheduled task runs on Pages even when the group shows its plan first',async()=>{
  const store=makeStorage();
  const {request}=setup(store);
  // Only the plan gate is sent. X-engage must stay tracked; writing the
  // direct default here would never show a plan.
  await request('/api/groups/x-engage','PATCH',{settings:{confirmPlan:true}});
  const task=await request('/api/tasks','POST',{kind:'bot-task',payload:{groupId:'x-engage',botId:'handoff',message:'draft a reply',label:'Draft check',kind:'once',nextAt:new Date(Date.now()+3600000).toISOString()}});
  const saved=JSON.parse(store.map.get('agent-control-ghpages-v1'));
  saved.tasks.find(t=>t.id===task.id).runAt=new Date(Date.now()-1000).toISOString();
  store.map.set('agent-control-ghpages-v1',JSON.stringify(saved));
  const after=await request('/api/state');
  const text=(after.chats?.handoff||[]).map(m=>m.text).join('\n');
  assert.match(text,/Scheduled task: draft a reply/);
  assert.match(text,/Passing this through/);
  assert.doesNotMatch(text,/Start it when you are ready/);
  assert.equal(after.groups.find(g=>g.id==='x-engage').settings.coordination,'tracked');
  assert.equal(after.groups.find(g=>g.id==='x-engage').settings.confirmPlan,true);
  assert.ok((after.chats?.handoff||[]).some(m=>m.role==='bot'&&m.senderId),'A scheduled reply keeps the bot that wrote it.');
  assert.equal(after.tasks.find(t=>t.id===task.id).status,'done');
  const runs=after.groupRuns||[];
  assert.ok(runs.some(r=>r.groupId==='x-engage'&&r.status==='completed'),'A scheduled task occupies the group, then frees it.');
  assert.ok(runs.every(r=>r.groupId!=='x-engage'||!['running','queued','awaiting_plan','awaiting_browser','awaiting_feed','awaiting_checkpoint'].includes(r.status)));
});
test('a due scheduled Pages task with checkpoints leaves the group paused',async()=>{
  const store=makeStorage();
  const {request}=setup(store);
  await request('/api/groups/x-engage','PATCH',{settings:{checkpoints:true,coordination:'direct'}});
  const task=await request('/api/tasks','POST',{kind:'bot-task',payload:{groupId:'x-engage',botId:null,message:'go',label:'All bots',kind:'once',nextAt:new Date(Date.now()+3600000).toISOString()}});
  const saved=JSON.parse(store.map.get('agent-control-ghpages-v1'));
  saved.tasks.find(t=>t.id===task.id).runAt=new Date(Date.now()-1000).toISOString();
  store.map.set('agent-control-ghpages-v1',JSON.stringify(saved));
  const after=await request('/api/state');
  const runs=after.groupRuns||[];
  const paused=runs.find(r=>r.groupId==='x-engage');
  assert.equal(paused?.status,'awaiting_checkpoint');
  assert.equal(paused.checkpointsEnabled,true);
  assert.ok(paused.input);
  assert.ok(paused.checkpoint?.nextStep);
});
test('the Pages engine answers the same run routes the server serves',async()=>{
  const store=makeStorage();
  const {request}=setup(store);
  // Pause the run so there is something a person can still stop.
  await request('/api/groups/x-engage','PATCH',{settings:{checkpoints:true,coordination:'tracked'}});
  const run=await request('/api/groups/x-engage/chat','POST',{message:'go',chatKey:'team-x-engage'});
  assert.ok(run.runId,'POST /chat returns a run id, like the server');
  assert.equal(run.status,'awaiting_checkpoint');
  const log=await request('/api/groups/x-engage/chat');
  assert.ok(Array.isArray(log.messages)&&Array.isArray(log.runs),'GET /chat returns messages and runs');
  assert.ok(log.runs.some(r=>r.id===run.runId),'the run is read back from the workspace snapshot');
  const cancelled=await request(`/api/groups/x-engage/runs/${run.runId}/cancel`,'POST',{});
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
  store.map.set('agent-control-ghpages-v1',JSON.stringify({...before,groupRuns:[{id:'h',groupId:'x-engage',chatKey:'team-x-engage',status:'awaiting_plan',createdAt:new Date().toISOString()}]}));
  await request('/api/chats/team-x-engage','DELETE');
  const after=await request('/api/state');
  assert.equal(after.groupRuns.find(r=>r.id==='h').status,'cancelled');
});
test('a due scheduled Pages task waits while a plan is already on screen',async()=>{
  const store=makeStorage();
  const {request}=setup(store);
  const base=await request('/api/state');
  store.map.set('agent-control-ghpages-v1',JSON.stringify({...base,groupRuns:[{id:'plan-1',groupId:'x-engage',status:'awaiting_plan',createdAt:new Date().toISOString()}]}));
  const task=await request('/api/tasks','POST',{kind:'bot-task',payload:{groupId:'x-engage',botId:'handoff',message:'draft a reply',label:'Draft check',kind:'once',nextAt:new Date(Date.now()+3600000).toISOString()}});
  const saved=JSON.parse(store.map.get('agent-control-ghpages-v1'));
  saved.tasks.find(t=>t.id===task.id).runAt=new Date(Date.now()-1000).toISOString();
  store.map.set('agent-control-ghpages-v1',JSON.stringify(saved));
  const after=await request('/api/state');
  const row=after.tasks.find(t=>t.id===task.id);
  assert.equal(row.status,'queued');
  assert.match(row.lastError,/already active/i);
  assert.ok(Date.parse(row.runAt)>Date.now()-2000);
  assert.doesNotMatch((after.chats?.handoff||[]).map(m=>m.text).join('\n'),/Scheduled task:/);
});
test('Pages due() does not re-enter and double-fire scheduled tasks',async()=>{
  const store=makeStorage();
  const {request}=setup(store);
  const a=await request('/api/tasks','POST',{kind:'bot-task',payload:{groupId:'x-engage',botId:'handoff',message:'first',label:'A',kind:'once',nextAt:new Date(Date.now()+3600000).toISOString()}});
  const b=await request('/api/tasks','POST',{kind:'bot-task',payload:{groupId:'x-engage',botId:'handoff',message:'second',label:'B',kind:'once',nextAt:new Date(Date.now()+3600000).toISOString()}});
  const saved=JSON.parse(store.map.get('agent-control-ghpages-v1'));
  for(const id of [a.id,b.id])saved.tasks.find(t=>t.id===id).runAt=new Date(Date.now()-1000).toISOString();
  store.map.set('agent-control-ghpages-v1',JSON.stringify(saved));
  const after=await request('/api/state');
  assert.equal(after.tasks.find(t=>t.id===a.id).status,'done');
  assert.equal(after.tasks.find(t=>t.id===b.id).status,'done');
  const lines=(after.chats?.handoff||[]).map(m=>m.text);
  assert.equal(lines.filter(t=>t==='Scheduled task: first').length,1);
  assert.equal(lines.filter(t=>t==='Scheduled task: second').length,1);
});
test('a scheduled Pages task that cannot run is failed, not stored as done',async()=>{
  const store=makeStorage();
  const {request}=setup(store);
  const other=await request('/api/groups','POST',{name:'Other',description:'Guests'});
  const guest=await request(`/api/groups/${other.id}/bots`,'POST',{name:'Expert',instructions:'Help when asked.'});
  await request(`/api/groups/${other.id}/bots/${guest.id}`,'PATCH',{settings:{enabled:false,summonable:true}});
  const task=await request('/api/tasks','POST',{kind:'bot-task',payload:{groupId:'x-engage',botId:'handoff',message:'@Expert draft a reply',label:'Ask expert',kind:'once',nextAt:new Date(Date.now()+3600000).toISOString()}});
  const saved=JSON.parse(store.map.get('agent-control-ghpages-v1'));
  saved.tasks.find(t=>t.id===task.id).runAt=new Date(Date.now()-1000).toISOString();
  store.map.set('agent-control-ghpages-v1',JSON.stringify(saved));
  const after=await request('/api/state');
  const row=after.tasks.find(t=>t.id===task.id);
  assert.equal(row.status,'failed');
  assert.match(row.lastError,/switched off/i);
  assert.match((after.chats?.handoff||[]).map(m=>m.text).join('\n'),/did not run/);
});

test('the Pages demo approves with the delay window the person picked',async()=>{
  // The Approve button sends {minDelay,maxDelay}; the demo ignored the body and
  // used the workspace default, so the choice a person made had no effect here
  // while the Node build honoured it. The default window is 2-10 minutes.
  const {request}=setup(makeStorage());
  const d=await seed(request);
  const before=Date.now();
  const approved=await request(`/api/drafts/${d.id}/approve`,'POST',{minDelay:45,maxDelay:45});
  assert.equal(approved.status,'scheduled');
  const minutes=(Date.parse(approved.dueAt)-before)/60000;
  assert.ok(minutes>=44&&minutes<=46,`the chosen 45 minute window sets the due time, got ${minutes} minutes`);
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
