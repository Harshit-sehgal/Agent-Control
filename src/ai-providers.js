/** Bring-your-own-key AI providers.
 *
 * A workspace saves one or more providers (an OpenAI-compatible base URL plus an
 * API key). Only metadata lives in the state document (`state.ai`); the key and
 * any custom header values are stored encrypted by the credential vault and
 * referenced by id, so a record can never be read for a secret. A workspace
 * picks a default provider + model, and any bot may override either, so
 * different bots can run on different models the way Grok/Open Agents tiles do.
 */
import * as credentials from './credentials.js';
import {envConfig,discoverModels,protocolOf,configReady,complete} from './ai.js';
import {normaliseProtocol,inferProtocol,presetById,protocolById} from '../shared/ai-presets.js';
import {uuid} from '../shared/core.js';

const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
const clean=(v,n)=>String(v??'').trim().slice(0,n);
const validBase=u=>{try{const x=new URL(u);return (x.protocol==='http:'||x.protocol==='https:')&&!x.username&&!x.password&&!x.search&&!x.hash;}catch{return false;}};
const hostOf=u=>{try{return new URL(u).host;}catch{return '';}};
/** Admin listings keep the endpoint path, but strip userinfo, query and hash. */
function safeBase(u){try{const x=new URL(String(u||''));x.username='';x.password='';x.search='';x.hash='';return x.href.replace(/\/+$/,'');}catch{return '';}}

// --- per-provider request extras -------------------------------------------
// A gateway may want a header of its own (a beta flag, a router's attribution,
// an org id) and Azure wants an api-version in the query. The names are safe to
// list; the values are a secret, so they never touch the provider record.
const HEADER_NAME=/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;
const MAX_HEADERS=8;
const capList=(list,n)=>Array.isArray(list)?list.slice(0,n):[];
const sameJson=o=>JSON.stringify(Object.keys(o||{}).sort().map(k=>[k,o[k]]));
/** Azure versions look like 2024-10-21. Any protocol's value is sliced to 24
 * characters and stripped of URL-meaningful punctuation, because it is
 * interpolated into a query string; a blank one is `null` (the default). */
function cleanApiVersion(value){
  if(value===undefined)return undefined;
  return clean(value,24).replace(/[^A-Za-z0-9._~-]/g,'')||null;
}
/** Validate a custom header set. Strict on purpose: a header value is written to
 * the wire on every call, so a stray CR/LF would let it split the request. */
function cleanHeaders(headers){
  // `null` is treated as absent, so a form that omits the field cannot wipe a
  // saved set by accident; `{}` is the explicit clear.
  if(headers===undefined||headers===null)return undefined;
  if(typeof headers!=='object'||Array.isArray(headers))fail('Custom headers must be an object of header name to value.');
  const out={};const entries=Object.entries(headers);
  if(entries.length>MAX_HEADERS)fail(`Use at most ${MAX_HEADERS} custom headers.`);
  for(const [rawName,value] of entries){
    const name=String(rawName??'').trim();
    if(!HEADER_NAME.test(name))fail(`"${clean(name,80)}" is not a valid header name. Letters, digits and !#$%&'*+.^_\`|~- only, up to 64 characters.`);
    if(typeof value!=='string')fail(`Header "${name}" needs a text value.`);
    if(!value||value.length>2000)fail(`Header "${name}" needs a value of 1 to 2000 characters.`);
    if(/[\r\n]/.test(value))fail(`Header "${name}" must not contain a line break.`);
    out[name]=value;
  }
  return out;
}
/** Header values ride in the vault as one JSON credential (addCredential takes a
 * string, so the object is stringified here and parsed back in providerConfig),
 * and the record only keeps the credential id plus the names. */
function writeHeaders(store,workspaceId,{label,createdBy,existingId,headers}){
  const value=JSON.stringify(headers);
  if(existingId){
    try{credentials.replaceCredential(store,workspaceId,existingId,value);return existingId;}
    catch(error){if(error.status!==404)throw error;}
  }
  return credentials.addCredential(store,workspaceId,{name:`AI headers · ${label}`,kind:'ai_headers',value,createdBy}).id;
}
/** The decrypted header set, or `{}` when the credential was deleted by hand:
 * a missing set must not stop a bot from answering. */
function readHeaders(store,provider){
  if(!provider?.headersCredentialId)return {};
  let raw;
  try{raw=credentials.revealValue(store,provider.headersCredentialId);}
  catch(error){if(error.status===404)return {};throw error;}
  try{const parsed=JSON.parse(raw);return parsed&&typeof parsed==='object'&&!Array.isArray(parsed)?parsed:{};}catch{return {};}
}
const headerNamesOf=p=>capList(p?.headerNames,MAX_HEADERS).filter(name=>typeof name==='string');
const labelsOf=p=>p?.labels&&typeof p.labels==='object'&&!Array.isArray(p.labels)?p.labels:{};

/** Ensure the AI shape exists on a state document. */
export function aiState(state){
  state.ai??={providers:[],defaultProviderId:null,defaultModel:null,bots:{}};
  if(!Array.isArray(state.ai.providers))state.ai.providers=[];
  if(!state.ai.bots||typeof state.ai.bots!=='object')state.ai.bots={};
  return state.ai;
}
/** A saved provider may predate `protocol` (it carried the old `style`
 * shorthand), so resolve it the same way the call path does. */
const protocolOfProvider=p=>protocolOf({protocol:p?.protocol,style:p?.style,baseUrl:p?.baseUrl});
const modelCount=p=>Array.isArray(p?.models)?p.models.length:0;
// The base URL may contain a secret path segment. The browser only needs the
// host for display, so never return the full URL in public provider metadata.
const publicProvider=p=>({id:p.id,label:p.label,protocol:protocolOfProvider(p),host:hostOf(p.baseUrl),modelCount:modelCount(p),createdAt:p.createdAt,createdBy:p.createdBy||null});
/** The settings page gets the full picture: the endpoint, both model lists, the
 * friendly labels, the Azure version and the header NAMES. Values stay in the
 * vault, so even this listing cannot leak one. */
const providerListing=p=>({...publicProvider(p),baseUrl:safeBase(p.baseUrl),models:Array.isArray(p.models)?p.models:[],chatModels:capList(p.chatModels||p.models,300),allModels:capList(p.allModels||p.models,2000),labels:labelsOf(p),apiVersion:p.apiVersion||null,hasHeaders:headerNamesOf(p),modelsAt:p.modelsAt||null,modelsError:p.modelsError||null,keyOptional:Boolean(p.keyOptional)});
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

/** Add a BYOK provider. The key is written to the vault, never to the state.
 * The key is used immediately to read the provider's own model catalogue, so
 * the picker reflects that key's plan instead of a hard-coded list. A failed
 * catalogue is recorded, not fatal: the provider still saves. */
export async function addProvider(store,workspaceId,{label,baseUrl,apiKey,style,protocol,preset,apiVersion,headers,createdBy}={}){
  const name=clean(label,80);const url=clean(baseUrl,300).replace(/\/+$/,'');const key=String(apiKey||'').trim();
  const chosen=normaliseProtocol(protocol)||normaliseProtocol(style)||normaliseProtocol(presetById(preset)?.protocol)||inferProtocol(url);
  if(!name)fail('Give the provider a name (e.g. OpenAI, Groq, my router).');
  if(!validBase(url))fail('Base URL must be an absolute http(s) URL without a username, password, query, or hash.');
  if(!key)fail('Paste the API key for this provider.');
  if(!protocolById(chosen))fail('Unknown API protocol.');
  // Validate the headers before anything is written, so a rejected set cannot
  // leave an orphan key credential behind.
  const extra=cleanHeaders(headers)||{};
  const credential=credentials.addCredential(store,workspaceId,{name:`AI key · ${name}`,kind:'ai_provider',value:key,createdBy});
  const provider={id:uuid(),label:name,baseUrl:url,protocol:chosen,apiVersion:cleanApiVersion(apiVersion)??null,keyOptional:Boolean(presetById(preset)?.keyOptional),credentialId:credential.id,headersCredentialId:null,headerNames:[],createdBy:createdBy||null,createdAt:new Date().toISOString()};
  if(Object.keys(extra).length){
    provider.headersCredentialId=writeHeaders(store,workspaceId,{label:name,createdBy,headers:extra});
    provider.headerNames=Object.keys(extra).sort();
  }
  await store.update(s=>{const ai=aiState(s);ai.providers.unshift(provider);if(!ai.defaultProviderId)ai.defaultProviderId=provider.id;});
  return listingOf(store,provider.id);
}

/** Every provider with its cached model ids, for the settings page. Only an
 * admin gets this: the endpoint path may itself carry a secret for a custom
 * gateway. */
export function listProviderListings(store){
  const ai=aiState(store.read());
  return {providers:ai.providers.map(p=>({...providerListing(p),models:(Array.isArray(p.models)?p.models:[]).slice(0,300)})),defaultProviderId:ai.defaultProviderId||null,defaultModel:ai.defaultModel||null,bots:ai.bots||{}};
}

/** One provider as the admin page sees it, or null. */
export function getProvider(store,id){
  const provider=store.read().ai?.providers?.find(p=>p.id===id);
  return provider?providerListing(provider):null;
}
const listingOf=(store,id)=>getProvider(store,id)||{id};

/** Change a saved provider, optionally rotating its key, and re-read the
 * catalogue: the models that key can use change with the key or the endpoint. */
export async function updateProvider(store,workspaceId,id,{label,baseUrl,apiKey,protocol,style,preset,apiVersion,headers}={}){
  const current=store.read().ai?.providers?.find(p=>p.id===id);
  if(!current)fail('Provider not found.',404);
  const name=label===undefined?current.label:clean(label,80);
  const url=baseUrl===undefined?current.baseUrl:clean(baseUrl,300).replace(/\/+$/,'');
  // `style` is the pre-protocol field; still honoured so an older client edits.
  const chosen=normaliseProtocol(protocol)||normaliseProtocol(style)||normaliseProtocol(presetById(preset)?.protocol)||protocolOfProvider(current);
  const key=typeof apiKey==='string'?apiKey.trim():'';
  if(!name)fail('Give the provider a name (e.g. OpenAI, Groq, my router).');
  if(!validBase(url))fail('Base URL must be an absolute http(s) URL without a username, password, query, or hash.');
  if(!protocolById(chosen))fail('Unknown API protocol.');
  // `headers === undefined` keeps what is saved (a blank key keeps the key, so a
  // blank header set keeps the headers); `{}` clears them.
  const extra=cleanHeaders(headers);
  const nextVersion=apiVersion===undefined?(current.apiVersion||null):cleanApiVersion(apiVersion);
  const versionChanged=nextVersion!==(current.apiVersion||null);
  const changedKey=Boolean(key);
  const headersChanged=extra!==undefined&&sameJson(readHeaders(store,current))!==sameJson(extra);
  let credentialId=current.credentialId;
  if(changedKey){
    if(credentialId){credentials.replaceCredential(store,workspaceId,credentialId,key);}
    else credentialId=credentials.addCredential(store,workspaceId,{name:`AI key · ${name}`,kind:'ai_provider',value:key,createdBy:current.createdBy}).id;
  }
  let headersCredentialId=current.headersCredentialId||null;
  let headerNames=headerNamesOf(current);
  if(headersChanged){
    if(Object.keys(extra).length){
      // Replace in place: the id on the record stays valid, so nothing dangles.
      headersCredentialId=writeHeaders(store,workspaceId,{label:name,createdBy:current.createdBy,existingId:headersCredentialId,headers:extra});
      headerNames=Object.keys(extra).sort();
    }else{
      if(headersCredentialId){try{credentials.deleteCredential(store,workspaceId,headersCredentialId);}catch(error){if(error.status!==404)throw error;}}
      headersCredentialId=null;headerNames=[];
    }
  }
  // Headers and the Azure version shape the request, so they invalidate the
  // catalogue the same way a new endpoint or key does.
  const endpointChanged=url!==current.baseUrl||chosen!==protocolOfProvider(current)||changedKey||headersChanged||versionChanged;
  await store.update(s=>{const ai=aiState(s);const p=ai.providers.find(x=>x.id===id);if(!p)return;
    p.label=name;p.baseUrl=url;p.protocol=chosen;p.credentialId=credentialId||null;
    p.apiVersion=nextVersion;p.headersCredentialId=headersCredentialId;p.headerNames=headerNames;
    if(preset!==undefined)p.keyOptional=Boolean(presetById(preset)?.keyOptional);
    if(endpointChanged){p.models=[];p.chatModels=[];p.allModels=[];p.labels={};p.modelsAt=null;p.modelsError=null;}
  });
  return {...listingOf(store,id),endpointChanged};
}

/** Read the provider's catalogue with its stored key and keep the result, so
 * the picker works without another round trip. */
export async function refreshModels(store,providerId){
  const provider=store.read().ai?.providers?.find(p=>p.id===providerId);
  if(!provider)fail('Provider not found.',404);
  const at=new Date().toISOString();
  try{
    const found=await discoverModels(providerConfig(store,provider));
    // Keep the split the caller returned: `models`/`chatModels` are the
    // chat-capable subset the picker offers, `allModels` everything the key can
    // see, and `labels` the provider's own friendly names for both.
    const chatModels=capList(found.models,2000);
    const allModels=capList(found.allModels||found.models,2000);
    const labels=labelsOf(found);
    await store.update(s=>{const p=aiState(s).providers.find(x=>x.id===providerId);if(!p)return;p.models=chatModels;p.chatModels=chatModels;p.allModels=allModels;p.labels=labels;p.modelsAt=at;p.modelsError=null;});
    return {models:chatModels,chatModels,allModels,labels,protocol:found.protocol,at};
  }catch(error){
    // Keep the last good catalogue: a transient failure should cost the picker
    // its freshness, not every bot its model (Anthropic and Gemini have no
    // "auto", so an empty list would break drafting too).
    await store.update(s=>{const p=aiState(s).providers.find(x=>x.id===providerId);if(!p)return;p.modelsAt=at;p.modelsError=String(error.message||'Could not read the model list.').slice(0,300);});
    throw error;
  }
}

export async function deleteProvider(store,workspaceId,id){
  const provider=store.read().ai?.providers?.find(p=>p.id===id);
  if(!provider)fail('Provider not found.',404);
  // The key and any custom header values are two vault rows; both go with the
  // provider. A row someone already deleted by hand is not an error.
  for(const credentialId of [provider.credentialId,provider.headersCredentialId]){
    if(!credentialId)continue;
    try{credentials.deleteCredential(store,workspaceId,credentialId);}catch(error){if(error.status!==404)throw error;}
  }
  await store.update(s=>{const ai=aiState(s);ai.providers=ai.providers.filter(p=>p.id!==id);if(ai.defaultProviderId===id)ai.defaultProviderId=ai.providers[0]?.id||null;
    for(const [botId,override] of Object.entries(ai.bots)){
      if(override?.providerId!==id)continue;
      const model=override.model||null;
      if(!model)delete ai.bots[botId];else ai.bots[botId]={providerId:null,model};
    }
  });
  return {ok:true};
}

/** Resolve a saved provider to a ready config (decrypts its key and headers). */
export function providerConfig(store,provider){
  const apiKey=credentials.revealValue(store,provider.credentialId);
  const protocol=protocolOfProvider(provider);
  return {baseUrl:provider.baseUrl,apiKey,model:'auto',protocol,style:protocol==='openai-responses'?'responses':'chat',apiVersion:provider.apiVersion||null,headers:readHeaders(store,provider),source:'byok',label:provider.label,providerId:provider.id,models:Array.isArray(provider.models)?provider.models:[]};
}
/** A provider that needs the model id in the URL or body cannot run "auto".
 * Fall back to the first model its catalogue reported, so a fresh workspace
 * works before anyone opens the picker. */
function concreteModel(protocol,model,chatModels,allModels){
  if(model&&model!=='auto')return model;
  if(protocol==='anthropic'||protocol==='gemini'||protocol==='azure-openai')return chatModels?.[0]||allModels?.[0]||'auto';
  return model||'auto';
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
    const chosen=override?.model||ai.defaultModel||'auto';
    const chatModels=Array.isArray(provider.chatModels)?provider.chatModels:config.models;
    return {...config,model:concreteModel(config.protocol,chosen,chatModels,config.models)};
  }
  const env=envConfig();
  if(configReady(env))return {...env,model:override?.model||ai.defaultModel||env.model};
  return null;
}

/** One real round trip against a saved provider, so the settings page can say
 * "this key works" instead of guessing from a catalogue read. The model pick is
 * the caller's, else the same fallback resolveConfig uses. */
export async function testProvider(store,providerId,{model}={}){
  const provider=store.read().ai?.providers?.find(p=>p.id===providerId);
  if(!provider)fail('Provider not found.',404);
  const config=providerConfig(store,provider);
  const pick=clean(model,120)||concreteModel(config.protocol,'auto',Array.isArray(provider.chatModels)?provider.chatModels:config.models,config.models);
  const started=Date.now();
  try{
    const reply=await complete({instructions:'You are a connectivity check. Reply with the single word OK.',input:'ping',maxTokens:16,config:{...config,model:pick}});
    return {ok:true,model:pick,reply:String(reply??'').slice(0,300),ms:Date.now()-started};
  }catch(error){
    // src/ai.js already redacted the key and named the usual fix; pass its own
    // words through (with its status) instead of a generic failure.
    throw fail(String(error?.message||'The provider did not answer.'),error?.status||400);
  }
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
  return refreshModels(store,providerId);
}

/** True when the environment or a saved provider can run a model. */
export function aiAvailable(store){
  if(configReady(envConfig()))return true;
  return Boolean(store.read().ai?.providers?.length);
}
