-- Scoped descriptive edits use the existing workspace lock, version and event ledger.
-- This function never writes work_sessions, blocks, settings or notifications.
create or replace function public.commit_task_context(p_proposal jsonb)
returns bigint language plpgsql security definer set search_path='' as $$
declare m public.workspace_members; w public.workspaces; prior public.work_events;
  command jsonb; patch jsonb; context_patch jsonb; old_item jsonb; next_item jsonb; expected jsonb;
  stored_sessions jsonb; next_items jsonb; before_state jsonb; after_state jsonb; evt jsonb;
  field text; value jsonb; saved_at text;
begin
  select * into m from public.workspace_members where user_id=auth.uid() and active for share;
  if m.user_id is null or m.role<>'owner' then raise exception 'Only the owner can update task context' using errcode='42501'; end if;
  select * into w from public.workspaces where id=m.workspace_id for update;
  if not found then raise exception 'Workspace unavailable' using errcode='42501'; end if;
  select * into prior from public.work_events where workspace_id=w.id and operation_id=p_proposal->>'operationId';
  if found then
    if prior.actor_id<>m.user_id or prior.operation_payload is distinct from p_proposal->'commands'
      then raise exception 'Operation id already used for a different actor or command'; end if;
    return prior.version;
  end if;
  if (p_proposal->>'baseVersion')::bigint is distinct from w.version
    then raise exception 'Schedule changed. Read fresh context before saving.' using errcode='40001'; end if;
  if p_proposal->>'actorId' is distinct from m.user_id::text or p_proposal->>'status' is distinct from 'ready'
    or p_proposal->'requiresApproval' is distinct from 'false'::jsonb
    then raise exception 'Invalid context proposal'; end if;
  if coalesce(p_proposal->>'operationId','') !~ '^[0-9a-fA-F-]{36}$'
    or jsonb_typeof(p_proposal->'commands') is distinct from 'array' or jsonb_array_length(p_proposal->'commands')<>1
    then raise exception 'Save one task context patch with an operation ID'; end if;
  command:=p_proposal->'commands'->0; patch:=command->'patch';
  if command->>'type' is distinct from 'context_update' or command-'type'-'itemId'-'patch'<>'{}'::jsonb
    or jsonb_typeof(patch) is distinct from 'object' or patch='{}'::jsonb
    or patch-'title'-'description'-'references'-'blockedReason'-'workContext'<>'{}'::jsonb
    then raise exception 'Only descriptive task context fields are supported'; end if;
  select item into old_item from jsonb_array_elements(w.items) item where item->>'id'=command->>'itemId';
  if old_item is null then raise exception 'Work item unavailable in this workspace'; end if;
  if patch ? 'title' and (jsonb_typeof(patch->'title')<>'string' or length(patch->>'title') not between 1 and 200 or patch->>'title'<>btrim(patch->>'title'))
    then raise exception 'Invalid title'; end if;
  if patch ? 'description' and (jsonb_typeof(patch->'description')<>'string' or length(patch->>'description')>30000)
    then raise exception 'Invalid description'; end if;
  if patch ? 'blockedReason' then
    if old_item->>'status'<>'waiting' then raise exception 'Waiting reason requires an already-waiting task'; end if;
    if jsonb_typeof(patch->'blockedReason') not in ('string','null') or length(patch->>'blockedReason')>2000
      then raise exception 'Invalid waiting reason'; end if;
  end if;
  if patch ? 'references' then
    if jsonb_typeof(patch->'references')<>'array' or jsonb_array_length(patch->'references')>20
      then raise exception 'Invalid references'; end if;
    if exists(select 1 from jsonb_array_elements(patch->'references') ref where jsonb_typeof(ref)<>'string' or length(ref#>>'{}')>2000)
      then raise exception 'Invalid reference'; end if;
  end if;
  expected:=old_item || (patch-'workContext');
  if patch ? 'workContext' then
    context_patch:=patch->'workContext';
    if jsonb_typeof(context_patch)<>'object' or context_patch='{}'::jsonb
      or context_patch-'websiteUrl'-'projectUrl'-'requestedResult'-'requirementsStatus'-'requirementsNote'-'progressNote'-'materialsStatus'-'materialsNote'-'manualOnly'<>'{}'::jsonb
      then raise exception 'Invalid website context patch'; end if;
    for field,value in select * from jsonb_each(context_patch) loop
      if field='manualOnly' then
        if jsonb_typeof(value)<>'boolean' then raise exception 'Invalid manual coordination value'; end if;
      else
        if jsonb_typeof(value)<>'string' or length(value#>>'{}')>(case when field in ('websiteUrl','projectUrl','materialsNote') then 2000 else 4000 end)
          then raise exception 'Invalid website context text'; end if;
        if field='requirementsStatus' and (value#>>'{}') not in ('tentative','confirmed') then raise exception 'Invalid requirements state'; end if;
        if field='materialsStatus' and (value#>>'{}') not in ('not_checked','ready','missing','inaccessible') then raise exception 'Invalid materials state'; end if;
        if field in ('websiteUrl','projectUrl') and (value#>>'{}')<>'' and
          ((value#>>'{}') !~* '^https?://[^/?#[:space:]]+' or substring(split_part(value#>>'{}','://',2) from '^[^/?#]+') ~ '@')
          then raise exception 'Use an HTTP(S) URL without embedded credentials'; end if;
      end if;
    end loop;
    expected:=expected||jsonb_build_object('workContext',
      '{"websiteUrl":"","projectUrl":"","requestedResult":"","requirementsStatus":"tentative","progressNote":"","materialsStatus":"not_checked","materialsNote":"","manualOnly":false}'::jsonb
      || coalesce(old_item->'workContext','{}'::jsonb) || context_patch);
  end if;
  if jsonb_typeof(p_proposal->'items') is distinct from 'array' or jsonb_array_length(p_proposal->'items')<>jsonb_array_length(w.items)
    then raise exception 'Context cannot add or remove tasks'; end if;
  select item into next_item from jsonb_array_elements(p_proposal->'items') item where item->>'id'=old_item->>'id';
  if next_item is null or next_item-'updatedAt' is distinct from expected-'updatedAt'
    or exists(select 1 from jsonb_array_elements(w.items) old where old->>'id'<>old_item->>'id'
      and not exists(select 1 from jsonb_array_elements(p_proposal->'items') fresh where fresh=old))
    then raise exception 'Context cannot change status, effort, project dates or other tasks'; end if;
  select coalesce(jsonb_agg(body order by starts_at,id),'[]'::jsonb) into stored_sessions from public.work_sessions where workspace_id=w.id;
  if p_proposal->'sessions' is distinct from stored_sessions or p_proposal->'blocks' is distinct from w.blocks
    then raise exception 'Context must preserve every booking, completed session and block'; end if;
  saved_at:=to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  expected:=expected||jsonb_build_object('updatedAt',saved_at);
  select jsonb_agg(case when item->>'id'=old_item->>'id' then expected else item end order by ord)
    into next_items from jsonb_array_elements(w.items) with ordinality rows(item,ord);
  before_state:=jsonb_build_object('items',w.items,'sessions',stored_sessions,'blocks',w.blocks);
  after_state:=jsonb_build_object('items',next_items,'sessions',stored_sessions,'blocks',w.blocks);
  update public.workspaces set items=next_items,version=version+1 where id=w.id;
  evt:=jsonb_build_object('id',pg_catalog.gen_random_uuid()::text,'operationId',p_proposal->>'operationId',
    'actorId',m.user_id,'actorName',m.name,'version',w.version+1,'type','task_context_updated',
    'summary',jsonb_build_array('Updated task context for '||(expected->>'title')||'. Schedule, effort and status unchanged.'),
    'itemIds',jsonb_build_array(old_item->>'id'),'before',before_state,'after',after_state,'createdAt',saved_at,'undoneBy',null);
  insert into public.work_events(id,workspace_id,operation_id,actor_id,version,body,operation_payload)
    values(evt->>'id',w.id,p_proposal->>'operationId',m.user_id,w.version+1,evt,p_proposal->'commands');
  return w.version+1;
end;
$$;
revoke all on function public.commit_task_context(jsonb) from public,anon;
grant execute on function public.commit_task_context(jsonb) to authenticated;

-- Context is synchronized to CRM's existing change feed without stakeholder mail.
-- Other event kinds retain their existing notification behavior.
create or replace function public.track_crm_work_event() returns trigger
language plpgsql security definer set search_path='' as $$
declare source public.crm_task_links; before_item jsonb; after_item jsonb; before_sessions jsonb; after_sessions jsonb; kind text;
begin
  for source in select * from public.crm_task_links where workspace_id=new.workspace_id and work_item_id is not null order by integration_id,external_task_id loop
    select value into before_item from jsonb_array_elements(new.body#>'{before,items}') where value->>'id'=source.work_item_id;
    select value into after_item from jsonb_array_elements(new.body#>'{after,items}') where value->>'id'=source.work_item_id;
    select coalesce(jsonb_agg(s order by s->>'id'),'[]') into before_sessions from jsonb_array_elements(new.body#>'{before,sessions}') s where s->>'workItemId'=source.work_item_id;
    select coalesce(jsonb_agg(s order by s->>'id'),'[]') into after_sessions from jsonb_array_elements(new.body#>'{after,sessions}') s where s->>'workItemId'=source.work_item_id;
    if before_item is distinct from after_item or before_sessions is distinct from after_sessions then
      kind:=case when after_item->>'status' in ('completed','cancelled') then after_item->>'status' else 'schedule_updated' end;
      if new.body->>'type'='task_context_updated' and new.operation_payload->0->>'type'='context_update' then
        perform public.append_crm_change(source.integration_id,source.external_task_id,kind,public.crm_task_projection(source));
      else
        perform public.record_crm_task_change(source,kind,new.id,false);
      end if;
    end if;
  end loop;
  return new;
end;
$$;
