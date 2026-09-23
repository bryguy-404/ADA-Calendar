import "server-only";
import { z } from "zod";
import { crmCancellationInputSchema, crmCancellationReviewSchema, crmOperationResultSchema, type CrmAuthenticatedContext } from "../crm-integration";
import { planCommands } from "../scheduler";
import { CrmApiError } from "./crm-auth";
import { parseCrmStored } from "./crm-http";
import { crmRequesterActor } from "./crm-planning";
import { readCrmSchedule } from "./crm-repository";
import { crmDatabaseFailure, requireCrmBooking } from "./crm-submissions";
import { getSupabaseAdminClient } from "./supabase";

export async function reviewCrmCancellation(context: CrmAuthenticatedContext, taskId: string) {
  requireCrmBooking();
  const { data, error } = await getSupabaseAdminClient().rpc("read_crm_cancellation", {
    p_integration_id: context.connection.id, p_credential_hash: context.connection.credentialHash,
    p_external_task_id: taskId, p_requester_subject: context.requester.subject, p_requester_email: context.requester.email,
  });
  crmDatabaseFailure(error);
  return parseCrmStored(crmCancellationReviewSchema, data);
}

export async function cancelCrmTask(context: CrmAuthenticatedContext, input: z.infer<typeof crmCancellationInputSchema>) {
  requireCrmBooking();
  const db = getSupabaseAdminClient();
  const { operationId, ...intent } = input;
  const old = await db.from("crm_operations").select("requester_subject,requester_email,kind,input,status,result")
    .eq("integration_id", context.connection.id).eq("operation_id", operationId).maybeSingle();
  crmDatabaseFailure(old.error);
  const saved = old.data;
  if (saved) {
    if (saved.kind !== "cancellation" || saved.requester_subject !== context.requester.subject || saved.requester_email !== context.requester.email
      || Object.entries(intent).some(([key, value]) => saved.input?.[key] !== value))
      throw new CrmApiError("crm_operation_conflict", "This operation belongs to another request.", 409);
    if (saved.status === "completed") return parseCrmStored(crmOperationResultSchema, saved.result);
  }
  const review = await reviewCrmCancellation(context, input.externalTaskId);
  if (!review.canCancel || review.reviewToken !== input.reviewToken || review.started && !input.acknowledgeStarted)
    throw new CrmApiError("crm_preview_stale", "Review this cancellation again. The task may have changed or started.", 409);
  let proposal = null;
  if (review.task.workItemId) {
    const { snapshot } = await readCrmSchedule(context);
    if (snapshot.version !== review.task.version) throw new CrmApiError("crm_preview_stale", "Review the updated task before cancelling.", 409);
    // A single, source-authorized withdrawal delegates only this status command.
    // SQL independently checks the original requester, exact command and every
    // changed item/session before invoking the shared scheduler transaction.
    proposal = planCommands(snapshot, [{ type: "status", itemId: review.task.workItemId, status: "cancelled" }],
      { ...crmRequesterActor(context), role: "owner" }, { operationId: `crm-cancel-${context.connection.id}-${operationId}` });
    if (proposal.status !== "ready" || proposal.requiresApproval)
      throw new CrmApiError("crm_preview_stale", "Bryan needs to review this task before it can be cancelled.", 409);
  }
  const { data, error } = await db.rpc("cancel_crm_task", {
    p_integration_id: context.connection.id, p_credential_hash: context.connection.credentialHash, p_operation_id: operationId,
    p_external_task_id: input.externalTaskId, p_requester_subject: context.requester.subject, p_requester_email: context.requester.email,
    p_review_token: input.reviewToken, p_reason: input.reason, p_acknowledge_started: input.acknowledgeStarted, p_proposal: proposal,
  });
  crmDatabaseFailure(error);
  return parseCrmStored(crmOperationResultSchema, data);
}
