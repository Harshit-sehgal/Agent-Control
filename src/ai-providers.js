/** Bring-your-own-key AI providers.
 *
 * A workspace saves one or more providers (an OpenAI-compatible base URL plus an
 * API key). Only metadata lives in the state document (`state.ai`); the key is
 * stored encrypted by the credential vault and referenced by `credentialId`. A
 * workspace picks a default provider + model, and any bot may override either,
 * so different bots can run on different models the way Grok/Open Agents tiles do.
 */
import * as credentials from './credentials.js';
import {envConfig,listModels,inferStyle,configReady} from './ai.js';
import {uuid} from '../shared/core.js';

const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
const clean=(v,n)=>String(v??'').trim().slice(0,n);
const validBase=u=>{try{const x=new URL(u);return (x.protocol==='http:'||x.protocol==='https:')&&!x.username&&!x.password&&!x.search&&!x.hash;}catch{return false;}};
const hostOf=u=>{try{return new URL(u).host;}catch{return '';}};
/** Admin listings keep the endpoint path, but strip userinfo, query and hash. */
function safeBase(u){try{const x=new URL(String(u||''));x.username='';x.password='';x.search='';x.hash='';return x.href.replace(/\/+$/,'');}catch{return '';}}

/** Ensure the AI shape exists on a state document. */
export function aiState(state){
  state.ai??={providers:[],defaultProviderId:null,defaultModel:null,bots:{}};
  if(!Array.isArray(state.ai.providers))state.ai.providers=[];
  if(!state.ai.bots||typeof state.ai.bots!=='object')state.ai.bots={};
  return state.ai;
}
// The base URL may contain a secret path segment. The browser only needs the
// host for display, so never return the full URL in public provider metadata.
const publicProvider=p=>({id:p.id,label:p.label,style:p.style,host:hostOf(p.baseUrl),createdAt:p.createdAt,createdBy:p.createdBy||null});
const providerListing=p=>({...publicProvider(p),baseUrl:safeBase(p.baseUrl)});
function publicBots(bots){
  const out={};
  if(!bots||typeof bots!=='object')return out;
  for(const [id,override] of Object.entries(bots)){
    if(!override||typeof override!=='object'||Array.isArray(override))continue;
    const providerId=override.providerId||null,model=override.model||null;
    if(providerId||model)out[id]={providerId,model};
  }
  return out;
}
/** Provider metadata safe to send to the browser. No key, no vault id. */
export function publicAi(state){
  const ai=aiState(state);
  return {providers:ai.providers.map(publicProvider),defaultProviderId:ai.defaultProviderId,defaultModel:ai.defaultModel||null,bots:publicBots(ai.bots)};
}

export function listProviders(state){
  const ai=aiState(state);
  return {providers:ai.providers.map(providerListing),defaultProviderId:ai.defaultProviderId,defaultModel:ai.defaultModel||null};
}

/** Add a BYOK provider. The key is written to the vault, never to the state. */
export async function addProvider(store,workspaceId,{label,baseUrl,apiKey,style,createdBy}={}){
  const name=clean(label,80);const url=clean(baseUrl,300).replace(/\/+$/,'');const key=String(apiKey||'').trim();
  if(!name)fail('Give the provider a name (e.g. OpenAI, Groq, my router).');
  if(!validBase(url))fail('Base URL must be an absolute http(s) URL without a username, password, query, or hash.');
  if(!key)fail('Paste the API key for this provider.');
  const resolvedStyle=style==='responses'?'responses':style==='chat'?'chat':inferStyle(url);
  const credential=credentials.addCredential(store,workspaceId,{name:`AI key · ${name}`,kind:'ai_provider',value:key,createdBy});
  const provider={id:uuid(),label:name,baseUrl:url,style:resolvedStyle,credentialId:credential.id,createdBy:createdBy||null,createdAt:new Date().toISOString()};
  await store.update(s=>{const ai=aiState(s);ai.providers.unshift(provider);if(!ai.defaultProviderId)ai.defaultProviderId=provider.id;});
  return providerListing(provider);
}

export async function deleteProvider(store,workspaceId,id){
  const provider=store.read().ai?.providers?.find(p=>p.id===id);
  if(!provider)fail('Provider not found.',404);
  if(provider.credentialId){try{credentials.deleteCredential(store,workspaceId,provider.credentialId);}catch(error){if(error.status!==404)throw error;}}
  await store.update(s=>{const ai=aiState(s);ai.providers=ai.providers.filter(p=>p.id!==id);if(ai.defaultProviderId===id)ai.defaultProviderId=ai.providers[0]?.id||null;
    for(const [botId,override] of Object.entries(ai.bots)){
      if(override?.providerId!==id)continue;
      const model=override.model||null;
      if(!model)delete ai.bots[botId];else ai.bots[botId]={providerId:null,model};
    }
  });
  return {ok:true};
}

/** Resolve a saved provider to a ready config (decrypts its key). */
export function providerConfig(store,provider){
  const apiKey=credentials.revealValue(store,provider.credentialId);
  return {baseUrl:provider.baseUrl,apiKey,model:'auto',style:provider.style||inferStyle(provider.baseUrl),source:'byok',label:provider.label,providerId:provider.id};
}

/** The config a bot should run on: its own override, else the workspace default,
 * else the environment. `null` when nothing is configured. */
export function resolveConfig(store,botId){
  const state=store.read();const ai=aiState(state);
  const override=botId?ai.bots[botId]:null;
  // A pin whose provider was deleted must fall through to the workspace
  // default. Skipping that sent the bot to the environment key, or to the
  // template path while a saved provider was still configured.
  const pinned=override?.providerId&&ai.providers.some(p=>p.id===override.providerId)?override.providerId:null;
  const providerId=pinned||ai.defaultProviderId;
  const provider=ai.providers.find(p=>p.id===providerId);
  if(provider){
    const config=providerConfig(store,provider);
    return {...config,model:override?.model||ai.defaultModel||'auto'};
  }
  const env=envConfig();
  if(configReady(env))return {...env,model:override?.model||ai.defaultModel||env.model};
  return null;
}

export async function setDefaults(store,{providerId,model}={}){
  await store.update(s=>{const ai=aiState(s);
    if(providerId!==undefined){if(providerId&&!ai.providers.some(p=>p.id===providerId))throw fail('Provider not found.',404);ai.defaultProviderId=providerId||null;}
    if(model!==undefined)ai.defaultModel=clean(model,120)||null;
  });
  return listProviders(store.read());
}

export async function setBotModel(store,botId,{providerId,model}={}){
  if(!botId)fail('Missing bot id.');
  // The override is keyed by bot id, so a typo or a stale id must be rejected
  // instead of writing an override nothing will ever read.
  const existing=store.read();
  if(!(existing.groups||[]).some(group=>(group.bots||[]).some(bot=>bot.id===botId)))fail('Bot not found.',404);
  await store.update(s=>{const ai=aiState(s);const next={...(ai.bots[botId]||{})};
    if(providerId!==undefined){if(providerId&&!ai.providers.some(p=>p.id===providerId))throw fail('Provider not found.',404);next.providerId=providerId||null;}
    if(model!==undefined)next.model=clean(model,120);
    if(!next.providerId&&!next.model)delete ai.bots[botId];else ai.bots[botId]=next;
  });
  const stored=store.read().ai.bots[botId]||null;
  return {botId,model:stored?.model||null,providerId:stored?.providerId||null};
}

export async function modelsForProvider(store,providerId){
  const provider=store.read().ai?.providers?.find(p=>p.id===providerId);
  if(!provider)fail('Provider not found.',404);
  return listModels(providerConfig(store,provider));
}

/** True when the environment or a saved provider can run a model. */
export function aiAvailable(store){
  if(configReady(envConfig()))return true;
  return Boolean(store.read().ai?.providers?.length);
}
