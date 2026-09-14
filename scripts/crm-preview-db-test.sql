-- Phase 2a SQL checks. Fictional local fixtures only; every write rolls back.
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
declare workspace uuid := gen_random_uuid(); other_workspace uuid := gen_random_uuid(); owner_id uuid := gen_random_uuid();
  principal uuid := gen_random_uuid(); integration uuid := gen_random_uuid(); preview uuid := gen_random_uuid();
  human uuid := gen_random_uuid(); payload jsonb; original jsonb; input jsonb; commands jsonb; email text := 'fixture@example.invalid';
begin
  insert into auth.users(id,email,raw_app_meta_data,banned_until) values
    (owner_id,'owner-'||owner_id||'@example.invalid','{}',null),
    (principal,'principal-'||principal||'@example.invalid','{"ada_crm_principal":true}',now()+interval '100 years');
  insert into public.workspaces(id,settings,clients,blocks) values
    (workspace,'{"reserveMinutes":0}','[{"id":"calendar-client","name":"Fictional Client","aliases":[]}]','[{"title":"PRIVATE_APPOINTMENT"}]'),
    (other_workspace,'{"reserveMinutes":60}','[]','[{"title":"OTHER_WORKSPACE"}]');
  insert into public.workspace_members(workspace_id,user_id,name,email,role)
    values(workspace,owner_id,'Fixture owner','owner-'||owner_id||'@example.invalid','owner');
  insert into public.crm_integrations(id,workspace_id,principal_user_id,created_by,crm_origin,crm_auth_url,crm_public_key,agency_domain,credential_hash,enabled)
    values(integration,workspace,principal,owner_id,'https://crm.example.invalid','https://fictional.supabase.co','sb_publishable_fixture','example.invalid',repeat('b',64),true);
  insert into public.crm_client_mappings(integration_id,workspace_id,external_client_id,calendar_client_id,confirmed_by)
    values(integration,workspace,'crm-client','calendar-client',owner_id);
  insert into public.work_sessions(workspace_id,id,work_item_id,starts_at,ends_at,status,body)
    select workspace,'fixture-history-'||n,'fixture-old-work','2026-01-05T14:00:00Z','2026-01-05T14:15:00Z','completed',
      jsonb_build_object('id','fixture-history-'||n,'status','completed') from generate_series(1,1001) n;
  select to_jsonb(w) into original from public.workspaces w where id=workspace;

  set local role service_role;
  payload := public.read_crm_schedule_context(integration,'crm-client');
  if payload#>>'{snapshot,workspaceId}'<>workspace::text or payload#>>'{snapshot,settings,reserveMinutes}'<>'0'
    or payload#>>'{mapping,calendarClientId}'<>'calendar-client' or payload#>>'{mapping,revision}'<>'1'
    or jsonb_array_length(payload#>'{snapshot,sessions}')<>1001 then raise exception 'Snapshot or mapping was incomplete'; end if;
  if payload::text like '%OTHER_WORKSPACE%' or payload::text like '%credential_hash%' then raise exception 'Wrong data in context'; end if;
  if (public.read_crm_schedule_context(integration,'missing-client'))->'mapping'<>'null'::jsonb then raise exception 'Unconfirmed mapping accepted'; end if;
  if public.read_crm_schedule_context(gen_random_uuid(),'crm-client') is not null then raise exception 'Unknown connection accepted'; end if;
  reset role;

  if has_table_privilege('authenticated','public.crm_previews','SELECT,INSERT,UPDATE,DELETE')
    or has_table_privilege('anon','public.crm_previews','SELECT')
    or has_table_privilege('service_role','public.crm_previews','INSERT,UPDATE,DELETE')
    or not (select relrowsecurity from pg_class where oid='public.crm_previews'::regclass)
    then raise exception 'Preview table privilege/RLS failure'; end if;
  set local role authenticated;
  perform pg_temp.must_fail(format('select public.read_crm_schedule_context(%L,''crm-client'')',integration),'permission denied');
  perform pg_temp.must_fail('select * from public.crm_previews','permission denied');
  perform pg_temp.must_fail(format('select public.create_crm_preview(%L,%L,%L,%L,0,1,''{}'',''[]'',%L,now())',integration,preview,human,email,repeat('a',64)),'permission denied');
  reset role;

  input := jsonb_build_object('externalTaskId','fixture-task','externalClientId','crm-client','title','Fictional request','estimatedMinutes',60);
  commands := jsonb_build_array(jsonb_build_object('type','create','item',jsonb_build_object(
    'id',preview,'requesterId',principal,'requestedBy',email,'clientId','calendar-client','priorityId','normal')));
  set local role service_role;
  perform public.create_crm_preview(integration,preview,human,email,0,1,input,commands,repeat('a',64),now());
  select to_jsonb(p) into payload from public.crm_previews p where id=preview and integration_id=integration;
  if payload->>'requester_subject' is distinct from human::text or payload->'input' is distinct from input or payload->'commands' is distinct from commands
    or (payload->>'expires_at')::timestamptz is distinct from (payload->>'created_at')::timestamptz+interval '15 minutes'
    then raise exception 'Preview binding or expiry was not persisted'; end if;
  perform pg_temp.must_fail(format('update public.crm_previews set requester_subject=%L where id=%L',owner_id,preview),'permission denied');
  perform pg_temp.must_fail(format('select public.create_crm_preview(%L,%L,%L,%L,1,1,%L,%L,%L,now())',integration,preview,human,email,input,commands,repeat('a',64)),'changed');
  perform pg_temp.must_fail(format('select public.create_crm_preview(%L,%L,%L,%L,0,1,%L,%L,%L,now()-interval ''16 minutes'')',integration,preview,human,email,input,commands,repeat('a',64)),'expired');
  perform pg_temp.must_fail(format('select public.create_crm_preview(%L,%L,%L,%L,0,1,%L,%L,%L,now()+interval ''1 minute'')',integration,preview,human,email,input,commands,repeat('a',64)),'invalid clock');
  perform pg_temp.must_fail(format('select public.create_crm_preview(%L,%L,%L,''outside@other.invalid'',0,1,%L,%L,%L,now())',integration,preview,human,input,commands,repeat('a',64)),'agency requester');
  perform pg_temp.must_fail(format('select public.create_crm_preview(%L,%L,%L,%L,0,1,%L,%L,%L,now())',integration,preview,human,email,input,jsonb_set(commands,'{0,overrideProtected}','true'),repeat('a',64)),'requester-only');
  reset role;

  update public.crm_client_mappings set confirmed_at=now() where integration_id=integration;
  if (select revision from public.crm_client_mappings where integration_id=integration)<>2 then raise exception 'Mapping revision did not advance'; end if;
  perform pg_temp.must_fail(format('select public.create_crm_preview(%L,%L,%L,%L,0,1,%L,%L,%L,now())',integration,preview,human,email,input,commands,repeat('a',64)),'changed');
  update public.crm_integrations set enabled=false where id=integration;
  if public.read_crm_schedule_context(integration,'crm-client') is not null then raise exception 'Revoked connection could read workload'; end if;
  perform pg_temp.must_fail(format('select public.create_crm_preview(%L,%L,%L,%L,0,2,%L,%L,%L,now())',integration,preview,human,email,input,commands,repeat('a',64)),'disabled');
  if (select count(*) from public.crm_previews where integration_id=integration)<>1 then raise exception 'Rejected previews were persisted'; end if;
  if (select to_jsonb(w) from public.workspaces w where id=workspace)<>original
    or (select count(*) from public.work_sessions where workspace_id=workspace)<>1001
    or exists(select 1 from public.work_events where workspace_id=workspace)
    or exists(select 1 from public.pending_requests where workspace_id=workspace)
    or exists(select 1 from public.notifications where workspace_id=workspace)
    then raise exception 'Previewing changed bookings/settings or enqueued mail'; end if;
  raise notice 'PASS: complete scoped snapshot, private immutable previews, requester binding, 15-minute expiry, version/mapping rejection, revocation, no scheduling/mail';
end;
$$;
rollback;
