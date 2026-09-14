import "server-only";
import { z } from "zod";
import { commandSchema } from "../schemas";
import { crmTaskInputSchema, crmOperationResultSchema, type CrmAuthenticatedContext, type CrmSubmission, type CrmOperationResult } from "../crm-integration";
import { planCommands } from "../scheduler";
import { CrmApiError } from "./crm-auth";
import { crmRequesterActor } from "./crm-planning";
import { readCrmSchedule } from "./crm-repository";
import { reviewFingerprint } from "./preview";
import { getSupabaseAdminClient } from "./supabase";

import { parseCrmStored } from "./crm-http";
import { crmBookingEnabled } from "./crm-flags";
export function requireCrmBooking() {
  if (!crmBookingEnabled()) throw new CrmApiError("crm_booking_disabled", "CRM booking is not enabled yet.", 503);
}
export function crmDatabaseFailure(error: { code?: string } | null) {
  if (!error) return;
  if (error.code === "40001") throw new CrmApiError("crm_preview_stale", "The schedule, request or client mapping changed. Review it again.", 409);
  if (error.code === "23505") throw new CrmApiError("crm_operation_conflict", "This task or operation is already linked to another submission. Check its saved result.", 409);
  if (error.code === "42501") throw new CrmApiError("crm_unauthorized", "This connection or request is no longer available.", 401);
  if (error.code === "22023") throw new CrmApiError("crm_invalid_input", "Check the submitted task details.", 400);
  throw new CrmApiError("crm_unavailable", "Calendar could not confirm this operation. Check its saved result before retrying.", 503);
}
const savedPreviewSchema = z.object({
  id: z.uuid(), integration_id: z.uuid(), requester_subject: z.uuid(), requester_email: z.string(),
  external_task_id: z.string(), external_client_id: z.string(), calendar_client_id: z.string(),
  mapping_revision: z.number().int(), base_version: z.number().int(), input: crmTaskInputSchema,
  commands: z.array(commandSchema).length(1), review_fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  created_at: z.string(), expires_at: z.string(),
});
const stale = () => new CrmApiError("crm_preview_stale", "This preview changed or expired. Request and review a fresh preview.", 409);

/** Replays precede expiry checks, but remain bound to the verified human and exact intent. */
export async function submitCrmTask(context: CrmAuthenticatedContext, input: CrmSubmission, kind: "booking" | "request", now = new Date().toISOString()): Promise<CrmOperationResult> {
  requireCrmBooking();
  const db = getSupabaseAdminClient();
  const operation = await db.from("crm_operations").select("requester_subject,requester_email,kind,input,status,result")
    .eq("integration_id", context.connection.id).eq("operation_id", input.operationId).maybeSingle();
  crmDatabaseFailure(operation.error);
  const intent = { previewId: input.previewId, note: input.note };
  if (operation.data) {
    const old = operation.data;
    if (old.requester_subject !== context.requester.subject || old.requester_email !== context.requester.email || old.kind !== kind
      || old.input?.previewId !== input.previewId || old.input?.note !== input.note)
      throw new CrmApiError("crm_operation_conflict", "This operation belongs to another submission.", 409);
    if (old.status === "completed") return parseCrmStored(crmOperationResultSchema, old.result);
    if (old.status !== "prepared") throw new CrmApiError("crm_operation_conflict", "This operation has already finished.", 409);
  }
  const saved = await db.from("crm_previews").select("id,integration_id,requester_subject,requester_email,external_task_id,external_client_id,calendar_client_id,mapping_revision,base_version,input,commands,review_fingerprint,created_at,expires_at")
    .eq("integration_id", context.connection.id).eq("id", input.previewId).maybeSingle();
  crmDatabaseFailure(saved.error);
  if (!saved.data) throw stale();
  const preview = parseCrmStored(savedPreviewSchema, saved.data);
  if (preview.requester_subject !== context.requester.subject || preview.requester_email !== context.requester.email)
    throw new CrmApiError("crm_unauthorized", "This preview belongs to another requester.", 403);
  if (!Number.isFinite(Date.parse(preview.expires_at)) || Date.parse(preview.expires_at) <= Date.parse(now) || Date.parse(preview.created_at) > Date.parse(now) + 5000) throw stale();
  const loaded = await readCrmSchedule(context, preview.external_client_id);
  if (loaded.snapshot.version !== preview.base_version || loaded.mapping?.revision !== preview.mapping_revision || loaded.mapping?.calendarClientId !== preview.calendar_client_id) throw stale();
  // Reuse the original immutable commands (including creation timestamps), so
  // clock/capacity changes invalidate the review rather than silently changing it.
  const proposal = planCommands(loaded.snapshot, preview.commands, crmRequesterActor(context), { now, operationId: preview.id });
  if (reviewFingerprint(proposal) !== preview.review_fingerprint) throw stale();
  if (kind === "booking" && (proposal.status !== "ready" || proposal.requiresApproval))
    throw new CrmApiError("crm_approval_required", "This work needs Bryan's approval. Submit it as a request.", 409);
  if (kind === "request" && proposal.status === "ready" && !proposal.requiresApproval)
    throw new CrmApiError("crm_clean_fit", "This work fits. Use the reviewed booking action.", 409);
  proposal.operationId = `crm-${context.connection.id}-${input.operationId}`;
  const { data, error } = await db.rpc("finalize_crm_submission", {
    p_integration_id: context.connection.id, p_credential_hash: context.connection.credentialHash,
    p_operation_id: input.operationId, p_preview_id: input.previewId,
    p_requester_subject: context.requester.subject, p_requester_email: context.requester.email,
    p_kind: kind, p_note: intent.note, p_proposal: proposal, p_fingerprint: preview.review_fingerprint,
  });
  crmDatabaseFailure(error);
  return parseCrmStored(crmOperationResultSchema, data);
}
