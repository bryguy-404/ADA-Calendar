import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {execFileSync, spawn} from 'node:child_process';
import path from 'node:path';

export const stackDirectory = '/private/tmp/ada-crm-fullstack-local';
export const container = 'supabase_db_ada-crm-integration-test';
export async function prepareCrmStack(calendarDir, crmDir) {
  const directory=path.join(stackDirectory,'supabase');mkdirSync(path.join(directory,'migrations'),{recursive:true});
  writeFileSync(path.join(directory,'config.toml'),`project_id = "ada-crm-integration-test"
[api]
enabled = true
port = 55521
schemas = ["public"]
extra_search_path = ["public", "extensions"]
[db]
port = 55522
shadow_port = 55520
major_version = 17
[studio]
enabled = false
port = 55523
[local_smtp]
enabled = true
port = 55524
[storage]
enabled = false
[analytics]
enabled = false
port = 55527
[auth]
enabled = true
site_url = "https://crm.integration.invalid"
enable_signup = false
minimum_password_length = 12
[auth.email]
enable_signup = true
enable_confirmations = true
`);
  const files=['supabase-schema.sql','task-notifications.sql','task-identity.sql','task-assigner.sql','resources.sql','calendar-integration.sql','my-day-emails.sql','calendar-sync.sql'];
  files.forEach((file,index)=>writeFileSync(path.join(directory,'migrations',`20260915000${index}_${file}`),readFileSync(path.join(crmDir,'deploy',file))));
  const cli=path.join(calendarDir,'node_modules/.bin/supabase');
  // Capture CLI output privately: status/start output may contain local keys.
  async function run(args) {
    const chunks=[];const child=spawn(cli,[...args,'--workdir',stackDirectory],{stdio:['ignore','pipe','pipe']});
    for(const stream of [child.stdout,child.stderr])stream.on('data',data=>chunks.push(data));
    const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve);});
    writeFileSync(path.join(stackDirectory,'supabase-private.log'),Buffer.concat(chunks),{mode:0o600});
    if(code!==0)throw new Error('Isolated CRM database command failed; inspect the private local log without exposing keys.');
  }
  await run(['start','--exclude','studio,storage-api,imgproxy,postgres-meta,edge-runtime,logflare,vector,supavisor']);
  // Only this newly created, explicitly disposable CRM test stack is reset.
  await run(['db','reset','--local','--yes']);
  return readStatus(cli,stackDirectory,'http://127.0.0.1:55521');
}
export function readStatus(cli,directory,expectedUrl) {
  const output=execFileSync(cli,['status','--workdir',directory,'--output','json'],{encoding:'utf8',stdio:['ignore','pipe','pipe']});
  const data=JSON.parse(output.slice(output.indexOf('{'),output.lastIndexOf('}')+1));
  if(data.API_URL!==expectedUrl)throw new Error('Refusing unexpected database endpoint.');
  return data;
}
