'use strict';
// Synthetic data only. Browser binaries and results stay inside this project.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
process.env.PLAYWRIGHT_BROWSERS_PATH ||= path.join(root,'.tools','browsers');
const {chromium}=require('playwright');
const {dashboard}=require('../src/dashboard');
const {summarize}=require('../src/indexer');
const {cards}=require('../src/pricing');
const {decimal}=require('../src/money');
const output=path.join(root,'artifacts','ui');fs.mkdirSync(output,{recursive:true});
const now=new Date('2026-10-16T18:00:00Z');
const settings={selectedMonth:'2026-10',assumedTier:'standard',billingProjectIds:[],billingRefreshMinutes:15,rateOverrides:cards.map(c=>({...c,from:'2026-10-01',source:'Synthetic test fixture rates'}))};
const events=[];
for(let day=1;day<=16;day++)for(let request=0;request<(day%4+1)*4;request++)events.push({id:`example-${day}-${request}`,session:`example-session-${day}`,timestamp:`2026-10-${String(day).padStart(2,'0')}T10:00:00Z`,model:request%3?'gpt-6-astra':'gpt-6-luna',tier:'standard',provider:'openai',source:request%2?'Codex desktop':'Codex in VS Code',usage:{input:26000+day*600,cached:18000+day*300,write:5000,output:1400+day*50,reasoning:500+day*20},issue:null});
const summary=summarize(events,settings,now);summary.diagnostics={files:24,retainedFiles:24,bytesRead:0,elapsedMs:12,parseErrors:0,resets:0,errors:[]};
const billingRows=summary.days.map(d=>({date:d.label,project:'Example project',lineItem:'Text model usage (example)',quantity:d.input+d.output,quantityUnit:'tokens',amount:(BigInt(d.amount)+decimal('0.20')).toString()}));
const billing={month:'2026-10',rows:billingRows,amount:billingRows.reduce((n,r)=>n+BigInt(r.amount),0n).toString(),fetchedAt:new Date().toISOString(),end:now.getTime()/1000};
const view={summary,billing,billingHistory:[billing],fx:{rate:94.97,date:'2026-10-16',source:'Example reference rate'},settings,connected:true};
const palettes={
  dark:{'editor-background':'#1f1f1f','editor-foreground':'#cccccc','descriptionForeground':'#a7a7a7','panel-border':'#454545','sideBar-background':'#181818','button-background':'#0078d4','button-foreground':'#ffffff','charts-blue':'#4daafc','charts-orange':'#d18616','charts-green':'#89d185','charts-yellow':'#cca700','charts-purple':'#b180d7'},
  light:{'editor-background':'#ffffff','editor-foreground':'#333333','descriptionForeground':'#616161','panel-border':'#d4d4d4','sideBar-background':'#f8f8f8','button-background':'#005fb8','button-foreground':'#ffffff','charts-blue':'#006bb3','charts-orange':'#9a5d00','charts-green':'#187b39','charts-yellow':'#8b6500','charts-purple':'#7d3eac','textLink-foreground':'#006ab1','focusBorder':'#005fb8','button-secondaryBackground':'#e5e5e5','button-secondaryForeground':'#333333'}
};
async function main(){
  const browser=await chromium.launch({headless:true});const checks=[];const errors=[];
  try {
    for(const [theme,vars]of Object.entries(palettes)){
      let html=dashboard(view);const nonce=html.match(/<style nonce="([^"]+)"/)[1];
      html=html.replace('<body>','<body class="vscode-'+theme+'">').replace('</head>','<style nonce="'+nonce+'">:root{'+Object.entries(vars).map(([k,v])=>'--vscode-'+k+':'+v).join(';')+'}</style></head>');
      const file=path.join(output,'example-'+theme+'.html');fs.writeFileSync(file,html);
      const page=await browser.newPage({viewport:{width:1440,height:1050}});
      await page.addInitScript(()=>{window.__messages=[];window.acquireVsCodeApi=()=>({getState:()=>JSON.parse(sessionStorage.getItem('ledger-state')||'null'),setState:s=>sessionStorage.setItem('ledger-state',JSON.stringify(s)),postMessage:m=>window.__messages.push(m)});});
      page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
      await page.goto(require('node:url').pathToFileURL(file).href);
      for(const tab of ['Overview','Daily','Monthly','Tokens']){
        await page.getByRole('tab',{name:tab,exact:true}).click();
        assert.equal(await page.getByRole('tab',{name:tab,exact:true}).getAttribute('aria-selected'),'true');
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,theme+' '+tab+' overflows');
        await page.screenshot({path:path.join(output,theme+'-'+tab.toLowerCase()+'.png')});checks.push(theme+' '+tab);
      }
      await page.reload();assert.equal(await page.getByRole('tab',{name:'Tokens',exact:true}).getAttribute('aria-selected'),'true','Tab selection survives refresh');
      await page.getByRole('tab',{name:'Overview',exact:true}).focus();await page.keyboard.press('ArrowRight');assert.equal(await page.getByRole('tab',{name:'Daily',exact:true}).getAttribute('aria-selected'),'true');
      await page.setViewportSize({width:390,height:844});
      for(const tab of ['Overview','Daily','Monthly','Tokens']){await page.getByRole('tab',{name:tab,exact:true}).click();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'Narrow '+tab+' overflows');}
      await page.getByRole('tab',{name:'Overview',exact:true}).click();await page.screenshot({path:path.join(output,theme+'-narrow.png'),fullPage:true});
      await page.getByRole('button',{name:'Export',exact:true}).click();assert.ok((await page.evaluate(()=>window.__messages)).some(m=>m.action==='export'));
      await page.close();
    }
    assert.deepEqual(errors,[],'No browser/CSP errors');
    fs.writeFileSync(path.join(output,'verification.json'),JSON.stringify({syntheticData:true,checks,keyboard:true,persistence:true,narrow:true,errors},null,2));
    console.log(JSON.stringify({checks:checks.length,keyboard:true,persistence:true,narrow:true,errors,output}));
  } finally {await browser.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
