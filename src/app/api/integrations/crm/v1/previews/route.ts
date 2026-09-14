import { randomUUID } from "node:crypto";
import { crmTaskInputSchema } from "@/lib/crm-integration";
import { authenticateCrmRequest } from "@/lib/server/crm-auth";
import { crmFailure, crmJson, readCrmJson } from "@/lib/server/crm-http";
import { prepareCrmPreview } from "@/lib/server/crm-planning";
import { readCrmSchedule, saveCrmPreview } from "@/lib/server/crm-repository";

export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    const context = await authenticateCrmRequest(request);
    const input = crmTaskInputSchema.parse(await readCrmJson(request));
    const loaded = await readCrmSchedule(context, input.externalClientId);
    const preview = prepareCrmPreview(context, loaded, input, randomUUID(), new Date().toISOString());
    await saveCrmPreview(context, preview);
    return crmJson(preview.response);
  } catch (error) { return crmFailure(error); }
}
