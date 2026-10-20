import "server-only";
import { z } from "zod";
import { dateSchema, idSchema } from "../schemas";
import { crmOperationResultSchema, type CrmConnection } from "../crm-integration";
import { newWorkItem } from "../work";
import { localDate } from "../time";
import { planCommands } from "../scheduler";
import { CrmApiError } from "./crm-auth";
import { crmRequesterActor } from "./crm-planning";
import { readCrmSchedule } from "./crm-repository";
import { getSupabaseAdminClient } from "./supabase";
import { crmDatabaseFailure } from "./crm-submissions";
import { parseCrmStored } from "./crm-http";

// Service-only delivery of an assignment durably authenticated and saved by CRM.
// No scheduling fields, commands, roles, company creation, or overrides are accepted.
export const crmIntakeSchema = z.object({
  operationId: z.uuid(), externalTaskId: idSchema, externalClientId: idSchema,
  title: z.string().trim().min(1).max(200), description: z.string().max(30000).default(""),
  due: dateSchema.nullable(), requesterSubject: z.uuid(), requesterEmail: z.email(),
}).strict();

export async function receiveCrmIntake(connection: CrmConnection, input: z.infer<typeof crmIntakeSchema>) {
  if (input.requesterEmail !== input.requesterEmail.toLowerCase() || input.requesterEmail.split("@")[1] !== connection.agencyDomain)
    throw new CrmApiError("crm_team_required", "A verified agency assignment is required.", 403);
  const db = getSupabaseAdminClient();
  const saved = await db.from("crm_intakes").select("input,result").eq("integration_id", connection.id).eq("operation_id", input.operationId).maybeSingle();
  crmDatabaseFailure(saved.error);
  if (saved.data) {
    if (JSON.stringify(crmIntakeSchema.parse(saved.data.input)) !== JSON.stringify(input))
      throw new CrmApiError("crm_operation_conflict", "Assignment intent cannot change.", 409);
    return parseCrmStored(crmOperationResultSchema, saved.data.result);
  }
  const context = { connection, requester: { subject: input.requesterSubject, email: input.requesterEmail, name: input.requesterEmail } };
  const { snapshot, mapping } = await readCrmSchedule(context, input.externalClientId);
  if (!mapping) throw new CrmApiError("crm_client_unmapped", "Bryan needs to confirm this client's Calendar mapping.", 422);
  const now = new Date().toISOString();
  const actor = crmRequesterActor(context);
  const item = newWorkItem(actor, localDate(now, snapshot.settings.timeZone), {
    id: `crm-intake-${input.operationId}`, clientId: mapping.calendarClientId,
    title: input.title, description: input.description, status: "waiting",
    estimatedMinutes: null, remainingMinutes: null, deadline: input.due,
    windowEnd: input.due, blockedReason: "New CRM assignment — estimate and schedule this work.",
    createdAt: now, updatedAt: now,
  });
  // Delegates only creation of waiting work. SQL checks the complete snapshot and
  // rejects every session/block change before calling the shared transaction.
  const proposal = planCommands(snapshot, [{ type: "create", item, sessions: [] }], { ...actor, role: "owner" },
    { now, operationId: `crm-intake-${connection.id}-${input.operationId}` });
  if (proposal.status !== "ready" || proposal.requiresApproval)
    throw new CrmApiError("crm_unavailable", "This assignment could not be received yet.", 503);
  const { data, error } = await db.rpc("receive_crm_intake", {
    p_integration_id: connection.id, p_credential_hash: connection.credentialHash,
    p_input: input, p_proposal: proposal, p_mapping_revision: mapping.revision,
  });
  crmDatabaseFailure(error);
  return parseCrmStored(crmOperationResultSchema, data);
}
