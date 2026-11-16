-- Durable private previews; actual calendar mutations still use commit_schedule.
-- No schedule, membership preference, history, or outbox row is changed here.
create table public.mcp_schedule_operations (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  actor_id uuid not null references auth.users(id) on delete cascade,
  operation_id uuid not null,
  payload jsonb not null check (jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 200000),
  created_at timestamptz not null default now(),
  primary key (workspace_id, actor_id, operation_id)
);
alter table public.mcp_schedule_operations enable row level security;
revoke all on public.mcp_schedule_operations from public, anon, authenticated, service_role;
grant select on public.mcp_schedule_operations to authenticated;
create policy mcp_schedule_owner_read on public.mcp_schedule_operations for select to authenticated using (
  actor_id = (select auth.uid()) and workspace_id = (select public.current_workspace_id())
  and (select public.current_workspace_role()) = 'owner'
);
create function public.prepare_mcp_schedule(p_workspace_id uuid, p_operation_id uuid, p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare member public.workspace_members%rowtype; saved jsonb;
begin
  select * into member from public.workspace_members
    where user_id = auth.uid() and active and role = 'owner' for share;
  if not found or member.workspace_id is distinct from p_workspace_id then
    raise exception 'Owner workspace required.' using errcode = '42501';
  end if;
  if p_operation_id is null or p_payload is null or jsonb_typeof(p_payload) <> 'object'
    or octet_length(p_payload::text) > 200000
    or p_payload #>> '{input,workspaceId}' is distinct from p_workspace_id::text
    or p_payload #>> '{input,operationId}' is distinct from p_operation_id::text then
    raise exception 'Invalid prepared operation.' using errcode = '22023';
  end if;
  insert into public.mcp_schedule_operations(workspace_id, actor_id, operation_id, payload)
    values(member.workspace_id, member.user_id, p_operation_id, p_payload) on conflict do nothing;
  select payload into saved from public.mcp_schedule_operations
    where workspace_id = member.workspace_id and actor_id = member.user_id and operation_id = p_operation_id;
  return saved;
end $$;
revoke all on function public.prepare_mcp_schedule(uuid, uuid, jsonb) from public, anon, service_role;
grant execute on function public.prepare_mcp_schedule(uuid, uuid, jsonb) to authenticated;
