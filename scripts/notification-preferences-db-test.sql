-- Fictional local-only recipients. No provider calls; all rows and queue changes roll back.
begin;
set local statement_timeout='30s';
do $$
declare
  workspace uuid:=gen_random_uuid(); owner_id uuid:=gen_random_uuid(); muted uuid:=gen_random_uuid(); other_id uuid:=gen_random_uuid();
  payload jsonb; claimed public.notifications; seen integer:=0;
begin
  insert into auth.users(id,email) values(owner_id,owner_id||'@example.invalid'),(muted,muted||'@example.invalid'),(other_id,other_id||'@example.invalid');
  insert into public.workspaces(id,settings) values(workspace,jsonb_build_object('timeZone','UTC','weeklyDay',extract(dow from now()),'weeklyTime','00:00'));
  insert into public.workspace_members(workspace_id,user_id,name,email,role,receive_updates) values
    (workspace,owner_id,'Owner',owner_id||'@example.invalid','owner',false),
    (workspace,muted,'Muted',muted||'@example.invalid','requester',true),
    (workspace,other_id,'Other',other_id||'@example.invalid','requester',true);
  payload:=jsonb_build_array(
    jsonb_build_object('id',muted||'-queued','recipient',muted||'@example.invalid','subject','Fixture','body','Fixture'),
    jsonb_build_object('id',other_id||'-queued','recipient',other_id||'@example.invalid','subject','Fixture','body','Fixture'));
  perform public.enqueue_notifications(workspace,'before-optout',payload,'updates',owner_id);
  update public.workspace_members set receive_updates=false where user_id=muted;
  payload:=replace(payload::text,'-queued','-after')::jsonb;
  perform public.enqueue_notifications(workspace,'after-optout',payload,'updates',owner_id);
  if exists(select 1 from public.notifications where id=muted||'-after') then raise exception 'Muted requester enqueued'; end if;
  if not exists(select 1 from public.notifications where id=other_id||'-after') then raise exception 'Other recipient lost email'; end if;
  payload:=replace(payload::text,'-after','-draft')::jsonb;
  perform public.enqueue_notifications(workspace,'draft-optout',payload,'draft',owner_id);
  if exists(select 1 from public.notifications where id=muted||'-draft') then raise exception 'Muted requester received draft'; end if;
  perform public.enqueue_notifications(workspace,'owner-alert',jsonb_build_array(jsonb_build_object('id',owner_id||'-alert','recipient',owner_id||'@example.invalid','subject','Review','body','Review')),'owner',muted);
  if not exists(select 1 from public.notifications where id=owner_id||'-alert') then raise exception 'Owner review alert suppressed'; end if;
  begin
    perform public.enqueue_notifications(workspace,'invalid',jsonb_build_array(jsonb_build_object('id','bad-recipient','recipient','outsider@example.invalid')),'updates',owner_id);
    raise exception 'Invalid recipient accepted';
  exception when others then
    if sqlerrm<>'Invalid notification recipient' then raise; end if;
  end;
  perform set_config('request.jwt.claim.role','service_role',true);
  perform public.enqueue_weekly_summaries('https://calendar.example.invalid');
  if exists(select 1 from public.notifications where workspace_id=workspace and event_id like 'weekly/%' and recipient=muted||'@example.invalid') then raise exception 'Muted weekly summary enqueued'; end if;
  if not exists(select 1 from public.notifications where workspace_id=workspace and event_id like 'weekly/%' and recipient=other_id||'@example.invalid') then raise exception 'Other weekly summary suppressed'; end if;
  -- The runner uses only the isolated local DB. Other local queue rows roll back too.
  for batch in 1..100 loop
    for claimed in select * from public.claim_notifications(50) loop
      if claimed.recipient=muted||'@example.invalid' then raise exception 'Muted queued email claimed for delivery'; end if;
      if claimed.workspace_id=workspace then seen:=seen+1; end if;
    end loop;
    exit when exists(select 1 from public.notifications where id=muted||'-queued' and status='captured') and seen>=5;
  end loop;
  if (select status from public.notifications where id=muted||'-queued')<>'captured' or seen<>5 then raise exception 'Queue opt-out or other deliveries failed: %',seen; end if;
  if exists(select 1 from pgmq.q_ada_notifications where message->>'notificationId'=muted||'-queued') then raise exception 'Muted email not archived'; end if;
  if not (select active and role='requester' from public.workspace_members where user_id=muted) then raise exception 'Opt-out changed access'; end if;
  raise notice 'Preferences: update/draft/weekly suppression, queued-mail capture, owner/other alerts and access passed';
end;
$$;
rollback;
