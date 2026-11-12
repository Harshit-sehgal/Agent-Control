import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createContext,runInContext} from 'node:vm';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const source=await readFile(path.join(root,'shared/transport.js'),'utf8');

// Load transport.js with browser stubs and capture the fetch options it builds.
// `backend` drives the <meta name="agent-backend"> marker the build stamps.
function load({protocol='https:',backend='server'}={}){
  const calls=[];
  const response={ok:true,status:200,json:async()=>({ok:true})};
  const fetch=(url,options)=>{calls.push({url,options});return Promise.resolve(response);};
  const meta={getAttribute:()=>backend};
  const document={querySelector:selector=>selector.includes('agent-backend')?meta:null};
  const context={window:{AGENT_LOCAL_API:(...args)=>Promise.resolve({local:args})},location:{protocol},document,fetch,console,JSON,Promise,Error,String,Object};
  context.window.window=context.window;
  runInContext(source,createContext(context));
  return {api:context.window.AGENT_API,calls};
}

test('GET requests are sent without a body',async()=>{
  const {api,calls}=load();
  await api('/api/state','GET',{});
  assert.equal(calls[0].options.method,'GET');
  assert.equal('body' in calls[0].options,false);
});

test('a missing method defaults to bodyless GET',async()=>{
  const {api,calls}=load();
  await api('/api/state');
  assert.equal(calls[0].options.method,'GET');
  assert.equal('body' in calls[0].options,false);
});

test('POST requests keep their JSON body',async()=>{
  const {api,calls}=load();
  await api('/api/login','POST',{password:'x'});
  assert.equal(calls[0].options.method,'POST');
  assert.equal(calls[0].options.body,'{"password":"x"}');
});

test('a static build marker routes to the browser-local backend',async()=>{
  const {api,calls}=load({backend:'static'});
  const result=await api('/api/state','GET',{});
  assert.equal(calls.length,0);
  assert.equal(result.local[0],'/api/state');
});

test('the server build marker uses the real /api backend',async()=>{
  const {api,calls}=load({backend:'server'});
  await api('/api/state','GET',{});
  assert.equal(calls.length,1);
  assert.equal(calls[0].url,'/api/state');
});

test('local file protocol routes to the browser-local backend',async()=>{
  const {api,calls}=load({protocol:'file:'});
  const result=await api('/api/state','GET',{});
  assert.equal(calls.length,0);
  assert.equal(result.local[0],'/api/state');
});

test('a GET answered with an ETag is revalidated, and a 304 returns the same object',async()=>{
  const calls=[];
  const responses=[
    {ok:true,status:200,headers:{get:name=>name==='ETag'?'W/"v1"':null},json:async()=>({version:1})},
    {ok:false,status:304,headers:{get:()=>null},json:async()=>{throw new Error('no body');}},
    {ok:true,status:200,headers:{get:name=>name==='ETag'?'W/"v2"':null},json:async()=>({version:2})},
  ];
  const fetch=(url,options)=>{calls.push({url,options});return Promise.resolve(responses[calls.length-1]);};
  const document={querySelector:()=>({getAttribute:()=>'server'})};
  const context={window:{},location:{protocol:'https:'},document,fetch,console,JSON,Promise,Error,String,Object};
  context.window.window=context.window;
  runInContext(source,createContext(context));
  const api=context.window.AGENT_API;
  const first=await api('/api/state','GET');
  assert.equal(calls[0].options.headers['If-None-Match'],undefined,'nothing to revalidate yet');
  const second=await api('/api/state','GET');
  assert.equal(calls[1].options.headers['If-None-Match'],'W/"v1"');
  assert.equal(second,first,'a 304 is the remembered answer, by identity');
  api.forget();
  const third=await api('/api/state','GET');
  assert.equal(calls[2].options.headers['If-None-Match'],undefined,'forget() drops what was remembered');
  assert.deepEqual(third,{version:2});
});