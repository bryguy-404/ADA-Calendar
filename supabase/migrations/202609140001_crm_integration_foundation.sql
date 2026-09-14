-- Phase 1: private integration foundation only. No connection is enabled or seeded.
-- These records do not give the CRM a Calendar login or a scheduling capability.
create table public.crm_integrations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id),
  principal_user_id uuid not null unique references auth.users(id),
  created_by uuid not null references auth.users(id),
  crm_origin text not null check (crm_origin ~ '^https://[a-z0-9][a-z0-9.-]*(:[0-9]+)?$'),
  crm_auth_url text not null check (crm_auth_url ~ '^https://[a-z0-9-]+[.]supabase[.]co$'),
  crm_public_key text not null check (length(crm_public_key) between 1 and 4096),
  agency_domain text not null check (agency_domain ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?([.][a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'),
  credential_hash text not null check (credential_hash ~ '^[a-f0-9]{64}$'),
  enabled boolean not null default false,
  last_sequence bigint not null default 0 check (last_sequence >= 0),
  created_at timestamptz not null default now(),
  unique (id, workspace_id)
);

-- The technical identity exists for audit FKs only: banned, tagged by trusted Auth
-- administration, and NEVER a workspace member. All existing browser RPCs deny it.
create function public.guard_crm_integration_identity() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if tg_op='UPDATE' and (new.id, new.workspace_id, new.principal_user_id, new.created_by, new.crm_auth_url, new.agency_domain)
    is distinct from (old.id, old.workspace_id, old.principal_user_id, old.created_by, old.crm_auth_url, old.agency_domain)
    then raise exception 'CRM connection identity is immutable; provision a new connection'; end if;
  if not exists(select 1 from public.workspace_members where workspace_id=new.workspace_id
      and user_id=new.created_by and role='owner' and active)
    then raise exception 'CRM setup requires the active workspace owner'; end if;
  if not exists(select 1 from auth.users where id=new.principal_user_id
      and raw_app_meta_data->>'ada_crm_principal'='true' and banned_until>now())
    or exists(select 1 from public.workspace_members where user_id=new.principal_user_id)
    then raise exception 'CRM principal must be a banned non-member technical identity'; end if;
  return new;
end;
$$;
create trigger crm_integration_identity before insert or update of id, workspace_id, principal_user_id, created_by, crm_auth_url, agency_domain, enabled
  on public.crm_integrations for each row execute function public.guard_crm_integration_identity();

create function public.reject_crm_principal_membership() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if exists(select 1 from public.crm_integrations where principal_user_id=new.user_id)
    or exists(select 1 from auth.users where id=new.user_id and raw_app_meta_data->>'ada_crm_principal'='true')
    then raise exception 'CRM technical identities cannot be Calendar members'; end if;
  return new;
end;
$$;
create trigger reject_crm_principal_membership before insert or update on public.workspace_members
  for each row execute function public.reject_crm_principal_membership();

create table public.crm_client_mappings (
  integration_id uuid not null,
  workspace_id uuid not null,
  external_client_id text not null check (external_client_id ~ '^[A-Za-z0-9_-]{1,150}$'),
  calendar_client_id text not null check (calendar_client_id ~ '^[A-Za-z0-9_-]{1,150}$'),
  confirmed_by uuid not null references auth.users(id),
  confirmed_at timestamptz not null default now(),
  primary key (integration_id, external_client_id),
  unique (integration_id, workspace_id, external_client_id, calendar_client_id),
  foreign key (integration_id, workspace_id) references public.crm_integrations(id, workspace_id)
);
create function public.guard_crm_client_mapping() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if not exists(select 1 from public.workspace_members where user_id=new.confirmed_by
      and workspace_id=new.workspace_id and role='owner' and active)
    then raise exception 'Only the active Calendar owner can confirm a client mapping'; end if;
  if not exists(select 1 from public.workspaces w, jsonb_array_elements(w.clients) c
      where w.id=new.workspace_id and c->>'id'=new.calendar_client_id)
    then raise exception 'Calendar client does not exist in this workspace'; end if;
  return new;
end;
$$;
create trigger crm_client_mapping before insert or update on public.crm_client_mappings
  for each row execute function public.guard_crm_client_mapping();

create table public.crm_task_links (
  integration_id uuid not null,
  workspace_id uuid not null,
  external_task_id text not null check (external_task_id ~ '^[A-Za-z0-9_-]{1,150}$'),
  external_client_id text not null,
  calendar_client_id text not null,
  work_item_id text,
  pending_request_id text references public.pending_requests(id),
  requester_subject uuid not null,
  requester_email text not null check (length(requester_email) between 3 and 320),
  created_at timestamptz not null default now(),
  primary key (integration_id, external_task_id),
  unique (workspace_id, work_item_id),
  unique (workspace_id, pending_request_id),
  check (work_item_id is not null or pending_request_id is not null),
  foreign key (integration_id, workspace_id, external_client_id, calendar_client_id)
    references public.crm_client_mappings(integration_id, workspace_id, external_client_id, calendar_client_id)
);
create function public.guard_crm_task_link() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if tg_op='UPDATE' and (new.integration_id, new.workspace_id, new.external_task_id, new.external_client_id,
      new.calendar_client_id, new.requester_subject, new.requester_email, new.created_at)
    is distinct from (old.integration_id, old.workspace_id, old.external_task_id, old.external_client_id,
      old.calendar_client_id, old.requester_subject, old.requester_email, old.created_at)
    then raise exception 'CRM source attribution is immutable'; end if;
  if tg_op='UPDATE' and (old.work_item_id is not null and new.work_item_id is distinct from old.work_item_id
    or old.pending_request_id is not null and new.pending_request_id is distinct from old.pending_request_id)
    then raise exception 'CRM source links cannot be reassigned or detached'; end if;
  if new.work_item_id is not null and not exists(select 1 from public.workspaces w, jsonb_array_elements(w.items) i
    where w.id=new.workspace_id and i->>'id'=new.work_item_id and i->>'clientId'=new.calendar_client_id)
    then raise exception 'Linked work must exist under the mapped Calendar client'; end if;
  if new.pending_request_id is not null and not exists(select 1 from public.pending_requests
    where id=new.pending_request_id and workspace_id=new.workspace_id)
    then raise exception 'Linked request must belong to the same workspace'; end if;
  return new;
end;
$$;
create trigger crm_task_link before insert or update on public.crm_task_links
  for each row execute function public.guard_crm_task_link();

-- A prepared operation is only a durable intent. Phase 2 must complete it in the
-- SAME transaction as the shared scheduler write, source link, notifications and change log.
create table public.crm_operations (
  integration_id uuid not null references public.crm_integrations(id),
  operation_id uuid not null,
  external_task_id text not null check (external_task_id ~ '^[A-Za-z0-9_-]{1,150}$'),
  requester_subject uuid not null,
  requester_email text not null check (length(requester_email) between 3 and 320),
  kind text not null check (kind in ('booking','request','reply')),
  input jsonb not null check (jsonb_typeof(input)='object' and octet_length(input::text)<=262144),
  status text not null default 'prepared' check (status in ('prepared','completed','rejected')),
  result jsonb,
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  primary key (integration_id, operation_id),
  check (status='prepared' and result is null and finished_at is null
    or status<>'prepared' and jsonb_typeof(result)='object' and result is not null and finished_at is not null)
);
create function public.guard_crm_operation() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if (new.integration_id, new.operation_id, new.external_task_id, new.requester_subject, new.requester_email, new.kind, new.input, new.created_at)
    is distinct from (old.integration_id, old.operation_id, old.external_task_id, old.requester_subject, old.requester_email, old.kind, old.input, old.created_at)
    then raise exception 'CRM operation identity and input are immutable'; end if;
  if old.status<>'prepared' and new is distinct from old then raise exception 'CRM operation result is final'; end if;
  return new;
end;
$$;
create trigger crm_operation before update on public.crm_operations
  for each row execute function public.guard_crm_operation();

create function public.prepare_crm_operation(p_integration_id uuid, p_operation_id uuid, p_external_task_id text,
  p_requester_subject uuid, p_requester_email text, p_kind text, p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare prior public.crm_operations;
begin
  perform 1 from public.crm_integrations where id=p_integration_id and enabled for share;
  if not found then raise exception 'CRM connection is disabled'; end if;
  insert into public.crm_operations(integration_id,operation_id,external_task_id,requester_subject,requester_email,kind,input)
    values(p_integration_id,p_operation_id,p_external_task_id,p_requester_subject,p_requester_email,p_kind,p_input)
    on conflict(integration_id,operation_id) do nothing;
  select * into strict prior from public.crm_operations where integration_id=p_integration_id and operation_id=p_operation_id for update;
  if (prior.external_task_id,prior.requester_subject,prior.requester_email,prior.kind,prior.input)
    is distinct from (p_external_task_id,p_requester_subject,p_requester_email,p_kind,p_input)
    then raise exception 'CRM operation id already belongs to another request' using errcode='23505'; end if;
  return jsonb_build_object('operationId',prior.operation_id,'status',prior.status,'result',prior.result);
end;
$$;

create table public.crm_changes (
  integration_id uuid not null references public.crm_integrations(id),
  sequence bigint not null check (sequence > 0),
  external_task_id text not null,
  kind text not null check (kind in ('booked','request_updated','schedule_updated','completed','cancelled')),
  body jsonb not null check (jsonb_typeof(body)='object' and octet_length(body::text)<=65536),
  created_at timestamptz not null default now(),
  primary key (integration_id, sequence),
  foreign key (integration_id, external_task_id) references public.crm_task_links(integration_id, external_task_id)
);
-- PRIVATE helper for future scheduling transactions. Per-connection serialization
-- prevents a cursor skipping a lower sequence whose transaction commits later.
create function public.append_crm_change(p_integration_id uuid,p_external_task_id text,p_kind text,p_body jsonb)
returns bigint language plpgsql security definer set search_path='' as $$
declare next_sequence bigint;
begin
  update public.crm_integrations set last_sequence=last_sequence+1 where id=p_integration_id returning last_sequence into next_sequence;
  if next_sequence is null then raise exception 'Unknown CRM connection'; end if;
  insert into public.crm_changes(integration_id,sequence,external_task_id,kind,body)
    values(p_integration_id,next_sequence,p_external_task_id,p_kind,p_body);
  return next_sequence;
end;
$$;

create table public.crm_api_budgets (
  integration_id uuid primary key references public.crm_integrations(id),
  window_start timestamptz not null,
  request_count integer not null check (request_count between 1 and 120)
);
create function public.consume_crm_api_budget(p_integration_id uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare consumed integer; window_time timestamptz := date_trunc('minute',clock_timestamp());
begin
  perform 1 from public.crm_integrations where id=p_integration_id and enabled for share;
  if not found then return false; end if;
  insert into public.crm_api_budgets(integration_id,window_start,request_count) values(p_integration_id,window_time,1)
  on conflict(integration_id) do update set window_start=excluded.window_start,
    request_count=case when crm_api_budgets.window_start<>excluded.window_start then 1 else crm_api_budgets.request_count+1 end
    where crm_api_budgets.window_start<>excluded.window_start or crm_api_budgets.request_count<120
  returning request_count into consumed;
  return consumed is not null;
end;
$$;

alter table public.crm_integrations enable row level security;
alter table public.crm_client_mappings enable row level security;
alter table public.crm_task_links enable row level security;
alter table public.crm_operations enable row level security;
alter table public.crm_changes enable row level security;
alter table public.crm_api_budgets enable row level security;
revoke all on public.crm_integrations,public.crm_client_mappings,public.crm_task_links,public.crm_operations,public.crm_changes,public.crm_api_budgets from public,anon,authenticated;
grant all on public.crm_integrations,public.crm_client_mappings,public.crm_task_links,public.crm_operations,public.crm_changes,public.crm_api_budgets to service_role;
revoke all on function public.guard_crm_integration_identity(),public.reject_crm_principal_membership(),public.guard_crm_client_mapping(),public.guard_crm_task_link(),public.guard_crm_operation(),
  public.append_crm_change(uuid,text,text,jsonb),public.prepare_crm_operation(uuid,uuid,text,uuid,text,text,jsonb),public.consume_crm_api_budget(uuid) from public,anon,authenticated,service_role;
grant execute on function public.prepare_crm_operation(uuid,uuid,text,uuid,text,text,jsonb),public.consume_crm_api_budget(uuid) to service_role;
