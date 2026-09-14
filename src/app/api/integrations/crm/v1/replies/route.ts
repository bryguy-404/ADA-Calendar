import { crmReplySchema, crmOperationResultSchema } from "@/lib/crm-integration";
import { authenticateCrmRequest } from "@/lib/server/crm-auth";
import { crmFailure, crmJson, parseCrmStored, readCrmJson } from "@/lib/server/crm-http";
import { crmDatabaseFailure, requireCrmBooking } from "@/lib/server/crm-submissions";
import { getSupabaseAdminClient } from "@/lib/server/supabase";
export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    const { connection, requester } = await authenticateCrmRequest(request);
    requireCrmBooking();
    const input = crmReplySchema.parse(await readCrmJson(request));
    const { data, error } = await getSupabaseAdminClient().rpc("reply_crm_request", {
      p_integration_id: connection.id, p_credential_hash: connection.credentialHash, p_operation_id: input.operationId,
      p_external_task_id: input.externalTaskId, p_requester_subject: requester.subject, p_requester_email: requester.email, p_message: input.message,
    });
    crmDatabaseFailure(error);
    return crmJson(parseCrmStored(crmOperationResultSchema, data));
  } catch (error) { return crmFailure(error); }
}
