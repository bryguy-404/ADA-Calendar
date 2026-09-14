import "server-only";
import { z } from "zod";
import { settingsSchema, clientSchema, prioritySchema, workItemSchema, sessionSchema, blockSchema, idSchema } from "../schemas";
import type { CrmAuthenticatedContext } from "../crm-integration";
import type { CrmPreparedPreview, CrmScheduleContext } from "./crm-planning";
import { CrmApiError } from "./crm-auth";
import { getSupabaseAdminClient } from "./supabase";

const scheduleContextSchema = z.object({
  snapshot: z.object({
    workspaceId: z.uuid(), version: z.number().int().nonnegative(), settings: settingsSchema,
    clients: z.array(clientSchema), priorities: z.array(prioritySchema), items: z.array(workItemSchema),
    sessions: z.array(sessionSchema), blocks: z.array(blockSchema),
  }),
  mapping: z.object({ calendarClientId: idSchema, revision: z.number().int().positive() }).nullable(),
});

/** One database snapshot, including all sessions; never multiple reads or a paginated session table. */
export async function readCrmSchedule(context: CrmAuthenticatedContext, externalClientId?: string): Promise<CrmScheduleContext> {
  const { data, error } = await getSupabaseAdminClient().rpc("read_crm_schedule_context", {
    p_integration_id: context.connection.id, p_external_client_id: externalClientId ?? null,
  });
  if (error) throw new CrmApiError("crm_unavailable", "Calendar availability is temporarily unavailable.", 503);
  if (!data) throw new CrmApiError("crm_unauthorized", "This CRM connection is no longer available.", 401);
  const parsed = scheduleContextSchema.safeParse(data);
  if (!parsed.success || parsed.data.snapshot.workspaceId !== context.connection.workspaceId)
    throw new CrmApiError("crm_unavailable", "Calendar availability is temporarily unavailable.", 503);
  return parsed.data;
}

export async function saveCrmPreview(context: CrmAuthenticatedContext, preview: CrmPreparedPreview): Promise<void> {
  const { error } = await getSupabaseAdminClient().rpc("create_crm_preview", {
    p_integration_id: context.connection.id, p_preview_id: preview.response.previewId,
    p_requester_subject: context.requester.subject, p_requester_email: context.requester.email,
    p_base_version: preview.response.baseVersion, p_mapping_revision: preview.mappingRevision,
    p_input: preview.input, p_commands: preview.commands, p_fingerprint: preview.fingerprint,
    p_created_at: preview.response.createdAt,
  });
  if (error?.code === "40001") throw new CrmApiError("crm_preview_stale", "The schedule or client mapping changed. Request a fresh preview.", 409);
  if (error?.code === "42501") throw new CrmApiError("crm_unauthorized", "This CRM connection is no longer available.", 401);
  if (error) throw new CrmApiError("crm_unavailable", "The preview could not be saved. Try again shortly.", 503);
}
