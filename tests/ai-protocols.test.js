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

test('Azure OpenAI puts the deployment in the path, the version in the query and no model in the body', async () => {
  const {requests,port,close}=await stub({status:200,json:{choices:[{message:{content:'Azure reply'}}]}});
  try{
    // The resource endpoint has no /v1, and the model is a deployment name, which
    // may contain a space or a slash a user typed in the portal.
    const cfg=config(port,{baseUrl:`http://127.0.0.1:${port}`,protocol:'azure-openai',model:'my dep/one',apiVersion:'2024-06-01'});
    const out=await executeCustomBot({instructions:'Draft it'},'go',cfg);
    assert.equal(out,'Azure reply');
  }finally{close();}
  assert.equal(requests[0].url,'/openai/deployments/my%20dep%2Fone/chat/completions?api-version=2024-06-01','the deployment is the path and the version the query');
  assert.equal(requests[0].headers['api-key'],'k');
  assert.equal(requests[0].headers.authorization,undefined,'Azure authenticates with api-key, not a bearer token');
  assert.equal('model' in requests[0].body,false,'the deployment is in the URL; a body model would be ignored at best');
  assert.equal(requests[0].body.messages[0].role,'system');
  assert.match(requests[0].body.messages[0].content,/Draft it/);
  assert.equal(requests[0].body.messages[1].role,'user');
  assert.equal(requests[0].body.messages[1].content,'go');
  assert.ok(Number.isInteger(requests[0].body.max_tokens));
});

test('a blank or absent Azure API version falls back to 2024-10-21', async () => {
  const {requests,port,close}=await stub({status:200,json:{choices:[{message:{content:'ok'}}]}});
  try{
    const base={baseUrl:`http://127.0.0.1:${port}`,protocol:'azure-openai',model:'dep'};
    await executeCustomBot({instructions:'x'},'y',{...config(port,base),apiVersion:''});
    await executeCustomBot({instructions:'x'},'y',{...config(port,base),apiVersion:'   '});
    await executeCustomBot({instructions:'x'},'y',config(port,base));
  }finally{close();}
  assert.equal(requests.length,3);
  for(const request of requests)assert.equal(request.url,'/openai/deployments/dep/chat/completions?api-version=2024-10-21','a blank version still leaves a callable URL');
});

test('Azure model discovery asks /openai/deployments, reads the value envelope and follows nextLink', async () => {
  const requests=[];
  const server=http.createServer((req,res)=>{
    requests.push({url:req.url,headers:req.headers});
    const second=req.url.includes('page=2');
    const json=second
      ? {value:[{name:'deployment-b'}]}
      : {value:[{name:'deployment-a'}],nextLink:`http://127.0.0.1:${server.address().port}/openai/deployments?api-version=2024-06-01&page=2`};
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify(json));
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  try{
    const found=await discoverModels(config(server.address().port,{baseUrl:`http://127.0.0.1:${server.address().port}`,protocol:'azure-openai',model:'dep',apiVersion:'2024-06-01'}));
    assert.deepEqual(found.models,['deployment-a','deployment-b'],'rows live under value, and both pages are kept');
    assert.deepEqual(found.allModels,['deployment-a','deployment-b']);
    assert.equal(found.protocol,'azure-openai');
  }finally{server.close();}
  assert.equal(requests.length,2);
  assert.equal(requests[0].url,'/openai/deployments?api-version=2024-06-01');
  assert.equal(requests[1].url,'/openai/deployments?api-version=2024-06-01&page=2','the absolute nextLink is followed as given');
  for(const request of requests){
    assert.equal(request.headers['api-key'],'k');
    assert.equal(request.headers.authorization,undefined);
  }
});

test('custom headers are applied last: a pasted X-Api-Key coexists and a pasted Authorization wins', async () => {
  const {requests,port,close}=await stub({status:200,json:{choices:[{message:{content:'gw reply'}}]}});
  try{
    const cfg=config(port,{protocol:'openai-chat',headers:{'X-Api-Key':'routed-key-value','Authorization':'Token pasted-token'}});
    const out=await executeCustomBot({instructions:'x'},'y',cfg);
    assert.equal(out,'gw reply');
  }finally{close();}
  assert.equal(requests[0].headers['x-api-key'],'routed-key-value','a gateway that wants its own header gets it');
  assert.equal(requests[0].headers.authorization,'Token pasted-token','the pasted header beats the bearer one instead of being corrected');
  assert.equal(requests[0].headers['content-type'],'application/json','the protocol headers still go');
  assert.equal(requests[0].body.model,'m');
});

test('a pasted full call endpoint still produces a single call path on the wire', async () => {
  const chat=await stub({status:200,json:{choices:[{message:{content:'chat reply'}}]}});
  try{
    const cfg=config(chat.port,{baseUrl:`http://127.0.0.1:${chat.port}/v1/chat/completions`,protocol:'openai-chat',model:'m'});
    assert.equal(await executeCustomBot({instructions:'x'},'y',cfg),'chat reply');
  }finally{chat.close();}
  assert.deepEqual(chat.requests.map(r=>r.url),['/v1/chat/completions'],'the endpoint is not appended to itself');

  const claude=await stub({status:200,json:{content:[{type:'text',text:'claude reply'}]}});
  try{
    const cfg=config(claude.port,{baseUrl:`http://127.0.0.1:${claude.port}/v1/messages/`,protocol:'anthropic',model:'claude-sonnet-4-5'});
    assert.equal(await executeCustomBot({instructions:'x'},'y',cfg),'claude reply');
  }finally{claude.close();}
  assert.deepEqual(claude.requests.map(r=>r.url),['/v1/messages']);
});

test('an error status names the usual fix and keeps the provider\'s own words', async () => {
  const cases=[[401,/key was rejected/i],[403,/key was rejected/i],[404,/base URL/i],[429,/rate limited/i]];
  for(const [status,expected] of cases){
    const {port,close}=await stub({status,json:{error:{message:'provider says nope'}}});
    try{
      await assert.rejects(
        () => executeCustomBot({instructions:'x'},'y',config(port,{protocol:'openai-chat',apiKey:'sk-long-enough-key'})),
        e => {
          assert.match(e.message,new RegExp(String(status)),`a ${status} is reported as one`);
          assert.match(e.message,/provider says nope/,`a ${status} keeps the provider's words`);
          assert.match(e.message,expected,`a ${status} names the usual fix`);
          if(status===404)assert.match(e.message,/\/v1/,'the 404 hint says most providers need /v1');
          assert.equal(e.message.includes('sk-long-enough-key'),false,'the key never travels in the message');
          return true;
        },
      );
    }finally{close();}
  }
});

test('a short key is left inside ordinary words, a real key is redacted', async () => {
  const short=await stub({status:401,json:{error:{message:'session expired for this key'}}});
  try{
    await assert.rejects(
      () => executeCustomBot({instructions:'x'},'y',config(short.port,{protocol:'openai-chat',apiKey:'sess'})),
      e => /session expired/.test(e.message) && !e.message.includes('[redacted]'),
    );
  }finally{short.close();}

  const long=await stub({status:401,json:{error:{message:'the key sk-live-abcdef123456 is not valid'}}});
  try{
    await assert.rejects(
      () => executeCustomBot({instructions:'x'},'y',config(long.port,{protocol:'openai-chat',apiKey:'sk-live-abcdef123456'})),
      e => /\[redacted\]/.test(e.message) && !e.message.includes('sk-live-abcdef123456'),
    );
  }finally{long.close();}
});

test('the catalogue keeps the chat models apart from everything the key can see, with the provider labels', async () => {
  const {port,close}=await stub({status:200,json:{data:[
    {id:'gpt-4.1',display_name:'GPT 4.1'},
    {id:'llama-guard3:8b'},
    {id:'text-embedding-3-small'},
    {id:'whisper-1'},
    {id:'tts-1'},
    {id:'dall-e-3'},
    {id:'omni-moderation-latest'},
    {id:'rerank-v3.5'},
  ]}});
  try{
    const found=await discoverModels(config(port,{protocol:'openai-chat'}));
    assert.deepEqual(found.models,['gpt-4.1','llama-guard3:8b'],'a guard model and a normal chat model both answer chat; the rest cannot');
    assert.equal(found.allModels.length,8,'the picker still offers "all models" the key lists');
    for(const id of ['text-embedding-3-small','whisper-1','tts-1','dall-e-3','omni-moderation-latest','rerank-v3.5'])assert.ok(found.allModels.includes(id),`${id} is listed but not chat-capable`);
    assert.deepEqual(found.labels,{'gpt-4.1':'GPT 4.1'});
  }finally{close();}
});

test('a gateway that answers models instead of data is parsed, and the catalogue is capped and sorted', async () => {
  const {port,close}=await stub({status:200,json:{models:[{id:'zeta-chat',displayName:'Zeta Chat'},{id:'alpha-chat'}]}});
  try{
    const found=await discoverModels(config(port,{protocol:'openai-chat'}));
    assert.deepEqual(found.models,['alpha-chat','zeta-chat'],'rows under models are read, and the ids are sorted');
    assert.deepEqual(found.labels,{'zeta-chat':'Zeta Chat'});
  }finally{close();}

  const ids=Array.from({length:2005},(_,i)=>`model-${String(i).padStart(4,'0')}`);
  const big=await stub({status:200,json:{data:ids.map(id=>({id}))}});
  try{
    const found=await discoverModels(config(big.port,{protocol:'openai-chat'}));
    assert.equal(found.allModels.length,2000,'the catalogue is capped at 2000 so a huge provider cannot bloat the record');
    assert.equal(found.models.length,2000);
    assert.equal(found.allModels[0],'model-0000');
    assert.equal(found.allModels.at(-1),'model-1999','the cap keeps the first 2000 the provider listed');
    assert.deepEqual(found.allModels,[...found.allModels].sort(),'the picker reads them in order');
  }finally{big.close();}
});

test('Anthropic display_name and Gemini displayName become the picker labels', async () => {
  const anthropic=await stub({status:200,json:{data:[{id:'claude-sonnet-4-5',display_name:'Claude Sonnet 4.5'}],has_more:false}});
  try{
    const found=await discoverModels(config(anthropic.port,{protocol:'anthropic',model:'claude-sonnet-4-5'}));
    assert.deepEqual(found.labels,{'claude-sonnet-4-5':'Claude Sonnet 4.5'});
  }finally{anthropic.close();}

  const gemini=await stub({status:200,json:{models:[{name:'models/gemini-2.5-pro',displayName:'Gemini 2.5 Pro',supportedGenerationMethods:['generateContent']}]}});
  try{
    const found=await discoverModels(config(gemini.port,{protocol:'gemini',model:'gemini-2.5-pro'}));
    assert.deepEqual(found.models,['gemini-2.5-pro']);
    assert.deepEqual(found.labels,{'gemini-2.5-pro':'Gemini 2.5 Pro'});
  }finally{gemini.close();}
});

test('a tool fence the model puts last keeps its closing fence', async () => {
  // The trailing-fence cleanup exists to unwrap ```markdown answers. It used to
  // eat the closing fence of an ask block, and an unclosed block is plain text,
  // so the bot's request silently never happened.
  const reply = 'Draft.\n```ask\n{"to":"Researcher","task":"Which source?"}\n```';
  const {port,close} = await stub({status:200,json:{choices:[{message:{content:reply}}]}});
  try {
    const bot = {id: 'b', name: 'Writer', instructions: 'Write posts.', permissions: ['bot.ask']};
    const result = await executeCustomBot(bot, 'Write a post.', config(port, {protocol: 'openai-chat'}));
    assert.equal(result, reply, 'The block must reach the orchestrator intact.');
  } finally { close(); }
  const wrapped = '\u0060\u0060\u0060markdown\nAn ordinary answer.\n\u0060\u0060\u0060';
  const {port: port2, close: close2} = await stub({status:200,json:{choices:[{message:{content:wrapped}}]}});
  try {
    const bot = {id: 'b', name: 'Writer', instructions: 'Write posts.'};
    const result = await executeCustomBot(bot, 'Write a post.', config(port2, {protocol: 'openai-chat'}));
    assert.equal(result, 'An ordinary answer.', 'A wrapper fence is still unwrapped.');
  } finally { close2(); }
});
