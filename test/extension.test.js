'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),os=require('node:os');
const {EventEmitter}=require('node:events');
const {SharedState}=require('../src/shared-state');
const {scopeKey}=require('../src/billing');
function world(t,options={}) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'ai-cost-ledger-test-'));
  const secrets=new Map(options.key?[['openaiOrganizationAdminKey',options.key]]:[]),secretEvents=new EventEmitter(),windows=[];
  let costsCalls=0,fxCalls=0;
  const common={directory,secrets,secretEvents,windows,
    fetchCosts:async(key,config)=>{costsCalls++;return options.fetchCosts?options.fetchCosts(key,config):{scope:scopeKey(config),month:config.selectedMonth,amount:'1230000000000',rows:[],fetchedAt:new Date().toISOString()};},
    fetchFx:async()=>{fxCalls++;return {rate:95,date:'2026-10-16',source:'Test',fetchedAt:new Date().toISOString()};},
    get costsCalls(){return costsCalls;},get fxCalls(){return fxCalls;}};
  t.after(async()=>{for(const window of windows)window.dispose();await new Promise(r=>setTimeout(r,100));assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir())+path.sep+'ai-cost-ledger-test-'));await fs.promises.rm(directory,{recursive:true,force:true});});
  return common;
}
function harness(common,options={}){
  let worker,tree,status;const commands=new Map(),configurationEvents=new EventEmitter(),workers=[];
  const summary={totals:{month:{amount:'0',count:0,unpriced:0}},diagnostics:{files:0}};
  class FakeWorker extends EventEmitter{constructor(_file,data){super();worker=this;workers.push(this);this.alive=true;this.cachePath=data.workerData.cachePath;}postMessage(m){if(options.throwPost)throw new Error('failed');if(this.alive)queueMicrotask(()=>this.emit('message',{id:m.id,result:{...summary,month:m.settings.selectedMonth}}));}terminate(){this.alive=false;return Promise.resolve();}}
  class VSCodeEmitter {constructor(){this.events=new EventEmitter();this.event=fn=>{this.events.on('event',fn);return{dispose:()=>this.events.off('event',fn)};};}fire(value){this.events.emit('event',value);}dispose(){this.events.removeAllListeners();}}
  const disposable={dispose(){}};
  const globalValues={usdInr:95,...options.globalValues},workspaceValues={...options.workspaceValues},executed=[],notices=[];
  const vscode={EventEmitter:VSCodeEmitter,ExtensionMode:{Production:1,Development:2,Test:3},TreeItemCollapsibleState:{None:0},
    window:{createOutputChannel:()=>({...disposable,appendLine(){}}),createStatusBarItem:()=>{status={...disposable,show(){this.visible=true;}};return status;},registerTreeDataProvider:(_id,p)=>{tree=p;return disposable;},
      showInputBox:async()=>options.inputKey||'new-test-admin-key',showInformationMessage(...args){notices.push(args);},showWarningMessage(){},showErrorMessage(){}},
    StatusBarAlignment:{Right:2},ThemeColor:class{},
    workspace:{getConfiguration:()=>({inspect:key=>({globalValue:globalValues[key],workspaceValue:workspaceValues[key]}),get:(key,fallback)=>workspaceValues[key]??globalValues[key]??fallback}),onDidChangeConfiguration:fn=>{configurationEvents.on('change',fn);return{dispose:()=>configurationEvents.off('change',fn)};}},
    commands:{registerCommand:(name,fn)=>{commands.set(name,fn);return disposable;},executeCommand:async(...args)=>{executed.push(args);if(options.executeCommand)await options.executeCommand(...args);}}
  };
  const module={exports:{}};
  const sandbox={module,exports:module.exports,require:id=>{
    if(id==='vscode')return vscode;
    if(id==='node:worker_threads')return{Worker:FakeWorker};
    if(id==='./shared-state' && options.production)return{...require('../src/shared-state'),SharedState:class extends SharedState{constructor(){super(common.directory);}}};
    if(id==='./dashboard')return{dashboard:()=>'<html></html>'};
    if(id==='./billing')return{scopeKey,fetchCosts:common.fetchCosts,fetchFx:common.fetchFx};
    return require(id.startsWith('./')?path.resolve(__dirname,'../src',id):id);
  },__dirname:path.resolve(__dirname,'../src'),process:{...process,env:{...process.env,AI_COST_LEDGER_TEST_DATA_DIR:options.useConfiguredDirectory?undefined:common.directory}},Buffer,Date,setTimeout,clearTimeout,
    setInterval:()=>1,clearInterval:()=>{},queueMicrotask,console};
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname,'../src/extension.js'),'utf8'),sandbox);
  const state=new Map();
  const extContext={subscriptions:[],extensionMode:options.production?1:2,globalState:{get:key=>state.get(key),update:async(key,value)=>{state.set(key,value);}},
    secrets:{get:async key=>common.secrets.get(key),store:async(key,value)=>{common.secrets.set(key,value);common.secretEvents.emit('change',{key});},delete:async key=>{common.secrets.delete(key);common.secretEvents.emit('change',{key});},
      onDidChange:fn=>{common.secretEvents.on('change',fn);return{dispose:()=>common.secretEvents.off('change',fn)};}},globalStorageUri:{fsPath:path.join(common.directory,'unused-workspace-storage')}};
  const h={api:module.exports,extContext,getWorker:()=>worker,commands,workers,executed,notices,getTree:()=>tree,getStatus:()=>status,globalValues,workspaceValues,
    dispose(){for(const item of extContext.subscriptions)item.dispose();},change:async()=>{for(const fn of configurationEvents.listeners('change'))await fn({affectsConfiguration:()=>true});}};
  common.windows.push(h);return h;
}
const waitFor=async condition=>{const end=Date.now()+2000;while(!condition()){if(Date.now()>end)throw new Error('Condition timed out');await new Promise(r=>setTimeout(r,20));}};
async function installedFixture(common,metadata={}){
  const relativeLocation='abishek-local.ai-cost-ledger-0.2.0',directory=path.join(common.directory,'extensions',relativeLocation),inventory=path.join(path.dirname(directory),'extensions.json');
  await fs.promises.mkdir(directory,{recursive:true});await fs.promises.writeFile(inventory,JSON.stringify([{identifier:{id:'abishek-local.ai-cost-ledger'},relativeLocation,metadata}]));
  return{directory,inventory,extension:{extensionUri:{fsPath:directory}}};
}

test('activation registers global UI and worker failure makes subsequent refresh settle promptly',async t=>{
  const h=harness(world(t)),api=await h.api.activate(h.extContext);await api.ready;
  assert.equal(h.commands.size,7);assert.ok(api.getSnapshot().summary);assert.equal(h.getStatus().visible,true);
  assert.ok(h.getTree().getChildren().some(item=>item.command?.command==='aiCostLedger.open'));
  const w=h.getWorker();w.alive=false;w.emit('error',new Error('synthetic failure'));w.emit('exit',1);
  await Promise.race([api.refresh(),new Promise((_,reject)=>setTimeout(()=>reject(new Error('Refresh hung')),200))]);
  assert.match(api.getSnapshot().indexError,/unavailable/);
});
test('unexpected clean worker exit and postMessage errors settle without hanging',async t=>{
  const common=world(t),h=harness(common),api=await h.api.activate(h.extContext);await api.ready;
  h.getWorker().alive=false;h.getWorker().emit('exit',0);await api.refresh();assert.match(api.getSnapshot().indexError,/unavailable/);
  const broken=harness(common,{throwPost:true}),brokenApi=await broken.api.activate(broken.extContext);await brokenApi.ready;assert.match(brokenApi.getSnapshot().indexError,/request failed/);
});
test('month command switches accounting scope and rejects invalid future months',async t=>{
  const h=harness(world(t)),api=await h.api.activate(h.extContext);await api.ready;
  await h.commands.get('aiCostLedger.selectMonth')('2026-09');assert.equal(api.getSnapshot().settings.selectedMonth,'2026-09');
  await h.commands.get('aiCostLedger.selectMonth')('9999-13');assert.equal(api.getSnapshot().settings.selectedMonth,'2026-09');
});
test('workspace overrides cannot restrict the global source, billing scope or rate',async t=>{
  const common=world(t),h=harness(common,{globalValues:{codexHome:path.join(common.directory,'global-logs'),usdInr:95},workspaceValues:{codexHome:'C:/wrong',usdInr:1,billingProjectIds:['wrong'],organizationId:'wrong'}});
  const api=await h.api.activate(h.extContext);await api.ready;
  assert.equal(api.getSnapshot().settings.codexHome,path.join(common.directory,'global-logs'));assert.equal(api.getSnapshot().fx.rate,95);assert.equal(api.getSnapshot().settings.organizationId,'');assert.equal(api.getSnapshot().settings.billingProjectIds.length,0);
  assert.equal(api.getGlobalRuntimeInfo().workspaceScoped,false);assert.equal(path.dirname(api.getGlobalRuntimeInfo().cachePath),common.directory);
  h.globalValues.codexHome=path.join(common.directory,'another-global-home');await h.change();assert.equal(h.workers.length,2);assert.notEqual(h.workers[0].cachePath,h.workers[1].cachePath);
});
test('two windows share one fresh billing/FX fetch and one per-home cache',async t=>{
  const common=world(t,{key:'test-admin-key'}),a=harness(common,{globalValues:{usdInr:0}}),b=harness(common,{globalValues:{usdInr:0}});
  const [first,second]=await Promise.all([a.api.activate(a.extContext),b.api.activate(b.extContext)]);await Promise.all([first.ready,second.ready]);
  await waitFor(()=>!!first.getSnapshot().billing&&!!second.getSnapshot().billing);
  assert.equal(common.costsCalls,1);assert.equal(common.fxCalls,1);assert.equal(first.getGlobalRuntimeInfo().cachePath,second.getGlobalRuntimeInfo().cachePath);
  await a.commands.get('aiCostLedger.refresh')();assert.equal(common.costsCalls,2);
  const saved=await fs.promises.readFile(path.join(common.directory,'shared-state.json'),'utf8');assert.equal(saved.includes('test-admin-key'),false);
});
test('disconnect in one window invalidates another window in-flight result',async t=>{
  let finish;const waiting=new Promise(resolve=>{finish=resolve;});
  const common=world(t,{key:'old-admin-key',fetchCosts:async(_key,config)=>{await waiting;return{scope:scopeKey(config),month:config.selectedMonth,amount:'999',rows:[],fetchedAt:new Date().toISOString()};}});
  const a=harness(common),first=await a.api.activate(a.extContext);await waitFor(()=>common.costsCalls===1);
  const b=harness(common),second=await b.api.activate(b.extContext);await second.ready;
  await b.commands.get('aiCostLedger.disconnect')();finish();await first.ready;
  await waitFor(()=>!first.getSnapshot().connected);
  assert.equal(first.getSnapshot().billing,null);assert.equal(second.getSnapshot().billing,null);
  const shared=await new SharedState(common.directory).read();assert.equal(shared.auth.connected,false);assert.deepEqual(shared.billingHistory,{});
});
test('connect propagates to another open window through SecretStorage and shared state',async t=>{
  const common=world(t),a=harness(common),b=harness(common);
  const first=await a.api.activate(a.extContext),second=await b.api.activate(b.extContext);await Promise.all([first.ready,second.ready]);
  assert.equal(first.getSnapshot().connected,false);await a.commands.get('aiCostLedger.connect')();
  await waitFor(()=>second.getSnapshot().connected&&!!second.getSnapshot().billing);
  assert.equal(first.getSnapshot().billing.amount,second.getSnapshot().billing.amount);assert.equal(common.costsCalls,1);
});

test('production profile activation enables a known inventory entry with missing scope metadata once',async t=>{
  const common=world(t),fixture=await installedFixture(common);
  const h=harness(common,{production:true,executeCommand:async(command)=>{assert.equal(command,'workbench.extensions.action.toggleApplyToAllProfiles');const entries=JSON.parse(await fs.promises.readFile(fixture.inventory,'utf8'));entries[0].metadata.isApplicationScoped=true;await fs.promises.writeFile(fixture.inventory,JSON.stringify(entries));}});
  h.extContext.extension=fixture.extension;const api=await h.api.activate(h.extContext);await api.ready;
  assert.equal(h.executed.length,1);assert.equal(api.getSnapshot().globalScope.allProfiles,true);
  const another=harness(common,{production:true});another.extContext.extension=fixture.extension;const second=await another.api.activate(another.extContext);await second.ready;
  assert.equal(another.executed.length,0);assert.equal(second.getSnapshot().globalScope.allProfiles,true);
});
test('development activation never toggles profile installation metadata',async t=>{
  const common=world(t),fixture=await installedFixture(common,{isApplicationScoped:false});
  const h=harness(common);h.extContext.extension=fixture.extension;const api=await h.api.activate(h.extContext);await api.ready;assert.equal(h.executed.length,0);
});

test('configured global data directory is used while workspace override is ignored',async t=>{
  const common=world(t),chosen=path.join(common.directory,'private-data'),ignored=path.join(common.directory,'workspace-data');
  const h=harness(common,{useConfiguredDirectory:true,globalValues:{dataDirectory:chosen},workspaceValues:{dataDirectory:ignored}});
  const api=await h.api.activate(h.extContext);await api.ready;
  assert.equal(api.getGlobalRuntimeInfo().storagePath,chosen);assert.equal(path.dirname(api.getGlobalRuntimeInfo().cachePath),chosen);assert.equal(fs.existsSync(path.join(chosen,'shared-state.json')),true);assert.equal(fs.existsSync(ignored),false);
  h.globalValues.dataDirectory=path.join(common.directory,'changed-data');await h.change();
  assert.equal(api.getGlobalRuntimeInfo().storagePath,chosen);assert.equal(api.getSnapshot().globalScope.reloadRequired,true);assert.equal(h.notices.length,1);assert.match(h.notices[0][0],/reload all VS Code windows/);
  await h.change();assert.equal(h.notices.length,1);assert.equal(fs.existsSync(h.globalValues.dataDirectory),false);
});
test('development test directory takes precedence over application cache path',async t=>{
  const common=world(t),configured=path.join(common.directory,'must-not-write');
  const h=harness(common,{globalValues:{dataDirectory:configured}}),api=await h.api.activate(h.extContext);await api.ready;
  assert.equal(api.getGlobalRuntimeInfo().storagePath,common.directory);assert.equal(fs.existsSync(configured),false);
});

test('status and Activity Bar distinguish missing local records from provider zero',async t=>{
  const common=world(t),h=harness(common),api=await h.api.activate(h.extContext);await api.ready;
  assert.match(h.getStatus().text,/No local records/);assert.equal(h.getTree().getChildren()[0].label,'No local records');assert.doesNotMatch(h.getStatus().text,/\$0/);
  const billed=world(t,{key:'test-key',fetchCosts:async(_key,config)=>({scope:scopeKey(config),month:config.selectedMonth,amount:'0',rows:[],fetchedAt:new Date().toISOString()})});
  const p=harness(billed),reported=await p.api.activate(p.extContext);await reported.ready;
  assert.match(p.getStatus().text,/\$0\.00/);assert.match(p.getTree().getChildren()[0].label,/^\$0\.00/);
});
test('concurrent production windows serialize all-profiles toggle and reread metadata',async t=>{
  const common=world(t),fixture=await installedFixture(common,{isApplicationScoped:false});
  let releaseToggle,toggles=0;const gate=new Promise(resolve=>{releaseToggle=resolve;});
  const toggle=async()=>{toggles++;await gate;const content=JSON.parse(await fs.promises.readFile(fixture.inventory,'utf8'));content[0].metadata.isApplicationScoped=!content[0].metadata.isApplicationScoped;await fs.promises.writeFile(fixture.inventory,JSON.stringify(content));};
  const a=harness(common,{production:true,executeCommand:toggle}),b=harness(common,{production:true,executeCommand:toggle});
  a.extContext.extension=fixture.extension;b.extContext.extension=fixture.extension;
  const [first,second]=await Promise.all([a.api.activate(a.extContext),b.api.activate(b.extContext)]);
  await waitFor(()=>toggles===1);await new Promise(r=>setTimeout(r,80));assert.equal(toggles,1);releaseToggle();await Promise.all([first.ready,second.ready]);
  assert.equal(toggles,1);assert.equal(JSON.parse(await fs.promises.readFile(fixture.inventory,'utf8'))[0].metadata.isApplicationScoped,true);
});
test('profile activation never toggles an unmatched extension installation',async t=>{
  const common=world(t),fixture=await installedFixture(common,{isApplicationScoped:false});
  const h=harness(common,{production:true});h.extContext.extension={extensionUri:{fsPath:path.join(path.dirname(fixture.directory),'different-version')}};
  const api=await h.api.activate(h.extContext);await api.ready;assert.equal(h.executed.length,0);
});
