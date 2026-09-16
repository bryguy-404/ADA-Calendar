-- Fictional isolated-local fixtures. Every account, notification and booking rolls back.
begin;
set local statement_timeout='30s';
create function pg_temp.must_fail(statement text, expected text) returns void language plpgsql as $$
declare failed boolean:=false;
begin
  begin execute statement; exception when others then
    if position(lower(expected) in lower(sqlerrm))=0 then raise; end if; failed:=true;
  end;
  if not failed then raise exception 'Expected failure: %',expected; end if;
end;
$$;
create function pg_temp.preview(connection uuid,preview uuid,human uuid,task text,day date,version bigint) returns jsonb language plpgsql as $$
declare principal uuid; input jsonb; commands jsonb;
begin
  select principal_user_id into principal from public.crm_integrations where id=connection;
  input:=jsonb_build_object('externalTaskId',task,'externalClientId','crm-client','title','Fixture task','estimatedMinutes',60);
  commands:=jsonb_build_array(jsonb_build_object('type','create','item',jsonb_build_object('id',preview,'clientId','calendar-client',
    'requesterId',principal,'requestedBy','teammate@example.invalid','title','Fixture task','description','PRIVATE_DESCRIPTION','category','web',
    'status','planned','priorityId','normal','estimatedMinutes',60,'remainingMinutes',60,'windowStart',day,'deadline',null)));
  perform public.create_crm_preview(connection,preview,human,'teammate@example.invalid',version,1,input,commands,repeat('a',64),now());
  return commands;
end;
$$;
create function pg_temp.proposal(connection uuid,preview uuid,operation uuid,commands jsonb,day date,hour integer) returns jsonb language plpgsql as $$
declare w public.workspaces; principal uuid; session jsonb; sessions jsonb;
begin
  select workspace.* into w from public.workspaces workspace join public.crm_integrations c on c.workspace_id=workspace.id where c.id=connection;
  select principal_user_id into principal from public.crm_integrations where id=connection;
  session:=jsonb_build_object('id',preview||'-session','workItemId',preview,'start',(day+make_time(hour,0,0)) at time zone 'America/Indiana/Indianapolis',
    'end',(day+make_time(hour+1,0,0)) at time zone 'America/Indiana/Indianapolis','status','planned','protected',false,'usesReserve',false);
  select coalesce(jsonb_agg(body order by starts_at,id),'[]') into sessions from public.work_sessions where workspace_id=w.id;
  return jsonb_build_object('operationId','crm-'||connection||'-'||operation,'baseVersion',w.version,'actorId',principal,'status','ready','requiresApproval',false,
    'commands',commands,'items',w.items||jsonb_build_array(commands#>'{0,item}'),'sessions',sessions||jsonb_build_array(session),'blocks',w.blocks,
    'summary',jsonb_build_array('Fixture task booked'),'affectedItemIds',jsonb_build_array(preview));
end;
$$;

do $$
declare workspace uuid:=gen_random_uuid(); owner_id uuid:=gen_random_uuid(); principal uuid:=gen_random_uuid(); viewer uuid:=gen_random_uuid();
  connection uuid:=gen_random_uuid(); human uuid:=gen_random_uuid(); preview uuid:=gen_random_uuid(); race_preview uuid:=gen_random_uuid();
  operation uuid:=gen_random_uuid(); request_preview uuid:=gen_random_uuid(); request_operation uuid:=gen_random_uuid(); reply_operation uuid:=gen_random_uuid();
  day date:=date_trunc('week',now())::date+14; commands jsonb; proposal jsonb; race_commands jsonb; race_proposal jsonb;
  request_commands jsonb; request_proposal jsonb; response jsonb; replay jsonb; original_settings jsonb; before_approval jsonb;
  request_id text; events_count integer; changes_count integer; mail_count integer; current_version bigint; old_actor public.workspace_members;
begin
  insert into auth.users(id,email,raw_app_meta_data,banned_until) values
    (owner_id,'owner-'||owner_id||'@example.invalid','{}',null),
    (viewer,'viewer-'||viewer||'@example.invalid','{}',null),
    (principal,'principal-'||principal||'@example.invalid','{"ada_crm_principal":true}',now()+interval '100 years');
  original_settings:='{"timeZone":"America/Indiana/Indianapolis","weekdays":[1,2,3,4,5],"dayStart":"09:00","dayEnd":"17:00","lunchStart":"12:00","lunchEnd":"12:30","reserveStart":"16:00","reserveMinutes":0}';
  insert into public.workspaces(id,settings,clients,priorities) values(workspace,original_settings,
    '[{"id":"calendar-client","name":"Fictional Client","aliases":["PRIVATE_ALIAS"]}]','[{"id":"normal","label":"Normal","rank":0}]');
  insert into public.workspace_members(workspace_id,user_id,name,email,role) values
    (workspace,owner_id,'Fixture owner','owner-'||owner_id||'@example.invalid','owner'),
    (workspace,viewer,'Fixture viewer','viewer-'||viewer||'@example.invalid','viewer');
  perform set_config('request.jwt.claim.sub',viewer::text,true);
  set local role authenticated;
  perform pg_temp.must_fail('select public.read_crm_owner_setup()','Only the owner');
  perform pg_temp.must_fail('select public.manage_crm_connection(''{"type":"create"}'')','Only the owner');
  reset role;
  perform set_config('request.jwt.claim.sub',owner_id::text,true);
  set local role authenticated;
  perform public.manage_crm_connection(jsonb_build_object('type','create','id',connection,'principalUserId',principal,'crmOrigin','https://crm.example.invalid',
    'crmAuthUrl','https://fixture.supabase.co','crmPublicKey','sb_publishable_fixture','agencyDomain','example.invalid','credentialHash',repeat('b',64)));
  if public.read_crm_owner_setup()#>>'{connections,0,enabled}'<>'false' then raise exception 'Setup enabled itself'; end if;
  if public.read_crm_owner_setup()::text like '%credential%' or public.read_crm_owner_setup()::text like '%principal%' then raise exception 'Setup leaked secrets'; end if;
  perform public.manage_crm_connection(jsonb_build_object('type','map','connectionId',connection,'externalClientId','crm-client','calendarClientId','calendar-client'));
  perform public.manage_crm_connection(jsonb_build_object('type','set_enabled','connectionId',connection,'enabled',true));
  reset role;

  if has_function_privilege('service_role','public.commit_schedule_as_actor(public.workspace_members,jsonb,jsonb,jsonb,text,text)','EXECUTE')
    or has_function_privilege('authenticated','public.finalize_crm_submission(uuid,text,uuid,uuid,uuid,text,text,text,jsonb,text)','EXECUTE')
    or has_function_privilege('anon','public.manage_crm_connection(jsonb)','EXECUTE') then raise exception 'Transaction privilege leak'; end if;
  perform set_config('request.jwt.claim.sub',principal::text,true);
  set local role authenticated;
  perform pg_temp.must_fail('select public.commit_schedule(''{}'',''{}'')','Not authorized');
  perform pg_temp.must_fail('select public.submit_schedule_request(''{}'')','Not authorized');
  reset role;

  commands:=pg_temp.preview(connection,preview,human,'booking-task',day,0);
  race_commands:=pg_temp.preview(connection,race_preview,human,'racing-task',day,0);
  proposal:=pg_temp.proposal(connection,preview,operation,commands,day,9);
  race_proposal:=pg_temp.proposal(connection,race_preview,gen_random_uuid(),race_commands,day,9);
  set local role service_role;
  response:=public.finalize_crm_submission(connection,repeat('b',64),operation,preview,human,'teammate@example.invalid','booking','',proposal,repeat('a',64));
  reset role;
  if response#>>'{task,status}'<>'planned' or response#>>'{task,workItemId}'<>preview::text or response->>'sequence'<>'1'
    or response::text like '%PRIVATE_%' then raise exception 'Bad public booking result'; end if;
  if (select count(*) from public.work_sessions where workspace_id=workspace)<>1
    or (select count(*) from public.work_events where workspace_id=workspace)<>1
    or (select count(*) from public.notifications where workspace_id=workspace)<>2 then raise exception 'Booking not atomic with event/email'; end if;
  set local role service_role;
  -- Same operation must replay even though its original workspace version is stale.
  replay:=public.finalize_crm_submission(connection,repeat('b',64),operation,preview,human,'teammate@example.invalid','booking','',proposal,repeat('a',64));
  if replay<>response then raise exception 'Replay changed result'; end if;
  perform pg_temp.must_fail(format('select public.finalize_crm_submission(%L,%L,%L,%L,%L,%L,''booking'',''changed'',%L,%L)',connection,repeat('b',64),operation,preview,human,'teammate@example.invalid',proposal,repeat('a',64)),'another request');
  perform pg_temp.must_fail(format('select public.finalize_crm_submission(%L,%L,%L,%L,%L,%L,''booking'','''',%L,%L)',connection,repeat('b',64),operation,preview,gen_random_uuid(),'teammate@example.invalid',proposal,repeat('a',64)),'another request');
  perform pg_temp.must_fail(format('select public.finalize_crm_submission(%L,%L,%L,%L,%L,%L,''booking'','''',%L,%L)',connection,repeat('b',64),gen_random_uuid(),race_preview,human,'teammate@example.invalid',race_proposal,repeat('a',64)),'Preview changed');
  reset role;
  if (select count(*) from public.crm_operations where integration_id=connection)<>1 then raise exception 'Failed race left an operation'; end if;

  request_commands:=pg_temp.preview(connection,request_preview,human,'request-task',day,1);
  request_proposal:=pg_temp.proposal(connection,request_preview,request_operation,request_commands,day,9);
  -- A transaction-start clock must not permit a now-past booking after lock wait.
  set local role service_role;
  perform pg_temp.must_fail(format('select public.finalize_crm_submission(%L,%L,%L,%L,%L,%L,''booking'','''',%L,%L)',connection,repeat('b',64),request_operation,request_preview,human,'teammate@example.invalid',jsonb_set(request_proposal,'{sessions,1,start}',to_jsonb(now()+interval '1 microsecond')),repeat('a',64)),'Preview changed');
  reset role;
  -- Valid bindings still cannot bypass overlap exclusion or requester authority.
  set local role service_role;
  perform pg_temp.must_fail(format('select public.finalize_crm_submission(%L,%L,%L,%L,%L,%L,''booking'','''',%L,%L)',connection,repeat('b',64),request_operation,request_preview,human,'teammate@example.invalid',request_proposal,repeat('a',64)),'exclusion constraint');
  perform pg_temp.must_fail(format('select public.finalize_crm_submission(%L,%L,%L,%L,%L,%L,''booking'','''',%L,%L)',connection,repeat('b',64),request_operation,request_preview,human,'teammate@example.invalid',jsonb_set(request_proposal,'{items,0,title}','"Tampered"'),repeat('a',64)),'cannot edit');
  reset role;
  if exists(select 1 from public.crm_operations where integration_id=connection and operation_id=request_operation) then raise exception 'Failed commit left operation intent'; end if;
  request_proposal:=request_proposal||'{"status":"approval_required","requiresApproval":true}';
  set local role service_role;
  response:=public.finalize_crm_submission(connection,repeat('b',64),request_operation,request_preview,human,'teammate@example.invalid','request','Please review',request_proposal,repeat('a',64));
  reset role;
  request_id:=response#>>'{task,requestId}';
  if response#>>'{task,status}'<>'pending' or (select version from public.workspaces where id=workspace)<>1
    or (select count(*) from public.work_sessions where workspace_id=workspace)<>1 then raise exception 'Request changed schedule'; end if;

  perform set_config('request.jwt.claim.sub',owner_id::text,true);
  set local role authenticated;
  perform public.resolve_schedule_request(request_id,'needs_information','Can this use the next open hour?');
  reset role;
  set local role service_role;
  response:=public.reply_crm_request(connection,repeat('b',64),reply_operation,'request-task',human,'teammate@example.invalid','Yes, use the next opening.');
  replay:=public.reply_crm_request(connection,repeat('b',64),reply_operation,'request-task',human,'teammate@example.invalid','Yes, use the next opening.');
  if response<>replay then raise exception 'Reply replay changed'; end if;
  perform pg_temp.must_fail(format('select public.reply_crm_request(%L,%L,%L,''request-task'',%L,''teammate@example.invalid'',''Yes'')',connection,repeat('b',64),gen_random_uuid(),gen_random_uuid()),'this requester');
  reset role;
  if (select jsonb_array_length(body->'conversation') from public.pending_requests where id=request_id)<>3
    or (select body#>>'{conversation,2,message}' from public.pending_requests where id=request_id)<>'Yes, use the next opening.' then raise exception 'Conversation lost a message'; end if;

  before_approval:=jsonb_build_object('items',(select items from public.workspaces where id=workspace),'blocks','[]'::jsonb,
    'sessions',(select jsonb_agg(body order by starts_at,id) from public.work_sessions where workspace_id=workspace));
  request_proposal:=pg_temp.proposal(connection,request_preview,request_operation,request_commands,day,10)
    ||jsonb_build_object('actorId',owner_id,'operationId','approve-fixture');
  set local role authenticated;
  perform public.commit_schedule(request_proposal,jsonb_build_object('id','approve-'||request_operation,'type','request_approved','summary','[]'::jsonb,'itemIds',jsonb_build_array(request_preview)),'[]',request_id,null);
  reset role;
  if not exists(select 1 from public.crm_task_links where integration_id=connection and external_task_id='request-task' and work_item_id=request_preview::text and pending_request_id=request_id)
    then raise exception 'Approval lost source link'; end if;
  if (select body#>>'{status}' from public.crm_changes where integration_id=connection order by sequence desc limit 1)<>'planned' then raise exception 'Approval did not record booked work'; end if;

  -- Undo approval through the existing owner path, preserving permanent source history.
  request_proposal:=before_approval||jsonb_build_object('actorId',owner_id,'operationId','undo-fixture','baseVersion',2,'commands','[]'::jsonb,'status','ready','requiresApproval',false);
  set local role authenticated;
  perform public.commit_schedule(request_proposal,jsonb_build_object('id','undo-'||request_operation,'type','schedule_undone','summary','[]'::jsonb,'itemIds',jsonb_build_array(request_preview)),'[]',null,'approve-'||request_operation);
  reset role;
  if (select body#>>'{status}' from public.crm_changes where integration_id=connection order by sequence desc limit 1)<>'unbooked'
    or not exists(select 1 from public.crm_task_links where integration_id=connection and external_task_id='request-task' and work_item_id=request_preview::text)
    then raise exception 'Undo lost authoritative status or source history'; end if;

  -- A verified CRM requester can opt out of email without losing completion synchronization.
  insert into auth.users(id,email,raw_app_meta_data) values(human,'teammate@example.invalid','{}');
  insert into public.workspace_members(workspace_id,user_id,name,email,role,receive_updates)
    values(workspace,human,'Muted requester','teammate@example.invalid','requester',false);
  -- Changes keep accumulating while the connection is disabled; retries fail closed.
  update public.crm_integrations set enabled=false where id=connection;
  request_proposal:=before_approval||jsonb_build_object('actorId',owner_id,'operationId','complete-fixture','baseVersion',3,'status','ready','requiresApproval',false,
    'commands',jsonb_build_array(jsonb_build_object('type','status','itemId',preview,'status','completed')));
  request_proposal:=jsonb_set(jsonb_set(request_proposal,'{items,0,status}','"completed"'),'{sessions,0,status}','"completed"');
  set local role authenticated;
  perform public.commit_schedule(request_proposal,jsonb_build_object('id','complete-'||operation,'type','schedule_changed','summary','[]'::jsonb,'itemIds',jsonb_build_array(preview)),
    jsonb_build_array(jsonb_build_object('id','muted-completion-'||operation,'recipient','teammate@example.invalid','subject','Completed','body','Fixture completed')));
  reset role;
  if exists(select 1 from public.notifications where workspace_id=workspace and event_id='complete-'||operation) then raise exception 'Muted requester received completion mail'; end if;
  if (select kind from public.crm_changes where integration_id=connection order by sequence desc limit 1)<>'completed' then raise exception 'Disabled connection lost completion'; end if;
  set local role service_role;
  perform pg_temp.must_fail(format('select public.finalize_crm_submission(%L,%L,%L,%L,%L,%L,''booking'','''',%L,%L)',connection,repeat('b',64),operation,preview,human,'teammate@example.invalid',proposal,repeat('a',64)),'connection unavailable');
  reset role;
  if (select settings from public.workspaces where id=workspace)<>original_settings then raise exception 'Saved reserve/settings changed'; end if;
  if exists(select 1 from public.notifications where workspace_id=workspace and (body like '%PRIVATE_%' or status<>'queued')) then raise exception 'Private data leaked or mail was sent'; end if;
  perform pg_temp.must_fail(format('update public.workspaces set clients=''[]'' where id=%L',workspace),'cannot be removed');
  -- Phase 4: an uncertain ID closes permanently, but a completed booking is never cancelled.
  update public.crm_integrations set enabled=true where id=connection;
  select count(*) into events_count from public.work_events where workspace_id=workspace;
  set local role service_role;
  replay:=public.settle_crm_operation(connection,repeat('b',64),operation);
  if replay->>'status'<>'completed' then raise exception 'Settling cancelled committed work'; end if;
  perform pg_temp.must_fail(format('select public.settle_crm_operation(%L,%L,%L)',connection,repeat('c',64),gen_random_uuid()),'unavailable');
  perform pg_temp.must_fail(format('select public.settle_crm_operation(%L,null,%L)',connection,gen_random_uuid()),'unavailable');
  request_operation:=gen_random_uuid();
  replay:=public.settle_crm_operation(connection,repeat('b',64),request_operation);
  if replay->>'status'<>'rejected' then raise exception 'Unknown operation not closed'; end if;
  perform pg_temp.must_fail(format('select public.prepare_crm_operation(%L,%L,%L,%L,%L,%L,%L)',connection,request_operation,'closed-fixture',human,'teammate@example.invalid','booking','{}'::jsonb),'closed');
  request_operation:=gen_random_uuid();
  perform public.prepare_crm_operation(connection,request_operation,'closed-fixture',human,'teammate@example.invalid','booking','{}');
  replay:=public.settle_crm_operation(connection,repeat('b',64),request_operation);
  if replay->>'status'<>'rejected' or public.settle_crm_operation(connection,repeat('b',64),request_operation)<>replay then raise exception 'Prepared closure is not stable'; end if;
  reset role;
  if (select status from public.crm_operations where integration_id=connection and operation_id=request_operation)<>'rejected' then raise exception 'Prepared operation still active'; end if;
  if (select count(*) from public.work_events where workspace_id=workspace)<>events_count then raise exception 'Recovery changed scheduled work'; end if;
  if has_function_privilege('authenticated','public.settle_crm_operation(uuid,text,uuid)','execute')
    or has_table_privilege('authenticated','public.crm_closed_operations','select') then raise exception 'Recovery authority leaked'; end if;
  -- Cleanup is bounded and cannot erase a preview needed by an unresolved operation.
  update public.crm_previews set created_at=now()-interval '8 days',expires_at=now()-interval '8 days'+interval '15 minutes' where id=race_preview and integration_id=connection;
  insert into public.crm_previews select clone.* from public.crm_previews template
    cross join generate_series(1,501) n cross join lateral jsonb_populate_record(null::public.crm_previews,
      to_jsonb(template)||jsonb_build_object('id',md5(n::text||gen_random_uuid()::text)::uuid)) clone
    where template.integration_id=connection and template.id=race_preview;
  set local role service_role;
  perform public.prepare_crm_operation(connection,gen_random_uuid(),'cleanup-fixture',human,'teammate@example.invalid','booking',jsonb_build_object('previewId',race_preview));
  if public.prune_crm_previews(connection,repeat('b',64))<>500 or public.prune_crm_previews(connection,repeat('b',64))<>1 then raise exception 'Cleanup exceeded batch limit or lost retained preview'; end if;
  reset role;
  if not exists(select 1 from public.crm_previews where integration_id=connection and id=race_preview) then raise exception 'Prepared preview deleted'; end if;
  raise notice 'CRM transactions: booking, retries, collisions, authority, requests, replies, approval, Undo, completion, recovery and outbox passed';
end;
$$;
rollback;
