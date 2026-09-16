-- Honor requester email preferences independently of scheduling and CRM synchronization.
-- Existing owner alerts, authorization, change feeds and other recipients are unchanged.
create or replace function public.enqueue_notifications(p_workspace uuid, p_event text, p_notifications jsonb, p_audience text, p_actor uuid)
returns void language plpgsql security definer set search_path='' as $$
declare n jsonb; m public.workspace_members;
begin
  for n in select value from jsonb_array_elements(coalesce(p_notifications,'[]')) loop
    select * into m from public.workspace_members where workspace_id=p_workspace and lower(email)=lower(n->>'recipient') and active;
    if m.user_id is null then raise exception 'Invalid notification recipient'; end if;
    if p_audience='owner' and m.role<>'owner' then raise exception 'Invalid request notification recipient'; end if;
    if p_audience='updates' and not (m.role='requester' or m.role='owner' and m.user_id<>p_actor) then raise exception 'Invalid update notification recipient'; end if;
    if p_audience='draft' and not (m.role='requester') then raise exception 'Invalid draft recipient'; end if;
    -- Preference changes suppress email; they must never reject a valid schedule commit.
    if m.role='requester' and not m.receive_updates and p_audience in ('updates','draft') then continue; end if;
    insert into public.notifications(id,workspace_id,event_id,recipient,recipient_name,subject,body,idempotency_key)
      values(n->>'id',p_workspace,p_event,m.email,m.name,left(n->>'subject',500),n->>'body','ada/'||p_event||'/'||m.user_id::text)
      on conflict(workspace_id,event_id,recipient) do nothing;
  end loop;
end;
$$;
revoke all on function public.enqueue_notifications(uuid,text,jsonb,text,uuid) from public, anon, authenticated;

create or replace function public.record_crm_task_change(p_link public.crm_task_links,p_kind text,p_event_id text,p_notify_owner boolean default false) returns jsonb
language plpgsql security definer set search_path='' as $$
declare payload jsonb; seq bigint; target record; message text;
begin
  payload:=public.crm_task_projection(p_link);
  seq:=public.append_crm_change(p_link.integration_id,p_link.external_task_id,p_kind,payload);
  message:='ADA Calendar: '||coalesce(payload->>'title','Work request')||E'\nStatus: '||coalesce(payload->>'status','pending')
    ||E'\nClient: '||coalesce(payload#>>'{client,name}','Client')
    ||E'\nTimes ('||coalesce(payload->>'timeZone','workspace timezone')||'): '||(payload->'sessions')::text
    ||case when payload->>'decisionNote' is not null then E'\nDecision note: '||(payload->>'decisionNote') else '' end
    ||E'\nReview the current task in ADA CRM. Reference: '||p_link.external_task_id;
  -- Recipients come only from the verified source and active Calendar owner.
  -- Normal Calendar notifications for the same event/recipient deduplicate here.
  for target in select p_link.requester_email as email,p_link.requester_email as name
    union select email,name from public.workspace_members where workspace_id=p_link.workspace_id and role='owner' and active and p_notify_owner
  loop
    -- The change feed above remains authoritative even when its requester opts out of mail.
    if exists(select 1 from public.workspace_members where workspace_id=p_link.workspace_id
      and lower(email)=lower(target.email) and role='requester' and not receive_updates) then continue; end if;
    insert into public.notifications(id,workspace_id,event_id,recipient,recipient_name,subject,body,idempotency_key)
      values(gen_random_uuid()::text,p_link.workspace_id,p_event_id,target.email,target.name,
        'ADA Calendar · '||case when p_kind='request_updated' then 'Work request updated' else 'Workload updated' end,
        message,'ada/crm/'||p_event_id||'/'||lower(target.email))
      on conflict(workspace_id,event_id,recipient) do nothing;
  end loop;
  return jsonb_build_object('sequence',seq,'task',payload);
end;
$$;
revoke all on function public.record_crm_task_change(public.crm_task_links,text,text,boolean) from public,anon,authenticated,service_role;

create or replace function public.claim_notifications(p_limit integer default 20) returns setof public.notifications
language plpgsql security definer set search_path='' as $$
declare q record; n public.notifications;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Worker access only'; end if;
  for q in select * from pgmq.read('ada_notifications',120,least(greatest(p_limit,1),50)) loop
    select * into n from public.notifications where id=q.message->>'notificationId' for update;
    if n.id is null or n.status<>'queued' then perform pgmq.archive('ada_notifications',q.msg_id); continue; end if;
    -- Recheck current preferences for messages queued before the requester opted out.
    if exists(select 1 from public.workspace_members where workspace_id=n.workspace_id
      and lower(email)=lower(n.recipient) and role='requester' and not receive_updates) then
      update public.notifications set status='captured',last_error='Captured: recipient opted out of Calendar updates.',lease_until=null where id=n.id;
      perform pgmq.archive('ada_notifications',q.msg_id); continue;
    end if;
    if n.send_started_at<now()-interval '23 hours' and n.provider_id is null then
      update public.notifications set status='uncertain',last_error='Delivery requires reconciliation; provider idempotency window is expiring.',lease_until=null where id=n.id;
      perform pgmq.archive('ada_notifications',q.msg_id); continue;
    end if;
    if n.next_attempt_at>now() then perform pgmq.set_vt('ada_notifications',q.msg_id,greatest(1,extract(epoch from n.next_attempt_at-now())::integer)); continue; end if;
    update public.notifications set lease_until=now()+interval '2 minutes',attempts=attempts+1,send_started_at=coalesce(send_started_at,now()) where id=n.id returning * into n;
    return next n;
  end loop;
end;
$$;
