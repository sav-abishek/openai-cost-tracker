'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
async function run(){
  const vscode=require('vscode');
  const extension=vscode.extensions.getExtension('abishek-local.ai-cost-ledger');
  assert.ok(extension,'Extension discovered');
  const api=await extension.activate();await api.ready;
  const first=api.getSnapshot();assert.ok(first.summary,'Local index produced a summary');
  assert.equal(first.summary.diagnostics.parseErrors,0);
  assert.equal(first.connected,false,'No billing credential inherited into isolated test profile');
  assert.equal(extension.packageJSON.capabilities.untrustedWorkspaces.supported,true);
  assert.equal(extension.packageJSON.capabilities.virtualWorkspaces.supported,true);
  if(process.env.AI_COST_LEDGER_HOST_FIXTURE==='1') {
    assert.equal(first.summary.totals.all.count,3,'All projects are included, irrespective of the opened folder');
    assert.equal(first.summary.totals.all.input,300);
  }
  const commands=await vscode.commands.getCommands();
  for(const suffix of ['open','selectMonth','refresh','connect','disconnect','export','fx'])assert.ok(commands.includes('aiCostLedger.'+suffix));
  assert.ok(commands.includes('aiCostLedger.summary.focus'),'Global activity bar view registered');
  await vscode.commands.executeCommand('aiCostLedger.summary.focus');
  await vscode.commands.executeCommand('aiCostLedger.open');
  await api.refresh();
  const second=api.getSnapshot();
  let profileScopeVerified=false;
  if(process.env.AI_COST_LEDGER_TEST_INSTALLED_PATH) {
    const installed=process.env.AI_COST_LEDGER_TEST_INSTALLED_PATH;
    const inventoryPath=path.join(path.dirname(installed),'extensions.json');
    const metadata=()=>JSON.parse(fs.readFileSync(inventoryPath,'utf8')).find(e=>e.identifier.id==='abishek-local.ai-cost-ledger'&&e.relativeLocation===path.basename(installed))?.metadata;
    if(!metadata()?.isApplicationScoped) await vscode.commands.executeCommand('workbench.extensions.action.toggleApplyToAllProfiles','abishek-local.ai-cost-ledger',{location:vscode.Uri.file(installed)});
    profileScopeVerified=metadata()?.isApplicationScoped===true;
    assert.equal(profileScopeVerified,true,'Native apply-to-all-profiles action verified');
  }
  const report={passed:true,extensionVersion:extension.packageJSON.version,commands:7,index:first.summary.diagnostics,
    secondIndex:second.summary.diagnostics,fx:second.fx,providerBillingTested:false,webviewOpened:true,activityBarOpened:true,
    profileScopeVerified,workspaceTrusted:vscode.workspace.isTrusted,workspaceFolders:vscode.workspace.workspaceFolders?.length||0};
  const out=process.env.AI_COST_LEDGER_HOST_REPORT || path.resolve(__dirname,'../artifacts/host-test-result.json');fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,JSON.stringify(report,null,2));
  console.log('AI Cost Ledger extension-host checks passed');
}
module.exports={run};
