-- Close uncertain operations without tokens or new scheduling authority. No work/session changes.
create table public.crm_closed_operations (
  integration_id uuid not null references public.crm_integrations(id),
  operation_id uuid not null,
  closed_at timestamptz not null default now(),
  primary key(integration_id,operation_id)
);
alter table public.crm_closed_operations enable row level security;
revoke all on public.crm_closed_operations from public,anon,authenticated,service_role;
grant select on public.crm_closed_operations to service_role;

create function public.guard_closed_crm_operation() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  -- Existing finalizers already hold this connection after the workspace lock.
  -- The share lock also fences the foundation prepare RPC against recovery closure.
  perform 1 from public.crm_integrations where id=new.integration_id for share;
  if new.status <> 'rejected' and exists(select 1 from public.crm_closed_operations
    where integration_id=new.integration_id and operation_id=new.operation_id) then
    raise exception 'CRM operation is closed; review a new operation' using errcode='23505';
  end if;
  return new;
end $$;
create trigger crm_closed_operation before insert or update on public.crm_operations
  for each row execute function public.guard_closed_crm_operation();
revoke all on function public.guard_closed_crm_operation() from public,anon,authenticated,service_role;

create function public.settle_crm_operation(p_integration_id uuid,p_credential_hash text,p_operation_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare connection public.crm_integrations; operation public.crm_operations; answer jsonb;
begin
  select * into connection from public.crm_integrations where id=p_integration_id for update;
  if not found or not connection.enabled or connection.credential_hash is distinct from p_credential_hash then
    raise exception 'CRM connection unavailable' using errcode='42501';
  end if;
  select * into operation from public.crm_operations where integration_id=p_integration_id and operation_id=p_operation_id for update;
  if found and operation.status='completed' then return operation.result; end if;
  answer:=jsonb_build_object('apiVersion','1','operationId',p_operation_id,'status','rejected');
  insert into public.crm_closed_operations(integration_id,operation_id) values(p_integration_id,p_operation_id) on conflict do nothing;
  update public.crm_operations set status='rejected',result=answer,finished_at=now()
    where integration_id=p_integration_id and operation_id=p_operation_id and status='prepared';
  return answer;
end $$;
revoke all on function public.settle_crm_operation(uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.settle_crm_operation(uuid,text,uuid) to service_role;

create function public.prune_crm_previews(p_integration_id uuid,p_credential_hash text)
returns integer language plpgsql security definer set search_path='' as $$
declare removed integer;
begin
  perform 1 from public.crm_integrations where id=p_integration_id and enabled and credential_hash=p_credential_hash for share;
  if not found then raise exception 'CRM connection unavailable' using errcode='42501'; end if;
  delete from public.crm_previews p where p.integration_id=p_integration_id and p.id in (
    select old.id from public.crm_previews old where old.integration_id=p_integration_id and old.expires_at<now()-interval '7 days'
      and not exists(select 1 from public.crm_operations o where o.integration_id=p_integration_id and o.status='prepared' and o.input->>'previewId'=old.id::text)
      order by old.expires_at limit 500);
  get diagnostics removed=row_count;
  return removed;
end $$;
revoke all on function public.prune_crm_previews(uuid,text) from public,anon,authenticated;
grant execute on function public.prune_crm_previews(uuid,text) to service_role;
