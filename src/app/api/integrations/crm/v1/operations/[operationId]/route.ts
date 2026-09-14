import { z } from "zod";
import { crmOperationResultSchema } from "@/lib/crm-integration";
import { authenticateCrmService } from "@/lib/server/crm-auth";
import { crmFailure, crmJson, parseCrmStored } from "@/lib/server/crm-http";
import { crmDatabaseFailure } from "@/lib/server/crm-submissions";
import { getSupabaseAdminClient } from "@/lib/server/supabase";
export const runtime = "nodejs";
/** Credential-only recovery for the CRM server. Never return operation input or human tokens. */
export async function GET(request: Request, context: { params: Promise<{ operationId: string }> }) {
  try {
    const connection = await authenticateCrmService(request);
    const operationId = z.uuid().parse((await context.params).operationId);
    const { data, error } = await getSupabaseAdminClient().from("crm_operations").select("status,result")
      .eq("integration_id", connection.id).eq("operation_id", operationId).maybeSingle();
    crmDatabaseFailure(error);
    if (data?.status === "completed") return crmJson(parseCrmStored(crmOperationResultSchema, data.result));
    if (!data) {
      const closed = await getSupabaseAdminClient().from("crm_closed_operations").select("operation_id")
        .eq("integration_id", connection.id).eq("operation_id", operationId).maybeSingle();
      crmDatabaseFailure(closed.error);
      if (closed.data) return crmJson({ apiVersion: "1", operationId, status: "rejected" });
    }
    return crmJson({ apiVersion: "1", operationId, status: data ? parseCrmStored(z.enum(["prepared", "rejected"]), data.status) : "not_found" });
  } catch (error) { return crmFailure(error); }
}
