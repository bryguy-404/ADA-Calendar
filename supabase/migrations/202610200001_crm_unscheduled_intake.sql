-- Assignment intake has no scheduling authority. No backfill, client writes or mail.
create table public.crm_intakes (
 integration_id uuid not null references public.crm_integrations(id),
 operation_id uuid not null, external_task_id text not null,
 input jsonb not null, result jsonb not null, created_at timestamptz not null default now(),
 primary key(integration_id,operation_id), unique(integration_id,external_task_id)
);
alter table public.crm_intakes enable row level security;
revoke all on public.crm_intakes from public,anon,authenticated;
grant select on public.crm_intakes to service_role;

create function public.receive_crm_intake(p_integration_id uuid,p_credential_hash text,p_input jsonb,p_proposal jsonb,p_mapping_revision bigint)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c public.crm_integrations; w public.workspaces; mapping public.crm_client_mappings;
 saved public.crm_intakes; source public.crm_task_links; actor public.workspace_members;
 item jsonb; command jsonb; payload jsonb; result jsonb; seq bigint; work_id text; event_id text; v_operation uuid;
begin
 select * into c from public.crm_integrations where id=p_integration_id;
 if not found then raise exception 'Connection unavailable' using errcode='42501'; end if;
 select * into w from public.workspaces where id=c.workspace_id for update;
 select * into c from public.crm_integrations where id=p_integration_id for share;
 if not c.enabled or c.credential_hash is distinct from p_credential_hash then raise exception 'Connection unavailable' using errcode='42501'; end if;
 v_operation:=(p_input->>'operationId')::uuid;
 if v_operation is null or coalesce(p_input->>'externalTaskId','')!~'^[A-Za-z0-9_-]{1,150}$'
 or coalesce(p_input->>'externalClientId','')!~'^[A-Za-z0-9_-]{1,150}$'
 or length(coalesce(trim(p_input->>'title'),'')) not between 1 and 200
 or p_input->>'requesterSubject' is null or (p_input->>'requesterSubject')::uuid is null
 or coalesce(p_input->>'requesterEmail','')<>lower(p_input->>'requesterEmail')
 or split_part(coalesce(p_input->>'requesterEmail',''),'@',2)<>c.agency_domain
 then raise exception 'Invalid assignment' using errcode='22023'; end if;
 select * into saved from public.crm_intakes where integration_id=c.id and crm_intakes.operation_id=v_operation;
 if found then
  if saved.input is distinct from p_input then raise exception 'Assignment intent changed' using errcode='23505'; end if;
  return saved.result;
 end if;
 if exists(select 1 from public.crm_task_links where integration_id=c.id and external_task_id=p_input->>'externalTaskId') then
  raise exception 'Task already linked' using errcode='23505'; end if;
 select * into mapping from public.crm_client_mappings where integration_id=c.id and external_client_id=p_input->>'externalClientId' for share;
 if not found or mapping.revision is distinct from p_mapping_revision then raise exception 'Confirm client mapping' using errcode='40001'; end if;
 work_id:='crm-intake-'||v_operation; event_id:='crm-intake-'||c.id||'-'||v_operation;
 command:=p_proposal#>'{commands,0}';
 select value into item from jsonb_array_elements(p_proposal->'items') where value->>'id'=work_id;
 if p_proposal->>'operationId' is distinct from event_id or p_proposal->>'actorId' is distinct from c.principal_user_id::text
 or (p_proposal->>'baseVersion')::bigint is distinct from w.version
 or jsonb_array_length(p_proposal->'commands') is distinct from 1
 or command is distinct from jsonb_build_object('type','create','item',item,'sessions','[]'::jsonb)
 or item->>'id' is distinct from work_id or item->>'clientId' is distinct from mapping.calendar_client_id
 or item->>'title' is distinct from p_input->>'title' or item->>'description' is distinct from p_input->>'description'
 or item->>'deadline' is distinct from p_input->>'due'
 or item->>'requesterId' is distinct from c.principal_user_id::text or item->>'requestedBy' is distinct from left(p_input->>'requesterEmail',120)
 or item->>'status' is distinct from 'waiting' or item->>'estimatedMinutes' is not null or item->>'remainingMinutes' is not null
 or item->>'priorityId' is distinct from 'normal' or item->>'completedAt' is not null
 or p_proposal->'blocks' is distinct from w.blocks
 or jsonb_array_length(p_proposal->'items') is distinct from jsonb_array_length(w.items)+1
 or exists(select 1 from jsonb_array_elements(w.items) old where not exists(select 1 from jsonb_array_elements(p_proposal->'items') fresh where fresh=old))
 or (select coalesce(jsonb_agg(s order by s->>'id'),'[]') from jsonb_array_elements(p_proposal->'sessions') s)
    is distinct from (select coalesce(jsonb_agg(body order by id),'[]') from public.work_sessions where workspace_id=w.id)
 then raise exception 'Intake may only add unscheduled waiting work' using errcode='22023'; end if;
 -- A constrained internal delegation, never an owner membership or an approval.
 actor.workspace_id:=w.id; actor.user_id:=c.principal_user_id; actor.role:='owner';
 actor.name:=p_input->>'requesterEmail'; actor.email:=actor.name; actor.active:=true; actor.receive_updates:=false;
 perform public.commit_schedule_as_actor(actor,p_proposal,jsonb_build_object('id',event_id,'type','crm_intake',
  'summary',p_proposal->'summary','itemIds',jsonb_build_array(work_id)),'[]',null,null);
 insert into public.crm_task_links(integration_id,workspace_id,external_task_id,external_client_id,calendar_client_id,work_item_id,requester_subject,requester_email)
 values(c.id,w.id,p_input->>'externalTaskId',p_input->>'externalClientId',mapping.calendar_client_id,work_id,(p_input->>'requesterSubject')::uuid,p_input->>'requesterEmail') returning * into source;
 -- CRM owns the single assignment email; receiving it emits no duplicate mail.
 payload:=public.crm_task_projection(source);
 seq:=public.append_crm_change(c.id,source.external_task_id,'schedule_updated',payload);
 result:=jsonb_build_object('apiVersion','1','operationId',v_operation,'status','completed','sequence',seq,'task',payload);
 insert into public.crm_intakes(integration_id,operation_id,external_task_id,input,result) values(c.id,v_operation,source.external_task_id,p_input,result);
 return result;
end $$;
revoke all on function public.receive_crm_intake(uuid,text,jsonb,jsonb,bigint) from public,anon,authenticated;
grant execute on function public.receive_crm_intake(uuid,text,jsonb,jsonb,bigint) to service_role;
