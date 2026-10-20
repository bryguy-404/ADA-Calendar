import { authenticateCrmService } from "@/lib/server/crm-auth";
import { crmFailure, crmJson, readCrmJson } from "@/lib/server/crm-http";
import { crmIntakeSchema, receiveCrmIntake } from "@/lib/server/crm-intake";
export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    const connection = await authenticateCrmService(request);
    return crmJson(await receiveCrmIntake(connection, crmIntakeSchema.parse(await readCrmJson(request))));
  } catch (error) { return crmFailure(error); }
}
