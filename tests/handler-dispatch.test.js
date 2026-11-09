/** `agent-job` dispatch in src/handlers.js.
 *
 * An `agent-job` queue task is fanned out to the paired local agents that hold
 * the permission the job names. Only the payload validation was tested before,
 * so the fan-out itself — who gets the work, under which idempotency key, and
 * whether a broken row can take the dispatch down — was unverified.
 *
 * The store is a real workspace store in a temp directory: the handler is SQL
 * over `agents` and `agent_tasks`, and a fake object would only re-state the
 * queries instead of exercising them.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {SqliteStore} from '../src/sqlite-store.js';
import {taskHandlers} from '../src/handlers.js';

async function harness(){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'agent-dispatch-'));
  const store=await new SqliteStore(path.join(dir,'state.db'),path.join(dir,'state.json')).init();
  const handlers=taskHandlers({
    ws:store, workspaceId:'default',
    auth:null, push:null,                       // only reached by the notification handler
    notify:()=>{},                              // no notification fan-out in these cases
    processCandidate:async()=>{},               // only reached by candidate-draft
  });
  return {dir,store,handlers,dispatch:task=>handlers['agent-job'](task)};
}

function addAgent(store,{id,permissions,revoked=null}){
  store.run('INSERT INTO agents (id,workspace_id,name,secret_hash,status,permissions,paired_at,revoked_at) VALUES (?,?,?,?,?,?,?,?)',
    id,'default',id,'stored-secret-hash','paired',
    typeof permissions==='string'?permissions:JSON.stringify(permissions),
    new Date().toISOString(),revoked);
  return id;
}

const agentTasks=store=>store.all('SELECT agent_id,kind,payload,status,idempotency_key,created_by FROM agent_tasks ORDER BY agent_id');

const job=(overrides={})=>({
  id:'task-1',
  createdBy:'user-1',
  payload:{action:'browser.capture',params:{url:'https://example.test/page'},...overrides},
});

test('a job reaches only the agents that hold its permission',async()=>{
  const {store,dispatch,dir}=await harness();
  try{
    addAgent(store,{id:'agent-capture',permissions:['browser.capture']});
    addAgent(store,{id:'agent-http',permissions:['http.check']});

    const result=await dispatch(job());

    assert.deepEqual(result,{dispatchedTo:['agent-capture']},'only the agent with the permission may receive the job');
    const rows=agentTasks(store);
    assert.equal(rows.length,1,'the other agent must not get a queued task');
    assert.equal(rows[0].agent_id,'agent-capture');
    assert.equal(rows[0].kind,'browser.capture');
    // The payload is the validated request, not the job's own fields: the enqueue
    // is the one door every caller goes through, so it stores what the browser
    // rule accepts and nothing else.
    assert.deepEqual(JSON.parse(rows[0].payload),{url:'https://example.test/page',steps:[]});
    assert.equal(rows[0].status,'queued');
    assert.equal(rows[0].created_by,'user-1','the agent task must record who asked for the job');
  }finally{
    await fs.rm(dir,{recursive:true,force:true});
  }
});

test('the idempotency key is job:<taskId>:<agentId>, so a retry cannot run twice',async()=>{
  const {store,dispatch,dir}=await harness();
  try{
    addAgent(store,{id:'agent-capture',permissions:['browser.capture']});

    await dispatch(job());
    const first=agentTasks(store);
    assert.equal(first[0].idempotency_key,'job:task-1:agent-capture',
      'the key must be derived from the queue task and the agent, not from the payload');

    // The queue retries a handler whose lease expired; the second run must find
    // the existing agent task instead of enqueuing the same work again.
    const again=await dispatch(job());
    assert.deepEqual(again,{dispatchedTo:['agent-capture']});
    assert.equal(agentTasks(store).length,1,'a retried job must not create a second agent task');

    // A different queue task is different work, even for the same agent.
    await dispatch({...job(),id:'task-2'});
    const keys=agentTasks(store).map(row=>row.idempotency_key).sort();
    assert.deepEqual(keys,['job:task-1:agent-capture','job:task-2:agent-capture']);
  }finally{
    await fs.rm(dir,{recursive:true,force:true});
  }
});

test('an explicit agentId narrows the fan-out to that agent',async()=>{
  const {store,dispatch,dir}=await harness();
  try{
    addAgent(store,{id:'agent-a',permissions:['browser.capture']});
    addAgent(store,{id:'agent-b',permissions:['browser.capture']});

    const result=await dispatch(job({agentId:'agent-b'}));

    assert.deepEqual(result,{dispatchedTo:['agent-b']});
    assert.deepEqual(agentTasks(store).map(row=>row.agent_id),['agent-b'],
      'an agent id in the payload must not fan out to the other holders');
  }finally{
    await fs.rm(dir,{recursive:true,force:true});
  }
});

test('a job no agent can hold fails with the message the operator sees',async()=>{
  const {store,dispatch,dir}=await harness();
  try{
    addAgent(store,{id:'agent-http',permissions:['http.check']});
    // A revoked agent keeps its permissions but must not be given work.
    addAgent(store,{id:'agent-old',permissions:['browser.capture'],revoked:new Date().toISOString()});

    await assert.rejects(()=>dispatch(job()),error=>{
      assert.equal(error.message,'No paired local agent holds the permission this job needs.');
      return true;
    });
    assert.deepEqual(agentTasks(store),[],'a failed dispatch must not leave a queued agent task');
  }finally{
    await fs.rm(dir,{recursive:true,force:true});
  }
});

test('one agent row with corrupt permissions does not stop the others',async()=>{
  const {store,dispatch,dir}=await harness();
  try{
    addAgent(store,{id:'agent-broken',permissions:'not json at all'});
    addAgent(store,{id:'agent-capture',permissions:['browser.capture']});

    const result=await dispatch(job());

    assert.deepEqual(result,{dispatchedTo:['agent-capture']},
      'a stored permissions column that will not parse must be treated as "holds nothing", not as a crash');
    assert.deepEqual(agentTasks(store).map(row=>row.agent_id),['agent-capture']);
  }finally{
    await fs.rm(dir,{recursive:true,force:true});
  }
});
