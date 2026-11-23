/** Fictional local API/SQL/stdio checks. No production accounts or external mail. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createClient} from '@supabase/supabase-js';
import {addDays,nextWorkDate} from '../src/lib/time.ts';
import {exercisePortableRequester} from './mcp-portable-checks.mjs';
export async function exerciseRequester(options) {
  const {restartApp,admin,config,owner,viewer,requester,other,password,workspaceId,otherWorkspaceId,mcp,sessionFiles,call,api,page,origin,date,checked,evidence}=options;
  let client=await mcp(sessionFiles[requester.id],'auto');
  const state=await api('state'),future=nextWorkDate(addDays(date,14),state.settings);
  const task={clientId:'fictional-client',title:'FICTIONAL requester MCP',description:'Fictional approved brief.',category:'web',webKind:'edit',estimatedMinutes:60,windowStart:future,windowEnd:null,targetDate:null,deadline:null,minimumSessionMinutes:15,references:['https://example.test/brief']};
  const make=async(minutes=60)=>({workspaceId,baseVersion:(await api('state')).version,operationId:randomUUID(),change:{kind:'create',task:{...task,estimatedMinutes:minutes},booking:{startDate:future,endDate:future,minutes,distribution:'total'}}});
  const commit=p=>({workspaceId,baseVersion:p.baseVersion,operationId:p.operationId,reviewFingerprint:p.reviewFingerprint});
  const rows=async table=>checked(await admin.from(table).select('*').eq('workspace_id',workspaceId).order('id'));
  const beforeSessions=await rows('work_sessions'),beforeEvents=await rows('work_events');
  const discovery=await call(client,'find_calendar_items',{kind:'clients'});assert.equal(discovery.results[0].id,'fictional-client');
  const availability=await call(client,'get_available_slots',{startDate:future,endDate:future});assert.ok(availability.days[0].openings.length);
  assert.ok(!JSON.stringify({discovery,availability}).includes('privateNotes'));
  const auth=createClient(config.API_URL,config.ANON_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
  checked(await auth.auth.signInWithPassword({email:requester.email,password}));
  const input=await make(),preview=await call(client,'prepare_schedule_change',input);
  assert.equal(preview.plannedOutcome,'booked');
  assert.equal(checked(await auth.from('mcp_schedule_operations').select('*').eq('operation_id',input.operationId)).length,1);
  const ownRecord=checked(await auth.from('mcp_schedule_operations').select('*').eq('operation_id',input.operationId))[0];
  assert.ok((await auth.from('mcp_schedule_operations').update({payload:{}}).eq('operation_id',input.operationId)).error);
  assert.ok((await auth.from('mcp_schedule_operations').delete().eq('operation_id',input.operationId)).error);
  await restartApp();await client.close();client=await mcp(sessionFiles[requester.id],'auto');
  assert.deepEqual((await call(client,'prepare_schedule_change',input)).diff,preview.diff);
  const result=await call(client,'commit_schedule_change',commit(preview));assert.equal(result.receipt.submissionOutcome,'booked');
  let after=await api('state');assert.equal(after.items.find(i=>i.id===input.operationId).requesterId,requester.id);
  assert.deepEqual(after.items.filter(i=>i.id!==input.operationId),state.items);
  assert.equal(after.notifications.filter(n=>n.recipient===requester.email).length,state.notifications.filter(n=>n.recipient===requester.email).length);
  assert.deepEqual((await rows('work_sessions')).filter(s=>beforeSessions.some(old=>old.id===s.id)),beforeSessions);
  assert.deepEqual((await rows('work_events')).filter(s=>beforeEvents.some(old=>old.id===s.id)),beforeEvents);
  const bookedCount=(await rows('work_events')).length;
  await restartApp();const restarted=await mcp(sessionFiles[requester.id],'auto');
  assert.equal((await call(restarted,'commit_schedule_change',commit(preview))).receipt.outcome,'replayed');assert.equal((await rows('work_events')).length,bookedCount);
  // Capacity conflict submits a visible request only; retry after server/adapter restart.
  const pendingInput=await make(600),pendingPreview=await call(restarted,'prepare_schedule_change',pendingInput);
  assert.equal(pendingPreview.plannedOutcome,'pending');assert.deepEqual(pendingPreview.diff,{items:[],sessions:[]});
  const beforePending=await api('state'),beforePendingRows=await rows('work_sessions');
  const pending=await call(restarted,'commit_schedule_change',commit(pendingPreview));assert.equal(pending.receipt.submissionOutcome,'pending');
  after=await api('state');assert.deepEqual(after.items,beforePending.items);assert.deepEqual(await rows('work_sessions'),beforePendingRows);assert.equal(after.version,beforePending.version);
  assert.ok(after.requests.some(r=>r.id===pendingInput.operationId&&r.requesterId===requester.id&&r.status==='pending'));
  await page.setViewportSize({width:1440,height:1000});await page.goto(origin);
  await page.getByRole('button',{name:/^Requests/}).click();
  const card=page.locator('.request-card').filter({hasText:task.title});
  await card.getByRole('button',{name:'Review with current schedule'}).click();
  await page.getByRole('heading',{name:task.title,exact:true}).waitFor();
  await page.screenshot({path:options.output+'/requester-pending-review.png'});
  await page.keyboard.press('Escape');
  const mailCount=after.notifications.length;
  await restartApp();const replayClient=await mcp(sessionFiles[requester.id],'auto');
  assert.equal((await call(replayClient,'commit_schedule_change',commit(pendingPreview))).receipt.outcome,'replayed');
  assert.equal((await rows('pending_requests')).filter(r=>r.id===pendingInput.operationId).length,1);assert.equal((await api('state')).notifications.length,mailCount);
  // Exact request reconciliation works beyond the bounded UI feed.
  checked(await admin.from('pending_requests').update({created_at:'2000-01-01T00:00:00Z'}).eq('id',pendingInput.operationId));
  const historical=Array.from({length:201},()=>{const id=randomUUID();return {id,workspace_id:workspaceId,requester_id:requester.id,body:{id,requesterId:requester.id,requesterName:requester.name,status:'declined',note:'Fictional pagination fixture',createdAt:new Date().toISOString(),resolvedAt:new Date().toISOString(),proposal:{...ownRecord.payload,commands:[],items:[],sessions:[],blocks:[],summary:[],conflicts:[],alternatives:[],affectedItemIds:[]}}};});
  checked(await admin.from('pending_requests').insert(historical));
  assert.equal((await api('state')).requests.some(r=>r.id===pendingInput.operationId),false);
  assert.equal((await call(replayClient,'commit_schedule_change',commit(pendingPreview))).receipt.requestId,pendingInput.operationId);
  checked(await admin.from('pending_requests').delete().in('id',historical.map(r=>r.id)));
  // Same version competing new bookings: only one can commit; neither displaces work.
  const a=await call(replayClient,'prepare_schedule_change',await make()),b=await call(replayClient,'prepare_schedule_change',await make());
  const second=await mcp(sessionFiles[requester.id],'auto');
  const attempts=await Promise.all([replayClient.callTool({name:'commit_schedule_change',arguments:commit(a)}),second.callTool({name:'commit_schedule_change',arguments:commit(b)})]);
  assert.equal(attempts.filter(r=>!r.isError).length,1);assert.equal(attempts.find(r=>r.isError).structuredContent.code,'stale_version');
  // API checks are independent of advertised tool visibility.
  const context=await page.context().browser().newContext();
  const login=await context.request.post(origin+'/api/auth/login',{headers:{Origin:origin},data:{email:requester.email,password}});assert.equal(login.status(),200);
  const post=(action,input,overrides={})=>context.request.post(origin+'/api/mcp-scheduling/'+action,{headers:{Origin:origin},data:{actorId:requester.id,workspaceId,input,...overrides}});
  assert.equal((await post('discover',{kind:'clients'},{actorId:owner.id})).status(),403);
  assert.equal((await post('availability',{startDate:future,endDate:future},{workspaceId:otherWorkspaceId})).status(),403);
  const valid=await make();
  for(const change of [{...valid.change,task:{...task,requesterId:owner.id}}, {kind:'ongoing',workItemId:'mcp-website'},
    {kind:'book',workItemId:'mcp-website',booking:valid.change.booking}, {kind:'reschedule',moves:[{sessionId:'mcp-software-booking',start:'2099-01-01T14:00:00Z',end:'2099-01-01T15:00:00Z',overrideProtected:true}]}])assert.equal((await post('prepare',{...valid,change})).status(),403);
  for(const estimate of [null,0,-1])assert.notEqual((await post('prepare',{...valid,change:{...valid.change,task:{...task,estimatedMinutes:estimate}}})).status(),200);
  const noBooking={...valid.change};delete noBooking.booking;assert.equal((await post('prepare',{...valid,change:noBooking})).status(),400);
  assert.equal((await post('prepare',{...valid,baseVersion:0})).status(),409);
  const forged={...ownRecord.payload,input:{...ownRecord.payload.input,operationId:randomUUID(),change:{kind:'ongoing',workItemId:'mcp-website'} }};
  assert.ok((await auth.rpc('prepare_mcp_schedule',{p_workspace_id:workspaceId,p_operation_id:forged.input.operationId,p_payload:forged})).error);
  for(const actor of [owner,viewer,other]){
    const a=createClient(config.API_URL,config.ANON_KEY,{auth:{persistSession:false,autoRefreshToken:false}});checked(await a.auth.signInWithPassword({email:actor.email,password}));
    assert.equal(checked(await a.from('mcp_schedule_operations').select('*').eq('operation_id',input.operationId)).length,0);
  }
  checked(await admin.from('workspace_members').update({active:false}).eq('user_id',requester.id));
  assert.notEqual((await post('discover',{kind:'clients'})).status(),200);
  assert.equal(checked(await auth.from('mcp_schedule_operations').select('*').eq('operation_id',input.operationId)).length,0);
  assert.ok((await auth.rpc('prepare_mcp_schedule',{p_workspace_id:workspaceId,p_operation_id:input.operationId,p_payload:ownRecord.payload})).error);
  checked(await admin.from('workspace_members').update({active:true}).eq('user_id',requester.id));await context.close();
  await exercisePortableRequester({...options,future});
  evidence.requesterMcp={passed:true,cleanFit:true,pendingWithoutCalendarMutation:true,restartReplay:true,concurrentVersionCheck:true,actorRls:true,immutablePreview:true,spoofAndOwnerEditsDenied:true,invalidEffortDenied:true,revocation:true,optOutPreserved:true};
}
