import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {makeDraft,executeCustomBot,discoverModels} from '../src/ai.js';

// The four wire protocols share one client. Each test drives a real loopback
// server so the request path, headers, body shape and response parsing are
// checked as they go on the wire, not through a mocked fetch.
const candidate={url:'https://x.com/a/status/1',text:'A post about robotics reliability.',author:'Tester',topic:'robotics'};
const settings={style:'casual and direct',opinions:''};

/** A throwaway provider that records every request it receives. */
async function stub(reply){
  const requests=[];
  const server=http.createServer((req,res)=>{
    let body='';req.on('data',c=>body+=c);
    req.on('end',()=>{
      requests.push({url:req.url,method:req.method,headers:req.headers,body:body?JSON.parse(body):null});
      res.writeHead(reply.status,{'Content-Type':'application/json'});
      res.end(JSON.stringify(reply.json));
    });
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  return {requests,port:server.address().port,close:()=>server.close()};
}
const config=(port,extra)=>({baseUrl:`http://127.0.0.1:${port}/v1`,apiKey:'k',model:'m',...extra});

test('OpenAI chat completions put the instructions in a system message and the task in a user message', async () => {
  const {requests,port,close}=await stub({status:200,json:{choices:[{message:{content:'Chat reply'}}]}});
  try{
    const draft=await makeDraft(candidate,settings,'',config(port,{protocol:'openai-chat'}));
    assert.equal(draft.mode,'ai');
    assert.equal(draft.text,'Chat reply');
  }finally{close();}
  assert.equal(requests.length,1);
  assert.equal(requests[0].method,'POST');
  assert.equal(requests[0].url,'/v1/chat/completions');
  assert.equal(requests[0].headers.authorization,'Bearer k');
  assert.equal(requests[0].headers['x-api-key'],undefined,'chat completions are a bearer protocol');
  assert.equal(requests[0].body.model,'m');
  assert.equal(requests[0].body.messages.length,2);
  assert.equal(requests[0].body.messages[0].role,'system');
  assert.match(requests[0].body.messages[0].content,/draft a short, casual reply/i);
  assert.equal(requests[0].body.messages[1].role,'user');
  assert.match(requests[0].body.messages[1].content,/robotics/);
  assert.ok(Number.isInteger(requests[0].body.max_tokens),'chat shape carries max_tokens');
  assert.equal('system' in requests[0].body,false);
});

test('OpenAI Responses posts to /responses with instructions and input, and reads output_text parts', async () => {
  const {requests,port,close}=await stub({status:200,json:{output:[{content:[{type:'output_text',text:'Resp reply'}]}]}});
  try{
    const out=await executeCustomBot({instructions:'Summarise the thread'},'go',config(port,{protocol:'openai-responses',model:'gpt-4.1-mini'}));
    assert.equal(out,'Resp reply');
  }finally{close();}
  assert.equal(requests[0].url,'/v1/responses');
  assert.equal(requests[0].headers.authorization,'Bearer k');
  assert.equal(requests[0].body.model,'gpt-4.1-mini');
  assert.match(requests[0].body.instructions,/Summarise the thread/);
  assert.equal(requests[0].body.input,'go');
  assert.ok(Number.isInteger(requests[0].body.max_output_tokens));
  assert.equal('messages' in requests[0].body,false,'the Responses shape is not chat');
});

test('Anthropic Messages uses x-api-key plus a version header, and only the text block becomes the reply', async () => {
  const {requests,port,close}=await stub({status:200,json:{content:[{type:'thinking',thinking:'the scratchpad'},{type:'text',text:'Anthropic reply'}]}});
  try{
    const out=await executeCustomBot({instructions:'Draft it'},'go',config(port,{protocol:'anthropic',model:'claude-sonnet-4-5'}));
    assert.equal(out,'Anthropic reply','a thinking block is not the answer');
  }finally{close();}
  assert.equal(requests[0].url,'/v1/messages');
  assert.equal(requests[0].headers['x-api-key'],'k');
  assert.equal(requests[0].headers['anthropic-version'],'2023-06-01');
  assert.equal(requests[0].headers.authorization,undefined,'Anthropic does not take a bearer token');
  assert.equal(requests[0].body.model,'claude-sonnet-4-5');
  assert.ok(Number.isInteger(requests[0].body.max_tokens));
  assert.match(requests[0].body.system,/Draft it/,'Anthropic takes the system prompt as a top-level field');
  assert.equal(requests[0].body.messages.length,1);
  assert.equal(requests[0].body.messages[0].role,'user');
  assert.equal(requests[0].body.messages[0].content,'go');
  assert.equal('instructions' in requests[0].body,false);
});

test('Gemini generateContent puts the model in the path, uses x-goog-api-key and skips thought parts', async () => {
  const {requests,port,close}=await stub({status:200,json:{candidates:[{content:{parts:[{text:'internal reasoning',thought:true},{text:'Gemini reply'}]}}]}});
  try{
    const out=await executeCustomBot({instructions:'Draft it'},'go',config(port,{protocol:'gemini',model:'gemini-2.5-flash'}));
    assert.equal(out,'Gemini reply','a thought part is scratchpad, not the answer');
  }finally{close();}
  assert.equal(requests[0].method,'POST');
  assert.equal(requests[0].url,'/v1/models/gemini-2.5-flash:generateContent');
  assert.equal(requests[0].headers['x-goog-api-key'],'k');
  assert.equal(requests[0].headers.authorization,undefined,'Gemini does not take a bearer token');
  assert.match(requests[0].body.systemInstruction.parts[0].text,/Draft it/);
  assert.equal(requests[0].body.contents.length,1);
  assert.equal(requests[0].body.contents[0].role,'user');
  assert.equal(requests[0].body.contents[0].parts[0].text,'go');
  assert.ok(Number.isInteger(requests[0].body.generationConfig.maxOutputTokens));
  assert.equal('messages' in requests[0].body,false);
});

test('a Gemini safety block is a 422 that names the reason', async () => {
  const {requests,port,close}=await stub({status:200,json:{candidates:[],promptFeedback:{blockReason:'SAFETY'}}});
  try{
    // A realistic key: a one-character key makes the redactor mangle "blocked".
    const cfg=config(port,{protocol:'gemini',model:'gemini-2.5-flash',apiKey:'sk-gemini-key'});
    await assert.rejects(
      () => executeCustomBot({instructions:'Draft it'},'go',cfg),
      e => e.status===422 && /blocked/i.test(e.message) && /SAFETY/.test(e.message) && !e.message.includes('sk-gemini-key'),
    );
  }finally{close();}
  assert.equal(requests.length,1,'the request was sent; the block came back in a 200 body');
});

test('a config with only the legacy style field still speaks chat completions', async () => {
  const {requests,port,close}=await stub({status:200,json:{choices:[{message:{content:'Legacy reply'}}]}});
  try{
    const draft=await makeDraft(candidate,settings,'',config(port,{style:'chat',model:'auto'}));
    assert.equal(draft.text,'Legacy reply');
  }finally{close();}
  assert.equal(requests[0].url,'/v1/chat/completions','style:"chat" maps to openai-chat');
  assert.equal(requests[0].headers.authorization,'Bearer k');
  assert.equal(requests[0].body.model,'auto');
  assert.equal(requests[0].body.messages[0].role,'system');
});

test('Gemini refuses the "auto" model before a request is sent, naming the fix', async () => {
  const {requests,port,close}=await stub({status:200,json:{candidates:[{content:{parts:[{text:'never used'}]}}]}});
  try{
    await assert.rejects(
      () => executeCustomBot({instructions:'Draft it'},'go',config(port,{protocol:'gemini',model:'auto'})),
      e => e.status===422 && /concrete model/i.test(e.message) && /AI and models/.test(e.message),
    );
  }finally{close();}
  assert.deepEqual(requests,[],'a guaranteed 400 is not worth a round trip');
});

test('an empty reply is a 502 rather than a blank draft', async () => {
  const {port,close}=await stub({status:200,json:{choices:[{message:{content:''}}]}});
  try{
    await assert.rejects(
      () => executeCustomBot({instructions:'Draft it'},'go',config(port,{protocol:'openai-chat'})),
      e => e.status===502 && /empty response/i.test(e.message),
    );
  }finally{close();}
});

test('OpenAI-compatible model discovery reads /models and sorts the ids', async () => {
  const {requests,port,close}=await stub({status:200,json:{data:[{id:'zeta-model'},{id:'alpha-model'},{id:'mid-model'}]}});
  try{
    const found=await discoverModels(config(port,{protocol:'openai-chat'}));
    assert.deepEqual(found.models,['alpha-model','mid-model','zeta-model']);
    assert.equal(found.protocol,'openai-chat');
    assert.ok(!Number.isNaN(Date.parse(found.at)),'the catalogue carries a timestamp');
  }finally{close();}
  assert.equal(requests[0].method,'GET');
  assert.equal(requests[0].url,'/v1/models');
  assert.equal(requests[0].headers.authorization,'Bearer k');
});

test('Anthropic model discovery follows has_more with after_id and merges both pages', async () => {
  const requests=[];
  const server=http.createServer((req,res)=>{
    requests.push({url:req.url,headers:req.headers});
    const second=req.url.includes('after_id=');
    const json=second
      ? {data:[{id:'claude-haiku-4-5'}],has_more:false}
      : {data:[{id:'claude-sonnet-4-5'}],has_more:true,last_id:'claude-sonnet-4-5'};
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify(json));
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  try{
    const found=await discoverModels(config(server.address().port,{protocol:'anthropic',model:'claude-sonnet-4-5'}));
    assert.deepEqual(found.models,['claude-haiku-4-5','claude-sonnet-4-5'],'both pages are kept, sorted');
    assert.equal(found.protocol,'anthropic');
    assert.equal(requests.length,2);
    assert.equal(requests[0].url,'/v1/models?limit=1000');
    assert.equal(requests[1].url,'/v1/models?limit=1000&after_id=claude-sonnet-4-5');
    for(const r of requests){
      assert.equal(r.headers['x-api-key'],'k');
      assert.equal(r.headers['anthropic-version'],'2023-06-01');
      assert.equal(r.headers.authorization,undefined);
    }
  }finally{server.close();}
});

test('Gemini model discovery follows nextPageToken, strips models/, and drops non-generateContent entries', async () => {
  const requests=[];
  const server=http.createServer((req,res)=>{
    requests.push({url:req.url,headers:req.headers});
    const json=req.url.includes('pageToken=page-2')
      ? {models:[{name:'models/gemini-2.5-flash',supportedGenerationMethods:['generateContent','countTokens']}]}
      : {
        models:[
          {name:'models/gemini-2.5-pro',supportedGenerationMethods:['generateContent']},
          {name:'models/text-embedding-004',supportedGenerationMethods:['embedContent']},
        ],
        nextPageToken:'page-2',
      };
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify(json));
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  try{
    const found=await discoverModels(config(server.address().port,{protocol:'gemini',model:'gemini-2.5-flash'}));
    assert.deepEqual(found.models,['gemini-2.5-flash','gemini-2.5-pro'],'the embedding model is hidden and the prefix is gone');
    assert.equal(found.protocol,'gemini');
    assert.equal(requests.length,2);
    assert.equal(requests[0].url,'/v1/models?pageSize=200');
    assert.equal(requests[1].url,'/v1/models?pageSize=200&pageToken=page-2');
    for(const r of requests)assert.equal(r.headers['x-goog-api-key'],'k');
  }finally{server.close();}
});

test('an Ollama server with no /v1/models is asked at its native /api/tags', async () => {
  const requests=[];
  const server=http.createServer((req,res)=>{
    requests.push(req.url);
    if(req.url==='/api/tags'){
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({models:[{name:'llama3.2:latest'},{name:'qwen2.5:7b'}]}));
      return;
    }
    res.writeHead(404,{'Content-Type':'application/json'});
    res.end(JSON.stringify({error:{message:'not found'}}));
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  try{
    const found=await discoverModels(config(server.address().port,{protocol:'openai-chat',model:'llama3.2'}));
    assert.deepEqual(found.models,['llama3.2:latest','qwen2.5:7b']);
    assert.equal(found.source,'native');
  }finally{server.close();}
  assert.deepEqual(requests,['/v1/models','/api/tags'],'the OpenAI path is tried first, then the native one');
});

test('a rejected discovery reports the provider message and never the key', async () => {
  const {port,close}=await stub({status:401,json:{error:{message:'bad key'}}});
  try{
    const cfg=config(port,{apiKey:'sk-discovery-secret',protocol:'openai-chat'});
    await assert.rejects(() => discoverModels(cfg),e=>{
      assert.match(e.message,/401/);
      assert.match(e.message,/bad key/);
      assert.equal(e.message.includes('sk-discovery-secret'),false,'the key must never round-trip in an error');
      return true;
    });
  }finally{close();}
});
