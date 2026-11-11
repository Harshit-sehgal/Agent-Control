import './env.js'; // load .env before anything reads process.env
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import crypto from 'node:crypto';
import {openStore as openSqliteStore} from './sqlite-store.js';
import {HSTS_ENABLED} from './http.js';
import {aiEnabled,aiModel,aiProvider} from './ai.js';
import {smtpConfig} from './mail.js';
import {Auth} from './auth.js';
import {openWorkspaces} from './workspaces.js';
import {createPush} from './push.js';
import {browserRuntime} from './browser-runtime.js';
import {browserLive} from './browser-live.js';
import * as agent from './agent.js';
import {createApp,createWorkspaceStarter} from './app.js';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
// The /api/health version is the package version, not a literal, so a release
// bump cannot drift away from the health endpoint.
const VERSION=JSON.parse(await fs.readFile(path.join(ROOT,'package.json'),'utf8')).version;
const PORT=Number(process.env.PORT||4173);
const HOST=process.env.HOST||'127.0.0.1';
const STORE_PATH=process.env.DATA_FILE||path.join(ROOT,'data','state.json');
const PASSWORD=process.env.DASHBOARD_PASSWORD||crypto.randomBytes(12).toString('base64url');
const store=await openSqliteStore(STORE_PATH);
// First boot bootstraps the owner account from DASHBOARD_PASSWORD; afterwards
// sessions, resets and roles live in the database.
const auth=new Auth(store);
auth.ensureBootstrap(PASSWORD);
// Paired-agent secrets are encrypted with this key; MASTER_KEY overrides the
// auto-generated keyfile that lives with the data directory.
agent.attachVault(store,STORE_PATH);
const push=createPush(store);
const isLive=()=>aiEnabled();

// `app.js` owns the dispatcher and the per-workspace services; this file only
// opens the database, wires the real services in, and listens. See src/app.js
// for why the seam exists.
const startWorkspace=createWorkspaceStarter({auth,push});
const workspaces=await openWorkspaces(store,auth,startWorkspace);
if(store.recoveredFrom)console.warn(`WARNING: ${STORE_PATH} was unreadable and has been moved to ${store.recoveredFrom}. A fresh state was created.`);
const {handler}=createApp({store,auth,workspaces,push,version:VERSION});

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
  // A mailbox typo should surface at boot, not on the first reminder: an
  // impossible value throws here, and a risky one is only warned about.
  const mail=smtpConfig();
  if(mail){
    if(!mail.requireTls&&!mail.secure)console.warn('config: SMTP_REQUIRE_TLS=0, so mail may be submitted in cleartext. Only do that for a relay on your own network.');
    if(!mail.from)console.warn('config: SMTP_HOST is set without SMTP_FROM or SMTP_USER, so there is no sender address.');
    if(mail.user&&!mail.pass)console.warn('config: SMTP_USER is set without SMTP_PASS; AUTH will fail.');
  }
}
preflight();
server.listen(PORT,HOST,()=>{
  console.log(`\nAgent Control Prototype: http${server instanceof https.Server?'s':''}://${HOST}:${PORT}`);
  if(!process.env.DASHBOARD_PASSWORD) console.log(`Temporary dashboard password (changes on restart): ${PASSWORD}`);
  console.log(`AI mode: ${isLive()?`Connected · ${aiModel()} @ ${aiProvider()}`:'No AI_API_KEY in the environment. Add a provider under You → AI and models, or set AI_API_KEY.'}`);
  if(HOST!=='127.0.0.1'&&HOST!=='localhost')console.warn('WARNING: Use HTTPS plus a private network / access proxy for remote access.');
});
// A server-side browser is a child process: leave it behind and a container
// restart keeps an orphan holding memory. Closing it is part of the drain.
const drain=()=>Promise.allSettled([workspaces.stop(),browserRuntime.close(),Promise.resolve(browserLive.close())]).finally(()=>server.close(()=>process.exit(0)));
process.on('SIGINT',()=>{void drain();});
// A container stops the process with SIGTERM, so it needs the same drain as
// Ctrl-C instead of being killed with requests and leases still open.
process.on('SIGTERM',()=>{void drain();});