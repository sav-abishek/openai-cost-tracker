'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { dashboard } = require('../src/dashboard');
const { summarize } = require('../src/indexer');
const { decimal } = require('../src/money');

const now = new Date('2026-10-16T12:00:00Z');
const usage = {input:100, cached:20, write:30, output:10, reasoning:4};
const event = (id, day, model = 'gpt-6-astra') => ({id, session:id, timestamp:`2026-10-${day}T10:00:00Z`, model, tier:'standard', provider:'openai', source:'Codex in VS Code', usage, issue:null});
function fixture(extra = {}) {
  const summary = summarize([event('priced','16'),event('unpriced','15','unknown-model')], {}, now);
  summary.diagnostics = {files:2, parseErrors:0, errors:[], elapsedMs:4, bytesRead:80};
  return {summary, billing:null, fx:{rate:83, date:'2026-10-16', source:'Test reference'}, settings:{selectedMonth:'2026-10', billingRefreshMinutes:15, billingProjectIds:[], assumedTier:'standard'}, connected:false, ...extra};
}
const scriptOf = html => html.match(/<script nonce="[^"]+">([\s\S]+?)<\/script>/)[1];
const dailyRow = (html,date) => html.match(new RegExp('<tr><th scope="row"><time datetime="'+date+'">[\\s\\S]+?<\\/tr>'))[0];

test('dashboard exposes four semantic tabs and contains all accounting details without external assets', () => {
  const html = dashboard(fixture());
  for (const name of ['overview','daily','monthly','tokens']) {
    assert.match(html, new RegExp('role="tab" id="tab-'+name+'" aria-controls="panel-'+name+'"'));
    assert.match(html, new RegExp('id="panel-'+name+'" role="tabpanel" aria-labelledby="tab-'+name+'"'));
  }
  for (const label of ['Daily cost & usage','Monthly usage history','Cost by token type','Inside output tokens','Local activity by model','Local activity by app','Coverage & assumptions','OpenAI billing line items']) assert.ok(html.includes(label));
  assert.ok(html.includes('Skip to dashboard content'));
  assert.ok(html.includes('All days and months use UTC'));
  assert.ok(html.includes('Ordinary ChatGPT conversations and subscription charges'));
  assert.ok(html.includes('Global tracking across your projects'));
  assert.equal(/<(script|link|img)[^>]+(?:src|href)=/.test(html),false);
  assert.equal(/\s(?:style|onclick|onkeydown)=/.test(html),false);
  assert.doesNotThrow(() => new vm.Script(scriptOf(html)));
});

test('daily ledger does not invent zeros after the fetched billing interval', () => {
  const billing = {month:'2026-10',amount:decimal('1.25').toString(),fetchedAt:'2026-10-15T12:00:00Z',end:Date.UTC(2026,9,15,12)/1000,rows:[{date:'2026-10-15',amount:decimal('1.25').toString(),project:null,lineItem:'Model tokens'}]};
  const html = dashboard(fixture({billing,connected:true}));
  assert.match(dailyRow(html,'2026-10-15'),/\$1\.2500/);
  assert.match(dailyRow(html,'2026-10-15'),/Partial day/);
  assert.match(dailyRow(html,'2026-10-16'),/Not fetched/);
  assert.equal(dailyRow(html,'2026-10-16').includes('$0.0000'),false);
  assert.match(html,/Hollow points show partial values/);
});

test('all-unpriced local day is a chart gap and previous-month billing cannot appear as this month', () => {
  const html = dashboard(fixture({billing:{month:'2026-09',amount:decimal('999').toString(),rows:[],fetchedAt:now.toISOString()},connected:true}));
  assert.match(dailyRow(html,'2026-10-15'),/Unpriced/);
  assert.equal(html.includes('2026-10-15: Local estimate $0'),false);
  assert.equal(html.includes('$999'),false);
  assert.match(html,/Awaiting billing/);
  assert.match(html,/2026-10-16: Local estimate \$0\.001395/);
});

test('negative provider credits keep their sign in daily totals and the trend', () => {
  const html = dashboard(fixture({billing:{month:'2026-10',amount:decimal('-1').toString(),rows:[{date:'2026-10-15',amount:decimal('-1').toString(),lineItem:'Credit',project:null}],fetchedAt:now.toISOString(),end:now.getTime()/1000},connected:true}));
  assert.match(dailyRow(html,'2026-10-15'),/\$-1\.0000/);
  assert.match(html,/2026-10-15: OpenAI reported \$-1\.000000/);
  assert.match(html,/class="zero-line"/);
});

// Exercise the webview script without a browser dependency: keyboard navigation,
// command dispatch and VS Code state persistence are the behavior being tested.
function scriptHarness(previous) {
  const callbacks = [], writes = [], messages = [];
  let document;
  function element(id, dataset = {}) {
    return {id,dataset,attributes:{},hidden:false,tabIndex:0,listeners:{},textContent:'Action',disabled:false,
      setAttribute(key,value){this.attributes[key]=value;},
      addEventListener(name,callback){this.listeners[name]=callback;},
      focus(){document.activeElement=this;},
      closest(){return null;}};
  }
  const tabs = ['overview','daily','monthly','tokens'].map(name=>element('tab-'+name,{tab:name}));
  const panels = tabs.map(tab=>element('panel-'+tab.dataset.tab));
  const action = element('',{action:'selectMonth',month:'2026-09'});
  const shortcut = element('',{goTab:'daily'});
  const disclosure = element('accuracy-details');
  const status = element('action-status');
  const all = [...tabs,...panels,action,shortcut,disclosure,status];
  document = {activeElement:null,
    querySelectorAll(selector){return selector==='[data-tab]'?tabs:selector==='[role="tabpanel"]'?panels:selector==='[data-go-tab]'?[shortcut]:selector==='[data-action]'?[action]:[];},
    getElementById(id){return all.find(node=>node.id===id);}};
  const window = {scrollY:0,listeners:{},scrollTo(_,y){this.scrollY=y;},addEventListener(name,callback){this.listeners[name]=callback;}};
  const context = {document,window,acquireVsCodeApi:()=>({getState:()=>previous,setState:value=>writes.push(JSON.parse(JSON.stringify(value))),postMessage:value=>messages.push(JSON.parse(JSON.stringify(value)))}),requestAnimationFrame:callback=>{callbacks.push(callback);return callbacks.length;},setTimeout:()=>{}};
  vm.runInNewContext(scriptOf(dashboard(fixture())),context);
  while(callbacks.length)callbacks.shift()();
  return {tabs,panels,action,shortcut,disclosure,document,window,writes,messages,flush:()=>{while(callbacks.length)callbacks.shift()();}};
}

test('webview restores active tab and scroll, then preserves each tab position with keyboard navigation', () => {
  const h = scriptHarness({tab:'tokens',scroll:420,scrollPositions:{tokens:420,overview:30},detailsOpen:true,focus:'tab-tokens'});
  assert.equal(h.panels[3].hidden,false);
  assert.equal(h.tabs[3].attributes['aria-selected'],'true');
  assert.equal(h.tabs[0].tabIndex,-1);
  assert.equal(h.window.scrollY,420);
  assert.equal(h.document.activeElement,h.tabs[3]);
  assert.equal(h.disclosure.open,true);
  let prevented = false;
  h.tabs[3].listeners.keydown({key:'ArrowRight',preventDefault(){prevented=true;}});
  assert.equal(prevented,true);
  assert.equal(h.panels[0].hidden,false);
  assert.equal(h.window.scrollY,30);
  h.tabs[3].listeners.click();
  assert.equal(h.window.scrollY,420);
  assert.equal(h.writes.at(-1).tab,'tokens');
});

test('webview tab shortcuts navigate and original action/month command contract stays intact', () => {
  const h = scriptHarness({tab:'overview'});
  h.shortcut.listeners.click();
  assert.equal(h.tabs[1].attributes['aria-selected'],'true');
  h.window.scrollY=150;
  h.window.listeners.scroll();h.flush();
  assert.equal(h.writes.at(-1).scrollPositions.daily,150);
  h.action.listeners.click();
  assert.deepEqual(h.messages,[{action:'selectMonth',month:'2026-09'}]);
  assert.equal(h.action.disabled,true);
});
