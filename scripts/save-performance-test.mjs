/** Real local Auth/API/browser/SQL; fictional history only, no resets or sends. */
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {execFileSync,spawn} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync,openSync,closeSync} from 'node:fs';
import {createServer} from 'node:net';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createClient} from '@supabase/supabase-js';
import {chromium,expect} from '@playwright/test';
import {DEFAULT_SETTINGS,DEFAULT_PRIORITIES} from '../src/lib/defaults.ts';
import {newWorkItem} from '../src/lib/work.ts';
import {addDays,dayOfWeek,localDate,localDateTime,nextWorkDate} from '../src/lib/time.ts';
import {readStatus} from './crm-fullstack/stack.mjs';

const root=fileURLToPath(new URL('../',import.meta.url)),origin='http://127.0.0.1:3195';
const output=path.join(root,'test-results/save-performance');mkdirSync(output,{recursive:true});
const workspaceId=randomUUID(),password=randomUUID()+'Aa1!',email=`save-test-${randomUUID()}@example.invalid`;
const checked=result=>{if(result.error)throw new Error(result.error.message);return result.data;};
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const typeFile=path.join(root,'next-env.d.ts'),originalTypes=readFileSync(typeFile,'utf8');
let userId,child,browser,context,admin,page;
const metrics={};

async function main() {
  await new Promise((resolve,reject)=>{
    const probe=createServer();probe.once('error',()=>reject(new Error('Test port 3195 is already in use.')));
    probe.listen(3195,'127.0.0.1',()=>probe.close(resolve));
  });
  const config=readStatus(path.join(root,'node_modules/.bin/supabase'),root,'http://127.0.0.1:55421');
  const options={auth:{persistSession:false,autoRefreshToken:false}};
  admin=createClient(config.API_URL,config.SERVICE_ROLE_KEY,options);
  try {
    userId=checked(await admin.auth.admin.createUser({email,password,email_confirm:true})).user.id;
    const actor={id:userId,name:'Fictional save tester',email,role:'owner'};
    const settings={...DEFAULT_SETTINGS,reserveMinutes:0},today=localDate(new Date().toISOString(),settings.timeZone);
    let yesterday=addDays(today,-1);while(!settings.weekdays.includes(dayOfWeek(yesterday)))yesterday=addDays(yesterday,-1);
    const future=nextWorkDate(addDays(today,2),settings),at=(day,time)=>localDateTime(day,time,settings.timeZone);
    const items=Array.from({length:69},(_,i)=>newWorkItem(actor,addDays(today,-180),{
      id:`fixture-${i}`,clientId:'fixture-client',title:i>1?'FICTIONAL completed project '+i:`FICTIONAL performance project ${i}`,
      description:'Fictional completed-work history for isolated performance verification. '.repeat(4),
      status:i>1?'completed':'planned',estimatedMinutes:i>1?60:null,remainingMinutes:i>1?0:null,
      completedAt:i>1?at(addDays(today,-i-2),'10:00'):null,
    }));
    const history=Array.from({length:101},(_,i)=>({
      id:`history-session-${i}`,workItemId:`fixture-${i%68+1}`,start:at(addDays(today,-i-2),'09:00'),end:at(addDays(today,-i-2),'09:30'),
      status:'completed',protected:true,usesReserve:false,
    })).sort((a,b)=>a.start.localeCompare(b.start)||a.id.localeCompare(b.id));
    const sessions=[...history,...[yesterday,future].map((day,i)=>({
      id:`pending-session-${i}`,workItemId:i?'fixture-0':'fixture-1',start:at(day,'10:00'),end:at(day,'11:00'),
      status:'planned',protected:false,usesReserve:false,
    }))];
    const clients=[{id:'fixture-client',name:'FICTIONAL history client',aliases:[]}];
    checked(await admin.from('workspaces').insert({id:workspaceId,version:200,settings,clients,priorities:DEFAULT_PRIORITIES,items,blocks:[]}));
    checked(await admin.from('workspace_members').insert({workspace_id:workspaceId,user_id:userId,name:actor.name,email,role:'owner'}));
    checked(await admin.from('work_sessions').insert(sessions.map(body=>({
      workspace_id:workspaceId,id:body.id,work_item_id:body.workItemId,starts_at:body.start,ends_at:body.end,status:body.status,body,
    }))));
    const saved={items,sessions,blocks:[]};
    const events=Array.from({length:200},(_,i)=>{
      const id=randomUUID(),operationId=`fixture-history-${i}`,version=i+1;
      const body={id,operationId,actorId:userId,actorName:actor.name,type:'schedule_changed',summary:[`Fictional historical change ${version}`],
        itemIds:['fixture-0'],createdAt:new Date(Date.now()-(200-i)*60000).toISOString(),version,before:saved,after:saved,undoneBy:null};
      return {id,workspace_id:workspaceId,operation_id:operationId,actor_id:userId,version,body,operation_payload:[]};
    });
    for(let i=0;i<events.length;i+=20)checked(await admin.from('work_events').insert(events.slice(i,i+20)));
    const reader=createClient(config.API_URL,config.ANON_KEY,options);
    checked(await reader.auth.signInWithPassword({email,password}));
    const ledger=checked(await reader.from('work_events').select('body,operation_payload').eq('workspace_id',workspaceId).order('version',{ascending:false}).limit(200));
    const ledgerHash=hash(ledger);
    metrics.previousHistoryBytes=Buffer.byteLength(JSON.stringify(ledger));

    const inherited=Object.fromEntries(['PATH','HOME','TMPDIR','SHELL','LANG'].filter(key=>process.env[key]).map(key=>[key,process.env[key]]));
    const env={...inherited,ADA_DEMO_MODE:'false',NEXT_TELEMETRY_DISABLED:'1',ADA_NEXT_DIST_DIR:'.next-save-performance',
      APP_URL:origin,NEXT_PUBLIC_APP_URL:origin,NEXT_PUBLIC_SUPABASE_URL:config.API_URL,NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:config.ANON_KEY,
      SUPABASE_SERVICE_ROLE_KEY:config.SERVICE_ROLE_KEY,EMAIL_MODE:'capture',OPENAI_API_KEY:'',RESEND_API_KEY:'',WORKER_SECRET:''};
    const fd=openSync(path.join(output,'server.log'),'w',0o600);
    child=spawn(process.execPath,[path.join(root,'node_modules/next/dist/bin/next'),'dev','--hostname','127.0.0.1','--port','3195'],{cwd:root,env,stdio:['ignore',fd,fd]});closeSync(fd);
    const deadline=Date.now()+60000;
    for(;;){
      if(child.exitCode!==null)throw new Error('Local performance server exited.');
      try{if((await fetch(origin+'/api/health')).ok)break;}catch{}
      if(Date.now()>deadline)throw new Error('Local performance server did not start.');
      await delay(300);
    }
    browser=await chromium.launch({channel:'chrome'});context=await browser.newContext({viewport:{width:1440,height:1000}});
    const api=async(route,body)=>{
      const started=performance.now();
      const response=body===undefined?await context.request.get(origin+'/api/'+route):await context.request.post(origin+'/api/'+route,{headers:{Origin:origin},data:body});
      const text=await response.text();assert.equal(response.status(),200,`${route}: ${text.slice(0,500)}`);
      return {data:JSON.parse(text),bytes:Buffer.byteLength(text),ms:Math.round(performance.now()-started)};
    };
    await api('auth/login',{email,password});
    await api('state'); // Warm the route; compilation is not save latency.
    const loaded=await api('state');
    metrics.currentStateBytes=loaded.bytes;metrics.stateReadMs=loaded.ms;
    metrics.currentHistoryBytes=Buffer.byteLength(JSON.stringify(loaded.data.events));
    assert.equal(loaded.data.events.length,200);
    assert.equal(loaded.data.events.filter(e=>e.before&&e.after).length,1);
    assert.deepEqual(loaded.data.sessions.filter(s=>s.status==='completed'),history);
    assert.ok(metrics.currentHistoryBytes<metrics.previousHistoryBytes/50,'History projection must shrink by at least 98%');
    page=await context.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto(origin+'/?work=fixture-0');
    await page.getByRole('button',{name:'Edit details',exact:true}).click();
    const form=page.getByRole('dialog',{name:'Edit details',exact:true});
    // The existing textarea value is also label text in React's rendered HTML.
    await form.getByPlaceholder('Context, requirements, and what finished looks like…',{exact:true}).fill('Fictional revised details; all completed work must survive.');
    await form.getByRole('button',{name:'Review changes',exact:true}).click();
    const saveResponse=page.waitForResponse(response=>response.url()===origin+'/api/commands'&&response.request().postDataJSON().action==='commit');
    const started=performance.now();
    await form.getByRole('button',{name:'Confirm changes',exact:true}).click();
    const edited=await saveResponse;assert.equal(edited.status(),200);
    await expect(form).toHaveCount(0);
    metrics.browserSaveMs=Math.round(performance.now()-started);
    const editedState=(await edited.json()).state;
    assert.deepEqual(editedState.sessions.filter(s=>s.status==='completed'),history);
    assert.equal(editedState.items[0].description,'Fictional revised details; all completed work must survive.');
    async function commit(commands){
      const operationId=randomUUID(),preview=(await api('commands',{operationId,commands,action:'preview'})).data.proposal;
      assert.equal(preview.status,'ready',JSON.stringify(preview.conflicts));
      return api('commands',{operationId,commands,action:'commit',baseVersion:preview.baseVersion,reviewFingerprint:preview.reviewFingerprint});
    }
    const completed=await commit([{type:'complete_day',itemId:'fixture-1',date:yesterday}]);
    metrics.completionSaveMs=completed.ms;metrics.saveResponseBytes=completed.bytes;
    assert.equal(completed.data.state.sessions.find(s=>s.id==='pending-session-0').status,'completed');
    assert.equal(completed.data.state.sessions.find(s=>s.id==='pending-session-1').status,'planned');
    await page.goto(origin+'/?work=fixture-1');
    const pastDay=page.locator(`[data-work-date="${yesterday}"]`);
    await expect(pastDay).toContainText('Day finished');
    await page.screenshot({path:path.join(output,'completed-history-preserved.png')});
    const restored=(await api('undo',{id:completed.data.state.events[0].id})).data.state;
    assert.deepEqual(restored.sessions,editedState.sessions);
    assert.deepEqual(restored.items,editedState.items);
    const added=await commit([{type:'create',item:newWorkItem(actor,future,{id:'fixture-new',clientId:'fixture-client',title:'FICTIONAL new task',
      estimatedMinutes:30,remainingMinutes:30}),sessions:[{id:'fixture-new-session',workItemId:'fixture-new',start:at(future,'11:00'),end:at(future,'11:30'),status:'planned',protected:false,usesReserve:false}]}]);
    metrics.createSaveMs=added.ms;
    assert.deepEqual(added.data.state.sessions.filter(s=>s.status==='completed'),history);
    assert.equal(added.data.state.events.length,200);
    const retained=checked(await reader.from('work_events').select('body,operation_payload').eq('workspace_id',workspaceId).lte('version',200).order('version',{ascending:false}));
    assert.equal(hash(retained),ledgerHash,'Every original full history snapshot must remain identical');
    assert.equal(checked(await admin.from('work_events').select('id').eq('workspace_id',workspaceId)).length,204);
    checked(await admin.from('workspace_members').update({active:false}).eq('workspace_id',workspaceId).eq('user_id',userId));
    assert.equal((await context.request.get(origin+'/api/state')).status(),401);
    const denied=await context.request.post(origin+'/api/commands',{headers:{Origin:origin},data:{action:'preview',operationId:randomUUID(),commands:[{type:'status',itemId:'fixture-0',status:'completed'}]}});
    assert.notEqual(denied.status(),200);
    assert.equal(checked(await admin.from('work_events').select('id').eq('workspace_id',workspaceId)).length,204);
    assert.deepEqual(errors,[]);
    metrics.historyReductionPercent=Number((100*(1-metrics.currentHistoryBytes/metrics.previousHistoryBytes)).toFixed(2));
    writeFileSync(path.join(output,'metrics.json'),JSON.stringify(metrics,null,2)+'\n');
    console.log('PASS: real local edit/create, past-day completion, exact Undo, 200 retained full snapshots, completed sessions, and revoked-member denial.');
    console.log(JSON.stringify(metrics));
  } catch (error) {
    writeFileSync(path.join(output,'metrics.json'),JSON.stringify(metrics,null,2)+'\n');
    if(page){
      await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});
      writeFileSync(path.join(output,'failure.html'),await page.content().catch(()=>''));
    }
    throw error;
  } finally {
    await context?.close();await browser?.close();
    if(child&&child.exitCode===null){
      child.kill('SIGTERM');await Promise.race([new Promise(resolve=>child.once('exit',resolve)),delay(5000)]);
      if(child.exitCode===null&&!child.signalCode)child.kill('SIGKILL');
    }
    writeFileSync(typeFile,originalTypes);
    if(admin){
      assert.match(workspaceId,/^[a-f0-9-]{36}$/);
      const statements=['begin;',`delete from pgmq.q_ada_notifications where message->>'notificationId' in (select id from public.notifications where workspace_id='${workspaceId}');`];
      for(const table of ['notifications','work_events','work_sessions','workspace_members','workspaces'])
        statements.push(`delete from public.${table} where ${table==='workspaces'?'id':'workspace_id'}='${workspaceId}';`);
      statements.push('commit;');
      execFileSync('docker',['exec','-i','supabase_db_ada-calendar','psql','-X','-v','ON_ERROR_STOP=1','-U','postgres','-d','postgres'],{input:statements.join('\n'),stdio:['pipe','pipe','pipe']});
      if(userId)checked(await admin.auth.admin.deleteUser(userId));
    }
  }
}
main().catch(error=>{console.error(error instanceof Error?error.message:'Local verification failed');process.exitCode=1;});
