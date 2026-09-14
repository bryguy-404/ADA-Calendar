-- Shared scheduling validation accepts an internal, trusted actor context.
-- Public RPCs still derive the actor from auth.uid(); CRM principals never get membership.
-- No schedule, settings, existing identities or connections are changed.

-- Large, fragmented multi-day work can exceed the original placeholder feed limit.
alter table public.crm_changes drop constraint crm_changes_body_check;
alter table public.crm_changes add constraint crm_changes_body_check
  check (jsonb_typeof(body)='object' and octet_length(body::text)<=1048576);

create or replace function public.commit_schedule_transaction_as_actor(p_actor public.workspace_members,p_proposal jsonb,p_event jsonb,p_notifications jsonb default '[]',p_request_id text default null,p_undo_id text default null)
returns bigint language plpgsql security definer set search_path='' as $$
declare m public.workspace_members; w public.workspaces; s jsonb; i jsonb; b jsonb; found_item jsonb;
  start_local timestamp; end_local timestamp; tz text; evt jsonb; before_state jsonb; after_state jsonb;
  has_override boolean; duplicate_version bigint; prior_event public.work_events; request_row public.pending_requests;
  reserve_start timestamp; reserve_end timestamp; usable_start timestamp; reserve_used numeric;
begin
  m := p_actor;
  if m.user_id is null or m.role='viewer' then raise exception 'Not authorized to schedule work'; end if;
  select * into w from public.workspaces where id=m.workspace_id for update;
  select version into duplicate_version from public.work_events where workspace_id=w.id and operation_id=p_proposal->>'operationId';
  if duplicate_version is not null then
    if not exists(select 1 from public.work_events where workspace_id=w.id and operation_id=p_proposal->>'operationId' and actor_id=m.user_id and operation_payload=p_proposal->'commands') then raise exception 'Operation id was already used for a different actor or command'; end if;
    return duplicate_version;
  end if;
  if coalesce((p_proposal->>'baseVersion')::bigint,-1)<>w.version then raise exception 'Schedule changed. Refresh and re-plan this operation.' using errcode='40001'; end if;
  if p_proposal->>'actorId' is distinct from m.user_id::text then raise exception 'Actor does not match authenticated session'; end if;
  if p_proposal->>'status' is distinct from 'ready' or coalesce((p_proposal->>'requiresApproval')::boolean,true) then raise exception 'Proposal is not ready to commit'; end if;
  if jsonb_typeof(p_proposal->'items') is distinct from 'array' or jsonb_typeof(p_proposal->'sessions') is distinct from 'array' or jsonb_typeof(p_proposal->'blocks') is distinct from 'array' then raise exception 'Invalid schedule shape'; end if;
  if exists(select 1 from jsonb_array_elements(p_proposal->'items') v group by v->>'id' having count(*)>1) then raise exception 'Duplicate item id'; end if;
  if m.role='requester' then
    if p_request_id is not null or p_undo_id is not null then raise exception 'Owner approval required'; end if;
    if p_proposal->'blocks'<>w.blocks then raise exception 'Requesters cannot change blocked time'; end if;
    if exists(select 1 from jsonb_array_elements(w.items) old where not exists(select 1 from jsonb_array_elements(p_proposal->'items') fresh where fresh=old)) then raise exception 'Requesters cannot edit or delete existing work'; end if;
    if exists(select 1 from public.work_sessions old where old.workspace_id=w.id and not exists(select 1 from jsonb_array_elements(p_proposal->'sessions') fresh where fresh=old.body)) then raise exception 'Requesters cannot move existing sessions'; end if;
    if exists(select 1 from jsonb_array_elements(p_proposal->'commands') cmd where cmd->>'type'<>'create' or coalesce((cmd->>'overrideProtected')::boolean,false) or coalesce((cmd->>'overrideDeadline')::boolean,false) or coalesce((cmd->>'urgent')::boolean,false)) then raise exception 'Requesters may only create clean-fit work'; end if;
    for i in select value from jsonb_array_elements(p_proposal->'items') loop
      if not exists(select 1 from jsonb_array_elements(w.items) old where old->>'id'=i->>'id') then
        if i->>'requesterId' is distinct from m.user_id::text or i->>'requestedBy' is distinct from m.name or i->>'status' is distinct from 'planned' or coalesce((i->>'estimatedMinutes')::integer,0)<=0 or coalesce((i->>'remainingMinutes')::integer,0)<=0 then raise exception 'New requests need your identity and a positive effort estimate'; end if;
        if i->>'priorityId' is distinct from 'normal' then raise exception 'Requested priority is advisory; new bookings start at Normal'; end if;
      end if;
    end loop;
    if exists(select 1 from jsonb_array_elements(p_proposal->'sessions') fresh where not exists(select 1 from public.work_sessions old where old.workspace_id=w.id and old.body=fresh) and (coalesce((fresh->>'usesReserve')::boolean,false) or exists(select 1 from jsonb_array_elements(w.items) old where old->>'id'=fresh->>'workItemId'))) then raise exception 'Requesters cannot reserve interruption time or add sessions to existing work'; end if;
  end if;
  has_override := m.role='owner' and exists(select 1 from jsonb_array_elements(coalesce(p_proposal->'commands','[]')) cmd where coalesce((cmd->>'overrideProtected')::boolean,false));
  if not has_override and p_undo_id is null and exists(
    select 1 from public.work_sessions old where old.workspace_id=w.id and old.status='planned' and coalesce((old.body->>'protected')::boolean,false)
      and not exists(select 1 from jsonb_array_elements(p_proposal->'sessions') fresh where fresh=old.body)
      and not (m.role='owner' and exists(select 1 from jsonb_array_elements(p_proposal->'commands') cmd
        where cmd->>'type'='status' and cmd->>'itemId'=old.work_item_id and cmd->>'status' in ('completed','cancelled')
        or cmd->>'type'='complete_day' and cmd->>'itemId'=old.work_item_id
          and (old.starts_at at time zone (w.settings->>'timeZone'))::date::text=cmd->>'date'
          and exists(select 1 from jsonb_array_elements(p_proposal->'sessions') fresh where fresh=old.body||jsonb_build_object('status','completed'))
        or cmd->>'type'='complete_session' and cmd->>'sessionId'=old.id and exists(select 1 from jsonb_array_elements(p_proposal->'sessions') fresh where fresh->>'id'=old.id and fresh->>'status'='completed' and fresh->>'start'=old.body->>'start' and (fresh->>'end')::timestamptz<=old.ends_at)))
  ) then raise exception 'Protected work needs an explicit owner override'; end if;
  if p_request_id is not null then
    if m.role<>'owner' then raise exception 'Only owner can approve requests'; end if;
    select * into request_row from public.pending_requests where id=p_request_id and workspace_id=w.id for update;
    if request_row.id is null or request_row.body->>'status' not in ('pending','needs_information') then raise exception 'Request is no longer pending'; end if;
  end if;
  if p_undo_id is not null then
    if m.role<>'owner' then raise exception 'Only owner can undo'; end if;
    select * into prior_event from public.work_events where id=p_undo_id and workspace_id=w.id for update;
    if prior_event.id is null or prior_event.version<>w.version or prior_event.body->>'undoneBy' is not null then raise exception 'Only the latest unchanged schedule event can be undone'; end if;
    if jsonb_build_object('items',p_proposal->'items','sessions',p_proposal->'sessions','blocks',p_proposal->'blocks')<>prior_event.body->'before' then raise exception 'Undo does not match original state'; end if;
  end if;
  tz := w.settings->>'timeZone';
  for i in select value from jsonb_array_elements(p_proposal->'items') loop

    if i ? 'timelineMode' and coalesce(i->>'timelineMode','') not in ('bookings','span') then raise exception 'Invalid timeline mode'; end if;
    if i ? 'dateConstraints' then
      if jsonb_typeof(i->'dateConstraints') is distinct from 'object'
        or ((i->'dateConstraints')-'earliestStart'-'allowedDates')<>'{}'::jsonb
        or not (i->'dateConstraints' ? 'earliestStart')
        or jsonb_typeof(i#>'{dateConstraints,allowedDates}') is distinct from 'array'
        then raise exception 'Invalid scheduling limits'; end if;
      if i#>>'{dateConstraints,earliestStart}' is not null and
        (coalesce(i#>>'{dateConstraints,earliestStart}','') !~ '^\d{4}-\d{2}-\d{2}$'
        or (i#>>'{dateConstraints,earliestStart}')::date::text<>i#>>'{dateConstraints,earliestStart}')
        then raise exception 'Invalid earliest start'; end if;
      if jsonb_array_length(i#>'{dateConstraints,allowedDates}')>366 or exists(
        select 1 from jsonb_array_elements_text(i#>'{dateConstraints,allowedDates}') d
        where d is null or d !~ '^\d{4}-\d{2}-\d{2}$' or d::date::text<>d
      ) then raise exception 'Invalid allowed work dates'; end if;
    end if;
    if coalesce(i->>'id','')='' or coalesce(i->>'title','')='' then raise exception 'Work needs id and title'; end if;
    if not exists(select 1 from jsonb_array_elements(w.clients) c where c->>'id'=i->>'clientId') then raise exception 'Unknown client'; end if;
    if not exists(select 1 from jsonb_array_elements(w.priorities) p where p->>'id'=i->>'priorityId') then raise exception 'Unknown priority'; end if;
    if coalesce(i->>'category','') not in ('web','it','landings','software') or coalesce(i->>'status','') not in ('planned','in_progress','waiting','completed','cancelled') then raise exception 'Invalid work category or status'; end if;
    if coalesce((i->>'estimatedMinutes')::integer,0)<0 or coalesce((i->>'remainingMinutes')::integer,0)<0 then raise exception 'Negative effort is invalid'; end if;
  end loop;
  for b in select value from jsonb_array_elements(p_proposal->'blocks') loop
    if (b->>'end')::timestamptz<=(b->>'start')::timestamptz then raise exception 'Invalid unavailable block'; end if;
  end loop;
  for s in select value from jsonb_array_elements(p_proposal->'sessions') loop
    select value into found_item from jsonb_array_elements(p_proposal->'items') where value->>'id'=s->>'workItemId';
    if found_item is null then raise exception 'Session refers to missing work'; end if;
    if s->>'status'='planned' then
      start_local := (s->>'start')::timestamptz at time zone tz;
      end_local := (s->>'end')::timestamptz at time zone tz;
      if end_local<=start_local or start_local::date<>end_local::date then raise exception 'Invalid session duration'; end if;
      if (s->>'start')::timestamptz<now() and p_undo_id is null and not exists(select 1 from public.work_sessions old where old.workspace_id=w.id and (old.body=s or m.role='owner' and old.status='planned' and old.id=s->>'id' and old.body-'end'=s-'end' and (s->>'end')::timestamptz<=old.ends_at)) then raise exception 'New or changed work cannot be scheduled in the past'; end if;
      if (found_item#>>'{dateConstraints,earliestStart}' is not null and start_local::date<(found_item#>>'{dateConstraints,earliestStart}')::date) or (jsonb_array_length(coalesce(found_item#>'{dateConstraints,allowedDates}','[]'))>0 and not exists(select 1 from jsonb_array_elements_text(found_item#>'{dateConstraints,allowedDates}') allowed where allowed=start_local::date::text)) then raise exception 'Session is outside allowed work dates'; end if;
      if found_item->>'deadline' is not null and start_local::date>(found_item->>'deadline')::date then raise exception 'Session exceeds its firm deadline'; end if;
      if not exists(select 1 from jsonb_array_elements_text(w.settings->'weekdays') d where d::integer=extract(dow from start_local)::integer) or start_local::time<(w.settings->>'dayStart')::time or end_local::time>(w.settings->>'dayEnd')::time then raise exception 'Session exceeds working hours'; end if;
      if start_local::time<(w.settings->>'lunchEnd')::time and end_local::time>(w.settings->>'lunchStart')::time then raise exception 'Session overlaps lunch'; end if;
      reserve_start:=start_local::date+(w.settings->>'reserveStart')::time;
      reserve_end:=least(start_local::date+(w.settings->>'dayEnd')::time,reserve_start+make_interval(mins=>(w.settings->>'reserveMinutes')::integer));
      usable_start:=greatest(reserve_start,now() at time zone tz);
      select coalesce(sum(extract(epoch from ((r->>'end')::timestamptz-(r->>'start')::timestamptz))/60),0) into reserve_used from jsonb_array_elements(p_proposal->'sessions') r where r->>'status'<>'cancelled' and coalesce((r->>'usesReserve')::boolean,false) and ((r->>'start')::timestamptz at time zone tz)::date=start_local::date;
      reserve_start:=usable_start+make_interval(secs=>(least((w.settings->>'reserveMinutes')::numeric,reserve_used,greatest(0,extract(epoch from reserve_end-usable_start)/60))*60)::double precision);
      if reserve_start<reserve_end and start_local<reserve_end and end_local>reserve_start and not coalesce((s->>'usesReserve')::boolean,false) then raise exception 'Session consumes reserved interruption capacity'; end if;
      if found_item->>'status' in ('completed','cancelled','waiting') and (s->>'end')::timestamptz>now() then raise exception 'Inactive work cannot have future planned sessions'; end if;
      if exists(select 1 from jsonb_array_elements(p_proposal->'blocks') block where tstzrange((block->>'start')::timestamptz,(block->>'end')::timestamptz,'[)') && tstzrange((s->>'start')::timestamptz,(s->>'end')::timestamptz,'[)')) then raise exception 'Session overlaps unavailable time'; end if;
    end if;
  end loop;
  before_state := jsonb_build_object('items',w.items,'blocks',w.blocks,'sessions',coalesce((select jsonb_agg(body order by starts_at,id) from public.work_sessions where workspace_id=w.id),'[]'));
  after_state := jsonb_build_object('items',p_proposal->'items','sessions',p_proposal->'sessions','blocks',p_proposal->'blocks');
  -- A replace inside the locked transaction permits legitimate multi-session moves; the
  -- exclusion constraint catches overlap before the transaction becomes visible.
  delete from public.work_sessions where workspace_id=w.id;
  insert into public.work_sessions(workspace_id,id,work_item_id,starts_at,ends_at,status,body)
    select w.id,entry.value->>'id',entry.value->>'workItemId',(entry.value->>'start')::timestamptz,(entry.value->>'end')::timestamptz,entry.value->>'status',entry.value from jsonb_array_elements(p_proposal->'sessions') entry;
  update public.workspaces set items=p_proposal->'items',blocks=p_proposal->'blocks',version=version+1 where id=w.id;
  evt := p_event || jsonb_build_object('operationId',p_proposal->>'operationId','actorId',m.user_id,'actorName',m.name,'version',w.version+1,'before',before_state,'after',after_state,'createdAt',now(),'undoneBy',null);
  insert into public.work_events(id,workspace_id,operation_id,actor_id,version,body,operation_payload) values(evt->>'id',w.id,p_proposal->>'operationId',m.user_id,w.version+1,evt,p_proposal->'commands');
  if p_request_id is not null then update public.pending_requests set body=body||jsonb_build_object('status','approved','resolvedAt',now()) where id=p_request_id; end if;
  if p_undo_id is not null then update public.work_events set body=jsonb_set(body,'{undoneBy}',to_jsonb(evt->>'id')) where id=p_undo_id; end if;
  perform public.enqueue_notifications(w.id,evt->>'id',p_notifications,'updates',m.user_id);
  return w.version+1;
end;
$$;

revoke all on function public.commit_schedule_transaction_as_actor(public.workspace_members,jsonb,jsonb,jsonb,text,text) from public,anon,authenticated,service_role;

create or replace function public.commit_schedule_daily_hours_as_actor(p_actor public.workspace_members,p_proposal jsonb,p_event jsonb,p_notifications jsonb default '[]',p_request_id text default null,p_undo_id text default null)
returns bigint language plpgsql security definer set search_path='' as $$
declare member public.workspace_members; workspace public.workspaces; item jsonb; day jsonb;
  budget numeric; booked numeric; total numeric; entry record; tz text;
begin
  member := p_actor;
  if member.user_id is null or member.role='viewer' then raise exception 'Not authorized to schedule work'; end if;
  select * into workspace from public.workspaces where id=member.workspace_id for update;
  tz := workspace.settings->>'timeZone';
  if member.role='requester' and exists(
    select 1 from jsonb_array_elements(p_proposal->'sessions') fresh
    where not exists(select 1 from public.work_sessions old where old.workspace_id=member.workspace_id and old.body=fresh)
      and (coalesce((fresh->>'protected')::boolean,false) or fresh->>'status' is distinct from 'planned')
  ) then raise exception 'Requesters cannot create protected or historical sessions'; end if;
  for item in select value from jsonb_array_elements(p_proposal->'items') loop
    if item ? 'dailyPlan' then
      if jsonb_typeof(item->'dailyPlan') is distinct from 'array' then raise exception 'Daily plan must be an array'; end if;
      if jsonb_array_length(item->'dailyPlan')>366 then raise exception 'Daily plan exceeds 366 days'; end if;
      if exists(select 1 from jsonb_array_elements(item->'dailyPlan') d group by d->>'date' having count(*)>1) then raise exception 'Duplicate daily-plan date'; end if;
      total := 0;
      for day in select value from jsonb_array_elements(item->'dailyPlan') loop
        if jsonb_typeof(day) is distinct from 'object' or (day-'date'-'minutes')<>'{}'::jsonb or jsonb_typeof(day->'minutes') is distinct from 'number'
          or coalesce(day->>'date','') !~ '^\d{4}-\d{2}-\d{2}$' or (day->>'date')::date::text<>day->>'date' then raise exception 'Invalid daily-plan entry'; end if;
        budget := (day->>'minutes')::numeric;
        if budget<15 or budget>480 or mod(budget,15)<>0 then raise exception 'Daily hours require positive 15-minute increments'; end if;
        total := total+budget;
        if (item#>>'{dateConstraints,earliestStart}' is not null and (day->>'date')::date<(item#>>'{dateConstraints,earliestStart}')::date)
          or (item->>'deadline' is not null and (day->>'date')::date>(item->>'deadline')::date)
          or (jsonb_array_length(coalesce(item#>'{dateConstraints,allowedDates}','[]'))>0 and not exists(select 1 from jsonb_array_elements_text(item#>'{dateConstraints,allowedDates}') d where d=day->>'date'))
          then raise exception 'Daily plan is outside allowed dates'; end if;
      end loop;
      if total>100000 then raise exception 'Daily plan exceeds supported effort'; end if;
      if jsonb_array_length(item->'dailyPlan')>0 then
        for entry in select ((s->>'start')::timestamptz at time zone tz)::date::text as work_date,
          sum(extract(epoch from ((s->>'end')::timestamptz-greatest((s->>'start')::timestamptz,now())))/60) as minutes
          from jsonb_array_elements(p_proposal->'sessions') s where s->>'workItemId'=item->>'id' and s->>'status'='planned' and (s->>'end')::timestamptz>now()
          group by 1 loop
          select (d->>'minutes')::numeric into budget from jsonb_array_elements(item->'dailyPlan') d where d->>'date'=entry.work_date;
          booked := entry.minutes;
          if booked>coalesce(budget,0) then raise exception 'Sessions exceed daily hours on %',entry.work_date; end if;
        end loop;
      end if;
    end if;
  end loop;
  return public.commit_schedule_transaction_as_actor(member,p_proposal,p_event,p_notifications,p_request_id,p_undo_id);
end;
$$;

revoke all on function public.commit_schedule_daily_hours_as_actor(public.workspace_members,jsonb,jsonb,jsonb,text,text) from public,anon,authenticated,service_role;

create or replace function public.commit_schedule_booking_focus_as_actor(p_actor public.workspace_members,p_proposal jsonb,p_event jsonb,p_notifications jsonb default '[]',p_request_id text default null,p_undo_id text default null)
returns bigint language plpgsql security definer set search_path='' as $$
declare member public.workspace_members; workspace public.workspaces; command jsonb; day jsonb; total numeric; session jsonb; minimum numeric;
  prior_event public.work_events; completion jsonb; allow_completed_undo boolean := false;
begin
  member := p_actor;
  if member.user_id is null or member.role='viewer' then raise exception 'Not authorized to schedule work'; end if;
  select * into workspace from public.workspaces where id=member.workspace_id for update;
  if jsonb_typeof(p_proposal->'sessions') is distinct from 'array' then raise exception 'Invalid schedule shape'; end if;
  if not exists(select 1 from public.work_events where workspace_id=member.workspace_id and operation_id=p_proposal->>'operationId') then
    -- Only the latest single day-completion event may reverse its own exact
    -- planned-to-completed transition. Stored commands and snapshots are the
    -- authority; event prose or caller-supplied metadata grants no permission.
    if p_undo_id is not null and member.role='owner' then
      select * into prior_event from public.work_events where id=p_undo_id and workspace_id=workspace.id for update;
      if prior_event.id is not null and prior_event.version=workspace.version and prior_event.body->>'undoneBy' is null
        and jsonb_typeof(prior_event.operation_payload)='array' and jsonb_array_length(prior_event.operation_payload)=1
        and prior_event.operation_payload->0->>'type'='complete_day'
        and ((prior_event.operation_payload->0)-'type'-'itemId'-'date')='{}'::jsonb
        and coalesce(prior_event.operation_payload->0->>'itemId','')<>''
        and coalesce(prior_event.operation_payload->0->>'date','') ~ '^\d{4}-\d{2}-\d{2}$'
        and jsonb_build_object('items',p_proposal->'items','sessions',p_proposal->'sessions','blocks',p_proposal->'blocks')=prior_event.body->'before'
        and workspace.items=prior_event.body#>'{after,items}' and workspace.blocks=prior_event.body#>'{after,blocks}'
        and jsonb_array_length(prior_event.body#>'{after,sessions}')=(select count(*) from public.work_sessions where workspace_id=workspace.id)
        and jsonb_array_length(prior_event.body#>'{before,sessions}')=jsonb_array_length(prior_event.body#>'{after,sessions}')
        and not exists(select 1 from public.work_sessions old where old.workspace_id=workspace.id
          and not exists(select 1 from jsonb_array_elements(prior_event.body#>'{after,sessions}') saved where saved=old.body))
      then
        completion:=prior_event.operation_payload->0;
        allow_completed_undo:=true;
      end if;
    end if;
    -- All other completion/cancellation remains immutable. The delegated core
    -- also verifies exact latest-event Undo and actor-bound duplicate replays.
    if exists(
      select 1 from public.work_sessions old
      where old.workspace_id=member.workspace_id and old.status<>'planned'
        and not exists(select 1 from jsonb_array_elements(p_proposal->'sessions') fresh where fresh=old.body)
        and not coalesce((allow_completed_undo and old.status='completed' and old.work_item_id=completion->>'itemId'
          and (old.starts_at at time zone (workspace.settings->>'timeZone'))::date::text=completion->>'date'
          and exists(select 1 from jsonb_array_elements(prior_event.body#>'{before,sessions}') original
            where original->>'id'=old.id and original->>'status'='planned'
              and original||jsonb_build_object('status','completed')=old.body
              and exists(select 1 from jsonb_array_elements(p_proposal->'sessions') fresh where fresh=original))),false)
    ) then raise exception 'Scheduling cannot remove or change completed or cancelled work'; end if;
  end if;
  for session in select value from jsonb_array_elements(p_proposal->'sessions') loop
    if session ? 'focusOverrideMinutes' then
      if jsonb_typeof(session->'focusOverrideMinutes') is distinct from 'number' then raise exception 'Invalid legacy booking metadata'; end if;
      minimum := (session->>'focusOverrideMinutes')::numeric;
      if minimum<15 or minimum>480 or mod(minimum,15)<>0 then raise exception 'Invalid legacy booking metadata'; end if;
      if member.role='requester' and not exists(select 1 from public.work_sessions old where old.workspace_id=member.workspace_id and old.body=session)
        then raise exception 'Requesters cannot add legacy booking metadata'; end if;
    end if;
  end loop;
  for command in select value from jsonb_array_elements(p_proposal->'commands') loop
    if command->>'type'='set_day_hours' then
      if member.role<>'owner' then raise exception 'Only owner can edit daily hours'; end if;
      if jsonb_typeof(command->'days') is distinct from 'array' or jsonb_array_length(command->'days') not between 1 and 366
        then raise exception 'Invalid day hours'; end if;
      if exists(select 1 from jsonb_array_elements(command->'days') d group by d->>'date' having count(*)>1) then raise exception 'Duplicate work day'; end if;
      total:=0;
      for day in select value from jsonb_array_elements(command->'days') loop
        if jsonb_typeof(day) is distinct from 'object' or (day-'date'-'minutes')<>'{}'::jsonb
          or jsonb_typeof(day->'minutes') is distinct from 'number'
          or coalesce(day->>'date','') !~ '^\d{4}-\d{2}-\d{2}$' or (day->>'date')::date::text<>day->>'date'
          or (day->>'minutes')::numeric<0 or (day->>'minutes')::numeric>480 or mod((day->>'minutes')::numeric,15)<>0
          then raise exception 'Invalid day hours'; end if;
        total:=total+(day->>'minutes')::numeric;
      end loop;
      if total>100000 then raise exception 'Day hours exceed supported effort'; end if;
    end if;
  end loop;
  return public.commit_schedule_daily_hours_as_actor(member,p_proposal,p_event,p_notifications,p_request_id,p_undo_id);
end;
$$;

revoke all on function public.commit_schedule_booking_focus_as_actor(public.workspace_members,jsonb,jsonb,jsonb,text,text) from public,anon,authenticated,service_role;

create or replace function public.commit_schedule_as_actor(p_actor public.workspace_members,p_proposal jsonb,p_event jsonb,p_notifications jsonb default '[]',p_request_id text default null,p_undo_id text default null)
returns bigint language plpgsql security definer set search_path='' as $$
declare member public.workspace_members; workspace public.workspaces; command jsonb;
  old_item jsonb; next_item jsonb; expected_daily jsonb; expected_mode jsonb; selected_count bigint; finished_minutes numeric; expected_remaining numeric;
begin
  member := p_actor;
  if member.user_id is null or member.role='viewer' then raise exception 'Not authorized to schedule work'; end if;
  select * into workspace from public.workspaces where id=member.workspace_id for update;
  if not found then raise exception 'Workspace not found'; end if;
  if exists(select 1 from jsonb_array_elements(p_proposal->'commands') c where c->>'type'='complete_day')
    and not exists(select 1 from public.work_events where workspace_id=member.workspace_id and operation_id=p_proposal->>'operationId') then
    if member.role<>'owner' then raise exception 'Only owner can finish a booked day'; end if;
    if jsonb_array_length(p_proposal->'commands')<>1 or p_request_id is not null or p_undo_id is not null
      then raise exception 'Finish one booked day separately from other changes'; end if;
    command:=p_proposal->'commands'->0;
    if (command-'type'-'itemId'-'date')<>'{}'::jsonb or coalesce(command->>'itemId','')=''
      or coalesce(command->>'date','') !~ '^\d{4}-\d{2}-\d{2}$' or (command->>'date')::date::text<>command->>'date'
      then raise exception 'Invalid booked day'; end if;
    if jsonb_typeof(p_proposal->'sessions') is distinct from 'array' or jsonb_typeof(p_proposal->'items') is distinct from 'array'
      then raise exception 'Invalid schedule shape'; end if;
    select value into old_item from jsonb_array_elements(workspace.items) where value->>'id'=command->>'itemId';
    select value into next_item from jsonb_array_elements(p_proposal->'items') where value->>'id'=command->>'itemId';
    if old_item is null or next_item is null then raise exception 'Work item no longer exists'; end if;
    if old_item->>'status' in ('completed','cancelled') then raise exception 'Project is already completed or cancelled'; end if;
    select round(coalesce(sum(extract(epoch from (s.ends_at-s.starts_at))/60),0)), count(*) into finished_minutes, selected_count
      from public.work_sessions s where s.workspace_id=workspace.id and s.work_item_id=command->>'itemId' and s.status='planned'
        and (s.starts_at at time zone (workspace.settings->>'timeZone'))::date::text=command->>'date';
    if jsonb_array_length(p_proposal->'sessions')<>(select count(*) from public.work_sessions where workspace_id=workspace.id)
      or exists(select 1 from public.work_sessions s where s.workspace_id=workspace.id and not exists(
        select 1 from jsonb_array_elements(p_proposal->'sessions') fresh where fresh=case
          when s.work_item_id=command->>'itemId' and s.status='planned' and (s.starts_at at time zone (workspace.settings->>'timeZone'))::date::text=command->>'date'
          then s.body||jsonb_build_object('status','completed') else s.body end))
      then raise exception 'Day completion must preserve all other bookings and the selected hours'; end if;
    if p_proposal->'blocks'<>workspace.blocks or jsonb_array_length(p_proposal->'items')<>jsonb_array_length(workspace.items)
      or exists(select 1 from jsonb_array_elements(workspace.items) i where i->>'id'<>command->>'itemId'
        and not exists(select 1 from jsonb_array_elements(p_proposal->'items') fresh where fresh=i))
      then raise exception 'Day completion cannot change other projects or blocked time'; end if;
    if old_item-'remainingMinutes'-'dailyPlan'-'forecastDate'-'updatedAt'-'timelineMode'
      <>next_item-'remainingMinutes'-'dailyPlan'-'forecastDate'-'updatedAt'-'timelineMode'
      then raise exception 'Day completion cannot change project details, status or original estimate'; end if;
    if selected_count=0 and next_item<>old_item then raise exception 'A finished day cannot change project details again'; end if;
    expected_mode:=old_item->'timelineMode';
    if expected_mode is null and selected_count>0 then expected_mode:=to_jsonb(case when old_item->>'estimatedMinutes' is null then 'span'::text else 'bookings'::text end); end if;
    if next_item->'timelineMode' is distinct from expected_mode then raise exception 'Day completion cannot change the project timeline mode'; end if;
    expected_remaining:=case when old_item->>'remainingMinutes' is null then null else greatest(0,(old_item->>'remainingMinutes')::numeric-finished_minutes) end;
    if next_item->'remainingMinutes' is distinct from coalesce(to_jsonb(expected_remaining),'null'::jsonb) then raise exception 'Day completion must subtract only its completed hours'; end if;
    if old_item ? 'dailyPlan' then
      select coalesce(jsonb_agg(case when d->>'date'=command->>'date' then d||jsonb_build_object('minutes',(d->>'minutes')::numeric-finished_minutes) else d end order by ord),'[]')
        into expected_daily from jsonb_array_elements(old_item->'dailyPlan') with ordinality rows(d,ord) where d->>'date'<>command->>'date' or ((d->>'minutes')::numeric>finished_minutes and mod((d->>'minutes')::numeric-finished_minutes,15)=0);
      if next_item->'dailyPlan' is distinct from expected_daily then raise exception 'Day completion must preserve the other daily budgets'; end if;
    elsif next_item ? 'dailyPlan' then raise exception 'Day completion cannot invent daily budgets'; end if;
  end if;
  return public.commit_schedule_booking_focus_as_actor(member,p_proposal,p_event,p_notifications,p_request_id,p_undo_id);
end;
$$;

revoke all on function public.commit_schedule_as_actor(public.workspace_members,jsonb,jsonb,jsonb,text,text) from public,anon,authenticated,service_role;

create or replace function public.submit_schedule_request_as_actor(p_actor public.workspace_members,p_request jsonb,p_notifications jsonb default '[]') returns text
language plpgsql security definer set search_path='' as $$
declare m public.workspace_members; w public.workspaces; req jsonb;
begin
  m := p_actor;
  if m.user_id is null or m.role<>'requester' then raise exception 'Only requesters can submit priority requests'; end if;
  select * into w from public.workspaces where id=m.workspace_id for update;
  if exists(select 1 from public.pending_requests where id=p_request->>'id' and workspace_id=w.id and requester_id=m.user_id) then return p_request->>'id'; end if;
  if coalesce((p_request#>>'{proposal,baseVersion}')::bigint,-1)<>w.version then raise exception 'Schedule changed. Refresh request.' using errcode='40001'; end if;
  if p_request#>>'{proposal,actorId}' is distinct from m.user_id::text then raise exception 'Request actor mismatch'; end if;
  if exists(select 1 from jsonb_array_elements(p_request#>'{proposal,commands}') cmd where cmd->>'type'<>'create') then raise exception 'Requesters may request new work only'; end if;
  req := p_request||jsonb_build_object('requesterId',m.user_id,'requesterName',m.name,'status','pending','createdAt',now(),'resolvedAt',null);
  insert into public.pending_requests(id,workspace_id,requester_id,body) values(req->>'id',w.id,m.user_id,req);
  perform public.enqueue_notifications(w.id,req->>'id',p_notifications,'owner',m.user_id);
  return req->>'id';
end;
$$;

revoke all on function public.submit_schedule_request_as_actor(public.workspace_members,jsonb,jsonb) from public,anon,authenticated,service_role;

create or replace function public.commit_schedule_transaction(p_proposal jsonb,p_event jsonb,p_notifications jsonb default '[]',p_request_id text default null,p_undo_id text default null)
returns bigint language plpgsql security definer set search_path='' as $$
declare m public.workspace_members;
begin
  select * into m from public.workspace_members where user_id=auth.uid() and active;
  if m.user_id is null then raise exception 'Not authorized to schedule work' using errcode='42501'; end if;
  return public.commit_schedule_transaction_as_actor(m,p_proposal,p_event,p_notifications,p_request_id,p_undo_id);
end;
$$;

create or replace function public.commit_schedule_daily_hours(p_proposal jsonb,p_event jsonb,p_notifications jsonb default '[]',p_request_id text default null,p_undo_id text default null)
returns bigint language plpgsql security definer set search_path='' as $$
declare m public.workspace_members;
begin
  select * into m from public.workspace_members where user_id=auth.uid() and active;
  if m.user_id is null then raise exception 'Not authorized to schedule work' using errcode='42501'; end if;
  return public.commit_schedule_daily_hours_as_actor(m,p_proposal,p_event,p_notifications,p_request_id,p_undo_id);
end;
$$;

create or replace function public.commit_schedule_booking_focus(p_proposal jsonb,p_event jsonb,p_notifications jsonb default '[]',p_request_id text default null,p_undo_id text default null)
returns bigint language plpgsql security definer set search_path='' as $$
declare m public.workspace_members;
begin
  select * into m from public.workspace_members where user_id=auth.uid() and active;
  if m.user_id is null then raise exception 'Not authorized to schedule work' using errcode='42501'; end if;
  return public.commit_schedule_booking_focus_as_actor(m,p_proposal,p_event,p_notifications,p_request_id,p_undo_id);
end;
$$;

create or replace function public.commit_schedule(p_proposal jsonb,p_event jsonb,p_notifications jsonb default '[]',p_request_id text default null,p_undo_id text default null)
returns bigint language plpgsql security definer set search_path='' as $$
declare m public.workspace_members;
begin
  select * into m from public.workspace_members where user_id=auth.uid() and active;
  if m.user_id is null then raise exception 'Not authorized to schedule work' using errcode='42501'; end if;
  return public.commit_schedule_as_actor(m,p_proposal,p_event,p_notifications,p_request_id,p_undo_id);
end;
$$;

create or replace function public.submit_schedule_request(p_request jsonb,p_notifications jsonb default '[]')
returns text language plpgsql security definer set search_path='' as $$
declare m public.workspace_members;
begin
  select * into m from public.workspace_members where user_id=auth.uid() and active;
  if m.user_id is null then raise exception 'Not authorized to schedule work' using errcode='42501'; end if;
  return public.submit_schedule_request_as_actor(m,p_request,p_notifications);
end;
$$;

-- A source-bound public projection. No description, private block, attachment or
-- arbitrary event/request snapshot is included in the change feed or email.
create function public.crm_task_projection(p_link public.crm_task_links) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare w public.workspaces; item jsonb; request jsonb; client jsonb;
begin
  select * into strict w from public.workspaces where id=p_link.workspace_id;
  select value into item from jsonb_array_elements(w.items) where value->>'id'=p_link.work_item_id;
  select body into request from public.pending_requests where id=p_link.pending_request_id;
  select value into client from jsonb_array_elements(w.clients) where value->>'id'=coalesce(item->>'clientId',p_link.calendar_client_id);
  return jsonb_build_object('externalTaskId',p_link.external_task_id,'workItemId',p_link.work_item_id,
    'requestId',p_link.pending_request_id,'requestStatus',request->>'status',
    'status',case when item is not null then item->>'status' when p_link.work_item_id is not null then 'unbooked' else request->>'status' end,
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

create function public.record_crm_task_change(p_link public.crm_task_links,p_kind text,p_event_id text,p_notify_owner boolean default false) returns jsonb
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

-- Called by all owner schedule commits, including completion, cancellation and
-- Undo, within the transaction that wrote the event. Compare stored snapshots,
-- not the caller's affectedItemIds or event prose.
create function public.track_crm_work_event() returns trigger
language plpgsql security definer set search_path='' as $$
declare source public.crm_task_links; before_item jsonb; after_item jsonb; before_sessions jsonb; after_sessions jsonb;
begin
  for source in select * from public.crm_task_links where workspace_id=new.workspace_id and work_item_id is not null order by integration_id,external_task_id loop
    select value into before_item from jsonb_array_elements(new.body#>'{before,items}') where value->>'id'=source.work_item_id;
    select value into after_item from jsonb_array_elements(new.body#>'{after,items}') where value->>'id'=source.work_item_id;
    select coalesce(jsonb_agg(s order by s->>'id'),'[]') into before_sessions from jsonb_array_elements(new.body#>'{before,sessions}') s where s->>'workItemId'=source.work_item_id;
    select coalesce(jsonb_agg(s order by s->>'id'),'[]') into after_sessions from jsonb_array_elements(new.body#>'{after,sessions}') s where s->>'workItemId'=source.work_item_id;
    if before_item is distinct from after_item or before_sessions is distinct from after_sessions then
      perform public.record_crm_task_change(source,case when after_item->>'status' in ('completed','cancelled') then after_item->>'status' else 'schedule_updated' end,new.id,false);
    end if;
  end loop;
  return new;
end;
$$;
create trigger track_crm_work_event after insert on public.work_events for each row execute function public.track_crm_work_event();
revoke all on function public.track_crm_work_event() from public,anon,authenticated,service_role;

create function public.track_crm_request() returns trigger
language plpgsql security definer set search_path='' as $$
declare source public.crm_task_links; created_id text; principal uuid;
begin
  select * into source from public.crm_task_links where pending_request_id=new.id and workspace_id=new.workspace_id;
  if not found or old.body=new.body then return new; end if;
  if new.body->>'status'='approved' and old.body->>'status'<>'approved' then
    created_id:=old.body#>>'{proposal,commands,0,item,id}';
    select principal_user_id into principal from public.crm_integrations where id=source.integration_id;
    if not exists(select 1 from public.workspaces w,jsonb_array_elements(w.items) i where w.id=source.workspace_id
      and i->>'id'=created_id and i->>'clientId'=source.calendar_client_id and i->>'requesterId'=principal::text)
      then raise exception 'CRM approval must preserve the original task, requester and client'; end if;
    update public.crm_task_links set work_item_id=created_id where integration_id=source.integration_id and external_task_id=source.external_task_id returning * into source;
  end if;
  perform public.record_crm_task_change(source,'request_updated','crm-request/'||new.id||'/'||gen_random_uuid()::text,new.body->>'status'='pending');
  return new;
end;
$$;
create trigger track_crm_request after update on public.pending_requests for each row execute function public.track_crm_request();
revoke all on function public.track_crm_request() from public,anon,authenticated,service_role;

-- Serialize request decisions with schedule commits BEFORE taking the request
-- row lock. This also makes change-sequence lock order consistent with bookings.
create or replace function public.resolve_schedule_request(p_id text,p_decision text,p_note text default '') returns void
language plpgsql security definer set search_path='' as $$
declare m public.workspace_members;
begin
  select * into m from public.workspace_members where user_id=auth.uid() and active;
  if m.role is distinct from 'owner' then raise exception 'Only owner can resolve requests'; end if;
  if p_decision not in ('declined','needs_information') then raise exception 'Approvals must atomically commit the proposed schedule'; end if;
  if length(p_note)>5000 then raise exception 'Decision note is too long'; end if;
  perform 1 from public.workspaces where id=m.workspace_id for update;
  update public.pending_requests set body=body||jsonb_build_object('status',p_decision,'note',p_note,'resolvedAt',now(),
    'conversation',coalesce(body->'conversation','[]')||jsonb_build_array(jsonb_build_object('author','owner','message',p_note,'createdAt',now())))
    where id=p_id and workspace_id=m.workspace_id and body->>'status' in ('pending','needs_information');
  if not found then raise exception 'Request is not pending'; end if;
end;
$$;

-- Trusted Node server supplies the freshly replanned proposal. SQL rechecks all
-- durable bindings under a workspace lock and applies the SAME requester rules.
create function public.finalize_crm_submission(p_integration_id uuid,p_credential_hash text,p_operation_id uuid,p_preview_id uuid,
  p_requester_subject uuid,p_requester_email text,p_kind text,p_note text,p_proposal jsonb,p_fingerprint text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare connection public.crm_integrations; preview public.crm_previews; mapping public.crm_client_mappings;
  actor public.workspace_members; operation public.crm_operations; source public.crm_task_links;
  version bigint; input jsonb; v_result jsonb; event_id text; request_id text; work_id text;
begin
  select * into connection from public.crm_integrations where id=p_integration_id;
  if not found then raise exception 'CRM connection unavailable' using errcode='42501'; end if;
  select w.version into version from public.workspaces w where id=connection.workspace_id for update;
  select * into connection from public.crm_integrations where id=p_integration_id for update;
  if not connection.enabled or connection.credential_hash<>p_credential_hash then raise exception 'CRM connection unavailable' using errcode='42501'; end if;
  if p_kind not in ('booking','request') or length(p_note)>5000 or p_requester_email<>lower(p_requester_email)
    or split_part(p_requester_email,'@',2)<>connection.agency_domain then raise exception 'Invalid CRM submission' using errcode='22023'; end if;
  input:=jsonb_build_object('previewId',p_preview_id,'note',p_note);
  select * into operation from public.crm_operations where integration_id=p_integration_id and operation_id=p_operation_id for update;
  if found then
    if (operation.requester_subject,operation.requester_email,operation.kind,operation.input) is distinct from (p_requester_subject,p_requester_email,p_kind,input)
      then raise exception 'Operation belongs to another request' using errcode='23505'; end if;
    if operation.status<>'prepared' then return operation.result; end if;
  end if;
  select * into preview from public.crm_previews where integration_id=p_integration_id and id=p_preview_id;
  if not found or (preview.requester_subject,preview.requester_email) is distinct from (p_requester_subject,p_requester_email)
    then raise exception 'Preview unavailable for this requester' using errcode='42501'; end if;
  select * into mapping from public.crm_client_mappings where integration_id=p_integration_id and external_client_id=preview.external_client_id for share;
  if preview.expires_at<=clock_timestamp() or preview.created_at>clock_timestamp()+interval '5 seconds'
    or preview.base_version<>version or mapping.revision is distinct from preview.mapping_revision
    or mapping.calendar_client_id is distinct from preview.calendar_client_id or p_fingerprint is distinct from preview.review_fingerprint
    then raise exception 'Preview changed or expired' using errcode='40001'; end if;
  if p_proposal->'commands' is distinct from preview.commands or p_proposal->>'actorId' is distinct from connection.principal_user_id::text
    or p_proposal->>'operationId' is distinct from ('crm-'||p_integration_id||'-'||p_operation_id)
    or (p_proposal->>'baseVersion')::bigint is distinct from version
    then raise exception 'Proposal binding mismatch' using errcode='40001'; end if;
  if exists(select 1 from public.crm_task_links where integration_id=p_integration_id and external_task_id=preview.external_task_id)
    then raise exception 'Source task is already linked' using errcode='23505'; end if;
  -- now() is the transaction start, potentially before waiting for the workspace
  -- lock. New bookings must still be in the future when the lock is acquired.
  if p_kind='booking' and exists(select 1 from jsonb_array_elements(p_proposal->'sessions') s
    where s->>'workItemId'=p_preview_id::text and (s->>'start')::timestamptz<clock_timestamp())
    then raise exception 'Preview changed while waiting to book' using errcode='40001'; end if;
  perform public.prepare_crm_operation(p_integration_id,p_operation_id,preview.external_task_id,p_requester_subject,p_requester_email,p_kind,input);
  actor.workspace_id:=connection.workspace_id; actor.user_id:=connection.principal_user_id;
  actor.name:=left(p_requester_email,120); actor.email:=p_requester_email; actor.role:='requester'; actor.active:=true; actor.receive_updates:=false;
  event_id:='crm-'||p_integration_id||'-'||p_operation_id;
  if p_kind='booking' then
    version:=public.commit_schedule_as_actor(actor,p_proposal,jsonb_build_object('id',event_id,'type','crm_booked',
      'summary',p_proposal->'summary','itemIds',jsonb_build_array(p_preview_id::text)),'[]',null,null);
    work_id:=p_preview_id::text;
  else
    request_id:=public.submit_schedule_request_as_actor(actor,jsonb_build_object('id',event_id,'proposal',p_proposal,'note',p_note,
      'conversation',case when p_note='' then '[]'::jsonb else jsonb_build_array(jsonb_build_object('author','requester','message',p_note,'createdAt',now())) end),'[]');
  end if;
  insert into public.crm_task_links(integration_id,workspace_id,external_task_id,external_client_id,calendar_client_id,work_item_id,pending_request_id,requester_subject,requester_email)
    values(p_integration_id,connection.workspace_id,preview.external_task_id,preview.external_client_id,preview.calendar_client_id,work_id,request_id,p_requester_subject,p_requester_email)
    returning * into source;
  v_result:=public.record_crm_task_change(source,case when p_kind='booking' then 'booked' else 'request_updated' end,event_id,true)
    ||jsonb_build_object('apiVersion','1','operationId',p_operation_id,'status','completed');
  update public.crm_operations set status='completed',result=v_result,finished_at=now() where integration_id=p_integration_id and operation_id=p_operation_id;
  return v_result;
end;
$$;
revoke all on function public.finalize_crm_submission(uuid,text,uuid,uuid,uuid,text,text,text,jsonb,text) from public,anon,authenticated;
grant execute on function public.finalize_crm_submission(uuid,text,uuid,uuid,uuid,text,text,text,jsonb,text) to service_role;

create function public.reply_crm_request(p_integration_id uuid,p_credential_hash text,p_operation_id uuid,p_external_task_id text,
  p_requester_subject uuid,p_requester_email text,p_message text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare connection public.crm_integrations; source public.crm_task_links; operation public.crm_operations; input jsonb; v_result jsonb; request public.pending_requests;
begin
  select * into connection from public.crm_integrations where id=p_integration_id;
  if not found then raise exception 'CRM connection unavailable' using errcode='42501'; end if;
  perform 1 from public.workspaces where id=connection.workspace_id for update;
  select * into connection from public.crm_integrations where id=p_integration_id for update;
  if not connection.enabled or connection.credential_hash<>p_credential_hash then raise exception 'CRM connection unavailable' using errcode='42501'; end if;
  if length(trim(p_message)) not between 1 and 5000 then raise exception 'Invalid reply' using errcode='22023'; end if;
  select * into source from public.crm_task_links where integration_id=p_integration_id and external_task_id=p_external_task_id;
  if not found or (source.requester_subject,source.requester_email) is distinct from (p_requester_subject,p_requester_email)
    then raise exception 'Request unavailable for this requester' using errcode='42501'; end if;
  input:=jsonb_build_object('externalTaskId',p_external_task_id,'message',p_message);
  v_result:=public.prepare_crm_operation(p_integration_id,p_operation_id,p_external_task_id,p_requester_subject,p_requester_email,'reply',input);
  if v_result->>'status'<>'prepared' then return v_result->'result'; end if;
  select * into request from public.pending_requests where id=source.pending_request_id for update;
  if not found or request.body->>'status'<>'needs_information' or source.work_item_id is not null
    then raise exception 'Request is not awaiting information' using errcode='40001'; end if;
  if jsonb_array_length(coalesce(request.body->'conversation','[]'))>=100 then raise exception 'Reply limit reached' using errcode='22023'; end if;
  update public.pending_requests set body=body||jsonb_build_object('status','pending','resolvedAt',null,
    'conversation',coalesce(body->'conversation','[]')||jsonb_build_array(jsonb_build_object('author','requester','message',p_message,'createdAt',now()))) where id=request.id;
  -- The request trigger records the feed and notifications inside this transaction.
  v_result:=jsonb_build_object('apiVersion','1','operationId',p_operation_id,'status','completed','task',public.crm_task_projection(source),
    'sequence',(select last_sequence from public.crm_integrations where id=p_integration_id));
  update public.crm_operations set status='completed',result=v_result,finished_at=now() where integration_id=p_integration_id and operation_id=p_operation_id;
  return v_result;
end;
$$;
revoke all on function public.reply_crm_request(uuid,text,uuid,text,uuid,text,text) from public,anon,authenticated;
grant execute on function public.reply_crm_request(uuid,text,uuid,text,uuid,text,text) to service_role;

create function public.read_crm_owner_setup() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare owner public.workspace_members;
begin
  select * into owner from public.workspace_members where user_id=auth.uid() and active and role='owner';
  if not found then raise exception 'Only the owner can configure CRM' using errcode='42501'; end if;
  return jsonb_build_object('connections',coalesce((select jsonb_agg(jsonb_build_object('id',id,'crmOrigin',crm_origin,'crmAuthUrl',crm_auth_url,
    'agencyDomain',agency_domain,'enabled',enabled) order by created_at) from public.crm_integrations where workspace_id=owner.workspace_id),'[]'),
    'mappings',coalesce((select jsonb_agg(jsonb_build_object('connectionId',integration_id,'externalClientId',external_client_id,
      'calendarClientId',calendar_client_id,'revision',revision)) from public.crm_client_mappings where workspace_id=owner.workspace_id),'[]'));
end;
$$;
revoke all on function public.read_crm_owner_setup() from public,anon;
grant execute on function public.read_crm_owner_setup() to authenticated;

create function public.manage_crm_connection(p_action jsonb) returns void
language plpgsql security definer set search_path='' as $$
declare owner public.workspace_members; connection public.crm_integrations;
begin
  select * into owner from public.workspace_members where user_id=auth.uid() and active and role='owner';
  if not found then raise exception 'Only the owner can configure CRM' using errcode='42501'; end if;
  perform 1 from public.workspaces where id=owner.workspace_id for update;
  if p_action->>'type'='create' then
    if exists(select 1 from public.crm_integrations where workspace_id=owner.workspace_id and crm_origin=p_action->>'crmOrigin')
      then raise exception 'This CRM origin already has a connection' using errcode='23505'; end if;
    insert into public.crm_integrations(id,workspace_id,principal_user_id,created_by,crm_origin,crm_auth_url,crm_public_key,agency_domain,credential_hash)
      values((p_action->>'id')::uuid,owner.workspace_id,(p_action->>'principalUserId')::uuid,owner.user_id,p_action->>'crmOrigin',p_action->>'crmAuthUrl',
        p_action->>'crmPublicKey',p_action->>'agencyDomain',p_action->>'credentialHash');
    return;
  end if;
  select * into connection from public.crm_integrations where id=(p_action->>'connectionId')::uuid and workspace_id=owner.workspace_id for update;
  if not found then raise exception 'Connection unavailable' using errcode='42501'; end if;
  case p_action->>'type'
    when 'rotate' then update public.crm_integrations set credential_hash=p_action->>'credentialHash' where id=connection.id;
    when 'set_enabled' then update public.crm_integrations set enabled=(p_action->>'enabled')::boolean where id=connection.id;
    when 'map' then
      insert into public.crm_client_mappings(integration_id,workspace_id,external_client_id,calendar_client_id,confirmed_by)
        values(connection.id,owner.workspace_id,p_action->>'externalClientId',p_action->>'calendarClientId',owner.user_id)
        on conflict(integration_id,external_client_id) do update set calendar_client_id=excluded.calendar_client_id,confirmed_by=owner.user_id,confirmed_at=now();
    else raise exception 'Unknown CRM setup action' using errcode='22023';
  end case;
end;
$$;
revoke all on function public.manage_crm_connection(jsonb) from public,anon;
grant execute on function public.manage_crm_connection(jsonb) to authenticated;

-- Clients used by source links/mappings must remain in the Calendar directory.
create function public.guard_crm_directory() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if exists(select 1 from public.crm_client_mappings mapping where workspace_id=new.id
    and not exists(select 1 from jsonb_array_elements(new.clients) c where c->>'id'=mapping.calendar_client_id))
    then raise exception 'A CRM-mapped client cannot be removed from the directory'; end if;
  return new;
end;
$$;
create trigger guard_crm_directory before update of clients on public.workspaces for each row execute function public.guard_crm_directory();
revoke all on function public.guard_crm_directory() from public,anon,authenticated,service_role;
