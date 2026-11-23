-- Requester previews are actor-private, immutable, and never calendar mutation authority.
drop policy mcp_schedule_owner_read on public.mcp_schedule_operations;
create policy mcp_schedule_actor_read on public.mcp_schedule_operations for select to authenticated using (
  actor_id = (select auth.uid()) and workspace_id = (select public.current_workspace_id())
  and (select public.current_workspace_role()) in ('owner', 'requester')
);
create or replace function public.prepare_mcp_schedule(p_workspace_id uuid, p_operation_id uuid, p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare member public.workspace_members%rowtype; saved jsonb;
begin
  select * into member from public.workspace_members
    where user_id = auth.uid() and active and role in ('owner', 'requester') for share;
  if not found or member.workspace_id is distinct from p_workspace_id then
    raise exception 'Active scheduling membership required.' using errcode = '42501';
  end if;
  if p_operation_id is null or p_payload is null or jsonb_typeof(p_payload) <> 'object'
    or octet_length(p_payload::text) > 200000
    or p_payload #>> '{input,workspaceId}' is distinct from p_workspace_id::text
    or p_payload #>> '{input,operationId}' is distinct from p_operation_id::text then
    raise exception 'Invalid prepared operation.' using errcode = '22023';
  end if;
  if member.role = 'requester' and (
    p_payload #>> '{input,change,kind}' is distinct from 'create'
    or (p_payload #> '{input,change,task}') ? 'requesterId'
    or coalesce((p_payload #>> '{input,change,task,estimatedMinutes}')::numeric, 0) <= 0
    or jsonb_typeof(p_payload #> '{input,change,booking}') is distinct from 'object'
    or jsonb_array_length(p_payload->'commands') is distinct from 1
    or p_payload #>> '{commands,0,type}' is distinct from 'create'
    or p_payload #>> '{commands,0,item,id}' is distinct from p_operation_id::text
    or p_payload #>> '{commands,0,item,requesterId}' is distinct from member.user_id::text
    or coalesce((p_payload #>> '{commands,0,overrideProtected}')::boolean, false)
    or coalesce((p_payload #>> '{commands,0,overrideDeadline}')::boolean, false)
  ) then raise exception 'Requester new-work preview required.' using errcode = '42501'; end if;
  insert into public.mcp_schedule_operations(workspace_id, actor_id, operation_id, payload)
    values(member.workspace_id, member.user_id, p_operation_id, p_payload) on conflict do nothing;
  select payload into saved from public.mcp_schedule_operations
    where workspace_id = member.workspace_id and actor_id = member.user_id and operation_id = p_operation_id;
  return saved;
end $$;
revoke all on function public.prepare_mcp_schedule(uuid, uuid, jsonb) from public, anon, service_role;
grant execute on function public.prepare_mcp_schedule(uuid, uuid, jsonb) to authenticated;
