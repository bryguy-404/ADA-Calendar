-- Phase 2a: coherent reads and durable, expiring previews. No booking capability.
alter table public.crm_client_mappings add column revision bigint not null default 1 check (revision>0);
create function public.version_crm_client_mapping() returns trigger
language plpgsql set search_path='' as $$
begin
  new.revision := old.revision+1;
  return new;
end;
$$;
create trigger crm_client_mapping_revision before update on public.crm_client_mappings
  for each row execute function public.version_crm_client_mapping();
revoke all on function public.version_crm_client_mapping() from public,anon,authenticated,service_role;

-- One SQL statement observes the connection, mapping, workspace and every session
-- at the same snapshot. Aggregation avoids PostgREST's session pagination limit.
create function public.read_crm_schedule_context(p_integration_id uuid,p_external_client_id text default null)
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object(
    'snapshot',jsonb_build_object(
      'workspaceId',w.id,'version',w.version,'settings',w.settings,'clients',w.clients,
      'priorities',w.priorities,'items',w.items,'blocks',w.blocks,
      'sessions',coalesce((select jsonb_agg(s.body order by s.starts_at,s.id)
        from public.work_sessions s where s.workspace_id=w.id),'[]'::jsonb)),
    'mapping',(select jsonb_build_object('calendarClientId',m.calendar_client_id,'revision',m.revision)
      from public.crm_client_mappings m where m.integration_id=i.id and m.external_client_id=p_external_client_id)
  ) from public.crm_integrations i join public.workspaces w on w.id=i.workspace_id
  where i.id=p_integration_id and i.enabled;
$$;
revoke all on function public.read_crm_schedule_context(uuid,text) from public,anon,authenticated;
grant execute on function public.read_crm_schedule_context(uuid,text) to service_role;

create table public.crm_previews (
  integration_id uuid not null references public.crm_integrations(id),
  id uuid not null,
  requester_subject uuid not null,
  requester_email text not null check (length(requester_email) between 3 and 320),
  external_task_id text not null check (external_task_id ~ '^[A-Za-z0-9_-]{1,150}$'),
  external_client_id text not null check (external_client_id ~ '^[A-Za-z0-9_-]{1,150}$'),
  calendar_client_id text not null,
  mapping_revision bigint not null check (mapping_revision>0),
  base_version bigint not null check (base_version>=0),
  input jsonb not null check (jsonb_typeof(input)='object' and octet_length(input::text)<=262144),
  commands jsonb not null check (jsonb_typeof(commands)='array' and jsonb_array_length(commands)=1 and octet_length(commands::text)<=262144),
  review_fingerprint text not null check (review_fingerprint ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null,
  expires_at timestamptz not null,
  primary key (integration_id,id),
  check (expires_at=created_at+interval '15 minutes')
);
create index crm_previews_expiry on public.crm_previews(integration_id,expires_at);
alter table public.crm_previews enable row level security;
revoke all on public.crm_previews from public,anon,authenticated,service_role;
grant select on public.crm_previews to service_role;

create function public.create_crm_preview(p_integration_id uuid,p_preview_id uuid,p_requester_subject uuid,p_requester_email text,
  p_base_version bigint,p_mapping_revision bigint,p_input jsonb,p_commands jsonb,p_fingerprint text,p_created_at timestamptz)
returns void language plpgsql security definer set search_path='' as $$
declare integration public.crm_integrations; workspace public.workspaces; mapping public.crm_client_mappings;
begin
  select * into integration from public.crm_integrations where id=p_integration_id and enabled;
  if not found then raise exception 'CRM connection is disabled' using errcode='42501'; end if;
  -- Schedule writes lock the workspace first. Use that same order before taking
  -- connection/mapping locks, so future change-log writes cannot deadlock this read.
  select * into workspace from public.workspaces where id=integration.workspace_id for share;
  perform 1 from public.crm_integrations where id=p_integration_id and enabled for share;
  if not found then raise exception 'CRM connection is disabled' using errcode='42501'; end if;
  select * into mapping from public.crm_client_mappings
    where integration_id=p_integration_id and external_client_id=p_input->>'externalClientId' for share;
  if workspace.version is distinct from p_base_version or mapping.revision is distinct from p_mapping_revision
    then raise exception 'Schedule or client mapping changed' using errcode='40001'; end if;
  if p_created_at is null or p_created_at>clock_timestamp()+interval '5 seconds' or p_created_at+interval '15 minutes'<=clock_timestamp()
    then raise exception 'Preview is already expired or has an invalid clock' using errcode='40001'; end if;
  if p_requester_email<>lower(p_requester_email) or split_part(p_requester_email,'@',2)<>integration.agency_domain
    or length(p_requester_email)-length(replace(p_requester_email,'@',''))<>1
    then raise exception 'Verified agency requester required' using errcode='42501'; end if;
  if p_commands#>>'{0,type}' is distinct from 'create'
    or p_commands#>>'{0,item,id}' is distinct from p_preview_id::text
    or p_commands#>>'{0,item,requesterId}' is distinct from integration.principal_user_id::text
    or p_commands#>>'{0,item,requestedBy}' is distinct from left(p_requester_email,120)
    or p_commands#>>'{0,item,clientId}' is distinct from mapping.calendar_client_id
    or p_commands#>>'{0,item,priorityId}' is distinct from 'normal'
    or coalesce((p_commands#>>'{0,overrideProtected}')::boolean,false)
    or coalesce((p_commands#>>'{0,overrideDeadline}')::boolean,false)
    or coalesce((p_commands#>>'{0,urgent}')::boolean,false)
    then raise exception 'Preview must contain requester-only new work'; end if;
  insert into public.crm_previews(integration_id,id,requester_subject,requester_email,external_task_id,external_client_id,
    calendar_client_id,mapping_revision,base_version,input,commands,review_fingerprint,created_at,expires_at)
    values(p_integration_id,p_preview_id,p_requester_subject,p_requester_email,p_input->>'externalTaskId',p_input->>'externalClientId',
      mapping.calendar_client_id,p_mapping_revision,p_base_version,p_input,p_commands,p_fingerprint,p_created_at,p_created_at+interval '15 minutes');
end;
$$;
revoke all on function public.create_crm_preview(uuid,uuid,uuid,text,bigint,bigint,jsonb,jsonb,text,timestamptz) from public,anon,authenticated;
grant execute on function public.create_crm_preview(uuid,uuid,uuid,text,bigint,bigint,jsonb,jsonb,text,timestamptz) to service_role;

-- No calendar writes, connection enabling, live configuration, or cleanup jobs.
-- Phase 2b must recheck expiry, human identity, mapping revision, workspace version
-- and recomputed review fingerprint before any atomic booking/request transaction.
