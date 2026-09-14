import { z } from "zod";
import { authenticateCrmService } from "@/lib/server/crm-auth";
import { crmFailure, crmJson, parseCrmStored, readCrmJson } from "@/lib/server/crm-http";
import { crmDatabaseFailure } from "@/lib/server/crm-submissions";
import { getSupabaseAdminClient } from "@/lib/server/supabase";
export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    const connection = await authenticateCrmService(request);
    z.object({}).strict().parse(await readCrmJson(request));
    const { data, error } = await getSupabaseAdminClient().rpc("prune_crm_previews", { p_integration_id: connection.id, p_credential_hash: connection.credentialHash });
    crmDatabaseFailure(error);
    return crmJson({ apiVersion: "1", removed: parseCrmStored(z.number().int().min(0).max(500), data) });
  } catch (error) { return crmFailure(error); }
}
