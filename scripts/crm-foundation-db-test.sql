-- All fictional fixtures and checks live in one rolled-back local transaction.
begin;
set local statement_timeout='30s';
create function pg_temp.must_fail(statement text, expected_message text) returns void language plpgsql as $$
declare failed boolean := false;
begin
  begin execute statement;
  exception when others then
    if position(lower(expected_message) in lower(sqlerrm))=0 then raise; end if;
    failed := true;
  end;
  if not failed then raise exception 'Expected failure: %', expected_message; end if;
end;
$$;

do $$
declare
  workspace uuid := gen_random_uuid(); other_workspace uuid := gen_random_uuid();
  owner_id uuid := gen_random_uuid(); requester_id uuid := gen_random_uuid(); principal uuid := gen_random_uuid();
  integration uuid := gen_random_uuid(); operation uuid := gen_random_uuid();
  source_user uuid := gen_random_uuid(); before_workspace jsonb; response jsonb; table_name text;
  input jsonb := '{"title":"Fictional CRM foundation test","estimatedMinutes":60}';
  email text := 'fictional-crm-user@example.invalid'; sequence_value bigint;
begin
  insert into auth.users(id,email,raw_app_meta_data,banned_until) values
    (owner_id,'owner-'||owner_id||'@example.invalid','{}',null),
    (requester_id,'requester-'||requester_id||'@example.invalid','{}',null),
    (principal,'principal-'||principal||'@example.invalid','{"ada_crm_principal":true}',now()+interval '100 years');
  insert into public.workspaces(id,settings,clients,items) values
    (workspace,'{"reserveMinutes":0}','[{"id":"calendar-client","name":"Fictional client"}]',
      jsonb_build_array(jsonb_build_object('id','fixture-work','clientId','calendar-client','requesterId',principal))),
    (other_workspace,'{"reserveMinutes":60}','[]','[]');
  insert into public.workspace_members(workspace_id,user_id,name,email,role) values
    (workspace,owner_id,'Fixture owner','owner-'||owner_id||'@example.invalid','owner'),
    (workspace,requester_id,'Fixture requester','requester-'||requester_id||'@example.invalid','requester');
  select to_jsonb(w) into before_workspace from public.workspaces w where id=workspace;

  -- Principal tagging alone prevents accidental membership, before registration.
  perform pg_temp.must_fail(format('insert into public.workspace_members(workspace_id,user_id,name,email,role) values(%L,%L,''Fake owner'',''principal@example.invalid'',''owner'')',workspace,principal), 'cannot be Calendar members');
  insert into public.crm_integrations(id,workspace_id,principal_user_id,created_by,crm_origin,crm_auth_url,crm_public_key,agency_domain,credential_hash)
    values(integration,workspace,principal,owner_id,'https://crm.example.invalid','https://fictional-crm.supabase.co','sb_publishable_fictional_fixture','example.invalid',repeat('a',64));
  if (select enabled from public.crm_integrations where id=integration) then raise exception 'Connection must default disabled'; end if;
  if public.consume_crm_api_budget(integration) then raise exception 'Disabled connection cannot consume API budget'; end if;
  perform pg_temp.must_fail(format('select public.prepare_crm_operation(%L,%L,''fixture-task'',%L,%L,''booking'',%L)',integration,operation,source_user,email,input),'disabled');
  perform pg_temp.must_fail(format('update public.crm_integrations set principal_user_id=%L where id=%L',owner_id,integration),'immutable');
  perform pg_temp.must_fail(format('update public.workspace_members set user_id=%L where user_id=%L',principal,requester_id),'cannot be Calendar members');
  update public.crm_integrations set enabled=true where id=integration;
  perform pg_temp.must_fail(format('insert into public.crm_integrations(workspace_id,principal_user_id,created_by,crm_origin,crm_auth_url,crm_public_key,agency_domain,credential_hash) values(%L,%L,%L,''https://crm.example.invalid'',''https://fictional-crm.supabase.co'',''fixture'',''example.invalid'',%L)',workspace,principal,requester_id,repeat('b',64)), 'requires the active workspace owner');
  perform pg_temp.must_fail(format('insert into public.crm_integrations(workspace_id,principal_user_id,created_by,crm_origin,crm_auth_url,crm_public_key,agency_domain,credential_hash) values(%L,%L,%L,''https://crm.example.invalid'',''https://fictional-crm.supabase.co'',''fixture'',''example.invalid'',%L)',workspace,requester_id,owner_id,repeat('b',64)), 'banned non-member');

  -- All secrets and source history are private, even to signed-in Calendar owners.
  foreach table_name in array array['crm_integrations','crm_client_mappings','crm_task_links','crm_operations','crm_changes','crm_api_budgets'] loop
    if has_table_privilege('anon','public.'||table_name,'SELECT') or has_table_privilege('authenticated','public.'||table_name,'SELECT')
      or has_table_privilege('authenticated','public.'||table_name,'INSERT,UPDATE,DELETE')
      then raise exception 'Browser table privileges leaked: %',table_name; end if;
    if not (select relrowsecurity from pg_class where oid=('public.'||table_name)::regclass) then raise exception 'RLS missing: %',table_name; end if;
  end loop;
  if has_function_privilege('authenticated','public.prepare_crm_operation(uuid,uuid,text,uuid,text,text,jsonb)','EXECUTE')
    or has_function_privilege('anon','public.consume_crm_api_budget(uuid)','EXECUTE')
    or has_function_privilege('service_role','public.append_crm_change(uuid,text,text,jsonb)','EXECUTE')
    then raise exception 'Private RPC privilege leaked'; end if;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',owner_id,'role','authenticated')::text,true);
  set local role authenticated;
  perform pg_temp.must_fail('select * from public.crm_integrations','permission denied');
  reset role;

  -- A forged session subject for the audit principal still grants no Calendar role.
  perform set_config('request.jwt.claims',jsonb_build_object('sub',principal,'role','authenticated')::text,true);
  set local role authenticated;
  if public.current_workspace_id() is not null or public.current_workspace_role() is not null then raise exception 'Principal acquired Calendar membership'; end if;
  if exists(select 1 from public.workspaces) then raise exception 'Principal can read Calendar workspaces'; end if;
  perform pg_temp.must_fail('select public.commit_schedule(''{}'',''{}'')','Not authorized');
  perform pg_temp.must_fail(format('select public.consume_crm_api_budget(%L)',integration),'permission denied');
  reset role;

  -- Owner-confirmed mappings must refer to this connection's workspace and client.
  perform pg_temp.must_fail(format('insert into public.crm_client_mappings(integration_id,workspace_id,external_client_id,calendar_client_id,confirmed_by,confirmed_at) values(%L,%L,''crm-client'',''calendar-client'',%L,now())',integration,workspace,requester_id),'Only the active Calendar owner');
  perform pg_temp.must_fail(format('insert into public.crm_client_mappings(integration_id,workspace_id,external_client_id,calendar_client_id,confirmed_by,confirmed_at) values(%L,%L,''crm-client'',''unknown'',%L,now())',integration,workspace,owner_id),'does not exist');
  perform pg_temp.must_fail(format('insert into public.crm_client_mappings(integration_id,workspace_id,external_client_id,calendar_client_id,confirmed_by,confirmed_at) values(%L,%L,''crm-client'',''calendar-client'',%L,now())',integration,other_workspace,owner_id),'Only the active Calendar owner');
  insert into public.crm_client_mappings(integration_id,workspace_id,external_client_id,calendar_client_id,confirmed_by,confirmed_at) values(integration,workspace,'crm-client','calendar-client',owner_id,now());
  perform pg_temp.must_fail(format('insert into public.crm_task_links(integration_id,workspace_id,external_task_id,external_client_id,calendar_client_id,work_item_id,requester_subject,requester_email) values(%L,%L,''fixture-task'',''crm-client'',''calendar-client'',''missing-work'',%L,%L)',integration,workspace,source_user,email),'must exist');
  insert into public.crm_task_links(integration_id,workspace_id,external_task_id,external_client_id,calendar_client_id,work_item_id,requester_subject,requester_email)
    values(integration,workspace,'fixture-task','crm-client','calendar-client','fixture-work',source_user,email);
  perform pg_temp.must_fail(format('update public.crm_task_links set requester_subject=%L where integration_id=%L',owner_id,integration),'immutable');
  perform pg_temp.must_fail(format('update public.crm_task_links set work_item_id=null where integration_id=%L',integration),'cannot be reassigned');

  -- Retries are bound to the verified human, source task and exact input.
  set local role service_role;
  response := public.prepare_crm_operation(integration,operation,'fixture-task',source_user,email,'booking',input);
  if response->>'status'<>'prepared' or response->'result'<>'null'::jsonb then raise exception 'Prepare must not claim a booking'; end if;
  if response<>public.prepare_crm_operation(integration,operation,'fixture-task',source_user,email,'booking',input) then raise exception 'Retry result changed'; end if;
  perform pg_temp.must_fail(format('select public.prepare_crm_operation(%L,%L,''fixture-task'',%L,%L,''booking'',%L)',integration,operation,owner_id,email,input),'another request');
  perform pg_temp.must_fail(format('select public.prepare_crm_operation(%L,%L,''other-task'',%L,%L,''booking'',%L)',integration,operation,source_user,email,input),'another request');
  perform pg_temp.must_fail(format('select public.prepare_crm_operation(%L,%L,''fixture-task'',%L,%L,''booking'',''{"estimatedMinutes":120}'')',integration,operation,source_user,email),'another request');
  perform pg_temp.must_fail(format('update public.crm_operations set input=''{}'' where integration_id=%L',integration),'immutable');
  update public.crm_operations set status='rejected',result='{"code":"fixture_rejected"}',finished_at=now() where integration_id=integration and operation_id=operation;
  response := public.prepare_crm_operation(integration,operation,'fixture-task',source_user,email,'booking',input);
  if response->>'status'<>'rejected' then raise exception 'Final retry must return its stored result'; end if;
  perform pg_temp.must_fail(format('update public.crm_operations set result=''{}'' where integration_id=%L',integration),'result is final');
  -- A valid 30,000-character non-ASCII description must fit its durable record.
  perform public.prepare_crm_operation(integration,gen_random_uuid(),'unicode-task',source_user,email,'booking',jsonb_build_object('description',repeat('漢',30000)));
  reset role;

  -- Change sequence and insertion roll back together on any failed write.
  sequence_value := public.append_crm_change(integration,'fixture-task','booked','{"status":"fixture"}');
  if sequence_value<>1 then raise exception 'Expected first ordered sequence'; end if;
  perform pg_temp.must_fail(format('select public.append_crm_change(%L,''unlinked-task'',''booked'',''{}'')',integration),'foreign key');
  sequence_value := public.append_crm_change(integration,'fixture-task','schedule_updated','{"status":"fixture"}');
  if sequence_value<>2 then raise exception 'Failed change must not consume a sequence'; end if;

  -- Exercise exhaustion deterministically without depending on a minute boundary.
  if not public.consume_crm_api_budget(integration) then raise exception 'First budget request denied'; end if;
  update public.crm_api_budgets set window_start=date_trunc('minute',clock_timestamp()),request_count=120 where integration_id=integration;
  if public.consume_crm_api_budget(integration) then raise exception 'Exhausted budget accepted'; end if;
  update public.crm_api_budgets set window_start=now()-interval '2 minutes' where integration_id=integration;
  if not public.consume_crm_api_budget(integration) then raise exception 'New budget window denied'; end if;
  update public.crm_integrations set enabled=false where id=integration;
  if public.consume_crm_api_budget(integration) then raise exception 'Revoked connection accepted'; end if;
  if (select to_jsonb(w) from public.workspaces w where id=workspace)<>before_workspace then raise exception 'Foundation changed calendar/settings'; end if;
  if exists(select 1 from public.work_events where workspace_id=workspace)
    or exists(select 1 from public.notifications where workspace_id=workspace)
    or exists(select 1 from public.work_sessions where workspace_id=workspace)
    then raise exception 'Foundation created work or outgoing mail'; end if;
  raise notice 'PASS: private grants, principal isolation, mappings, source identity, idempotency, ordered changes, rate limits, unchanged calendar/settings, no mail';
end;
$$;
rollback;
