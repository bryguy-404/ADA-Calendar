-- A source-bound withdrawal capability; no general requester editing authority.
alter table public.crm_operations drop constraint crm_operations_kind_check;
alter table public.crm_operations add constraint crm_operations_kind_check check(kind in ('booking','request','reply','cancellation'));
create table public.crm_cancellations (
  integration_id uuid not null references public.crm_integrations(id),
  operation_id uuid not null,
  external_task_id text not null,
  requester_subject uuid not null,
  requester_email text not null,
  reason text not null check(length(trim(reason)) between 1 and 1000),
  created_at timestamptz not null default now(),
  primary key(integration_id,operation_id),
  foreign key(integration_id,external_task_id) references public.crm_task_links(integration_id,external_task_id)
);
alter table public.crm_cancellations enable row level security;
revoke all on public.crm_cancellations from public,anon,authenticated,service_role;
create or replace function public.crm_task_projection(p_link public.crm_task_links) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare w public.workspaces; item jsonb; request jsonb; client jsonb; cancellation jsonb;
begin
  select * into strict w from public.workspaces where id=p_link.workspace_id;
  select value into item from jsonb_array_elements(w.items) where value->>'id'=p_link.work_item_id;
  select body into request from public.pending_requests where id=p_link.pending_request_id;
  select value into client from jsonb_array_elements(w.clients) where value->>'id'=coalesce(item->>'clientId',p_link.calendar_client_id);
  select jsonb_build_object('by',requester_email,'at',created_at,'reason',reason) into cancellation from public.crm_cancellations where integration_id=p_link.integration_id and external_task_id=p_link.external_task_id order by created_at desc limit 1;
  return jsonb_build_object('cancellation',cancellation,'externalTaskId',p_link.external_task_id,'workItemId',p_link.work_item_id,
    'requestId',p_link.pending_request_id,'requestStatus',request->>'status',
    'status',case when item is not null then item->>'status' when p_link.work_item_id is not null then 'unbooked' when cancellation is not null and request->>'status'='declined' then 'cancelled' else request->>'status' end,
    'title',coalesce(item->>'title',request#>>'{proposal,commands,0,item,title}'),
    'client',jsonb_build_object('id',client->>'id','name',client->>'name'),
    'estimatedMinutes',coalesce(item->'estimatedMinutes',request#>'{proposal,commands,0,item,estimatedMinutes}'),
    'remainingMinutes',item->'remainingMinutes','priorityId',item->>'priorityId',
    'targetDate',item->>'targetDate','deadline',item->>'deadline','forecastDate',item->>'forecastDate',
    'timeZone',w.settings->>'timeZone','version',w.version,
    'decisionNote',case when request->>'status' in ('needs_information','declined') then left(request->>'note',5000) else null end,
    'sessions',coalesce((select jsonb_agg(jsonb_build_object('start',body->>'start','end',body->>'end','status',status) order by starts_at,id)
      from public.work_sessions where workspace_id=w.id and work_item_id=p_link.work_item_id),'[]'::jsonb));
end;
$$;
revoke all on function public.crm_task_projection(public.crm_task_links) from public,anon,authenticated,service_role;

-- The review token changes with schedule or request decisions; elapsed time is only a warning.
create function public.read_crm_cancellation(p_integration_id uuid,p_credential_hash text,p_external_task_id text,p_requester_subject uuid,p_requester_email text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c public.crm_integrations; source public.crm_task_links; w public.workspaces; request jsonb; task jsonb; started boolean; protected boolean;
begin
  select * into c from public.crm_integrations where id=p_integration_id and enabled and credential_hash=p_credential_hash;
  if not found then raise exception 'Connection unavailable' using errcode='42501'; end if;
  select * into source from public.crm_task_links where integration_id=c.id and external_task_id=p_external_task_id;
  if not found or (source.requester_subject,source.requester_email) is distinct from (p_requester_subject,p_requester_email) then
    raise exception 'Only the original requester can cancel this task' using errcode='42501'; end if;
  select * into w from public.workspaces where id=c.workspace_id;
  select body into request from public.pending_requests where id=source.pending_request_id;
  task:=public.crm_task_projection(source);
  started:=task->>'status'='in_progress' or coalesce((task->>'remainingMinutes')::numeric<(task->>'estimatedMinutes')::numeric,false) or exists(select 1 from public.work_sessions where workspace_id=w.id and work_item_id=source.work_item_id and (status='completed' or status='planned' and starts_at<clock_timestamp()));
  protected:=exists(select 1 from public.work_sessions where workspace_id=w.id and work_item_id=source.work_item_id and status='planned' and ends_at>clock_timestamp() and coalesce((body->>'protected')::boolean,false));
  return jsonb_build_object('apiVersion','1','task',task,'reviewToken',md5(jsonb_build_object('version',w.version,'request',request)::text),
    'canCancel',task->>'status' in ('planned','in_progress','waiting','pending','needs_information') and not protected,
    'started',started,'protected',protected);
end $$;
revoke all on function public.read_crm_cancellation(uuid,text,text,uuid,text) from public,anon,authenticated;
grant execute on function public.read_crm_cancellation(uuid,text,text,uuid,text) to service_role;

create function public.cancel_crm_task(p_integration_id uuid,p_credential_hash text,p_operation_id uuid,p_external_task_id text,
  p_requester_subject uuid,p_requester_email text,p_review_token text,p_reason text,p_acknowledge_started boolean,p_proposal jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c public.crm_integrations; source public.crm_task_links; w public.workspaces; review jsonb; intent jsonb; v_result jsonb;
  actor public.workspace_members; old_item jsonb; fresh jsonb; old_session public.work_sessions; evt text; version bigint;
begin
  select * into c from public.crm_integrations where id=p_integration_id;
  if not found then raise exception 'Connection unavailable' using errcode='42501'; end if;
  select * into w from public.workspaces where id=c.workspace_id for update;
  select * into c from public.crm_integrations where id=p_integration_id for update;
  if not c.enabled or c.credential_hash is distinct from p_credential_hash then raise exception 'Connection unavailable' using errcode='42501'; end if;
  select * into source from public.crm_task_links where integration_id=c.id and external_task_id=p_external_task_id;
  if not found or (source.requester_subject,source.requester_email) is distinct from (p_requester_subject,p_requester_email) then
    raise exception 'Only the original requester can cancel this task' using errcode='42501'; end if;
  if p_reason is null or length(trim(p_reason)) not between 1 and 1000 or p_review_token is null or p_acknowledge_started is null then raise exception 'Invalid cancellation' using errcode='22023'; end if;
  intent:=jsonb_build_object('externalTaskId',p_external_task_id,'reviewToken',p_review_token,'reason',p_reason,'acknowledgeStarted',p_acknowledge_started);
  v_result:=public.prepare_crm_operation(c.id,p_operation_id,p_external_task_id,p_requester_subject,p_requester_email,'cancellation',intent);
  if v_result->>'status'<>'prepared' then return v_result->'result'; end if;
  review:=public.read_crm_cancellation(c.id,p_credential_hash,p_external_task_id,p_requester_subject,p_requester_email);
  if review->>'reviewToken' is distinct from p_review_token or not (review->>'canCancel')::boolean or (review->>'started')::boolean and not p_acknowledge_started then
    raise exception 'Cancellation review changed or task cannot be cancelled' using errcode='40001'; end if;
  evt:='crm-cancel-'||c.id||'-'||p_operation_id;
  insert into public.crm_cancellations(integration_id,operation_id,external_task_id,requester_subject,requester_email,reason)
    values(c.id,p_operation_id,p_external_task_id,p_requester_subject,p_requester_email,p_reason);
  if source.work_item_id is null then
    -- Withdrawal is a terminal requester decision, not an owner rejection or approval.
    update public.pending_requests set body=body||jsonb_build_object('status','declined','resolvedAt',now(),
      'note','Withdrawn by '||p_requester_email||': '||p_reason,
      'conversation',coalesce(body->'conversation','[]')||jsonb_build_array(jsonb_build_object('author','requester','message','Cancelled: '||p_reason,'createdAt',now())))
      where id=source.pending_request_id and body->>'status' in ('pending','needs_information');
    if not found then raise exception 'Request changed' using errcode='40001'; end if;
  else
    -- A narrowly delegated cancellation uses the shared scheduler transaction. Before
    -- invoking it, SQL independently proves no other work/history/settings can change.
    if p_proposal is null or p_proposal->'commands' is distinct from jsonb_build_array(jsonb_build_object('type','status','itemId',source.work_item_id,'status','cancelled'))
      or p_proposal->>'actorId' is distinct from c.principal_user_id::text or p_proposal->>'operationId' is distinct from evt
      or (p_proposal->>'baseVersion')::bigint is distinct from w.version or p_proposal->'blocks' is distinct from w.blocks
      or jsonb_array_length(p_proposal->'items') is distinct from jsonb_array_length(w.items) then raise exception 'Invalid cancellation proposal' using errcode='22023'; end if;
    for old_item in select value from jsonb_array_elements(w.items) loop
      select value into fresh from jsonb_array_elements(p_proposal->'items') where value->>'id'=old_item->>'id';
      if old_item->>'id'=source.work_item_id then
        if fresh->>'status' is distinct from 'cancelled' or fresh->>'completedAt' is not null or fresh->>'blockedReason' is not null
          or (fresh-'status'-'updatedAt'-'forecastDate'-'completedAt'-'blockedReason'-'timelineMode') is distinct from (old_item-'status'-'updatedAt'-'forecastDate'-'completedAt'-'blockedReason'-'timelineMode') then
          raise exception 'Cancellation may only change task status' using errcode='22023'; end if;
      elsif fresh is distinct from old_item then raise exception 'Cancellation cannot edit other work' using errcode='22023'; end if;
    end loop;
    for old_session in select * from public.work_sessions where workspace_id=w.id loop
      select value into fresh from jsonb_array_elements(p_proposal->'sessions') where value->>'id'=old_session.id;
      if old_session.work_item_id<>source.work_item_id or old_session.status<>'planned' or old_session.ends_at<=clock_timestamp() then
        if fresh is distinct from old_session.body then raise exception 'Cancellation must preserve completed and unrelated history' using errcode='22023'; end if;
      elsif fresh is not null and fresh is distinct from old_session.body then
        if fresh-'end' is distinct from old_session.body-'end' or (fresh->>'end')::timestamptz>clock_timestamp()+interval '5 seconds'
          or (fresh->>'end')::timestamptz<=old_session.starts_at then raise exception 'Invalid partial booking release' using errcode='22023'; end if;
      end if;
    end loop;
    if exists(select 1 from jsonb_array_elements(p_proposal->'sessions') s where not exists(select 1 from public.work_sessions old where old.workspace_id=w.id and old.id=s->>'id')) then
      raise exception 'Cancellation cannot add sessions' using errcode='22023'; end if;
    actor.workspace_id:=w.id; actor.user_id:=c.principal_user_id; actor.name:=p_requester_email; actor.email:=p_requester_email;
    -- Internal capability only, after exact source/intent validation; no member gains owner access.
    actor.role:='owner'; actor.active:=true; actor.receive_updates:=false;
    version:=public.commit_schedule_as_actor(actor,p_proposal,jsonb_build_object('id',evt,'type','crm_cancelled',
      'summary',jsonb_build_array('Cancelled by '||p_requester_email||': '||p_reason),'itemIds',jsonb_build_array(source.work_item_id),
      'crmCancellation',jsonb_build_object('requesterSubject',p_requester_subject,'email',p_requester_email,'reason',p_reason)),'[]',null,null);
  end if;
  v_result:=jsonb_build_object('apiVersion','1','operationId',p_operation_id,'status','completed','task',public.crm_task_projection(source),
    'sequence',(select last_sequence from public.crm_integrations where id=c.id));
  update public.crm_operations set status='completed',result=v_result,finished_at=now() where integration_id=c.id and operation_id=p_operation_id;
  return v_result;
end $$;
revoke all on function public.cancel_crm_task(uuid,text,uuid,text,uuid,text,text,text,boolean,jsonb) from public,anon,authenticated;
grant execute on function public.cancel_crm_task(uuid,text,uuid,text,uuid,text,text,text,boolean,jsonb) to service_role;
