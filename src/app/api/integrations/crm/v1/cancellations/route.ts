import { crmCancellationInputSchema } from "@/lib/crm-integration";
import { idSchema } from "@/lib/schemas";
import { authenticateCrmRequest } from "@/lib/server/crm-auth";
import { cancelCrmTask, reviewCrmCancellation } from "@/lib/server/crm-cancellation";
import { crmFailure, crmJson, readCrmJson } from "@/lib/server/crm-http";
export const runtime = "nodejs";
export async function GET(request: Request) {
  try {
    const context = await authenticateCrmRequest(request);
    return crmJson(await reviewCrmCancellation(context, idSchema.parse(new URL(request.url).searchParams.get("task"))));
  } catch (error) { return crmFailure(error); }
}
export async function POST(request: Request) {
  try {
    const context = await authenticateCrmRequest(request);
    return crmJson(await cancelCrmTask(context, crmCancellationInputSchema.parse(await readCrmJson(request))));
  } catch (error) { return crmFailure(error); }
}
