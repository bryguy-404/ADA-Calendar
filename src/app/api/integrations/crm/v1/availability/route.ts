import { crmAvailabilityQuerySchema } from "@/lib/crm-integration";
import { authenticateCrmRequest } from "@/lib/server/crm-auth";
import { crmFailure, crmJson } from "@/lib/server/crm-http";
import { crmAvailability } from "@/lib/server/crm-planning";
import { readCrmSchedule } from "@/lib/server/crm-repository";

export const runtime = "nodejs";
export async function GET(request: Request) {
  try {
    const context = await authenticateCrmRequest(request);
    const query = crmAvailabilityQuerySchema.parse(Object.fromEntries(new URL(request.url).searchParams));
    const { snapshot } = await readCrmSchedule(context);
    return crmJson(crmAvailability(snapshot, context, query.startDate, query.endDate, new Date().toISOString()));
  } catch (error) { return crmFailure(error); }
}
