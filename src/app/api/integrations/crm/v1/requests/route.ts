import { crmSubmissionSchema } from "@/lib/crm-integration";
import { authenticateCrmRequest } from "@/lib/server/crm-auth";
import { crmFailure, crmJson, readCrmJson } from "@/lib/server/crm-http";
import { submitCrmTask } from "@/lib/server/crm-submissions";
export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    const context = await authenticateCrmRequest(request);
    return crmJson(await submitCrmTask(context, crmSubmissionSchema.parse(await readCrmJson(request)), "request"));
  } catch (error) { return crmFailure(error); }
}
