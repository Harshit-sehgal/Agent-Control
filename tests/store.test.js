import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {JsonStore} from '../src/store.js';import {tick} from '../src/scheduler.js';

test('serial updates are durable and survive reload',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'agent-store-'));try{
    const filename=path.join(dir,'state.json');const s=await new JsonStore(filename).init();
    await Promise.all(Array.from({length:20},()=>s.update(d=>{d.version++;})));
    assert.equal(s.read().version,21);
    const loaded=await new JsonStore(filename).init();assert.equal(loaded.read().version,21);
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('scheduler only transitions due drafts, and does not auto-post',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'agent-scheduler-'));try{
    const s=await new JsonStore(path.join(dir,'db.json')).init();
    await s.update(d=>{d.drafts.push({id:'a',status:'scheduled',dueAt:new Date(1000).toISOString(),text:'A',revision:1,approvedRevision:1,approvedText:'A'});d.drafts.push({id:'b',status:'scheduled',dueAt:new Date(9000).toISOString()});});
    await tick(s,5000);assert.equal(s.read().drafts[0].status,'ready');assert.equal(s.read().drafts[1].status,'scheduled');
    assert.equal(s.read().drafts.filter(x=>x.status==='posted').length,0);
    await tick(s,5000);assert.equal(s.read().events.filter(e=>e.type==='ready').length,1);
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('a failed disk write never advances in-memory state ahead of disk',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'agent-store-fail-'));try{
    const s=await new JsonStore(path.join(dir,'state.json')).init();
    const before=s.read().version;
    const realPersist=s.persist.bind(s);
    s.persist=async()=>{throw new Error('disk full');};
    await assert.rejects(s.update(d=>{d.version=999;}),/disk full/);
    assert.equal(s.read().version,before);
    s.persist=realPersist;
    await s.update(d=>{d.version=before+1;});
    assert.equal(s.read().version,before+1);
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('an unreadable state file is quarantined instead of crashing on every start',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'agent-store-corrupt-'));
  try{
    const file=path.join(dir,'state.json');
    await fs.writeFile(file,'{corrupt');
    const s=await new JsonStore(file).init();
    // A fresh, usable state plus a recorded pointer for the operator.
    assert.ok(s.recoveredFrom?.startsWith(`${file}.corrupt-`));
    assert.equal(s.read().version>=1,true);
    await fs.access(s.recoveredFrom);
    assert.equal(await fs.readFile(s.recoveredFrom,'utf8'),'{corrupt');
    // The recovered store must still persist normally afterwards.
    await s.update(d=>{d.version=7;});
    assert.equal((await new JsonStore(file).init()).read().version,7);
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('a missing state file does not report a recovery',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'agent-store-fresh-'));
  try{
    assert.equal((await new JsonStore(path.join(dir,'state.json')).init()).recoveredFrom,undefined);
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});

