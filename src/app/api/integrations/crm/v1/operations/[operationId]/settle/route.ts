import { z } from "zod";
import { crmOperationResultSchema } from "@/lib/crm-integration";
import { authenticateCrmService } from "@/lib/server/crm-auth";
import { crmFailure, crmJson, parseCrmStored, readCrmJson } from "@/lib/server/crm-http";
import { crmDatabaseFailure } from "@/lib/server/crm-submissions";
import { getSupabaseAdminClient } from "@/lib/server/supabase";
export const runtime = "nodejs";
const resultSchema = z.union([crmOperationResultSchema, z.object({ apiVersion: z.literal("1"), operationId: z.uuid(), status: z.literal("rejected") })]);
/** An atomic fence: return an existing commit or prevent this operation from ever committing. */
export async function POST(request: Request, context: { params: Promise<{ operationId: string }> }) {
  try {
    const connection = await authenticateCrmService(request);
    const operationId = z.uuid().parse((await context.params).operationId);
    z.object({}).strict().parse(await readCrmJson(request));
    const { data, error } = await getSupabaseAdminClient().rpc("settle_crm_operation", {
      p_integration_id: connection.id, p_credential_hash: connection.credentialHash, p_operation_id: operationId,
    });
    crmDatabaseFailure(error);
    return crmJson(parseCrmStored(resultSchema, data));
  } catch (error) { return crmFailure(error); }
}
