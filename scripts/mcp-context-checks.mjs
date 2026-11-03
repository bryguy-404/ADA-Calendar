/** Fictional local fixtures only; called by the isolated Auth/API/SQL/MCP harness. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {createClient} from '@supabase/supabase-js';
import {planCommands} from '../src/lib/scheduler.ts';
import {signIn} from '../src/lib/mcp/client.ts';

export async function exerciseContextWrites({admin,config,owner,viewer,requester,other,password,users,workspaceId,otherWorkspaceId,ownerMcp,mcp,sessionFiles,call,api,page,origin,date,past,at,output,checked,expect,evidence}) {
  let state=await api('state');
  const task=state.items.find(item=>item.id==='mcp-website');
  task.status='waiting';task.blockedReason='FICTIONAL outdated dependency';task.workContext.manualOnly=true;
  // Explicit test seeding models legacy waiting work with intact protected bookings.
  checked(await admin.from('workspaces').update({items:state.items,version:state.version+1}).eq('id',workspaceId));
  const extra=[
    {id:'context-future-protected',start:at(date,'14:00'),end:at(date,'15:00'),status:'planned'},
    {id:'context-past-planned',start:at(past,'11:00'),end:at(past,'12:00'),status:'planned'},
    {id:'context-past-done',start:at(past,'13:00'),end:at(past,'14:00'),status:'completed'},
    {id:'context-past-cancelled',start:at(past,'15:00'),end:at(past,'16:00'),status:'cancelled'},
  ].map(session=>({...session,workItemId:task.id,protected:true,usesReserve:false,focusOverrideMinutes:15}));
  checked(await admin.from('work_sessions').insert(extra.map(body=>({workspace_id:workspaceId,id:body.id,work_item_id:body.workItemId,starts_at:body.start,ends_at:body.end,status:body.status,body}))));
  state=await api('state');
  const principal=checked(await admin.auth.admin.createUser({email:`mcp-crm-${randomUUID()}@example.invalid`,password,email_confirm:true,ban_duration:'87600h',app_metadata:{ada_crm_principal:true}})).user.id;
  users.push(principal);
  const integrationId=randomUUID();
  checked(await admin.from('crm_integrations').insert({id:integrationId,workspace_id:workspaceId,principal_user_id:principal,created_by:owner.id,crm_origin:'https://fictional.example',crm_auth_url:'https://fictional.supabase.co',crm_public_key:'fictional',agency_domain:'example.invalid',credential_hash:'a'.repeat(64)}));
  checked(await admin.from('crm_client_mappings').insert({integration_id:integrationId,workspace_id:workspaceId,external_client_id:'fictional-client',calendar_client_id:task.clientId,confirmed_by:owner.id}));
  checked(await admin.from('crm_task_links').insert({integration_id:integrationId,workspace_id:workspaceId,external_task_id:'fictional-linked-task',external_client_id:'fictional-client',calendar_client_id:task.clientId,work_item_id:task.id,requester_subject:requester.id,requester_email:requester.email}));
  // Opt-in makes this a real no-notification regression, not suppression by preference.
  checked(await admin.from('workspace_members').update({receive_updates:true}).eq('workspace_id',workspaceId).eq('user_id',requester.id));
  const initial=structuredClone(state),rows=checked(await admin.from('work_sessions').select('*').eq('workspace_id',workspaceId).order('id'));
  const eventsBefore=checked(await admin.from('work_events').select('*').eq('workspace_id',workspaceId).order('id'));
  const request=(patch,version=state.version)=>({workspaceId,workItemId:task.id,baseVersion:version,operationId:randomUUID(),patch});
  const patch=request({blockedReason:'FICTIONAL live result verified; awaiting existing policy',workContext:{requestedResult:'Prepare a reviewed draft',requirementsStatus:'tentative',requirementsNote:'Clinical reviewer pending',progressNote:'Verified fictional result',materialsStatus:'missing',materialsNote:'Existing policy copy'},references:['Original fictional email','https://docs.google.com/document/d/fictional-source']});
  const saved=await call(ownerMcp,'update_task_context',patch);
  assert.equal(saved.receipt.outcome,'committed');assert.equal(saved.receipt.notifications,'none');
  assert.equal(saved.workItem.status,'waiting');assert.equal(saved.workItem.workContext.manualOnly,true);
  assert.equal(saved.workItem.workContext.websiteUrl,task.workContext.websiteUrl);
  assert.equal(saved.workItem.workContext.requirementsNote,'Clinical reviewer pending');
  state=await api('state');assert.equal(state.version,initial.version+1);
  assert.deepEqual(state.sessions,initial.sessions);assert.deepEqual(state.blocks,initial.blocks);assert.deepEqual(state.settings,initial.settings);
  const savedItem=state.items.find(item=>item.id===task.id);
  assert.deepEqual(savedItem,{...initial.items.find(item=>item.id===task.id),...patch.patch,workContext:{...task.workContext,...patch.patch.workContext},updatedAt:savedItem.updatedAt});
  assert.deepEqual(checked(await admin.from('work_sessions').select('*').eq('workspace_id',workspaceId).order('id')),rows);
  assert.equal(state.notifications.length,initial.notifications.length);
  const replay=await call(ownerMcp,'update_task_context',patch);assert.equal(replay.receipt.outcome,'replayed');assert.equal(replay.source.scheduleVersion,state.version);
  assert.equal((await api('state')).version,state.version);
  assert.equal((await call(ownerMcp,'update_task_context',{...patch,patch:{blockedReason:'Different retry'}},true)).code,'operation_conflict');
  assert.equal((await call(ownerMcp,'update_task_context',request({description:'Stale content'},initial.version),true)).code,'stale_version');
  // Two distinct stale-base attempts may race, but exactly one commits.
  const competitors=[request({blockedReason:'Concurrent A'}),request({blockedReason:'Concurrent B'})];
  const responses=await Promise.all(competitors.map(data=>page.request.post(origin+'/api/task-context',{headers:{Origin:origin},data})));
  assert.deepEqual(responses.map(r=>r.status()).sort(),[200,409]);
  state=await api('state');
  for(const actor of [viewer,requester,other]) {
    const client=await mcp(sessionFiles[actor.id],'auto');
    assert.equal((await call(client,'update_task_context',request({description:'Denied'}),true)).code,actor===other?'workspace_mismatch':'access_denied');
    const login=await signIn(origin,actor.email,password,true);
    const response=await fetch(origin+'/api/task-context',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',Cookie:Object.entries(login.cookies).map(([name,value])=>`${name}=${value}`).join('; ')},body:JSON.stringify(request({description:'Denied through API'}))});
    assert.equal(response.status,403);
  }
  const wrong=await page.request.post(origin+'/api/task-context',{headers:{Origin:origin},data:{...request({description:'Denied'}),workspaceId:otherWorkspaceId}});assert.equal(wrong.status(),403);
  const invalid=await page.request.post(origin+'/api/task-context',{headers:{Origin:origin},data:request({status:'completed'})});assert.equal(invalid.status(),400);
  // Actual SQL rejects forged proposals even when the caller bypasses the app.
  const authenticated=createClient(config.API_URL,config.ANON_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
  checked(await authenticated.auth.signInWithPassword({email:owner.email,password}));
  const proposal=planCommands(state,[{type:'context_update',itemId:task.id,patch:{blockedReason:'Valid direct fixture'}}],owner,{operationId:randomUUID()});
  assert.equal(proposal.status,'ready');
  for(const forge of [
    p=>{p.items.find(item=>item.id===task.id).remainingMinutes=0;},
    p=>{p.items.find(item=>item.id===task.id).status='completed';},
    p=>{p.items.find(item=>item.id===task.id).windowStart=past;},
    p=>{p.sessions[0].protected=!p.sessions[0].protected;},
    p=>{p.sessions=p.sessions.slice(1);},
    p=>{p.commands[0].patch.status='completed';},
    p=>{p.commands[0].patch.workContext={execute:true};},
  ]) {
    const changed=structuredClone(proposal);forge(changed);
    const result=await authenticated.rpc('commit_task_context',{p_proposal:changed});assert.ok(result.error,'Forged context RPC must be denied');
  }
  for(const actor of [viewer,requester]) {
    const client=createClient(config.API_URL,config.ANON_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
    checked(await client.auth.signInWithPassword({email:actor.email,password}));
    assert.ok((await client.rpc('commit_task_context',{p_proposal:{...proposal,actorId:actor.id}})).error);
  }
  assert.equal((await api('state')).version,state.version);
  const cleared=await call(ownerMcp,'update_task_context',request({blockedReason:null,references:[],workContext:{progressNote:'',materialsNote:''}}));
  assert.equal(cleared.workItem.blockedReason,null);assert.deepEqual(cleared.workItem.references,[]);
  assert.equal(cleared.workItem.workContext.progressNote,'');assert.equal(cleared.workItem.workContext.manualOnly,true);
  // Supported UI at desktop/mobile, including stale-save recovery.
  for(const width of [1440,390]) {
    await page.setViewportSize({width,height:1000});await page.goto(origin+'/?work='+task.id);
    await page.getByRole('button',{name:'Edit waiting reason',exact:true}).click();
    await page.getByRole('textbox',{name:'Waiting reason',exact:true}).fill(`FICTIONAL current dependency at ${width}px`);
    if(width===1440) {
      state=await api('state');await call(ownerMcp,'update_task_context',request({description:'Concurrent description'}));
      await page.getByRole('button',{name:'Save waiting reason',exact:true}).click();
      await expect(page.getByRole('alert')).toContainText('Calendar changed');
      await page.getByRole('button',{name:'Reload saved reason',exact:true}).click();
      await page.getByRole('button',{name:'Edit waiting reason',exact:true}).click();
      await page.getByRole('textbox',{name:'Waiting reason',exact:true}).fill(`FICTIONAL current dependency at ${width}px`);
    }
    await page.screenshot({path:path.join(output,`waiting-reason-editor-${width}.png`)});
    await page.getByRole('button',{name:'Save waiting reason',exact:true}).click();
    await expect(page.getByRole('button',{name:'Edit waiting reason',exact:true})).toBeVisible();
    await page.reload();await expect(page.locator('.waiting-note')).toContainText(`FICTIONAL current dependency at ${width}px`);
    const readback=await call(ownerMcp,'get_work_item',{workItemId:task.id});assert.equal(readback.workItem.status,'waiting');
    assert.equal(readback.workItem.blockedReason,`FICTIONAL current dependency at ${width}px`);
    assert.deepEqual(checked(await admin.from('work_sessions').select('*').eq('workspace_id',workspaceId).order('id')),rows);
  }
  const final=await api('state');assert.equal(final.notifications.length,initial.notifications.length);
  assert.equal(checked(await admin.from('crm_changes').select('sequence').eq('integration_id',integrationId)).length,6);
  const allEvents=checked(await admin.from('work_events').select('*').eq('workspace_id',workspaceId).order('id'));
  assert.deepEqual(allEvents.filter(event=>eventsBefore.some(old=>old.id===event.id)),eventsBefore);
  assert.equal(allEvents.length-eventsBefore.length,6);
  Object.assign(evidence,{contextWrites:true,contextSqlSessionRowsPreserved:true,contextHistoryPreserved:true,contextNoNotifications:true,contextCrmSyncWithoutMail:true,contextRetryAndConcurrentConflict:true,contextDirectRpcTamperingRejected:true,waitingReasonDesktopMobile:true});
  console.log('PASS: scoped MCP/API/SQL context writes, exact retries, stale/concurrent denial, role/workspace isolation, explicit clears, unchanged sessions/history/effort and desktop/mobile waiting-reason saves.');
}
