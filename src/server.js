import './env.js'; // load .env before anything reads process.env
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import crypto from 'node:crypto';
import {openStore as openSqliteStore} from './sqlite-store.js';
// The JSON store remains available behind STORE_BACKEND=json for testing and
// as an explicit escape hatch; SQLite is the default persistence engine.
const openStore = async file => process.env.STORE_BACKEND === 'json'
  ? new (await import('./store.js')).JsonStore(file).init()
  : openSqliteStore(file);
import {scoreCandidate,CSP} from '../shared/core.js';
import * as wf from '../shared/workflow.js';
import * as tasks from '../shared/tasks.js';
import * as agent from './agent.js';
import * as notifications from './notifications.js';
import {aiEnabled,aiModel,aiProvider,makeDraft} from './ai.js';
import {startScheduler,startRetention} from './scheduler.js';
import {queueGroupRun,markInterrupted} from './coordination.js';
import {createQueue,recoverQueue,defaultHandlers} from './queue.js';
import {Auth,DEFAULT_WORKSPACE as DEFAULT_WORKSPACE_ID} from './auth.js';
import {fail,send,cookie,checkOrigin,rawBody,safeJson,SECURITY,HSTS_ENABLED} from './http.js';
import {createRouter,isReply,allows} from './router.js';
import {publicRoutes} from './routes-public.js';
import {workflowRoutes} from './routes-workflow.js';
import {groupRoutes} from './routes-groups.js';
import {accountRoutes} from './routes-account.js';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const PUBLIC=path.join(ROOT,'shared');
// The /api/health version is the package version, not a literal, so a release
// bump cannot drift away from the health endpoint.
const VERSION=JSON.parse(await fs.readFile(path.join(ROOT,'package.json'),'utf8')).version;
const PORT=Number(process.env.PORT||4173);
const HOST=process.env.HOST||'127.0.0.1';
const STORE_PATH=process.env.DATA_FILE||path.join(ROOT,'data','state.json');
const PASSWORD=process.env.DASHBOARD_PASSWORD||crypto.randomBytes(12).toString('base64url');
const store=await openStore(STORE_PATH);
await store.update(s=>{wf.migrate(s);wf.recoverInterrupted(s);});
await markInterrupted(store);
const stopScheduler=startScheduler(store);
const stopRetention=startRetention(store);
// First boot bootstraps the owner account from DASHBOARD_PASSWORD; afterwards
// sessions, resets and roles live in the database.
const auth=new Auth(store);
auth.ensureBootstrap(PASSWORD);
await recoverQueue(store);
// Tasks orphaned by a disconnected agent are re-armed at boot rather
// than left leased to a process that no longer exists.
const recoveredAgentTasks=agent.recoverAgentTasks(store);
if(recoveredAgentTasks)console.log(`Re-armed ${recoveredAgentTasks} agent task(s) from a previous run.`);
// Paired-agent secrets are encrypted with this key; MASTER_KEY overrides the
// auto-generated keyfile that lives with the data directory.
agent.attachVault(store,STORE_PATH);
// Task kinds map to handlers here rather than inside the queue module, so the
// worker stays independent of the server surface it drives.
// Notifications enqueue themselves as queue tasks, so the enqueue hook is
// filled in once the queue exists (handlers are registered before start()).
let enqueueNotification=()=>{};
const notify=(event)=>notifications.notify(store,enqueueNotification,{workspaceId:DEFAULT_WORKSPACE_ID,userId:null,...event});
const queue=createQueue(store,{
  ...defaultHandlers(store,notify),  'candidate-draft': async task=>processCandidate(task.payload.candidateId),
  'group-run': async task=>{ await queueGroupRun(store,{groupId:task.payload.groupId,message:task.payload.message,directBotId:task.payload.directBotId}); },
  'agent-job': async task=>{
    // Dispatch to a paired local agent: enqueue an agent task for each agent
    // that holds the required permission. The queue's idempotency and the
    // agent-side lease make exactly-once practical without claiming more than
    // the protocol can prove.
    const kind=task.payload.action;
    const agents=store.all("SELECT id,permissions FROM agents WHERE revoked_at IS NULL").map(a=>({id:a.id,permissions:JSON.parse(a.permissions||'[]')}))
      .filter(a=>!task.payload.agentId||a.id===task.payload.agentId)
      .filter(a=>a.permissions.includes(kind));
    if(!agents.length)throw new Error('No paired local agent holds the permission this job needs.');
    for(const a of agents){
      agent.enqueueAgentTask(store,a.id,{kind,payload:task.payload.params||{},idempotencyKey:`job:${task.id}:${a.id}`,createdBy:task.createdBy});
    }
    return {dispatchedTo:agents.map(a=>a.id)};
  },
  'notification': async task=>{
    const result=await notifications.deliver(store,task);
    store.run('UPDATE notifications SET status=?, sent_at=? WHERE id=?','sent',new Date().toISOString(),task.payload.notificationId);
    return result;
  },
},{onFail:(task,error)=>Promise.resolve(notify({title:'A background task failed',body:`${task.title}: ${error.message}`,kind:'task-failure',meta:{taskId:task.id}}))});
// The queue exists now, so notifications can enqueue themselves as delivery
// tasks. Handlers above captured this closure, not a started loop.
enqueueNotification=(s,spec)=>s.update(st=>{tasks.enqueueTask(st,spec);}).catch(error=>console.error('Notification enqueue:',error.message));
const stopQueue=queue.start();
if(store.recoveredFrom)console.warn(`WARNING: ${STORE_PATH} was unreadable and has been moved to ${store.recoveredFrom}. A fresh state was created.`);
const TYPES={'html':'text/html; charset=utf-8','js':'text/javascript; charset=utf-8','css':'text/css; charset=utf-8','svg':'image/svg+xml','png':'image/png','ico':'image/x-icon'};
const isLive=()=>aiEnabled();
/** Shared by the HTTP route and the queue worker: score a candidate and
 * produce a draft, releasing the candidate if anything fails so a transient
 * provider error never strands it. */
async function processCandidate(id){
  const context=await store.update(s=>wf.beginProcessing(s,id));
  try{
    const evaluation=scoreCandidate(context.candidate,context.settings.topics);
    const result=await makeDraft(context.candidate,context.settings);
    return await store.update(s=>wf.finishProcessing(s,id,evaluation,result));
  } catch(e){
    await store.update(s=>wf.failProcessing(s,id,e.message));
    throw e;
  }
}

// Every API route lives in a route module and is registered with the access it
// needs (see src/router.js). This file only wires them to the running services.
const router=createRouter();
const app={store,auth,processCandidate,version:VERSION,workspaceId:DEFAULT_WORKSPACE_ID};
publicRoutes(router,app);
workflowRoutes(router,app);
groupRoutes(router,app);
accountRoutes(router,app);

async function api(req,res,u){
  const found=router.find(req.method,u.pathname),access=found?.route.access;
  let actor=null;
  // A session is checked before the route is, so an anonymous caller learns
  // nothing about which paths exist. Then the route's declared role applies,
  // before the body is read.
  if(access!=='public'&&access!=='agent'){
    actor=auth.session(cookie(req,'agent_session'));
    if(!actor)fail('Sign in first.',401);
    if(!found)fail('Unknown endpoint.',404);
    if(!allows(actor.role,access))fail(`This action needs the ${access} role or higher.`,403);
  }
  // Bodies are read on demand: a handler that rate-limits or verifies a
  // signature does so before any JSON is parsed.
  let raw,parsed;
  const context={req,path:u.pathname,params:found.params,actor,
    raw:async()=>raw??=await rawBody(req),
    body:async()=>parsed??=safeJson(await rawBody(req,128*1024))};
  const result=await found.route.handler(context);
  const {status,body,headers}=isReply(result)?result:{status:200,body:result,headers:{}};
  if(req.method==='HEAD'){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...SECURITY,...headers});return res.end();}
  send(res,status,body,headers);
}
const ASSETS=new Set(['index.html','app.css','transport.js','local-api.js','app.js','ui-kit.js','ui-model.js','ui-store.js','ui-dialogs.js','ui-chat.js','ui-views.js','ui-panel.js','ui-sheets.js','ui-admin.js','ui-actions.js','ui-fx.js','core.js','workflow.js','tasks.js','evidence.js','contracts.js','retention.js','coordination.js','chats.js','group-simulator.js','chat-engine.js','usability.js','demo-feed.html']);
async function serve(req,res,u){
  let rel=u.pathname==='/'?'index.html':u.pathname.slice(1);
  if(!ASSETS.has(rel))return send(res,404,{error:'Not found'});
  try {const body=await fs.readFile(path.join(PUBLIC,rel));res.writeHead(200,{'Content-Type':TYPES[rel.split('.').pop()]||'application/octet-stream','Content-Security-Policy':CSP,...SECURITY,'Cache-Control':'no-store'});res.end(req.method==='HEAD'?undefined:body);}catch{return send(res,404,{error:'Missing asset'});}
}
const handler=async(req,res)=>{
  try{
    const host=req.headers.host||'localhost';const url=new URL(req.url,`http://${host}`);
    checkOrigin(req);
    if(url.pathname.startsWith('/api/'))await api(req,res,url);
    else if(req.method==='GET'||req.method==='HEAD')await serve(req,res,url);
    else fail('Method not allowed.',405);
  }catch(e){let status=e.status||500;console.error(status===500?'Server error: '+e.message:'');if(res.headersSent){res.end();return;}send(res,status,{error:status===500?'Internal server error':e.message});}
};
// Optional in-process TLS. A reverse proxy is still the recommended front for
// a real deployment; this exists so a private single-host install can serve
// HTTPS without one. `req.socket.encrypted` drives the Secure cookie flag.
const TLS={cert:process.env.TLS_CERT,key:process.env.TLS_KEY};
let server;
if(TLS.cert||TLS.key){
  if(!TLS.cert||!TLS.key)throw new Error('TLS_CERT and TLS_KEY must be set together. Remove both to serve plain HTTP (local use only).');
  let cert,key;
  try{cert=await fs.readFile(TLS.cert);key=await fs.readFile(TLS.key);}
  catch(e){throw new Error(`TLS_CERT/TLS_KEY could not be read: ${e.message}`);}
  server=https.createServer({cert,key},handler);
  console.log(`TLS: serving HTTPS from ${TLS.cert}`);
}else server=http.createServer(handler);
// Fail loudly on a misconfiguration that would silently weaken security, and
// warn about the rest; every check is about the deployment, not the app logic.
function preflight(){
  const origin=process.env.PUBLIC_ORIGIN||'';
  if(origin&&!/^https?:\/\//.test(origin))throw new Error('PUBLIC_ORIGIN must be an absolute http(s) URL, e.g. https://dash.example.com');
  if(HSTS_ENABLED&&!origin.startsWith('https://'))console.warn('config: HSTS is on but PUBLIC_ORIGIN is not https. Only enable it behind TLS termination.');
  if(!process.env.DASHBOARD_PASSWORD)console.warn('config: no DASHBOARD_PASSWORD set. A random password is printed each boot; set one for a stable login.');
  if(HOST!=='127.0.0.1'&&HOST!=='localhost'&&!origin.startsWith('https://'))console.warn('config: binding to '+HOST+' without HTTPS. Put TLS in front (reverse proxy).');
}
preflight();
server.listen(PORT,HOST,()=>{
  console.log(`\nAgent Control Prototype: http${server instanceof https.Server?'s':''}://${HOST}:${PORT}`);
  if(!process.env.DASHBOARD_PASSWORD) console.log(`Temporary dashboard password (changes on restart): ${PASSWORD}`);
  console.log(`AI mode: ${isLive()?`Connected · ${aiModel()} @ ${aiProvider()}`:'Template drafts (no AI provider configured)'}`);
  if(HOST!=='127.0.0.1'&&HOST!=='localhost')console.warn('WARNING: Use HTTPS plus a private network / access proxy for remote access.');
});
process.on('SIGINT',()=>{stopQueue();stopScheduler();stopRetention();server.close(()=>process.exit(0));});
