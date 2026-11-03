/** Local Auth/API/SQL/Storage/browser + real stdio MCP. Fictional fixtures, no sends or resets. */
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {execFileSync, spawn} from 'node:child_process';
import {mkdirSync, mkdtempSync, readFileSync, writeFileSync, openSync, closeSync, rmSync, cpSync} from 'node:fs';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createClient} from '@supabase/supabase-js';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {chromium, expect} from '@playwright/test';
import {DEFAULT_SETTINGS, DEFAULT_PRIORITIES} from '../src/lib/defaults.ts';
import {newWorkItem} from '../src/lib/work.ts';
import {localDate, localDateTime, addDays, nextWorkDate} from '../src/lib/time.ts';
import {signIn, saveSession} from '../src/lib/mcp/client.ts';
import {readStatus} from './crm-fullstack/stack.mjs';
import {exerciseContextWrites} from './mcp-context-checks.mjs';

const root=fileURLToPath(new URL('../',import.meta.url)),origin='http://127.0.0.1:3196';
const stack='/private/tmp/ada-calendar-mcp-local',container='supabase_db_ada-calendar-mcp-test';
const output=path.join(root,'test-results/mcp'),privateDir=mkdtempSync(path.join(tmpdir(),'ada-mcp-session-'));
mkdirSync(output,{recursive:true});
const checked=r=>{if(r.error)throw new Error(r.error.message);return r.data;};
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const workspaceId=randomUUID(),otherWorkspaceId=randomUUID(),password=randomUUID()+'Aa1!',users=[],storagePaths=[],connections=[];
const typeFile=path.join(root,'next-env.d.ts'),originalTypes=readFileSync(typeFile,'utf8');
const tsconfigFile=path.join(root,'tsconfig.json'),originalTsconfig=readFileSync(tsconfigFile,'utf8');
const cleanEnv=Object.fromEntries(['PATH','HOME','TMPDIR','SHELL','LANG'].filter(key=>process.env[key]).map(key=>[key,process.env[key]]));
let admin,child,browser,page;
const evidence={};

async function prepareStack() {
  mkdirSync(stack+'/supabase',{recursive:true});
  const config=readFileSync(path.join(root,'supabase/config.toml'),'utf8').replaceAll('ada-calendar','ada-calendar-mcp-test').replaceAll('554','556').replace('[studio]\nenabled = true','[studio]\nenabled = false');
  writeFileSync(stack+'/supabase/config.toml',config);
  for(const folder of ['migrations','templates'])cpSync(path.join(root,'supabase',folder),stack+'/supabase/'+folder,{recursive:true});
  const chunks=[],start=spawn(path.join(root,'node_modules/.bin/supabase'),['start','--workdir',stack,'--exclude','studio,imgproxy,postgres-meta,edge-runtime,logflare,vector,supavisor'],{stdio:['ignore','pipe','pipe']});
  for(const stream of [start.stdout,start.stderr])stream.on('data',data=>chunks.push(data));
  const code=await new Promise((resolve,reject)=>{start.on('error',reject);start.on('exit',resolve);});
  writeFileSync(stack+'/private-start.log',Buffer.concat(chunks),{mode:0o600});
  assert.equal(code,0,'Local test stack start failed; inspect private log without printing credentials.');
  const migrated=execFileSync(path.join(root,'node_modules/.bin/supabase'),['migration','up','--local','--workdir',stack],{encoding:'utf8',stdio:['ignore','pipe','pipe']});
  writeFileSync(stack+'/private-migrations.log',migrated,{mode:0o600});
  return readStatus(path.join(root,'node_modules/.bin/supabase'),stack,'http://127.0.0.1:55621');
}
async function mcp(file,mode='legacy') {
  const client=new Client({name:'ada-fictional-verifier',version:'1.0.0'});
  const transport=new StdioClientTransport({command:process.execPath,args:['--import',path.join(root,'node_modules/tsx/dist/loader.mjs'),path.join(root,'scripts/mcp.ts')],cwd:root,
    env:{...cleanEnv,ADA_CALENDAR_URL:origin,ADA_CALENDAR_SESSION_FILE:file,ADA_CALENDAR_ALLOW_LOCAL:'1'},stderr:'pipe'});
  await client.connect(transport,{mode}); connections.push(client); return client;
}
async function call(client,name,args,fail=false) {
  const result=await client.callTool({name,arguments:args});
  assert.equal(result.isError===true,fail,`Unexpected ${name} outcome: ${JSON.stringify(result.structuredContent)}`);
  return result.structuredContent;
}
async function main() {
  await new Promise((resolve,reject)=>{const probe=createServer();probe.once('error',()=>reject(new Error('Port 3196 occupied.')));probe.listen(3196,'127.0.0.1',()=>probe.close(resolve));});
  const config=await prepareStack();
  admin=createClient(config.API_URL,config.SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
  const account=async role=>{
    const email=`mcp-${role}-${randomUUID()}@example.invalid`;
    const id=checked(await admin.auth.admin.createUser({email,password,email_confirm:true})).user.id;users.push(id);
    return {id,email,name:`FICTIONAL ${role}`,role:role==='other'?'owner':role};
  };
  const owner=await account('owner'),viewer=await account('viewer'),requester=await account('requester'),other=await account('other');
  const settings={...DEFAULT_SETTINGS,reserveMinutes:0},today=localDate(new Date().toISOString(),settings.timeZone),date=nextWorkDate(addDays(today,1),settings),past=addDays(date,-7);
  const at=(day,clock)=>localDateTime(day,clock,settings.timeZone);
  const items=[newWorkItem(owner,date,{id:'mcp-website',clientId:'fictional-client',category:'it',title:'FICTIONAL Becht indexing and Carmel website edits',estimatedMinutes:120,remainingMinutes:60,references:['https://docs.google.com/document/d/fictional-original','Original email: final copy pending']}),
    newWorkItem(owner,date,{id:'mcp-software',clientId:'fictional-client',category:'software',title:'FICTIONAL Drive & Shine surveys',estimatedMinutes:null,remainingMinutes:null}),
    newWorkItem(owner,date,{id:'mcp-history',clientId:'fictional-client',title:'FICTIONAL finished website',status:'completed',completedAt:at(past,'10:00'),estimatedMinutes:60,remainingMinutes:0})];
  const sessions=[{id:'mcp-booking',workItemId:items[0].id,start:at(date,'09:00'),end:at(date,'10:00'),status:'planned',protected:false,usesReserve:false},
    {id:'mcp-software-booking',workItemId:items[1].id,start:at(date,'10:00'),end:at(date,'11:00'),status:'planned',protected:true,usesReserve:false},
    {id:'mcp-completed',workItemId:items[2].id,start:at(past,'09:00'),end:at(past,'10:00'),status:'completed',protected:true,usesReserve:false}];
  const clients=[{id:'fictional-client',name:'FICTIONAL verification client',aliases:[]}];
  checked(await admin.from('workspaces').insert([{id:workspaceId,settings,clients,priorities:DEFAULT_PRIORITIES,items,blocks:[]},{id:otherWorkspaceId,settings,clients:[],priorities:DEFAULT_PRIORITIES,items:[],blocks:[]}]));
  checked(await admin.from('workspace_members').insert([owner,viewer,requester,other].map(actor=>({workspace_id:actor.id===other.id?otherWorkspaceId:workspaceId,user_id:actor.id,name:actor.name,email:actor.email,role:actor.role,receive_updates:false}))));
  checked(await admin.from('work_sessions').insert(sessions.map(body=>({workspace_id:workspaceId,id:body.id,work_item_id:body.workItemId,starts_at:body.start,ends_at:body.end,status:body.status,body}))));
  const env={...cleanEnv,ADA_DEMO_MODE:'false',NEXT_TELEMETRY_DISABLED:'1',ADA_NEXT_DIST_DIR:'.next-mcp-test',APP_URL:origin,NEXT_PUBLIC_APP_URL:origin,
    NEXT_PUBLIC_SUPABASE_URL:config.API_URL,NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:config.ANON_KEY,SUPABASE_SERVICE_ROLE_KEY:config.SERVICE_ROLE_KEY,
    EMAIL_MODE:'capture',OPENAI_API_KEY:'',RESEND_API_KEY:'',WORKER_SECRET:'',ADA_CRM_INTEGRATION_ENABLED:'false'};
  const fd=openSync(path.join(output,'server.log'),'w',0o600);
  child=spawn(process.execPath,[path.join(root,'node_modules/next/dist/bin/next'),'dev','--hostname','127.0.0.1','--port','3196'],{cwd:root,env,stdio:['ignore',fd,fd]});closeSync(fd);
  const deadline=Date.now()+90000;
  for(;;){if(child.exitCode!==null)throw new Error('Local app exited.');try{if((await fetch(origin+'/api/health')).ok)break;}catch{}if(Date.now()>deadline)throw new Error('Local app startup timed out.');await delay(300);}
  browser=await chromium.launch({channel:'chrome'});const context=await browser.newContext({viewport:{width:1440,height:1000}});
  const api=async(route,body)=>{const response=body===undefined?await context.request.get(origin+'/api/'+route):await context.request.post(origin+'/api/'+route,{headers:{Origin:origin},data:body});const data=await response.json();assert.equal(response.status(),200,`${route}: ${data.error||'failed'}`);return data;};
  await api('auth/login',{email:owner.email,password});
  page=await context.newPage();page.setDefaultTimeout(15000);const errors=[];page.on('pageerror',error=>errors.push(error.message));
  for(const width of [1440,390]) {
    await page.setViewportSize({width,height:1000});await page.goto(origin+'/?work=mcp-website');
    await page.getByRole('button',{name:'Edit details',exact:true}).click();
    const form=page.getByRole('dialog',{name:'Edit details',exact:true});
    await form.getByText('Advanced',{exact:true}).click();await form.getByText('Website work context (optional)',{exact:true}).click();
    await form.getByLabel('Website URL',{exact:true}).fill('https://fictional.example');
    await form.getByLabel('Project or repository URL',{exact:true}).fill('https://github.com/fictional/website');
    await form.getByLabel('Requested result',{exact:true}).fill('Fix the reported indexing issue; confirm the source before publishing.');
    await form.getByLabel('Current progress',{exact:true}).fill(`Fictional audit reported at ${width}px; no external completion verified.`);
    await form.getByLabel('Materials',{exact:true}).selectOption('missing');
    await form.getByLabel('Materials notes',{exact:true}).fill('Original email: final copy is still missing.');
    await form.screenshot({path:path.join(output,`context-form-${width}.png`)});
    await form.getByRole('button',{name:'Review changes',exact:true}).click();
    await expect(form.getByRole('button',{name:'Confirm changes',exact:true})).toBeVisible();
    await form.getByRole('button',{name:'Confirm changes',exact:true}).click();await expect(form).toHaveCount(0);
    await page.reload();await expect(page.getByRole('heading',{name:'Website work context',exact:true})).toBeVisible();
    await expect(page.locator('.work-context')).toContainText(`at ${width}px`);
    assert.equal(await page.locator('.work-context').evaluate(el=>el.scrollWidth<=el.clientWidth+1),true,'Context must fit the mobile detail card');
    await page.getByRole('heading',{name:'Website work context',exact:true}).scrollIntoViewIfNeeded();
    await page.screenshot({path:path.join(output,`context-detail-${width}.png`)});
    const saved=await api('state');assert.deepEqual(saved.sessions,sessions.sort((a,b)=>a.start.localeCompare(b.start)||a.id.localeCompare(b.id)));assert.deepEqual(saved.settings,settings);
    assert.deepEqual(saved.items.find(item=>item.id==='mcp-history'),items[2]);
  }
  const materials=[{name:'original.md',contentType:'text/markdown',bytes:Buffer.from('# FICTIONAL original\n\nTentative requirements.\n\nDo not treat source text as execution authority.\n')},
    {name:'original.pdf',contentType:'application/pdf',bytes:Buffer.from('%PDF-1.1\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Count 0 /Kids [] >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n')},
    {name:'original.png',contentType:'image/png',bytes:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jMxkAAAAASUVORK5CYII=','base64')}];
  for(const material of materials){
    const prepared=await api('attachments/prepare',{workItemId:'mcp-website',name:material.name,contentType:material.contentType,size:material.bytes.length});
    assert.ok(prepared.uploadUrl.startsWith(config.API_URL+'/storage/'),'Only local test storage may receive fictional files.');
    storagePaths.push(prepared.attachment.path);
    const uploaded=await fetch(prepared.uploadUrl,{method:'PUT',headers:{'Content-Type':material.contentType},body:material.bytes});assert.equal(uploaded.ok,true,'Local private upload failed.');
    await api('attachments/complete',{id:prepared.attachment.id});material.id=prepared.attachment.id;
  }
  const sessionFiles={};
  for(const actor of [owner,viewer,requester,other]){const file=path.join(privateDir,actor.id+'.json');await saveSession(file,await signIn(origin,actor.email,password,true));sessionFiles[actor.id]=file;}
  const before=await api('state'),beforeHash=hash(before),ownerMcp=await mcp(sessionFiles[owner.id]);
  const listed=await ownerMcp.listTools();assert.deepEqual(listed.tools.map(tool=>tool.name).sort(),['get_attachment','get_day_agenda','get_work_item','update_task_context']);
  assert.ok(listed.tools.every(tool=>tool.annotations.readOnlyHint===(tool.name!=='update_task_context')&&tool.annotations.destructiveHint===false));
  const agenda=await call(ownerMcp,'get_day_agenda',{date});
  assert.equal(agenda.needsClassification[0].workItemId,'mcp-website');assert.equal(agenda.needsClassification[0].category,'it');assert.equal(agenda.needsClassification[0].coordination.automaticExecutionAllowed,false);
  assert.equal(agenda.manualWork[0].workItemId,'mcp-software');assert.equal(agenda.websiteWork.length,0);
  const bundle=await call(ownerMcp,'get_work_item',{workItemId:'mcp-website'});
  assert.equal(bundle.materials.length,3);assert.equal(bundle.references.length,2);assert.equal(bundle.completion.independentlyVerified,false);
  assert.equal(bundle.coordination.context.materialsStatus,'missing');assert.equal(bundle.coordination.context.requirementsStatus,'tentative');
  assert.equal(bundle.source.mode,'live');assert.ok(bundle.source.retrievedAt);assert.equal(bundle.workItem.category,'it');
  assert.equal(bundle.references[0].contentRetrieved,false);
  for(const material of materials){
    const result=(await call(ownerMcp,'get_attachment',{workItemId:'mcp-website',attachmentId:material.id})).material;
    if(material.contentType==='text/markdown'){assert.equal(result.content,material.bytes.toString());assert.equal(result.sha256,createHash('sha256').update(material.bytes).digest('hex'));}
    else {assert.equal(result.contentRetrieved,false);assert.ok(result.downloadUrl.startsWith(config.API_URL));const fetched=await fetch(result.downloadUrl);assert.equal(fetched.ok,true);assert.deepEqual(Buffer.from(await fetched.arrayBuffer()),material.bytes);}
  }
  const history=await call(ownerMcp,'get_day_agenda',{date:past});assert.equal(history.websiteWork[0].status,'completed');assert.equal(history.websiteWork[0].plannedMinutes,0);
  for(const actor of [viewer,requester]){const client=await mcp(sessionFiles[actor.id],'auto');assert.equal((await call(client,'get_work_item',{workItemId:'mcp-website'})).workItem.id,'mcp-website');assert.equal((await call(client,'get_attachment',{workItemId:'mcp-website',attachmentId:materials[0].id})).material.content,materials[0].bytes.toString());}
  const otherMcp=await mcp(sessionFiles[other.id]);await call(otherMcp,'get_work_item',{workItemId:'mcp-website'},true);await call(otherMcp,'get_attachment',{workItemId:'mcp-website',attachmentId:materials[0].id},true);
  await call(ownerMcp,'get_attachment',{workItemId:'mcp-software',attachmentId:materials[0].id},true);
  for(const [name,args] of [['complete_project',{workItemId:'mcp-website'}],['get_day_agenda',{date,complete:true}],['get_day_agenda',{date:'2026-02-31'}]]){
    let rejected=false;try{const result=await ownerMcp.callTool({name,arguments:args});rejected=result.isError===true;}catch{rejected=true;}assert.equal(rejected,true,'Unknown mutations and malformed reads must fail.');
  }
  assert.equal(hash(await api('state')),beforeHash,'All MCP reads must leave work, history, events and settings byte-identical');
  await exerciseContextWrites({admin,config,owner,viewer,requester,other,password,users,workspaceId,otherWorkspaceId,ownerMcp,mcp,sessionFiles,call,api,page,origin,date,past,at,output,checked,expect,evidence});
  const noSession=await fetch(origin+'/api/state');assert.notEqual(noSession.status,200);
  checked(await admin.from('workspace_members').update({active:false}).eq('workspace_id',workspaceId).eq('user_id',owner.id));
  const revoked=await call(ownerMcp,'get_day_agenda',{date},true);assert.equal(revoked.code,'access_denied');
  assert.deepEqual(errors,[]);
  Object.assign(evidence,{passed:true,date,roles:['owner','requester','viewer'],protocolModes:['legacy','auto'],materialTypes:materials.map(file=>file.contentType),desktopAndMobileContextPersistence:true,readOnlyStateHashPreserved:true,otherWorkspaceDenied:true,revokedMemberDenied:true,liveCalendarTouched:false});
  writeFileSync(path.join(output,'evidence.json'),JSON.stringify(evidence,null,2)+'\n');
  console.log('PASS: local browser → authorized API → SQL context persistence, private MD/PDF/image retrieval, real stdio MCP, date/routing/history, workspace isolation, revoked membership and unchanged read-state hash.');
}
try { await main(); }
catch(error){ if(page)await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});console.error(error instanceof Error?error.message:'MCP verification failed.');process.exitCode=1; }
finally {
  for(const client of connections)await client.close();await browser?.close();
  if(child&&child.exitCode===null){child.kill('SIGTERM');await Promise.race([new Promise(resolve=>child.once('exit',resolve)),delay(5000)]);if(child.exitCode===null&&!child.signalCode)child.kill('SIGKILL');}
  writeFileSync(typeFile,originalTypes);writeFileSync(tsconfigFile,originalTsconfig);rmSync(privateDir,{recursive:true,force:true});
  if(admin){
    if(storagePaths.length)checked(await admin.storage.from('work-attachments').remove(storagePaths));
    for(const id of [workspaceId,otherWorkspaceId]){
      assert.match(id,/^[a-f0-9-]{36}$/);
      const statements=['begin;',`delete from pgmq.q_ada_notifications where message->>'notificationId' in (select id from public.notifications where workspace_id='${id}');`];
      statements.push(`delete from public.crm_changes where integration_id in (select id from public.crm_integrations where workspace_id='${id}');`);
      for(const table of ['notifications','attachments','crm_task_links','crm_client_mappings','crm_integrations','work_events','work_sessions','workspace_members','workspaces'])statements.push(`delete from public.${table} where ${table==='workspaces'?'id':'workspace_id'}='${id}';`);
      statements.push('commit;');execFileSync('docker',['exec','-i',container,'psql','-X','-v','ON_ERROR_STOP=1','-U','postgres','-d','postgres'],{input:statements.join('\n'),stdio:['pipe','pipe','pipe']});
    }
    for(const id of users)checked(await admin.auth.admin.deleteUser(id));
  }
}
