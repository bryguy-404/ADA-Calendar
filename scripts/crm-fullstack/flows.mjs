import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {addDays,nextWorkDate,localDateTime} from '../../src/lib/time.ts';
import {DEFAULT_SETTINGS} from '../../src/lib/defaults.ts';

export async function exerciseFlows(h) {
  const {cal,crm,requester,requesterId,otherId,otherSession,workspaceId,connectionId,owner,gateway,submit,sync,restartCrm,page,ownerContext,ownerOrigin,day,outputDir,checked,sql,container,expect,fault}=h;
  const task=async id=>checked(await crm.from('tasks').select('*').eq('id',id).single());
  const state=()=>owner('state');
  const nextDay=nextWorkDate(addDays(day,1),DEFAULT_SETTINGS),laterDay=nextWorkDate(addDays(nextDay,1),DEFAULT_SETTINGS);
  const input=(title,scheduling={mode:'day',date:day},minutes=60)=>({externalTaskId:'fullstack-'+randomUUID(),externalClientId:'fullstack-client',title,category:'web',webKind:'edit',estimatedMinutes:minutes,description:'PRIVATE_FULLSTACK_DESCRIPTION',scheduling});
  const preview=async task=>{const id=randomUUID();return {id,task,...await submit('previews',{submissionId:id,kind:'create',task})};};
  const finish=(p,action='bookings')=>submit('submit',{submissionId:p.id,previewId:p.preview.previewId,action,note:''});
  const commandPreview=(commands,operationId=randomUUID())=>owner('commands',{commands,operationId,action:'preview'}).then(result=>({...result,commands,operationId}));
  async function commands(list) {
    const review=await commandPreview(list);assert.equal(review.proposal.status,'ready');
    return owner('commands',{commands:list,operationId:review.operationId,action:'commit',baseVersion:review.proposal.baseVersion,reviewFingerprint:review.proposal.reviewFingerprint});
  }
  // Create through the actual CRM UI. The request uses both actual Auth/REST services.
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.locator('[data-id="fullstack-client"]').getByRole('button',{name:'Toggle tasks'}).click();
  const form=page.locator('[data-add]');await form.getByLabel('Task',{exact:true}).fill('FICTIONAL full-stack browser booking');
  await form.getByLabel('Owner',{exact:true}).selectOption('Bryan');await form.getByRole('button',{name:'Add Task'}).click();
  const dialog=page.locator('[aria-labelledby=calendarTitle]');await expect(dialog).toBeVisible();
  await dialog.getByLabel('Estimated hours').fill('2');await dialog.getByLabel('Schedule',{exact:true}).selectOption('day');await dialog.locator('[name=date]').fill(day);
  await dialog.getByRole('button',{name:'Check Calendar',exact:true}).click();
  await expect(dialog.getByText('This task fits',{exact:true})).toBeVisible({timeout:20000});
  await page.screenshot({path:path.join(outputDir,'crm-real-preview.png')});
  await dialog.getByRole('button',{name:'Book task',exact:true}).click();await expect(dialog).not.toBeVisible({timeout:20000});
  const rows=checked(await crm.from('tasks').select('*').eq('title','FICTIONAL full-stack browser booking'));assert.equal(rows.length,1);const first=rows[0];assert.equal(first.calendar.status,'planned');
  assert.ok((await state()).items.some(item=>item.id===first.calendar.workItemId));
  const ownerPage=await ownerContext.newPage();await ownerPage.goto(ownerOrigin);await expect(ownerPage.locator('body')).toContainText('FICTIONAL full-stack browser booking');
  await ownerPage.screenshot({path:path.join(outputDir,'calendar-real-booking.png')});
  await sync();console.log('PASS: real browser → CRM gateway → CRM Auth → Calendar API/scheduler → both databases and Calendar UI.');

  // New due-date work fits around existing bookings; the prior task remains unchanged.
  const due=await preview(input('FICTIONAL due date',{mode:'due_by',date:nextDay,flexible:false},120));assert.equal(due.preview.status,'fits');
  assert.equal((await finish(due)).state,'completed');
  const beforeConflict=await state();
  const conflict=await preview(input('FICTIONAL conflict',{mode:'exact',date:day,startTime:'09:00'},60));assert.notEqual(conflict.preview.status,'fits');assert.ok(conflict.preview.alternatives.length);
  const requested=await finish(conflict,'requests');assert.equal(requested.result.task.status,'pending');
  assert.deepEqual((await state()).sessions,beforeConflict.sessions);
  await owner('requests/resolve',{id:requested.result.task.requestId,decision:'needs_information',note:'Can we shift the earlier task?'});await sync();
  assert.equal((await task(conflict.task.externalTaskId)).calendar.status,'needs_information');
  const spoof=await gateway('replies',{submissionId:randomUUID(),externalTaskId:conflict.task.externalTaskId,message:'Forged',actorId:otherId});assert.equal(spoof.status,400);
  const wrongRequester=await gateway('replies',{submissionId:randomUUID(),externalTaskId:conflict.task.externalTaskId,message:'Not my request'},otherSession.access_token);assert.equal(wrongRequester.status,403);
  const reply=await submit('replies',{submissionId:randomUUID(),externalTaskId:conflict.task.externalTaskId,message:'Please review shifting it.'});assert.equal(reply.state,'completed');
  const approval=await owner('requests/resolve',{id:requested.result.task.requestId,decision:'approved',preview:true});assert.equal(approval.proposal.status,'ready');
  const approved=await owner('requests/resolve',{id:requested.result.task.requestId,decision:'approved',baseVersion:approval.state.version,reviewFingerprint:approval.proposal.reviewFingerprint,note:'Fictional approval'});
  const approvalEvent=approved.state.events.find(event=>event.operationId==='approve/'+requested.result.task.requestId);assert.ok(approvalEvent);
  await sync();assert.equal((await task(conflict.task.externalTaskId)).calendar.status,'planned');
  await owner('undo',{id:approvalEvent.id});await sync();assert.equal((await task(conflict.task.externalTaskId)).calendar.status,'unbooked');
  const removedId=conflict.task.externalTaskId;assert.equal((await finish(conflict,'requests')).result.task.status,'pending');
  assert.equal((await task(removedId)).calendar.status,'unbooked','Replaying old acceptance must not recreate undone work');
  console.log('PASS: due dates, conflict alternatives, original-requester reply, owner approval and Undo remain authoritative.');

  // Schedule edits, completion and exact Undo reach both CRM data and its live subscription.
  await commands([{type:'update',itemId:first.calendar.workItemId,patch:{title:'FICTIONAL renamed in Calendar'}}]);await sync();
  assert.equal((await task(first.id)).title,'FICTIONAL renamed in Calendar');
  await expect(page.locator('.task').filter({hasText:'FICTIONAL renamed in Calendar'})).toBeVisible({timeout:15000});
  const done=await commands([{type:'status',itemId:first.calendar.workItemId,status:'completed'}]);await sync();assert.equal((await task(first.id)).done,true);
  await owner('undo',{id:done.state.events.find(event=>event.operationId===done.proposal.operationId).id});await sync();assert.equal((await task(first.id)).done,false);
  await commands([{type:'status',itemId:first.calendar.workItemId,status:'cancelled'}]);await sync();assert.equal((await task(first.id)).calendar.status,'cancelled');assert.equal((await task(first.id)).done,false);
  assert.equal((await state()).settings.reserveMinutes,0);
  console.log('PASS: Calendar title edits, live CRM subscription updates, completion, Undo and cancellation.');

  // Two reviewed requests compete for the same free exact slot. Only one can commit.
  const racers=await Promise.all(['A','B'].map(label=>preview(input('FICTIONAL race '+label,{mode:'exact',date:laterDay,startTime:'09:00'}))));
  const raced=await Promise.all(racers.map(p=>gateway('submit',{submissionId:p.id,previewId:p.preview.previewId,action:'bookings',note:''})));
  assert.equal(raced.filter(r=>r.status===200&&r.data.state==='completed').length,1);assert.equal(raced.filter(r=>r.status===409).length,1);
  const winner=racers[raced.findIndex(r=>r.status===200)];
  const replayed=await Promise.all([finish(winner),finish(winner)]);assert.deepEqual(replayed[0],replayed[1]);
  assert.equal(checked(await crm.from('tasks').select('id').eq('id',winner.task.externalTaskId)).length,1);
  const stale=await preview(input('FICTIONAL stale',{mode:'day',date:laterDay}));
  await commands([{type:'update',itemId:(await task(due.task.externalTaskId)).calendar.workItemId,patch:{title:'FICTIONAL due date updated'}}]);
  assert.equal((await gateway('submit',{submissionId:stale.id,previewId:stale.preview.previewId,action:'bookings',note:''})).status,409);
  console.log('PASS: competing bookings, repeated clicks and stale previews cannot duplicate or overbook work.');

  // Simulate an actual lost response after Calendar commits, then restart CRM.
  const lost=await preview(input('FICTIONAL lost response',{mode:'day',date:laterDay}));
  fault({path:'/api/integrations/crm/v1/bookings',operationId:lost.id});
  assert.equal((await finish(lost)).state,'committing');await sync();
  assert.equal((await task(lost.task.externalTaskId)).calendar.status,'planned');
  assert.equal(checked(await crm.from('tasks').select('id').eq('id',lost.task.externalTaskId)).length,1);
  const undispatched=await preview(input('FICTIONAL interrupted dispatch',{mode:'day',date:laterDay}));
  fault({path:'/api/integrations/crm/v1/bookings',operationId:undispatched.id,before:true});
  assert.equal((await finish(undispatched)).state,'committing');
  checked(await crm.from('calendar_submissions').update({updated_at:new Date(Date.now()-180000).toISOString()}).eq('id',undispatched.id));
  await sync();assert.equal(checked(await crm.from('calendar_submissions').select('state').eq('id',undispatched.id).single()).state,'rejected');
  assert.equal(checked(await cal.from('crm_closed_operations').select('operation_id').eq('integration_id',connectionId).eq('operation_id',undispatched.id)).length,1);
  assert.equal(checked(await crm.from('tasks').select('id').eq('id',undispatched.task.externalTaskId)).length,0);
  console.log('PASS: lost commit acknowledgement recovers once; an undispatched attempt is fenced before a fresh review.');

  // Mark actual booked work protected using owner authority, then verify a requester cannot move it.
  const winningTask=await task(winner.task.externalTaskId),workId=winningTask.calendar.workItemId;
  const protectedSessions=(await state()).sessions.filter(s=>s.workItemId===workId).map(s=>({...s,protected:true}));
  await commands([{type:'schedule',itemId:workId,sessions:protectedSessions}]);
  const protectedRequest=await preview(input('FICTIONAL protected conflict',{mode:'exact',date:laterDay,startTime:'09:00'}));
  assert.notEqual(protectedRequest.preview.status,'fits');
  const protectedResult=await finish(protectedRequest,'requests');const requestId=protectedResult.result.task.requestId;
  const withoutOverride=await owner('requests/resolve',{id:requestId,decision:'approved',preview:true});assert.notEqual(withoutOverride.proposal.status,'ready');
  const source=(await state()).requests.find(r=>r.id===requestId);
  const overrides=source.proposal.commands.map(c=>({...c,overrideProtected:true}));
  const withOverride=await owner('requests/resolve',{id:requestId,decision:'approved',preview:true,commands:overrides});assert.equal(withOverride.proposal.status,'ready');
  await owner('requests/resolve',{id:requestId,decision:'approved',commands:overrides,baseVersion:withOverride.state.version,reviewFingerprint:withOverride.proposal.reviewFingerprint});await sync();
  assert.equal((await task(protectedRequest.task.externalTaskId)).calendar.status,'planned');
  const blockedDay=nextWorkDate(addDays(laterDay,1),DEFAULT_SETTINGS);
  await commands([{type:'block',block:{id:randomUUID(),title:'PRIVATE_PERSONAL_BLOCK',kind:'time_off',start:localDateTime(blockedDay,'09:00',DEFAULT_SETTINGS.timeZone),end:localDateTime(blockedDay,'17:00',DEFAULT_SETTINGS.timeZone)}}]);
  const blocked=await preview(input('FICTIONAL private unavailable time',{mode:'exact',date:blockedDay,startTime:'09:00'}));assert.notEqual(blocked.preview.status,'fits');assert.doesNotMatch(JSON.stringify(blocked.preview),/PRIVATE_PERSONAL_BLOCK/);
  const declined=await finish(blocked,'requests');await owner('requests/resolve',{id:declined.result.task.requestId,decision:'declined',note:'Use an open date.'});await sync();
  assert.equal((await task(blocked.task.externalTaskId)).calendar.status,'declined');assert.equal((await task(blocked.task.externalTaskId)).done,false);
  console.log('PASS: protected time needs explicit owner override; private unavailable time stays private; decline is not completion.');

  // Database guards remain effective when the UI is bypassed; grandfathered work still edits.
  assert.ok((await requester.from('tasks').insert({id:'fullstack-bypass',client_id:'fullstack-client',title:'Unchecked',owner:'Bryan'})).error);
  assert.ok((await requester.from('tasks').update({done:true}).eq('id',winner.task.externalTaskId)).error);
  assert.ok((await requester.from('clients').delete().eq('id','fullstack-client')).error);
  checked(await requester.from('tasks').update({title:'FICTIONAL edited legacy'}).eq('id','fullstack-legacy'));
  const unmapped=await gateway('previews',{submissionId:randomUUID(),kind:'create',task:{...input('FICTIONAL unmapped'),externalClientId:'unmapped'}});assert.notEqual(unmapped.status,200);
  const publicState=await state();assert.doesNotMatch(JSON.stringify(publicState),/ada_crm_v1_/);
  console.log('PASS: direct-write protection, retained client/source history, old-task behavior and client mismatch.');

  // Internal companies added on CRM main use the same mapping and scheduling boundary.
  const internalId='internal-alpha-dog-agency';
  assert.ok((await requester.from('tasks').insert({id:'fullstack-internal-bypass',client_id:internalId,title:'Unchecked internal',owner:'Bryan'})).error);
  const internalInput={...input('FICTIONAL internal company task'),externalClientId:internalId};
  assert.notEqual((await gateway('previews',{submissionId:randomUUID(),kind:'create',task:internalInput})).status,200);
  await owner('admin/crm',{type:'map',connectionId,externalClientId:internalId,calendarClientId:'fullstack-client'});
  await page.reload();
  const internalPanel=page.locator('[data-id="'+internalId+'"]');
  await internalPanel.getByRole('button',{name:'Toggle tasks'}).click();
  await expect(internalPanel.getByRole('button',{name:'Copy Calendar client ID'})).toBeVisible();
  await expect(internalPanel.locator('[data-remove-client], [name=mrr]')).toHaveCount(0);
  const internalForm=internalPanel.locator('[data-add]');
  await internalForm.getByLabel('Task',{exact:true}).fill(internalInput.title);
  await internalForm.getByLabel('Owner',{exact:true}).selectOption('Bryan');
  await internalForm.getByRole('button',{name:'Add Task'}).click();
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Estimated hours').fill('0.25');
  await dialog.getByLabel('Schedule',{exact:true}).selectOption('day');
  await dialog.locator('[name=date]').fill(nextWorkDate(addDays(blockedDay,1),DEFAULT_SETTINGS));
  await dialog.getByRole('button',{name:'Check Calendar',exact:true}).click();
  await expect(dialog.getByText('This task fits',{exact:true})).toBeVisible();
  await dialog.getByRole('button',{name:'Book task',exact:true}).click();await expect(dialog).not.toBeVisible();
  await sync();
  const internalRows=checked(await crm.from('tasks').select('*').eq('title',internalInput.title));assert.equal(internalRows.length,1);
  assert.equal(internalRows[0].client_id,internalId);assert.equal(internalRows[0].calendar.status,'planned');
  assert.ok((await state()).items.some(item=>item.id===internalRows[0].calendar.workItemId));
  await expect(internalPanel.locator('.task').filter({hasText:internalInput.title}).locator('[data-done]')).toBeDisabled();
  await page.screenshot({path:path.join(outputDir,'crm-internal-company-booking.png'),fullPage:true});
  console.log('PASS: internal company tasks require owner mapping, book through the real Calendar API, and retain linked controls.');

  // Pause only new work; existing changes keep syncing, including after a worker restart.
  checked(await crm.from('calendar_connection').update({accepting:false}).eq('singleton',true));
  assert.equal((await gateway('previews',{submissionId:randomUUID(),kind:'create',task:input('FICTIONAL paused')})).status,503);
  await commands([{type:'status',itemId:(await task(winner.task.externalTaskId)).calendar.workItemId,status:'waiting',overrideProtected:true}]);await sync();assert.equal((await task(winner.task.externalTaskId)).calendar.status,'waiting');
  checked(await crm.from('calendar_connection').update({accepting:true}).eq('singleton',true));
  const rotated=await owner('admin/crm',{type:'rotate',connectionId});
  assert.notEqual((await gateway('previews',{submissionId:randomUUID(),kind:'create',task:input('FICTIONAL old key')})).status,200);
  await restartCrm({ADA_CALENDAR_CREDENTIAL:rotated.credential});await sync();
  assert.equal((await preview(input('FICTIONAL rotated credential'))).preview.status,'fits');
  await owner('admin/crm',{type:'set_enabled',connectionId,enabled:false});
  assert.notEqual((await gateway('previews',{submissionId:randomUUID(),kind:'create',task:input('FICTIONAL disabled')})).status,200);
  await owner('admin/crm',{type:'set_enabled',connectionId,enabled:true});await sync();
  checked(await crm.auth.admin.updateUserById(requesterId,{ban_duration:'24h'}));
  assert.equal((await gateway('status')).status,401);
  checked(await crm.auth.admin.updateUserById(requesterId,{ban_duration:'none'}));
  console.log('PASS: pause, restart/catch-up, credential rotation, connection revocation and revoked CRM user.');

  const notifications=checked(await cal.from('notifications').select('status,body').eq('workspace_id',workspaceId));assert.ok(notifications.length);assert.ok(notifications.every(n=>n.status==='queued'));assert.doesNotMatch(JSON.stringify(notifications),/PRIVATE_FULLSTACK_DESCRIPTION/);
  const linked=checked(await crm.from('tasks').select('id').not('calendar','is',null)).map(t=>t.id);
  const mail=checked(await crm.from('task_assignment_emails').select('task_id,status').in('task_id',linked));assert.equal(mail.filter(m=>['pending','sending','sent'].includes(m.status)).length,0);
  assert.ok(checked(await crm.from('tasks').select('id').eq('id',removedId)).length,'Undo history is retained');
  const health=await submit('status');assert.equal(health.sync.stale,false);assert.equal(errors.length,0);
  // Inspecting the real provider outboxes never dispatches them.
  assert.equal(sql(container,"select count(*) from public.task_assignment_emails where status='sent';").trim(),'0');
  await page.screenshot({path:path.join(outputDir,'crm-real-synchronized.png')});
  await ownerContext.pages().at(-1)?.screenshot({path:path.join(outputDir,'calendar-real-final.png')});
  console.log('PASS: integrated notification ownership, queued-only mail, source retention and healthy synchronization.');
}
