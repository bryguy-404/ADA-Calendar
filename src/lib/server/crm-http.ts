import "server-only";
import { z } from "zod";
import { CrmApiError } from "./crm-auth";

const privateHeaders = { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" };
export function crmJson(value: unknown) { return Response.json(value, { headers: privateHeaders }); }
/** Invalid stored data is a server/recovery failure, never a bad caller form. */
export function parseCrmStored<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new CrmApiError("crm_unavailable", "Calendar could not confirm the saved result. Check the operation before retrying.", 503);
  return parsed.data;
}
export function crmFailure(error: unknown) {
  const failure = error instanceof CrmApiError ? error : error instanceof z.ZodError
    ? new CrmApiError("crm_invalid_input", "Check the task fields, estimated hours and selected dates.", 400)
    : new CrmApiError("crm_unavailable", "The CRM connection is temporarily unavailable.", 503);
  return Response.json({ code: failure.code, error: failure.message }, {
    status: failure.status,
    headers: { ...privateHeaders, ...(failure.status === 429 ? { "Retry-After": "60" } : {}) },
  });
}

export async function readCrmJson(request: Request): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json")
    throw new CrmApiError("crm_content_type", "Send this request as JSON.", 415);
  const limit = 262_144;
  if (Number(request.headers.get("content-length")) > limit)
    throw new CrmApiError("crm_input_too_large", "This task request is too large.", 413);
  const reader = request.body?.getReader();
  if (!reader) throw new CrmApiError("crm_invalid_input", "Send the task details as JSON.", 400);
  const chunks: Uint8Array[] = []; let length = 0, expired = false;
  const timer = setTimeout(() => { expired = true; void reader.cancel().catch(() => {}); }, 8000);
  try {
    while (true) {
      const result = await reader.read();
      if (expired) throw new CrmApiError("crm_input_timeout", "The task request timed out. Try again.", 408);
      if (result.done) break;
      length += result.value.byteLength;
      if (length > limit) { await reader.cancel(); throw new CrmApiError("crm_input_too_large", "This task request is too large.", 413); }
      chunks.push(result.value);
    }
  } finally { clearTimeout(timer); reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new CrmApiError("crm_invalid_input", "Send valid task details as JSON.", 400); }
}
