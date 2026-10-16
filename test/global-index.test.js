'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {Indexer}=require('../src/indexer');
const NOW=new Date('2026-10-16T12:00:00Z');
function meta(id,project){return {type:'session_meta',timestamp:'2026-10-16T01:00:00Z',payload:{id,timestamp:'2026-10-16T01:00:00Z',originator:'Codex Desktop',source:'vscode',model_provider:'openai',cwd:project}};}
const context={type:'turn_context',payload:{model:'gpt-6-astra',service_tier:'default'}};
function count(n){const raw=m=>({input_tokens:100*m,cached_input_tokens:20*m,cache_write_input_tokens:30*m,output_tokens:10*m,reasoning_output_tokens:4*m});return {type:'event_msg',timestamp:`2026-10-16T02:00:${String(n).padStart(2,'0')}Z`,payload:{type:'token_count',info:{total_token_usage:raw(n),last_token_usage:raw(1)}}};}
function jsonl(rows){return rows.map(r=>JSON.stringify(r)).join('\n')+'\n';}
test('independent windows share one index across projects and never lose records or double count',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'ledger-global-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const home=path.join(root,'codex'),sessions=path.join(home,'sessions');await fs.mkdir(sessions,{recursive:true});
  const cache=path.join(root,'global','index.json'),one=path.join(sessions,'one.jsonl'),two=path.join(sessions,'two.jsonl');
  await fs.writeFile(one,jsonl([meta('session-one','/project/one'),context,count(1)]));
  const a=new Indexer(cache),b=new Indexer(cache);
  assert.equal((await a.scan(home,{},NOW)).totals.month.count,1);
  assert.equal((await b.scan(home,{},NOW)).diagnostics.bytesRead,0);
  await fs.appendFile(one,jsonl([count(2)]));
  const results=await Promise.all([a.scan(home,{},NOW),b.scan(home,{},NOW)]);
  assert.ok(results.every(r=>r.totals.month.count===2));
  assert.equal(results[0].totals.month.amount,results[1].totals.month.amount);
  assert.equal(results.reduce((sum,r)=>sum+r.diagnostics.bytesRead,0),Buffer.byteLength(jsonl([count(2)])));
  await fs.writeFile(two,jsonl([meta('session-two','/different/project'),context,count(1)]));
  assert.equal((await b.scan(home,{},NOW)).totals.month.count,3);
  await fs.unlink(two);
  assert.equal((await a.scan(home,{},NOW)).totals.month.count,3,'the older window reloads the shared checkpoint before writing');
  const final=new Indexer(cache);assert.equal((await final.scan(home,{},NOW)).totals.month.count,3);
  if(process.platform==='win32')assert.equal((await final.scan(home.toUpperCase()+path.sep,{},NOW)).totals.month.count,3,'case and trailing separators cannot erase retained history');
  assert.equal(JSON.parse(await fs.readFile(cache,'utf8')).version,4);
});
test('bundled rate cards conform to their own custom-rate schema',()=>{
  const {cards,validCard}=require('../src/pricing');
  assert.ok(cards.every(validCard),'Rate multipliers must not retain floating point tails');
});
test('manifest activates independently of project trust or workspace type',()=>{
  const pkg=require('../package.json');
  assert.deepEqual(pkg.extensionKind,['ui']);
  assert.ok(pkg.activationEvents.includes('onStartupFinished'));
  assert.equal(pkg.capabilities.untrustedWorkspaces.supported,true);
  assert.equal(pkg.capabilities.virtualWorkspaces.supported,true);
  assert.ok(Object.values(pkg.contributes.configuration.properties).every(p=>p.scope==='application'));
  assert.equal(pkg.contributes.views.aiCostLedger[0].id,'aiCostLedger.summary');
});
