import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {complete,executeCustomBot,aiEnabled} from '../src/ai.js';

// One plain provider call; the tests below vary the wire, not the prompt.
const ask=()=>complete({instructions:'Answer in one short sentence.',input:'A note about robotics reliability.'});

// A throwaway OpenAI-compatible server that records what it received.
async function stub(reply){
  const requests=[];
  const server=http.createServer((req,res)=>{let body='';req.on('data',c=>body+=c);req.on('end',()=>{requests.push({url:req.url,method:req.method,auth:req.headers.authorization,body:body?JSON.parse(body):null});res.writeHead(reply.status,{'Content-Type':'application/json'});res.end(JSON.stringify(reply.json));});});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  return {requests,port:server.address().port,close:()=>server.close()};
}
// Apply env for one test and restore it exactly afterwards.
async function withEnv(env,fn){
  const keys=Object.keys(env),saved=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
  Object.assign(process.env,env);
  try{return await fn();}finally{for(const k of keys){if(saved[k]===undefined)delete process.env[k];else process.env[k]=saved[k];}}
}

test('calls use the OpenAI-compatible chat shape and parse choices[].message',async()=>{
  const {requests,port,close}=await stub({status:200,json:{choices:[{message:{content:'A concise reply.'}}]}});
  try{
    const out=await withEnv({AI_BASE_URL:`http://127.0.0.1:${port}/v1`,AI_API_KEY:'test-key',AI_API_STYLE:'chat',AI_MODEL:'auto'},()=>ask());
    assert.equal(out,'A concise reply.');
  }finally{close();}
  assert.equal(requests.length,1);
  assert.equal(requests[0].url,'/v1/chat/completions');
  assert.equal(requests[0].auth,'Bearer test-key');
  assert.equal(requests[0].body.model,'auto');
  assert.equal(requests[0].body.messages.length,2);
  assert.equal(requests[0].body.messages[0].role,'system');
  assert.equal(requests[0].body.messages[1].role,'user');
  assert.match(requests[0].body.messages[1].content,/robotics/);
});

test('OpenAI Responses payloads are parsed when AI_API_STYLE=responses',async()=>{
  const {requests,port,close}=await stub({status:200,json:{output:[{content:[{type:'output_text',text:'Resp draft'}]}]}});
  try{
    const out=await withEnv({AI_BASE_URL:`http://127.0.0.1:${port}/v1`,AI_API_KEY:'sk-test',AI_API_STYLE:'responses',AI_MODEL:'gpt-4.1-mini'},()=>ask());
    assert.equal(out,'Resp draft');
  }finally{close();}
  assert.equal(requests[0].url,'/v1/responses');
  assert.ok('instructions' in requests[0].body,'Responses payload keeps the instructions field.');
});

test('the wire style is inferred as chat for a non-OpenAI host',async()=>{
  const {requests,port,close}=await stub({status:200,json:{choices:[{message:{content:'ok'}}]}});
  try{
    // No AI_API_STYLE: a loopback base URL must not be treated as OpenAI.
    const out=await withEnv({AI_BASE_URL:`http://127.0.0.1:${port}/v1`,AI_API_KEY:'k',AI_API_STYLE:'',AI_MODEL:'auto'},()=>ask());
    assert.equal(out,'ok');
  }finally{close();}
  assert.equal(requests[0].url,'/v1/chat/completions');
});

test('provider failures surface the status and message, never a fake success',async()=>{
  const {port,close}=await stub({status:429,json:{error:{message:'rate limited'}}});
  try{
    await withEnv({AI_BASE_URL:`http://127.0.0.1:${port}/v1`,AI_API_KEY:'k',AI_API_STYLE:'chat',AI_MODEL:'auto'},async()=>{
      await assert.rejects(ask(),/429.*rate limited/);
    });
  }finally{close();}
});

test('without a provider, a call is refused with a fix instead of a fake answer',async()=>{
  await withEnv({AI_API_KEY:'',OPENAI_API_KEY:'',AI_BASE_URL:'',OPENAI_BASE_URL:''},async()=>{
    assert.equal(aiEnabled(),false);
    await assert.rejects(ask(),e=>e.status===422&&/No AI provider is configured/.test(e.message));
  });
});

test('chat content arrays are the reply, and a non-text payload is not an answer',async()=>{
  const parts=await stub({status:200,json:{choices:[{message:{content:[{type:'text',text:'Real reply'}]}}]}});
  try{
    const out=await withEnv({AI_BASE_URL:`http://127.0.0.1:${parts.port}/v1`,AI_API_KEY:'k',AI_API_STYLE:'chat',AI_MODEL:'auto'},()=>ask());
    assert.equal(out,'Real reply');
  }finally{parts.close();}
  const image=await stub({status:200,json:{choices:[{message:{content:[{type:'image'}]}}]}});
  try{
    await withEnv({AI_BASE_URL:`http://127.0.0.1:${image.port}/v1`,AI_API_KEY:'k',AI_API_STYLE:'chat',AI_MODEL:'auto'},async()=>{
      await assert.rejects(ask(),/empty response/);
    });
  }finally{image.close();}
});

test('a provider error that echoes the key does not return the key',async()=>{
  const {port,close}=await stub({status:401,json:{error:{message:'bad key sk-test-secret'}}});
  try{
    await withEnv({AI_BASE_URL:`http://127.0.0.1:${port}/v1`,AI_API_KEY:'sk-test-secret',AI_API_STYLE:'chat',AI_MODEL:'auto'},async()=>{
      await assert.rejects(ask(),e=>{
        assert.match(e.message,/401/);
        assert.equal(e.message.includes('sk-test-secret'),false);
        return true;
      });
    });
  }finally{close();}
});

test('a long reply still keeps a trailing browser fence instead of slicing it off',async()=>{
  const block='```browser\n{"url":"https://example.com/docs"}\n```';
  const {port,close}=await stub({status:200,json:{choices:[{message:{content:`Note.\n${'x'.repeat(4000)}\n${block}`}}]}});
  try{
    const out=await withEnv({AI_BASE_URL:`http://127.0.0.1:${port}/v1`,AI_API_KEY:'k',AI_API_STYLE:'chat',AI_MODEL:'m'},()=>executeCustomBot({instructions:'Look it up',permissions:['browser.use']},'fetch docs'));
    assert.match(out,/```browser/);
    assert.ok(out.length>3000);
  }finally{close();}
});

test('a reply that is only a browser fence keeps those fences, and a markdown-wrapped reply still loses its wrapper',async()=>{
  const block='```browser\n{"url":"https://example.com/docs"}\n```';
  const page=await stub({status:200,json:{choices:[{message:{content:block}}]}});
  try{
    const out=await withEnv({AI_BASE_URL:`http://127.0.0.1:${page.port}/v1`,AI_API_KEY:'k',AI_API_STYLE:'chat',AI_MODEL:'m'},()=>executeCustomBot({instructions:'Look it up',permissions:['browser.use']},'fetch docs'));
    assert.match(out,/```browser/);
  }finally{page.close();}
  const wrapped=await stub({status:200,json:{choices:[{message:{content:'```\nA concise reply.\n```'}}]}});
  try{
    const out=await withEnv({AI_BASE_URL:`http://127.0.0.1:${wrapped.port}/v1`,AI_API_KEY:'k',AI_API_STYLE:'chat',AI_MODEL:'m'},()=>executeCustomBot({instructions:'Write'},'hi'));
    assert.equal(out,'A concise reply.');
  }finally{wrapped.close();}
});

test('custom bots run through the same configured provider',async()=>{
  const {requests,port,close}=await stub({status:200,json:{choices:[{message:{content:'Bot answer'}}]}});
  try{
    const out=await withEnv({AI_BASE_URL:`http://127.0.0.1:${port}/v1`,AI_API_KEY:'k',AI_API_STYLE:'chat',AI_MODEL:'auto'},()=>executeCustomBot({instructions:'Do the thing'},'do it now'));
    assert.equal(out,'Bot answer');
    assert.match(requests[0].body.messages[0].content,/Do the thing/);
    assert.match(requests[0].body.messages[1].content,/do it now/);
  }finally{close();}
});

test('a provider failure is reported as a gateway error the API can show, not a server crash',async()=>{
  const {port,close}=await stub({status:502,json:{error:{message:'All routed attempts failed'}}});
  try{
    await withEnv({AI_BASE_URL:`http://127.0.0.1:${port}/v1`,AI_API_KEY:'test-key',AI_API_STYLE:'chat'},async()=>{
      await assert.rejects(()=>executeCustomBot({name:'B',instructions:'Summarise.'},'hello'),e=>e.status===502&&/All routed attempts failed/.test(e.message));
    });
  }finally{close();}
  // Nothing is listening here: an unreachable provider is a gateway error too.
  await withEnv({AI_BASE_URL:'http://127.0.0.1:9/v1',AI_API_KEY:'test-key',AI_API_STYLE:'chat'},async()=>{
    await assert.rejects(()=>executeCustomBot({name:'B',instructions:'Summarise.'},'hello'),e=>e.status===502&&/could not be reached/.test(e.message));
  });
  const empty=await stub({status:200,json:{choices:[{message:{content:''}}]}});
  try{
    await withEnv({AI_BASE_URL:`http://127.0.0.1:${empty.port}/v1`,AI_API_KEY:'test-key',AI_API_STYLE:'chat'},async()=>{
      await assert.rejects(()=>executeCustomBot({name:'B',instructions:'Summarise.'},'hello'),e=>e.status===502&&/empty response/.test(e.message));
    });
  }finally{empty.close();}
});

test('a leftover think closer does not drop a browser fence',async()=>{
  const {port,close}=await stub({status:200,json:{choices:[{message:{content:'```browser\n{"url":"https://example.com"}\n```\n</think>'}}]}});
  try{
    const out=await withEnv({AI_BASE_URL:`http://127.0.0.1:${port}/v1`,AI_API_KEY:'test-key',AI_API_STYLE:'chat',AI_MODEL:'auto'},()=>executeCustomBot({name:'B',instructions:'Look it up.'},'go'));
    assert.match(out,/```browser/);
  }finally{close();}
});

test('a reply that is only a spawn fence keeps its fences, and the tool is described only with the permission',async()=>{
  const block='```spawn\n{"name":"Fact check","task":"Does the figure hold?"}\n```';
  const {requests,port,close}=await stub({status:200,json:{choices:[{message:{content:block}}]}});
  try{
    const out=await withEnv({AI_BASE_URL:`http://127.0.0.1:${port}/v1`,AI_API_KEY:'k',AI_API_STYLE:'chat',AI_MODEL:'m'},()=>executeCustomBot({instructions:'Draft it',permissions:['subagent.spawn']},'go'));
    assert.match(out,/```spawn/);
    assert.match(requests[0].body.messages[0].content,/spawn block/);
  }finally{close();}
  const plain=await stub({status:200,json:{choices:[{message:{content:'ok'}}]}});
  try{
    await withEnv({AI_BASE_URL:`http://127.0.0.1:${plain.port}/v1`,AI_API_KEY:'k',AI_API_STYLE:'chat',AI_MODEL:'m'},()=>executeCustomBot({instructions:'Draft it'},'go'));
    assert.match(plain.requests[0].body.messages[0].content,/cannot run tools, except asking another bot/);
    assert.doesNotMatch(plain.requests[0].body.messages[0].content,/spawn block/);
  }finally{plain.close();}
});

test('AI calls do not follow redirects',async()=>{
  const server=http.createServer((req,res)=>{
    if(req.url==='/v1/chat/completions'){res.writeHead(302,{Location:'/v1/ok'});res.end();return;}
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({choices:[{message:{content:'leaked'}}]}));
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  try{
    await withEnv({AI_BASE_URL:`http://127.0.0.1:${server.address().port}/v1`,AI_API_KEY:'test-key',AI_API_STYLE:'chat',AI_MODEL:'auto'},async()=>{
      await assert.rejects(()=>executeCustomBot({name:'B',instructions:'Summarise.'},'hello'),/redirected/);
    });
  }finally{server.close();}
});

// A server that answers raw bytes, for the stream shapes a JSON stub cannot make.
async function rawStub({status=200,type='text/event-stream',body='',delay=0}){
  const server=http.createServer((req,res)=>{req.resume();req.on('end',()=>{setTimeout(()=>{res.writeHead(status,{'Content-Type':type});res.end(body);},delay);});});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  return {port:server.address().port,close:()=>server.close()};
}

test('a streamed error is redacted before it is shortened, so no key head survives',async()=>{
  // The key sits past the 200-character bound: redacting afterwards cannot match
  // a key that was already cut, and the visible head is exactly what leaks.
  const key='sk-proj-A1b2C3d4E5f6G7h8I9j0K1L2M3N4O5P6Q7R8S9T0';
  const said='x'.repeat(170)+` invalid key ${key}`;
  const {port,close}=await rawStub({body:`data: ${JSON.stringify({error:{message:said}})}\n\n`});
  try{
    await assert.rejects(
      withEnv({AI_BASE_URL:`http://127.0.0.1:${port}/v1`,AI_API_KEY:key,AI_API_STYLE:'chat',AI_MODEL:'auto'},()=>ask()),
      error=>{assert.doesNotMatch(error.message,/sk-proj-A1b2/);assert.doesNotMatch(error.message,new RegExp(key.slice(0,16)));return true;},
    );
  }finally{close();}
});

test('a stream that stops on length says why instead of reporting an empty answer',async()=>{
  const {port,close}=await rawStub({body:'data: {"choices":[{"delta":{"role":"assistant"},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n'});
  try{
    await assert.rejects(
      withEnv({AI_BASE_URL:`http://127.0.0.1:${port}/v1`,AI_API_KEY:'k-test-key',AI_API_STYLE:'chat',AI_MODEL:'auto'},()=>ask()),
      /ran out of output tokens/,
    );
  }finally{close();}
});

test('a streamed refusal is reported as a refusal, not as a broken provider',async()=>{
  const {port,close}=await rawStub({body:'data: {"choices":[{"message":{"refusal":"I cannot help with that."}}]}\n\n'});
  try{
    await assert.rejects(
      withEnv({AI_BASE_URL:`http://127.0.0.1:${port}/v1`,AI_API_KEY:'k-test-key',AI_API_STYLE:'chat',AI_MODEL:'auto'},()=>ask()),
      /refused the request/,
    );
  }finally{close();}
});

test('the reason for an empty answer is named on every protocol, not just chat',async()=>{
  const responses=await stub({status:200,json:{status:'incomplete',incomplete_details:{reason:'max_output_tokens'},output:[]}});
  try{
    await assert.rejects(
      withEnv({AI_BASE_URL:`http://127.0.0.1:${responses.port}/v1`,AI_API_KEY:'sk-test',AI_API_STYLE:'responses',AI_MODEL:'gpt-4.1-mini'},()=>ask()),
      /ran out of output tokens/,
    );
  }finally{responses.close();}
  const anthropic=await stub({status:200,json:{content:[],stop_reason:'max_tokens'}});
  try{
    await assert.rejects(
      withEnv({AI_BASE_URL:`http://127.0.0.1:${anthropic.port}/v1`,AI_API_KEY:'sk-ant-test',AI_API_STYLE:'anthropic',AI_MODEL:'claude-3-5-haiku-latest'},()=>ask()),
      /ran out of output tokens/,
    );
  }finally{anthropic.close();}
});

test('a busy provider is retryable, so a queued run is not failed by a local 429',async()=>{
  const {port,close}=await rawStub({type:'application/json',body:JSON.stringify({choices:[{message:{content:'ok'}}]}),delay:150});
  try{
    await withEnv({AI_BASE_URL:`http://127.0.0.1:${port}/v1`,AI_API_KEY:'k-test-key',AI_API_STYLE:'chat',AI_MODEL:'auto',AI_MAX_CONCURRENCY:'1'},async()=>{
      const first=ask();
      const second=ask().catch(error=>error);
      await first;
      const busy=await second;
      assert.equal(busy.status,429);
      assert.equal(busy.permanent,undefined,'the queue must be allowed to retry a busy call');
      assert.match(busy.message,/busy with other requests/);
    });
  }finally{close();}
});
