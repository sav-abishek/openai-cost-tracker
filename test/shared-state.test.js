'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {SharedState,acquireLock,atomicJson,usageCachePath}=require('../src/shared-state');
async function temp(t){const root=await fs.promises.mkdtemp(path.join(os.tmpdir(),'ai-ledger-shared-test-'));t.after(async()=>{assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep+'ai-ledger-shared-test-'));await fs.promises.rm(root,{recursive:true,force:true});});return root;}
test('shared transactions preserve concurrent months and FX without lost writes',async t=>{
  const root=await temp(t),a=new SharedState(root),b=new SharedState(root);
  await Promise.all(Array.from({length:12},(_,i)=>(i%2?a:b).update(current=>{current.billingHistory['month-'+i]={amount:String(i)};return current;})));
  await Promise.all([a.update(current=>{current.fx={rate:95};return current;}),b.update(current=>{current.auth={revision:'new',connected:false};current.billingHistory={};return current;})]);
  const result=await a.read();assert.equal(result.revision,14);assert.equal(result.fx.rate,95);assert.equal(result.auth.connected,false);assert.deepEqual(result.billingHistory,{});
});
test('lock contention skips duplicates, releases safely, and recovers dead owners',async t=>{
  const root=await temp(t),file=path.join(root,'nested','request');
  const release=await acquireLock(file);assert.equal(await acquireLock(file),null);await release();await release();
  const next=await acquireLock(file);assert.equal(typeof next,'function');await next();
  await fs.promises.mkdir(file+'.lock');await fs.promises.writeFile(path.join(file+'.lock','owner.json'),JSON.stringify({pid:2147483647,token:'dead'}));
  const recovered=await acquireLock(file);assert.equal(typeof recovered,'function');await recovered();
});
test('atomic replacement yields complete JSON and deterministic per-home cache paths',async t=>{
  const root=await temp(t),file=path.join(root,'state.json');await atomicJson(file,{a:1});await atomicJson(file,{a:2});assert.deepEqual(JSON.parse(await fs.promises.readFile(file,'utf8')),{a:2});
  assert.equal(usageCachePath(path.join(root,'logs'),root),usageCachePath(path.join(root,'logs','.'),root));assert.notEqual(usageCachePath(path.join(root,'logs'),root),usageCachePath(path.join(root,'logs2'),root));
  assert.deepEqual((await fs.promises.readdir(root)).filter(name=>name.endsWith('.tmp')),[]);
});

test('simultaneous stale-lock contenders cannot evict the replacement owner',async t=>{
  const root=await temp(t),file=path.join(root,'contended');
  await fs.promises.mkdir(file+'.lock');await fs.promises.writeFile(path.join(file+'.lock','owner.json'),JSON.stringify({pid:2147483647,token:'dead'}));
  const attempts=await Promise.all(Array.from({length:12},()=>acquireLock(file,{waitMs:50})));
  const winners=attempts.filter(Boolean);assert.equal(winners.length,1);
  const owner=JSON.parse(await fs.promises.readFile(path.join(file+'.lock','owner.json'),'utf8'));assert.equal(owner.pid,process.pid);
  await winners[0]();assert.equal((await fs.promises.readdir(root)).length,0);
});

test('orphaned reaper markers remain recoverable across concurrent and later attempts',async t=>{
  const root=await temp(t),file=path.join(root,'orphaned');
  await fs.promises.writeFile(file+'.lock.reap',JSON.stringify({pid:2147483647,token:'abandoned-cleanup'}));
  for(let attempt=0;attempt<2;attempt++){
    await fs.promises.mkdir(file+'.lock');await fs.promises.writeFile(path.join(file+'.lock','owner.json'),JSON.stringify({pid:2147483647,token:'dead-'+attempt}));
    const results=await Promise.all(Array.from({length:8},()=>acquireLock(file,{waitMs:50})));
    const winners=results.filter(Boolean);assert.equal(winners.length,1);await winners[0]();
  }
  const empty=path.join(root,'empty');await fs.promises.writeFile(empty+'.lock.reap','');const old=new Date(Date.now()-700000);await fs.promises.utimes(empty+'.lock.reap',old,old);
  await fs.promises.mkdir(empty+'.lock');await fs.promises.writeFile(path.join(empty+'.lock','owner.json'),JSON.stringify({pid:2147483647,token:'dead'}));
  const release=await acquireLock(empty);assert.equal(typeof release,'function');await release();
});
