-- Run in an isolated local transaction, with the intake migration; always roll back.
do $$
declare workspace uuid:=gen_random_uuid(); owner_id uuid:=gen_random_uuid(); principal uuid:=gen_random_uuid();
 connection uuid:=gen_random_uuid(); human uuid:=gen_random_uuid(); operation uuid:=gen_random_uuid();
 item jsonb; proposal jsonb; bad jsonb; input jsonb; result jsonb; replay jsonb; settings jsonb; before_count bigint;
begin
 insert into auth.users(id,email,raw_app_meta_data,banned_until) values
 (owner_id,'intake-owner-'||owner_id||'@example.invalid','{}',null),
 (principal,'intake-principal-'||principal||'@example.invalid','{"ada_crm_principal":true}',now()+interval '100 years');
 settings:='{"timeZone":"America/Indiana/Indianapolis","weekdays":[1,2,3,4,5],"dayStart":"09:00","dayEnd":"17:00","lunchStart":"12:00","lunchEnd":"12:30","reserveStart":"16:00","reserveMinutes":0}';
 insert into public.workspaces(id,settings,clients,priorities) values(workspace,settings,'[{"id":"calendar-client","name":"Fictional intake client","aliases":[]}]','[{"id":"normal","label":"Normal","rank":2}]');
 insert into public.workspace_members(workspace_id,user_id,name,email,role) values(workspace,owner_id,'Fixture owner','intake-owner-'||owner_id||'@example.invalid','owner');
 insert into public.crm_integrations(id,workspace_id,principal_user_id,created_by,crm_origin,crm_auth_url,crm_public_key,agency_domain,credential_hash,enabled)
 values(connection,workspace,principal,owner_id,'https://crm.example.invalid','https://fixture.supabase.co','sb_publishable_fixture','example.invalid',repeat('a',64),true);
 insert into public.crm_client_mappings(integration_id,workspace_id,external_client_id,calendar_client_id,confirmed_by) values(connection,workspace,'crm-client','calendar-client',owner_id);
 input:=jsonb_build_object('operationId',operation,'externalTaskId','fictional-intake','externalClientId','crm-client','title','Fictional waiting assignment','description','','due',null,'requesterSubject',human,'requesterEmail','teammate@example.invalid');
 item:=jsonb_build_object('id','crm-intake-'||operation,'clientId','calendar-client','title','Fictional waiting assignment','description','','category','web','webKind','edit',
 'requesterId',principal,'requestedBy','teammate@example.invalid','priorityId','normal','requestedPriorityId',null,'status','waiting','estimatedMinutes',null,'remainingMinutes',null,
 'windowStart',current_date,'windowEnd',null,'targetDate',null,'deadline',null,'forecastDate',null,'completedAt',null,'blockedReason','Awaiting scheduling',
 'timelineMode','span','checklist','[]'::jsonb,'allowedDates','[]'::jsonb,'minimumSessionMinutes',15,'createdAt',now(),'updatedAt',now());
 proposal:=jsonb_build_object('operationId','crm-intake-'||connection||'-'||operation,'baseVersion',0,'actorId',principal,'status','ready','requiresApproval',false,
 'commands',jsonb_build_array(jsonb_build_object('type','create','item',item,'sessions','[]'::jsonb)),'items',jsonb_build_array(item),'sessions','[]'::jsonb,'blocks','[]'::jsonb,'summary',jsonb_build_array('Received assignment'),'affectedItemIds',jsonb_build_array(item->>'id'));
 if has_function_privilege('authenticated','public.receive_crm_intake(uuid,text,jsonb,jsonb,bigint)','execute') then raise exception 'Browser intake access';end if;
 if has_table_privilege('authenticated','public.crm_intakes','select') then raise exception 'Browser private intake access';end if;
 begin perform public.receive_crm_intake(connection,repeat('b',64),input,proposal,1);raise exception 'Bad credential accepted';exception when insufficient_privilege then null;end;
 bad:=jsonb_set(proposal,'{sessions}','[{"id":"unauthorized","workItemId":"anything"}]');
 begin perform public.receive_crm_intake(connection,repeat('a',64),input,bad,1);raise exception 'Session injection accepted';exception when invalid_parameter_value then null;end;
 bad:=jsonb_set(proposal,'{blocks}','[{"id":"unauthorized"}]');
 begin perform public.receive_crm_intake(connection,repeat('a',64),input,bad,1);raise exception 'Block injection accepted';exception when invalid_parameter_value then null;end;
 begin perform public.receive_crm_intake(connection,repeat('a',64),input||'{"externalClientId":"unknown"}',proposal,1);raise exception 'Unknown mapping accepted';exception when serialization_failure then null;end;
 result:=public.receive_crm_intake(connection,repeat('a',64),input,proposal,1);
 replay:=public.receive_crm_intake(connection,repeat('a',64),input,proposal,1);
 if result is distinct from replay or result#>>'{task,status}'<>'waiting' then raise exception 'Intake replay changed';end if;
 if (select version from public.workspaces where id=workspace)<>1 or exists(select 1 from public.work_sessions where workspace_id=workspace) then raise exception 'Intake reserved time or duplicated work';end if;
 if (select w.settings from public.workspaces w where w.id=workspace) is distinct from settings then raise exception 'Workspace settings changed';end if;
 if exists(select 1 from public.notifications where workspace_id=workspace) then raise exception 'Duplicate assignment notification';end if;
 if (select count(*) from public.crm_changes where integration_id=connection)<>1 then raise exception 'Duplicate feed event';end if;
 begin perform public.receive_crm_intake(connection,repeat('a',64),input||'{"title":"Changed"}',proposal,1);raise exception 'Changed retry accepted';exception when unique_violation then null;end;
 raise notice 'PASS: zero-capacity intake, identity, mapping, credential, projection guards, replay and single notification ownership';
end $$;
