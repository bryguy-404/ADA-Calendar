/** Isolated fictional local SQL/Auth/stdio checks. Never called against production. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {homedir} from 'node:os';
import {existsSync} from 'node:fs';
import {createClient} from '@supabase/supabase-js';
import {addDays,nextWorkDate} from '../src/lib/time.ts';

export async function exerciseScheduling({restartApp,admin,config,owner,viewer,requester,other,password,workspaceId,otherWorkspaceId,ownerMcp,mcp,sessionFiles,call,api,page,origin,date,at,checked,evidence}) {
  const baseline=await api('state');
  const auth=createClient(config.API_URL,config.ANON_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
  checked(await auth.auth.signInWithPassword({email:owner.email,password}));
  const records=checked(await admin.from('work_sessions').select('*').eq('workspace_id',workspaceId).order('id'));
  const events=checked(await admin.from('work_events').select('*').eq('workspace_id',workspaceId).order('id'));
  const future=nextWorkDate(addDays(date,2),baseline.settings),later=nextWorkDate(addDays(future,1),baseline.settings);
  const task={clientId:'fictional-client',title:'FICTIONAL MCP scheduling',description:'Fictional source brief; no client work authorized.',category:'web',webKind:'edit',estimatedMinutes:null,
    windowStart:date,windowEnd:null,targetDate:addDays(later,7),deadline:null,minimumSessionMinutes:15,references:['https://example.test/original'],
    workContext:{websiteUrl:'https://example.test',projectUrl:'',requestedResult:'Fictional verification',requirementsStatus:'confirmed',progressNote:'',materialsStatus:'ready',materialsNote:'',manualOnly:false}};
  const request=async change=>({workspaceId,baseVersion:(await api('state')).version,operationId:randomUUID(),change});
  const commitArgs=p=>({workspaceId,baseVersion:p.baseVersion,operationId:p.operationId,reviewFingerprint:p.reviewFingerprint});
  const create=await request({kind:'create',task});
  const discovery=await call(ownerMcp,'find_calendar_items',{kind:'clients',query:'fictional'});
  assert.equal(discovery.results[0].id,task.clientId);
  const availability=await call(ownerMcp,'get_available_slots',{startDate:future,endDate:later});
  assert.ok(availability.days[0].openings.length>0);
  const p=await call(ownerMcp,'prepare_schedule_change',create);
  assert.equal((await api('state')).version,baseline.version);
  assert.equal((await api('state')).notifications.length,baseline.notifications.length);
  assert.ok(checked(await auth.from('mcp_schedule_operations').select('operation_id').eq('workspace_id',workspaceId)).some(r=>r.operation_id===create.operationId));
  // Reopen a real stdio process and read the persisted preview rather than memory.
  await restartApp();
  const restarted=await mcp(sessionFiles[owner.id],'auto');
  await new Promise(resolve=>setTimeout(resolve,1100));
  const pAgain=await call(restarted,'prepare_schedule_change',create);assert.deepEqual(pAgain.diff,p.diff);
  const saved=await call(restarted,'commit_schedule_change',commitArgs(p));assert.equal(saved.receipt.outcome,'committed');
  let state=await api('state');assert.equal(state.items.find(i=>i.id===create.operationId).status,'waiting');
  assert.equal(state.sessions.filter(s=>s.workItemId===create.operationId).length,0);
  assert.equal((await call(ownerMcp,'commit_schedule_change',commitArgs(p))).receipt.outcome,'replayed');
  assert.equal((await api('state')).version,state.version);
  const candidates=await call(ownerMcp,'find_calendar_items',{kind:'tasks',unscheduledOnly:true});assert.ok(candidates.results.some(i=>i.id===create.operationId));
  const book=await request({kind:'book',workItemId:create.operationId,booking:{startDate:future,endDate:later,minutes:510,distribution:'total',resumeWaiting:true}});
  const bp=await call(ownerMcp,'prepare_schedule_change',book);assert.ok(bp.diff.sessions.length>=3);
  await call(ownerMcp,'commit_schedule_change',commitArgs(bp));
  state=await api('state');let own=state.sessions.filter(s=>s.workItemId===create.operationId);
  assert.equal(own.reduce((n,s)=>n+(Date.parse(s.end)-Date.parse(s.start))/60000,0),510);
  assert.equal(state.items.find(i=>i.id===create.operationId).remainingMinutes,null);
  const moving=own.find(s=>(Date.parse(s.end)-Date.parse(s.start))/60000===60);
  assert.ok(moving);
  const destination=nextWorkDate(addDays(later,1),state.settings);
  const move=await request({kind:'reschedule',moves:[{sessionId:moving.id,start:at(destination,'09:00'),end:at(destination,'10:00'),overrideProtected:false}]});
  const mp=await call(ownerMcp,'prepare_schedule_change',move);await call(ownerMcp,'commit_schedule_change',commitArgs(mp));
  state=await api('state');assert.equal(state.sessions.find(s=>s.id===moving.id).start,move.change.moves[0].start);
  own=state.sessions.filter(s=>s.workItemId===create.operationId);
  const ongoing=await request({kind:'ongoing',workItemId:create.operationId,unknownEffort:true});
  const op=await call(ownerMcp,'prepare_schedule_change',ongoing);await call(ownerMcp,'commit_schedule_change',commitArgs(op));
  state=await api('state');assert.deepEqual(state.sessions.filter(s=>s.workItemId===create.operationId),own);
  assert.equal(state.items.find(i=>i.id===create.operationId).targetDate,task.targetDate);
  assert.equal(state.items.find(i=>i.id===create.operationId).timelineMode,'span');
  // Competing prepared operations are both valid at preview time, only one can commit.
  const a=await request({kind:'create',task:{...task,title:'FICTIONAL concurrent A'}}),b=await request({kind:'create',task:{...task,title:'FICTIONAL concurrent B'}});
  const ap=await call(ownerMcp,'prepare_schedule_change',a),bp2=await call(ownerMcp,'prepare_schedule_change',b);
  const responses=await Promise.all([ap,bp2].map(preview=>page.request.post(origin+'/api/mcp-scheduling/commit',{headers:{Origin:origin},data:{actorId:owner.id,workspaceId,input:commitArgs(preview)}})));
  assert.deepEqual(responses.map(r=>r.status()).sort(),[200,409]);
  assert.equal((await call(ownerMcp,'prepare_schedule_change',{...a,change:{kind:'ongoing',workItemId:'mcp-website',unknownEffort:true}},true)).code,'operation_conflict');
  const stale=await call(ownerMcp,'prepare_schedule_change',{...await request({kind:'create',task}),baseVersion:baseline.version},true);assert.equal(stale.code,'stale_version');
  for(const actor of [viewer,requester,other]) {
    const c=await mcp(sessionFiles[actor.id],'auto');
    const denied=await call(c,'prepare_schedule_change',await request({kind:'create',task}),true);
    assert.equal(denied.code,'access_denied');
    const auth=createClient(config.API_URL,config.ANON_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
    checked(await auth.auth.signInWithPassword({email:actor.email,password}));
    assert.equal(checked(await auth.from('mcp_schedule_operations').select('*').eq('workspace_id',workspaceId)).length,0);
    assert.ok((await auth.rpc('prepare_mcp_schedule',{p_workspace_id:workspaceId,p_operation_id:randomUUID(),p_payload:{}})).error);
  }
  const wrong=await page.request.post(origin+'/api/mcp-scheduling/prepare',{headers:{Origin:origin},data:{actorId:owner.id,workspaceId:otherWorkspaceId,input:await request({kind:'create',task})}});assert.equal(wrong.status(),403);
  const old=checked(await auth.from('mcp_schedule_operations').select('*').eq('operation_id',create.operationId))[0];
  assert.ok((await auth.from('mcp_schedule_operations').update({payload:{}}).eq('operation_id',create.operationId)).error);
  assert.ok((await auth.from('mcp_schedule_operations').delete().eq('operation_id',create.operationId)).error);
  assert.deepEqual(checked(await auth.from('mcp_schedule_operations').select('*').eq('operation_id',create.operationId))[0],old);
  // Saved preferences: opt-in receives captured normal scheduling mail, opt-out suppresses it.
  checked(await admin.from('workspace_members').update({receive_updates:true}).eq('user_id',requester.id));
  const countBefore=(await api('state')).notifications.length;
  const notified=await call(ownerMcp,'prepare_schedule_change',await request({kind:'create',task:{...task,title:'FICTIONAL opted-in notification'}}));
  await call(ownerMcp,'commit_schedule_change',commitArgs(notified));
  const countAfter=(await api('state')).notifications.length;assert.ok(countAfter>countBefore);
  await call(restarted,'commit_schedule_change',commitArgs(notified));assert.equal((await api('state')).notifications.length,countAfter);
  checked(await admin.from('workspace_members').update({receive_updates:false}).eq('user_id',requester.id));
  const silent=await call(ownerMcp,'prepare_schedule_change',await request({kind:'create',task:{...task,title:'FICTIONAL saved opt-out'}}));
  await call(ownerMcp,'commit_schedule_change',commitArgs(silent));assert.equal((await api('state')).notifications.length,countAfter);
  // Scheduled creation has real multi-call delay; its creation timestamp is assigned on save.
  const scheduled=await call(ownerMcp,'prepare_schedule_change',await request({kind:'create',task:{...task,title:'FICTIONAL scheduled create'},booking:{startDate:destination,endDate:destination,minutes:30,distribution:'total'}}));
  await new Promise(resolve=>setTimeout(resolve,1100));await call(restarted,'commit_schedule_change',commitArgs(scheduled));
  state=await api('state');
  assert.deepEqual(state.items.filter(i=>baseline.items.some(old=>old.id===i.id)),baseline.items);
  assert.deepEqual(checked(await admin.from('work_sessions').select('*').eq('workspace_id',workspaceId).order('id')).filter(r=>records.some(old=>old.id===r.id)),records);
  assert.deepEqual(checked(await admin.from('work_events').select('*').eq('workspace_id',workspaceId).order('id')).filter(r=>events.some(old=>old.id===r.id)),events);
  assert.deepEqual(state.settings,baseline.settings);assert.deepEqual(state.blocks,baseline.blocks);
  // Test the maintained Claude gateway without loading its config or private session.
  const gateway=process.env.ADA_CLAUDE_GATEWAY || path.join(homedir(),'Documents/Codex/ada-agency-workflows/scripts/calendar_readonly.py');
  assert.ok(existsSync(gateway),'Set ADA_CLAUDE_GATEWAY to the maintained read-only gateway for this local acceptance test.');
  const proof=execFileSync('python3',['-B','-c',`import importlib.util,json\ns=importlib.util.spec_from_file_location('gateway',${JSON.stringify(gateway)})\nm=importlib.util.module_from_spec(s);s.loader.exec_module(m)\nnames=['find_calendar_items','get_available_slots','prepare_schedule_change','commit_schedule_change','update_task_context']\nassert all(not m.permitted({'method':'tools/call','params':{'name':n}}) for n in names)\nassert m.permitted({'method':'tools/call','params':{'name':'get_work_item'}})\nr=m.filtered_response({'id':1,'result':{'tools':[{'name':n} for n in names+['get_work_item']]}},{1})\nassert [t['name'] for t in r['result']['tools']]==['get_work_item']\nprint('read-only allowlist verified')`],{encoding:'utf8'});
  assert.match(proof,/verified/);
  Object.assign(evidence,{mcpScheduling:{passed:true,persistentSqlPreview:true,adapterAndServerRestartReplay:true,delayedCreate:true,unscheduledCreate:true,multiSlotFit:true,exactMovePreservesId:true,ongoingRetainsSessions:true,concurrentVersionCheck:true,ownerRlsIsolation:true,immutablePreview:true,historyAndUnrelatedRowsUnchanged:true,optInCaptureAndOptOutPreserved:true,claudeReadOnly:true,
    efficiency:{unit:'UTF-8 JSON bytes (not model tokens)',fullStateBytes:Buffer.byteLength(JSON.stringify(baseline)),discoveryBytes:Buffer.byteLength(JSON.stringify(discovery)),availabilityBytes:Buffer.byteLength(JSON.stringify(availability)),prepareBytes:Buffer.byteLength(JSON.stringify(p)),commitBytes:Buffer.byteLength(JSON.stringify(saved)),schedulingCallsAfterKnownIds:2}}});
  console.log('PASS: actual stdio → owner API → SQL scheduling, delayed creates, durable preview/replay, exact moves, ongoing, RLS/concurrency/history/notification preferences and Claude read-only allowlist.');
}
