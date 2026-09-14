import { CRM_API_VERSION, type CrmStatus } from "@/lib/crm-integration";
import { authenticateCrmRequest, CrmApiError } from "@/lib/server/crm-auth";

export const runtime = "nodejs";
const headers = { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" };

/** Phase 1 handshake only. No scheduling or workspace data is exposed. */
export async function GET(request: Request) {
  try {
    await authenticateCrmRequest(request);
    const result: CrmStatus = {
      apiVersion: CRM_API_VERSION, status: "authenticated",
      bookingEnabled: false, capabilities: ["connection_check"],
    };
    return Response.json(result, { headers });
  } catch (error) {
    const failure = error instanceof CrmApiError ? error
      : new CrmApiError("crm_unavailable", "The CRM connection is temporarily unavailable.", 503);
    return Response.json({ code: failure.code, error: failure.message }, {
      status: failure.status,
      headers: { ...headers, ...(failure.status === 429 ? { "Retry-After": "60" } : {}) },
    });
  }
}
