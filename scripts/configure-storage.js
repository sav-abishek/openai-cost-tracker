'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {parse,modify,applyEdits}=require('jsonc-parser');
const {usageCachePath}=require('../src/shared-state');
const root=path.resolve(__dirname,'..'),directory=path.join(root,'local-data');
const configRoot=process.platform==='win32'?path.join(process.env.APPDATA,'Code','User'):process.platform==='darwin'?path.join(os.homedir(),'Library','Application Support','Code','User'):path.join(process.env.XDG_CONFIG_HOME||path.join(os.homedir(),'.config'),'Code','User');
const settingsFile=path.join(configRoot,'settings.json');
fs.mkdirSync(directory,{recursive:true});
const original=fs.existsSync(settingsFile)?fs.readFileSync(settingsFile,'utf8'):'{}\n';
const errors=[];const settings=parse(original,errors,{allowTrailingComma:true});
if(errors.length || !settings || typeof settings!=='object' || Array.isArray(settings))throw new Error('Existing VS Code settings could not be safely parsed; no settings changed.');
const backup=path.join(directory,'settings-before-storage-'+new Date().toISOString().replace(/[:.]/g,'-')+'.jsonc');
fs.writeFileSync(backup,original,{flag:'wx',mode:0o600});
const updated=applyEdits(original,modify(original,['aiCostLedger.dataDirectory'],directory,{formattingOptions:{insertSpaces:true,tabSize:2,eol:original.includes('\r\n')?'\r\n':'\n'}}));
fs.mkdirSync(configRoot,{recursive:true});fs.writeFileSync(settingsFile,updated);
const codexHome=settings['aiCostLedger.codexHome']||process.env.CODEX_HOME||path.join(os.homedir(),'.codex');
const legacyIndex=path.join(configRoot,'globalStorage','abishek-local.ai-cost-ledger','usage-index.json');
const nextIndex=usageCachePath(codexHome,directory);
let indexMigrated=false;
if(fs.existsSync(legacyIndex)&&!fs.existsSync(nextIndex)){
  const candidate=JSON.parse(fs.readFileSync(legacyIndex,'utf8'));
  if(candidate.version===4&&path.resolve(candidate.home)===path.resolve(codexHome)){fs.copyFileSync(legacyIndex,nextIndex,fs.constants.COPYFILE_EXCL);indexMigrated=true;}
}
console.log(JSON.stringify({dataDirectory:directory,updatedUserSettings:true,legacyIndexCopied:indexMigrated,reloadRequired:true}));
