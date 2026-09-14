/** Real local applications + separate Auth/SQL stacks. No hosted traffic or sends. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {execFileSync,spawn} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync,openSync,closeSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:net';
import path from 'node:path';
import {createClient} from '@supabase/supabase-js';
import {chromium,expect} from '@playwright/test';
import {DEFAULT_SETTINGS,DEFAULT_PRIORITIES} from '../../src/lib/defaults.ts';
import {localDate,addDays,nextWorkDate} from '../../src/lib/time.ts';
import {prepareCrmStack,readStatus,stackDirectory,container} from './stack.mjs';
import {exerciseFlows} from './flows.mjs';

const calendarDir=fileURLToPath(new URL('../../',import.meta.url));
const crmDir=path.resolve(process.argv[2]||path.join(calendarDir,'../ada-crm-calendar-integration'));
const outputDir=path.join(calendarDir,'test-results/crm-fullstack');mkdirSync(outputDir,{recursive:true});
const transport=fileURLToPath(new URL('./transport.mjs',import.meta.url));
const ownerOrigin='http://127.0.0.1:3193',crmOrigin='https://crm.integration.invalid',authOrigin='https://ada-crm-integration.supabase.co';
const cli=path.join(calendarDir,'node_modules/.bin/supabase');
const typeFile=path.join(calendarDir,'next-env.d.ts');
const originalImports=readFileSync(typeFile,'utf8').split('\n').filter(line=>line.startsWith('import '));
const envBase=Object.fromEntries(['PATH','HOME','TMPDIR','SHELL','LANG'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
const cleanEnv={...envBase,ADA_FULLSTACK_LOCAL_TEST:'true',NEXT_TELEMETRY_DISABLED:'1',EMAIL_MODE:'capture',OPENAI_API_KEY:'',RESEND_API_KEY:'',WORKER_SECRET:'',TASK_EMAIL_ENABLED:'false',ADA_DEMO_MODE:'false'};
const children=[];let browser,ownerContext,crmContext,crmProcess,connectionId,principalId,crmEnv;
const calendarUsers=[],crmUsers=[],workspaceId=randomUUID();
const password=randomUUID()+'Aa1!',ownerEmail=`calendar-owner-${randomUUID()}@example.invalid`,requesterEmail=`crm-test-${randomUUID()}@alphadogagency.com`;
const checked=response=>{if(response.error)throw new Error('Local fixture/database operation failed: '+response.error.message);return response.data;};
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function sql(name,statement) {
  assert.ok(['supabase_db_ada-calendar',container].includes(name));
  return execFileSync('docker',['exec','-i',name,'psql','-X','-v','ON_ERROR_STOP=1','-U','postgres','-d','postgres','-At'],{input:statement,encoding:'utf8',stdio:['pipe','pipe','pipe']});
}
function launch(name,args,cwd,env) {
  const fd=openSync(path.join(outputDir,name+'.log'),'w',0o600);
  const child=spawn(process.execPath,args,{cwd,env,stdio:['ignore',fd,fd]});closeSync(fd);children.push(child);return child;
}
async function stop(child) {if(!child || child.exitCode!==null || child.signalCode)return;child.kill('SIGTERM');await Promise.race([new Promise(resolve=>child.once('exit',resolve)),delay(5000)]);if(child.exitCode===null&&!child.signalCode)child.kill('SIGKILL');}
async function available(url,child) {
  const deadline=Date.now()+60000;
  while(Date.now()<deadline){if(child.exitCode!==null)throw new Error('Local app exited; inspect its private test log.');try{const r=await fetch(url);if(r.ok)return;}catch{}await delay(300);}
  throw new Error('Local application did not become ready.');
}
async function browserBaseline(url,name) {
  const binary=process.env.ADA_AGENT_BROWSER_BIN||'agent-browser';
  const session='ada-fullstack-baseline';
  const run=args=>execFileSync(binary,['--session',session,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']});
  try{
    run(['--executable-path','/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','open',url]);
    const snapshot=run(['snapshot','-i']);assert.match(snapshot,/button|textbox/);
    run(['screenshot',path.join(outputDir,name+'-baseline.png')]);
    const errors=run(['errors']);assert.equal(errors.trim(),'','Initial app browser errors');
    console.log('PASS: '+name+' real app loads with controls and no browser errors.');
  }finally{run(['close']);}
}
async function jsonResponse(response,label) {
  const body=await response.json();
  if(!response.ok())throw new Error(`${label}: HTTP ${response.status()} ${body.error||body.code||'request failed'}`);
  return body;
}
async function main() {
  assert.equal(JSON.parse(readFileSync(path.join(crmDir,'package.json'),'utf8')).name,'alpha-dog-client-tracker');
  for(const port of [3193,3194])await new Promise((resolve,reject)=>{
    const probe=createServer();probe.once('error',()=>reject(new Error(`Local test port ${port} is occupied; no existing server will be reused.`)));
    probe.listen(port,'127.0.0.1',()=>probe.close(resolve));
  });
  console.log('Preparing the dedicated disposable CRM Auth/SQL stack.');
  const crmConfig=await prepareCrmStack(calendarDir,crmDir);
  const faultFile=path.join(stackDirectory,'faults.json');writeFileSync(faultFile,'{}',{mode:0o600});
  const calendarConfig=readStatus(cli,calendarDir,'http://127.0.0.1:55421');
  const options={auth:{persistSession:false,autoRefreshToken:false}};
  const cal=createClient(calendarConfig.API_URL,calendarConfig.SERVICE_ROLE_KEY,options);
  const crm=createClient(crmConfig.API_URL,crmConfig.SERVICE_ROLE_KEY,options);
  const requester=createClient(crmConfig.API_URL,crmConfig.ANON_KEY,options);
  try {
    const ownerId=checked(await cal.auth.admin.createUser({email:ownerEmail,password,email_confirm:true})).user.id;calendarUsers.push(ownerId);
    const requesterId=checked(await crm.auth.admin.createUser({email:requesterEmail,password,email_confirm:true})).user.id;crmUsers.push(requesterId);
    const otherEmail=`crm-other-${randomUUID()}@alphadogagency.com`;
    const otherId=checked(await crm.auth.admin.createUser({email:otherEmail,password,email_confirm:true})).user.id;crmUsers.push(otherId);
    const otherSession=checked(await createClient(crmConfig.API_URL,crmConfig.ANON_KEY,options).auth.signInWithPassword({email:otherEmail,password})).session;
    const session=checked(await requester.auth.signInWithPassword({email:requesterEmail,password})).session;
    checked(await cal.from('workspaces').insert({id:workspaceId,settings:{...DEFAULT_SETTINGS,reserveMinutes:0},clients:[{id:'fullstack-client',name:'FICTIONAL full-stack client',aliases:[]}],priorities:DEFAULT_PRIORITIES}));
    checked(await cal.from('workspace_members').insert({workspace_id:workspaceId,user_id:ownerId,name:'Fictional Calendar owner',email:ownerEmail,role:'owner'}));
    checked(await crm.from('clients').insert({id:'fullstack-client',name:'FICTIONAL full-stack client'}));
    checked(await crm.from('tasks').insert({id:'fullstack-legacy',client_id:'fullstack-client',title:'FICTIONAL grandfathered task',owner:'Bryan'}));
    checked(await crm.from('task_assignees').update({email:requesterEmail}).eq('name','Bryan'));
    const appEnv={...cleanEnv,ADA_NEXT_DIST_DIR:'.next-crm-integration',ADA_CRM_INTEGRATION_ENABLED:'true',ADA_CRM_BOOKING_ENABLED:'true',APP_URL:ownerOrigin,NEXT_PUBLIC_APP_URL:ownerOrigin,NEXT_PUBLIC_SUPABASE_URL:calendarConfig.API_URL,NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:calendarConfig.ANON_KEY,SUPABASE_SERVICE_ROLE_KEY:calendarConfig.SERVICE_ROLE_KEY};
    const calendarProcess=launch('calendar',['--import',transport,path.join(calendarDir,'node_modules/next/dist/bin/next'),'dev','--hostname','127.0.0.1','--port','3193'],calendarDir,appEnv);
    await available(ownerOrigin+'/api/health',calendarProcess);await browserBaseline(ownerOrigin,'calendar');
    browser=await chromium.launch({channel:'chrome'});
    ownerContext=await browser.newContext();
    const owner=async(route,body)=>jsonResponse(body===undefined?await ownerContext.request.get(ownerOrigin+'/api/'+route):await ownerContext.request.post(ownerOrigin+'/api/'+route,{headers:{Origin:ownerOrigin},data:body}),route);
    await owner('auth/login',{email:ownerEmail,password});
    const setup=await owner('admin/crm',{type:'create',crmOrigin,crmAuthUrl:authOrigin,crmPublicKey:crmConfig.ANON_KEY,agencyDomain:'alphadogagency.com'});
    connectionId=setup.credential.slice(11,47);
    principalId=checked(await cal.from('crm_integrations').select('principal_user_id').eq('id',connectionId).single()).principal_user_id;
    await owner('admin/crm',{type:'map',connectionId,externalClientId:'fullstack-client',calendarClientId:'fullstack-client'});
    await owner('admin/crm',{type:'set_enabled',connectionId,enabled:true});
    checked(await crm.from('calendar_connection').update({enforced:true,accepting:true}).eq('singleton',true));
    execFileSync('npm',['run','build'],{cwd:crmDir,env:envBase,stdio:['ignore','pipe','pipe']});
    crmEnv={...cleanEnv,NODE_ENV:'production',PORT:'3194',SUPABASE_URL:authOrigin,SUPABASE_ANON_KEY:crmConfig.ANON_KEY,SUPABASE_SERVICE_ROLE_KEY:crmConfig.SERVICE_ROLE_KEY,CRM_PUBLIC_ORIGIN:crmOrigin,ADA_CALENDAR_ENABLED:'true',ADA_CALENDAR_SYNC_ENABLED:'true',ADA_CALENDAR_URL:'https://calendar.integration.invalid',ADA_CALENDAR_CREDENTIAL:setup.credential};
    const restartCrm=async(patch={})=>{await stop(crmProcess);crmEnv={...crmEnv,...patch};crmProcess=launch('crm',['--import',transport,'server.mjs'],crmDir,crmEnv);await available('http://127.0.0.1:3194/healthz',crmProcess);};
    await restartCrm();await browserBaseline('http://127.0.0.1:3194','crm');
    const gateway=async(route,body,token=session.access_token)=>{
      const response=await fetch('http://127.0.0.1:3194/api/calendar/'+route,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+token,Origin:crmOrigin,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
      const data=await response.json();return {status:response.status,data};
    };
    const submit=async(route,body)=>{const r=await gateway(route,body);if(r.status!==200)throw new Error(`CRM ${route}: HTTP ${r.status} ${r.data.code||r.data.error}`);return r.data;};
    const sync=async()=>{
      checked(await crm.from('calendar_sync').update({next_run_at:new Date(0).toISOString()}).eq('singleton',true));
      await restartCrm();
      await expect.poll(async()=>{const c=checked(await cal.from('crm_integrations').select('last_sequence').eq('id',connectionId).single());const s=checked(await crm.from('calendar_sync').select('*').eq('singleton',true).single());return s.cursor===c.last_sequence && !s.lease_token && !s.last_error && Boolean(s.last_success_at);},{timeout:30000,message:'Real worker catches up and releases its lease'}).toBe(true);
    };
    // Browser requests retain their configured HTTPS origins; only transport destinations change.
    // Every Auth/REST response comes from the real local service. CDN script is the installed SDK.
    crmContext=await browser.newContext({serviceWorkers:'block'});
    await crmContext.route('**/*',async route=>{
      const url=new URL(route.request().url());
      const target=url.origin===crmOrigin?'http://127.0.0.1:3194':url.origin===authOrigin?crmConfig.API_URL:null;
      if(target){const response=await route.fetch({url:target+url.pathname+url.search});return route.fulfill({response});}
      if(url.hostname==='cdn.jsdelivr.net')return route.fulfill({contentType:'application/javascript',body:readFileSync(path.join(calendarDir,'node_modules/@supabase/supabase-js/dist/umd/supabase.js'))});
      if(['fonts.googleapis.com','fonts.gstatic.com'].includes(url.hostname))return route.fulfill({body:'',contentType:'text/css'});
      return route.abort('blockedbyclient');
    });
    await crmContext.routeWebSocket('**/*',route=>{
      const url=new URL(route.url());if(url.origin!=='wss://ada-crm-integration.supabase.co')return route.close();
      const socket=new WebSocket('ws://127.0.0.1:55521'+url.pathname+url.search);const queue=[];
      route.onMessage(message=>socket.readyState===WebSocket.OPEN?socket.send(message):queue.push(message));
      socket.addEventListener('open',()=>queue.splice(0).forEach(message=>socket.send(message)));
      socket.addEventListener('message',event=>route.send(event.data));
      route.onClose(()=>socket.close());socket.addEventListener('error',()=>route.close());
    });
    await crmContext.addInitScript(({session})=>localStorage.setItem('sb-ada-crm-integration-auth-token',JSON.stringify(session)),{session});
    const page=await crmContext.newPage();await page.goto(crmOrigin);
    await expect(page.locator('[data-id="fullstack-client"]').getByRole('button',{name:'Toggle tasks'})).toBeVisible();
    const day=nextWorkDate(addDays(localDate(new Date().toISOString(),DEFAULT_SETTINGS.timeZone),2),DEFAULT_SETTINGS);
    const fault=value=>writeFileSync(faultFile,JSON.stringify(value),{mode:0o600});
    await exerciseFlows({cal,crm,requester,requesterId,otherId,otherSession,session,workspaceId,connectionId,owner,gateway,submit,sync,restartCrm,page,ownerContext,ownerOrigin,crmOrigin,day,outputDir,checked,sql,container,expect,calendarProcess,fault});
    console.log('PASS: both actual local applications completed the integration suite. No real mail or hosted traffic.');
  } finally {
    writeFileSync(faultFile,'{}',{mode:0o600});
    await crmContext?.close();await ownerContext?.close();await browser?.close();
    for(const child of children)await stop(child);
    let generatedTypes=readFileSync(typeFile,'utf8');
    for(const original of originalImports){const name=original.match(/([^/]+\.d\.ts)/)?.[1];if(name)generatedTypes=generatedTypes.replace(new RegExp('import "\\./\\.next-crm-integration/(?:dev/)?types/'+name.replaceAll('.','\\.')+'";'),original);}
    writeFileSync(typeFile,generatedTypes);
    // Only generated Calendar fixture IDs; CRM's database is independently disposable.
    const statements=['begin;'];
    if(connectionId){assert.match(connectionId,/^[a-f0-9-]{36}$/);for(const table of ['crm_changes','crm_operations','crm_closed_operations','crm_previews','crm_task_links','crm_client_mappings','crm_api_budgets','crm_integrations'])statements.push(`delete from public.${table} where ${table==='crm_integrations'?'id':'integration_id'}='${connectionId}';`);}
    statements.push(`delete from pgmq.q_ada_notifications where message->>'notificationId' in (select id from public.notifications where workspace_id='${workspaceId}');`);
    for(const table of ['notifications','pending_requests','work_events','work_sessions','workspace_members','workspaces'])statements.push(`delete from public.${table} where ${table==='workspaces'?'id':'workspace_id'}='${workspaceId}';`);
    statements.push('commit;');sql('supabase_db_ada-calendar',statements.join('\n'));
    for(const id of [...calendarUsers,...(principalId?[principalId]:[])])checked(await cal.auth.admin.deleteUser(id));
    // Remove transient login/session material by closing contexts; no session is written to disk.
  }
}
main().catch(error=>{console.error(error instanceof Error?error.message:'Full-stack verification failed');if(error instanceof Error)console.error(error.stack?.split('\n').filter(line=>line.includes('scripts/crm-fullstack')).slice(0,2).join('\n'));process.exitCode=1;});
