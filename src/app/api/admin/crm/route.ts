import { randomUUID } from "node:crypto";
import { crmSetupActionSchema, crmOwnerSetupSchema } from "@/lib/crm-setup";
import { getLiveActor } from "@/lib/server/auth";
import { CrmApiError } from "@/lib/server/crm-auth";
import { crmBookingEnabled } from "@/lib/server/crm-flags";
import { crmFailure, crmJson, parseCrmStored, readCrmJson } from "@/lib/server/crm-http";
import { issueCrmCredential, isCrmPublicKey } from "@/lib/server/crm-credentials";
import { crmDatabaseFailure } from "@/lib/server/crm-submissions";
import { getSupabaseAdminClient, getSupabaseServerClient } from "@/lib/server/supabase";
export const runtime = "nodejs";
async function owner() {
  try {
    if ((await getLiveActor()).role !== "owner") throw new Error();
  } catch { throw new CrmApiError("crm_owner_required", "Sign in as the Calendar owner to configure CRM.", 403); }
}
async function setup() {
  const { data, error } = await (await getSupabaseServerClient()).rpc("read_crm_owner_setup");
  crmDatabaseFailure(error);
  return { ...parseCrmStored(crmOwnerSetupSchema, data), bookingEnabled: crmBookingEnabled(), integrationEnabled: process.env.ADA_CRM_INTEGRATION_ENABLED === "true" };
}
export async function GET() {
  try { await owner(); return crmJson(await setup()); } catch (error) { return crmFailure(error); }
}
export async function POST(request: Request) {
  try {
    if (request.headers.get("origin") !== new URL(process.env.APP_URL || request.url).origin)
      throw new CrmApiError("crm_origin_required", "Open these settings from ADA Calendar.", 403);
    await owner();
    const input = crmSetupActionSchema.parse(await readCrmJson(request));
    const db = await getSupabaseServerClient();
    let action: Record<string, unknown> = input, credential: string | undefined;
    if (input.type === "create") {
      if (!isCrmPublicKey(input.crmPublicKey)) throw new CrmApiError("crm_public_key_required", "Use the CRM project's public or publishable key.", 400);
      const existing = await setup();
      if (existing.connections.some(connection => connection.crmOrigin === input.crmOrigin))
        throw new CrmApiError("crm_connection_exists", "That CRM connection already exists. Rotate its key if you need a new one.", 409);
      const id = randomUUID(), issued = issueCrmCredential(id);
      // Admin createUser sends no invitation. The identity is banned at creation,
      // has no password and no membership, and is only used for audit foreign keys.
      const { data, error } = await getSupabaseAdminClient().auth.admin.createUser({
        email: `ada-crm-${id}@example.invalid`, email_confirm: true, ban_duration: "876000h", app_metadata: { ada_crm_principal: true },
      });
      if (error || !data.user) throw new CrmApiError("crm_setup_failed", "The disabled CRM identity could not be created.", 503);
      action = { ...input, id, principalUserId: data.user.id, credentialHash: issued.hash };
      credential = issued.token;
      // An uncertain database response must not delete a possibly linked audit
      // identity. An orphan remains banned and cannot access Calendar.
    } else if (input.type === "rotate") {
      const issued = issueCrmCredential(input.connectionId);
      action = { ...input, credentialHash: issued.hash }; credential = issued.token;
    }
    const { error } = await db.rpc("manage_crm_connection", { p_action: action });
    crmDatabaseFailure(error);
    // Do not make another read after issuing a secret: a failed read would hide
    // the only copy of a successfully rotated key. The UI refreshes separately.
    return crmJson({ ok: true, ...(credential ? { credential } : {}) });
  } catch (error) { return crmFailure(error); }
}
