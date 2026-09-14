import { crmBookingEnabled } from "@/lib/server/crm-flags";
import { CRM_API_VERSION, type CrmStatus } from "@/lib/crm-integration";
import { authenticateCrmRequest } from "@/lib/server/crm-auth";
import { crmFailure, crmJson } from "@/lib/server/crm-http";

export const runtime = "nodejs";

/** Connection capabilities only. This endpoint never returns workload data. */
export async function GET(request: Request) {
  try {
    await authenticateCrmRequest(request);
    const result: CrmStatus = {
      apiVersion: CRM_API_VERSION, status: "authenticated",
      bookingEnabled: crmBookingEnabled(), capabilities: ["connection_check", "availability", "previews", "operations", "changes", ...(crmBookingEnabled() ? ["bookings", "requests", "replies"] as const : [])],
    };
    return crmJson(result);
  } catch (error) { return crmFailure(error); }
}
