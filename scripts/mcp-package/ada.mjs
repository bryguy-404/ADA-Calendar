import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const directory=path.dirname(fileURLToPath(import.meta.url)),root=path.dirname(path.dirname(directory));
const action=process.argv[2];
const env={...process.env,ADA_CALENDAR_SESSION_FILE:process.env.ADA_CALENDAR_SESSION_FILE||path.join(root,'session.json')};
if(['start','login','verify'].includes(action)){
  const result=spawnSync(process.execPath,[path.join(directory,({start:'server',login:'login',verify:'verify'})[action]+'.cjs'),...process.argv.slice(3)],{env,stdio:'inherit'});
  process.exitCode=result.status??1;
} else if(action==='connect') {
  const cli=process.platform==='win32'?'claude.exe':'claude';
  const prior=spawnSync(cli,['mcp','get','ada-calendar-requester'],{encoding:'utf8'});
  if(prior.error)throw new Error('Claude Code is not on PATH. Install/sign in to Claude Code first.');
  if(prior.status===0)throw new Error('ada-calendar-requester already exists. Follow the update/rollback instructions; no configuration was changed.');
  const config=JSON.parse(readFileSync(path.join(directory,'claude-mcp.json'),'utf8')).mcpServers['ada-calendar-requester'];
  // Retain the exact registered config for removal/update rollback; never copy credentials.
  writeFileSync(path.join(directory,'registered-config.json'),JSON.stringify(config,null,2)+'\n',{mode:0o600});
  const result=spawnSync(cli,['mcp','add-json','--scope','user','ada-calendar-requester',JSON.stringify(config)],{stdio:'inherit'});
  process.exitCode=result.status??1;
} else {
  console.error('Usage: node ada.mjs login | verify YYYY-MM-DD | connect | start');process.exitCode=1;
}
