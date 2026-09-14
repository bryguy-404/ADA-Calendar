import { z } from "zod";
import { crmPublicTaskSchema } from "@/lib/crm-integration";
import { authenticateCrmService } from "@/lib/server/crm-auth";
import { crmFailure, crmJson, parseCrmStored } from "@/lib/server/crm-http";
import { crmDatabaseFailure } from "@/lib/server/crm-submissions";
import { getSupabaseAdminClient } from "@/lib/server/supabase";
export const runtime = "nodejs";
const querySchema = z.object({ after: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0), limit: z.coerce.number().int().min(1).max(100).default(50) }).strict();
const changeSchema = z.object({ sequence: z.number().int().positive(), kind: z.enum(["booked", "request_updated", "schedule_updated", "completed", "cancelled"]), body: crmPublicTaskSchema });
export async function GET(request: Request) {
  try {
    const connection = await authenticateCrmService(request);
    const { after, limit } = querySchema.parse(Object.fromEntries(new URL(request.url).searchParams));
    const { data, error } = await getSupabaseAdminClient().from("crm_changes").select("sequence,kind,body")
      .eq("integration_id", connection.id).gt("sequence", after).order("sequence").limit(limit + 1);
    crmDatabaseFailure(error);
    const rows = parseCrmStored(z.array(changeSchema), data);
    const changes = rows.slice(0, limit).map(row => ({ sequence: row.sequence, kind: row.kind, task: row.body }));
    return crmJson({ apiVersion: "1", changes, nextCursor: changes.at(-1)?.sequence ?? after, hasMore: rows.length > limit });
  } catch (error) { return crmFailure(error); }
}
