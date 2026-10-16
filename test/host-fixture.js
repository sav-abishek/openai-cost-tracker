'use strict';
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../.test-host'),home=path.join(root,'codex-fixture');
fs.mkdirSync(path.join(home,'sessions'),{recursive:true});
const day=new Date().toISOString().slice(0,10);
for(let n=1;n<=3;n++){
  const count={input_tokens:100,cached_input_tokens:20,cache_write_input_tokens:30,output_tokens:10,reasoning_output_tokens:4};
  const rows=[{type:'session_meta',timestamp:day+'T00:00:00Z',payload:{id:'host-fixture-'+n,timestamp:day+'T00:00:00Z',model_provider:'openai',originator:n===1?'Codex Desktop':'vscode',source:'vscode',cwd:path.join(root,'project-'+n)}},{type:'turn_context',payload:{model:'gpt-6-astra',service_tier:'default'}},{type:'event_msg',timestamp:day+'T00:00:01Z',payload:{type:'token_count',info:{total_token_usage:count,last_token_usage:count}}}];
  fs.writeFileSync(path.join(home,'sessions','fixture-'+n+'.jsonl'),rows.map(r=>JSON.stringify(r)).join('\n')+'\n');
  fs.mkdirSync(path.join(root,'project-'+n),{recursive:true});
}
console.log(home);
