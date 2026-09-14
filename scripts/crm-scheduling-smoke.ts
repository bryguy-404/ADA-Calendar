/** Actual TypeScript planner/repository -> isolated local SQL. Fictional fixtures;
 * no CRM provider verification, no external credentials, no mail delivery.
 * Run: node --conditions=react-server --import tsx scripts/crm-scheduling-smoke.ts */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { DEFAULT_SETTINGS, DEFAULT_PRIORITIES } from "../src/lib/defaults";
import { crmTaskInputSchema, type CrmAuthenticatedContext } from "../src/lib/crm-integration";
import { localDate, addDays, nextWorkDate } from "../src/lib/time";
import { planCommands } from "../src/lib/scheduler";
import { issueCrmCredential } from "../src/lib/server/crm-credentials";
import { prepareCrmPreview } from "../src/lib/server/crm-planning";
import { readCrmSchedule, saveCrmPreview } from "../src/lib/server/crm-repository";
import { submitCrmTask } from "../src/lib/server/crm-submissions";

async function main() {
  const output = execFileSync("node_modules/.bin/supabase", ["status", "--output", "json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const config = JSON.parse(output.slice(output.indexOf("{"), output.lastIndexOf("}") + 1));
  assert.equal(config.API_URL, "http://127.0.0.1:55421", "Refusing every non-local/non-ADA endpoint.");
  process.env.NEXT_PUBLIC_SUPABASE_URL = config.API_URL; process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = config.ANON_KEY; process.env.SUPABASE_SERVICE_ROLE_KEY = config.SERVICE_ROLE_KEY;
  process.env.ADA_CRM_INTEGRATION_ENABLED = "true"; process.env.ADA_CRM_BOOKING_ENABLED = "true";
  const options = { auth: { persistSession: false, autoRefreshToken: false } };
  const db = createClient(config.API_URL, config.SERVICE_ROLE_KEY, options), ownerClient = createClient(config.API_URL, config.ANON_KEY, options);
  const workspaceId = randomUUID(), connectionId = randomUUID(), actors: string[] = [];
  const checked = <T extends { error: { message: string } | null }>(response: T): T => { assert.equal(response.error, null, response.error?.message ?? "Local CRM operation failed"); return response; };
  try {
    const ownerEmail = `crm-fixture-${randomUUID()}@example.invalid`, password = randomUUID() + "Aa1!";
    const ownerId = checked(await db.auth.admin.createUser({ email: ownerEmail, password, email_confirm: true })).data.user!.id; actors.push(ownerId);
    const principalId = checked(await db.auth.admin.createUser({ email: `crm-principal-${randomUUID()}@example.invalid`, email_confirm: true, ban_duration: "876000h", app_metadata: { ada_crm_principal: true } })).data.user!.id; actors.push(principalId);
    checked(await ownerClient.auth.signInWithPassword({ email: ownerEmail, password }));
    checked(await db.from("workspaces").insert({ id: workspaceId, settings: { ...DEFAULT_SETTINGS, reserveMinutes: 0 }, clients: [{ id: "fixture-client", name: "Fictional Client", aliases: [] }], priorities: DEFAULT_PRIORITIES }));
    checked(await db.from("workspace_members").insert({ user_id: ownerId, workspace_id: workspaceId, name: "Fixture owner", email: ownerEmail, role: "owner" }));
    const issued = issueCrmCredential(connectionId);
    checked(await ownerClient.rpc("manage_crm_connection", { p_action: { type: "create", id: connectionId, principalUserId: principalId, crmOrigin: "https://fixture.example.invalid", crmAuthUrl: "https://fixture.supabase.co", crmPublicKey: "sb_publishable_fixture", agencyDomain: "example.invalid", credentialHash: issued.hash } }));
    checked(await ownerClient.rpc("manage_crm_connection", { p_action: { type: "map", connectionId, externalClientId: "fixture-crm-client", calendarClientId: "fixture-client" } }));
    checked(await ownerClient.rpc("manage_crm_connection", { p_action: { type: "set_enabled", connectionId, enabled: true } }));
    const context: CrmAuthenticatedContext = { connection: { id: connectionId, workspaceId, principalUserId: principalId, crmOrigin: "https://fixture.example.invalid", crmAuthUrl: "https://fixture.supabase.co", crmPublicKey: "sb_publishable_fixture", agencyDomain: "example.invalid", credentialHash: issued.hash, enabled: true }, requester: { subject: randomUUID(), email: "teammate@example.invalid", name: "teammate@example.invalid" } };
    const now = new Date().toISOString(), day = nextWorkDate(addDays(localDate(now, DEFAULT_SETTINGS.timeZone), 1), DEFAULT_SETTINGS);
    const input = crmTaskInputSchema.parse({ externalTaskId: "first-task", externalClientId: "fixture-crm-client", title: "Fictional integrated task", description: "PRIVATE_DESCRIPTION", category: "web", webKind: "edit", estimatedMinutes: 60, scheduling: { mode: "day", date: day } });
    let loaded = await readCrmSchedule(context, input.externalClientId);
    const preview = prepareCrmPreview(context, loaded, input, randomUUID(), now); assert.equal(preview.response.status, "fits");
    await saveCrmPreview(context, preview);
    const intent = { operationId: randomUUID(), previewId: preview.response.previewId, note: "" };
    const [booked, simultaneousRetry] = await Promise.all([submitCrmTask(context, intent, "booking"), submitCrmTask(context, intent, "booking")]);
    assert.deepEqual(simultaneousRetry, booked);
    assert.equal(booked.task.status, "planned"); assert.equal(booked.task.sessions.length, 1);
    assert.equal(JSON.stringify(booked).includes("PRIVATE"), false);
    assert.deepEqual(await submitCrmTask(context, intent, "booking"), booked);
    loaded = await readCrmSchedule(context, input.externalClientId);
    assert.equal(loaded.snapshot.settings.reserveMinutes, 0); assert.equal(loaded.snapshot.items.length, 1);
    const conflict = prepareCrmPreview(context, loaded, { ...input, externalTaskId: "conflicting-task", scheduling: { mode: "exact", date: day, startTime: "09:00" } }, randomUUID(), new Date().toISOString());
    assert.equal(conflict.response.status, "needs_approval"); await saveCrmPreview(context, conflict);
    const requestIntent = { operationId: randomUUID(), previewId: conflict.response.previewId, note: "Please review this exact time." };
    await assert.rejects(submitCrmTask(context, requestIntent, "booking"), /approval/);
    const requested = await submitCrmTask(context, requestIntent, "request");
    assert.equal(requested.task.status, "pending"); assert.ok(requested.task.requestId);
    assert.equal((await readCrmSchedule(context)).snapshot.items.length, 1);
    checked(await ownerClient.rpc("resolve_schedule_request", { p_id: requested.task.requestId, p_decision: "needs_information", p_note: "May I move the earlier task?" }));
    const reply = checked(await db.rpc("reply_crm_request", { p_integration_id: connectionId, p_credential_hash: issued.hash, p_operation_id: randomUUID(), p_external_task_id: "conflicting-task", p_requester_subject: context.requester.subject, p_requester_email: context.requester.email, p_message: "Yes, please review the change." })).data;
    assert.equal(reply.task.status, "pending");
    loaded = await readCrmSchedule(context);
    const owner = { id: ownerId, name: "Fixture owner", email: ownerEmail, role: "owner" as const };
    const approved = planCommands(loaded.snapshot, conflict.commands, owner, { operationId: randomUUID(), approveDisplacement: true });
    assert.equal(approved.status, "ready");
    checked(await ownerClient.rpc("commit_schedule", { p_proposal: approved, p_event: { id: randomUUID(), type: "request_approved", summary: approved.summary, itemIds: approved.affectedItemIds }, p_notifications: [], p_request_id: requested.task.requestId }));
    loaded = await readCrmSchedule(context); assert.equal(loaded.snapshot.items.length, 2);
    const changes = checked(await db.from("crm_changes").select("body").eq("integration_id", connectionId).order("sequence")).data!;
    assert.equal(changes.at(-1)!.body.status, "planned"); assert.equal(JSON.stringify(changes).includes("PRIVATE"), false);
    // Separately reviewed tasks compete for the same free exact slot.
    const raceDay = nextWorkDate(addDays(day, 1), DEFAULT_SETTINGS);
    const racePreviews = ["race-a", "race-b"].map(externalTaskId => prepareCrmPreview(context, { ...loaded, mapping: { calendarClientId: "fixture-client", revision: 1 } },
      { ...input, externalTaskId, scheduling: { mode: "exact", date: raceDay, startTime: "09:00" } }, randomUUID(), new Date().toISOString()));
    for (const entry of racePreviews) await saveCrmPreview(context, entry);
    const race = await Promise.allSettled(racePreviews.map(entry => submitCrmTask(context, { operationId: randomUUID(), previewId: entry.response.previewId, note: "" }, "booking")));
    assert.equal(race.filter(entry => entry.status === "fulfilled").length, 1);
    const loser = race.find(entry => entry.status === "rejected"); assert.ok(loser && loser.status === "rejected"); assert.equal(loser.reason.status, 409);
    assert.equal((await readCrmSchedule(context)).snapshot.items.length, 3);
    const mail = checked(await db.from("notifications").select("status").eq("workspace_id", workspaceId)).data!;
    assert.ok(mail.length > 0); assert.ok(mail.every(entry => entry.status === "queued"));
    console.log("PASS: real planner/repository/SQL booking, concurrent replay and competing-slot race, conflict approval request, conversation reply, owner-approved displacement, source projection and queued-only notifications. Isolated local ADA only.");
  } finally {
    // Preview retention intentionally denies DELETE to the service role. Use
    // local psql only for these generated fixture IDs, never broaden API grants.
    assert.match(workspaceId, /^[a-f0-9-]{36}$/); assert.match(connectionId, /^[a-f0-9-]{36}$/);
    const sql = ["begin;", ...["crm_changes", "crm_operations", "crm_previews", "crm_task_links", "crm_client_mappings", "crm_api_budgets", "crm_integrations"]
      .map(table => `delete from public.${table} where ${table === "crm_integrations" ? "id" : "integration_id"}='${connectionId}';`),
      `delete from pgmq.q_ada_notifications where message->>'notificationId' in (select id from public.notifications where workspace_id='${workspaceId}');`,
      ...["notifications", "pending_requests", "work_events", "work_sessions", "workspace_members", "workspaces"]
        .map(table => `delete from public.${table} where ${table === "workspaces" ? "id" : "workspace_id"}='${workspaceId}';`), "commit;"].join("\n");
    execFileSync("docker", ["exec", "-i", "supabase_db_ada-calendar", "psql", "-X", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres"], { input: sql, stdio: ["pipe", "ignore", "pipe"] });
    for (const id of actors) checked(await db.auth.admin.deleteUser(id));
  }
}
main().catch(error => { console.error(error instanceof Error ? error.message : "CRM scheduling smoke failed"); process.exitCode = 1; });
