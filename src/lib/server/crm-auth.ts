import "server-only";
import { z } from "zod";
import {
  crmAgencyDomainSchema, crmAuthUrlSchema, crmOriginSchema,
  type CrmAuthenticatedContext, type CrmConnection, type CrmRequester,
} from "../crm-integration";
import { isCrmPublicKey, matchesCrmCredential, parseCrmCredential } from "./crm-credentials";
import { getSupabaseAdminClient } from "./supabase";

export class CrmApiError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) { super(message); }
}

type Dependencies = {
  enabled: () => boolean;
  connection: (id: string) => Promise<CrmConnection | null>;
  consumeBudget: (id: string) => Promise<boolean>;
  verifyUser: (connection: CrmConnection, token: string) => Promise<unknown>;
};

const connectionSchema = z.object({
  id: z.uuid(), workspace_id: z.uuid(), principal_user_id: z.uuid(),
  crm_origin: crmOriginSchema, crm_auth_url: crmAuthUrlSchema,
  crm_public_key: z.string().refine(isCrmPublicKey), agency_domain: crmAgencyDomainSchema,
  credential_hash: z.string().regex(/^[a-f0-9]{64}$/), enabled: z.boolean(),
});

async function readConnection(id: string): Promise<CrmConnection | null> {
  const db = getSupabaseAdminClient();
  const { data, error } = await db.from("crm_integrations")
    .select("id,workspace_id,principal_user_id,crm_origin,crm_auth_url,crm_public_key,agency_domain,credential_hash,enabled")
    .eq("id", id).maybeSingle();
  if (error) throw new Error("Connection lookup failed.");
  if (!data) return null;
  const row = connectionSchema.parse(data);
  return {
    id: row.id, workspaceId: row.workspace_id, principalUserId: row.principal_user_id,
    crmOrigin: row.crm_origin, crmAuthUrl: row.crm_auth_url, crmPublicKey: row.crm_public_key,
    agencyDomain: row.agency_domain, credentialHash: row.credential_hash, enabled: row.enabled,
  };
}

async function consumeBudget(id: string): Promise<boolean> {
  const { data, error } = await getSupabaseAdminClient().rpc("consume_crm_api_budget", { p_integration_id: id });
  if (error) throw new Error("Connection budget check failed.");
  return data === true;
}

/** Auth checks use the pinned project, have a bounded response, and never follow redirects. */
export async function verifyCrmUser(connection: CrmConnection, token: string, request: typeof fetch = fetch): Promise<unknown> {
  if (!crmAuthUrlSchema.safeParse(connection.crmAuthUrl).success || !isCrmPublicKey(connection.crmPublicKey))
    throw new Error("Invalid CRM authentication configuration.");
  const response = await request(connection.crmAuthUrl + "/auth/v1/user", {
    headers: { apikey: connection.crmPublicKey, Authorization: "Bearer " + token },
    cache: "no-store", redirect: "error", signal: AbortSignal.timeout(8000),
  });
  if (response.status === 401 || response.status === 403)
    throw new CrmApiError("crm_sign_in_required", "Sign into the CRM again.", 401);
  if (!response.ok) throw new Error("CRM authentication is unavailable.");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("CRM authentication returned an empty response.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 64_000) { await reader.cancel(); throw new Error("CRM authentication response is too large."); }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = Buffer.concat(chunks);
  return JSON.parse(bytes.toString("utf8"));
}

const productionDependencies: Dependencies = {
  enabled: () => process.env.ADA_CRM_INTEGRATION_ENABLED === "true",
  connection: readConnection, consumeBudget, verifyUser: verifyCrmUser,
};

const verifiedUserSchema = z.object({
  id: z.uuid(), email: z.email(),
  email_confirmed_at: z.iso.datetime({ offset: true }),
  is_anonymous: z.boolean().optional(),
  banned_until: z.iso.datetime({ offset: true }).nullable().optional(),
});

function verifiedRequester(value: unknown, agencyDomain: string): CrmRequester {
  const parsed = verifiedUserSchema.safeParse(value);
  if (!parsed.success) throw new CrmApiError("crm_sign_in_required", "Sign into the CRM with a verified agency account.", 401);
  const user = parsed.data;
  const email = user.email.toLowerCase();
  if (user.is_anonymous || user.banned_until && Date.parse(user.banned_until) > Date.now()
    || email.split("@")[1] !== agencyDomain)
    throw new CrmApiError("crm_team_required", "Only verified CRM agency teammates can use this connection.", 403);
  return { subject: user.id, email, name: email };
}

/** Separate service and interactive authentication so future recovery workers need no saved user tokens. */
export async function authenticateCrmService(request: Request, dependencies: Dependencies = productionDependencies): Promise<CrmConnection> {
  if (!dependencies.enabled()) throw new CrmApiError("crm_disabled", "The CRM connection is not enabled.", 503);
  if (request.headers.has("origin"))
    throw new CrmApiError("crm_server_required", "Use the CRM server connection.", 403);
  const credential = parseCrmCredential(request.headers.get("authorization"));
  if (!credential) throw new CrmApiError("crm_unauthorized", "Invalid CRM connection credential.", 401);
  try {
    const connection = await dependencies.connection(credential.connectionId);
    if (!connection || connection.id !== credential.connectionId || !matchesCrmCredential(credential.token, connection.credentialHash) || !connection.enabled)
      throw new CrmApiError("crm_unauthorized", "Invalid CRM connection credential.", 401);
    if (!await dependencies.consumeBudget(connection.id))
      throw new CrmApiError("crm_rate_limited", "The CRM connection is busy. Try again shortly.", 429);
    return connection;
  } catch (error) {
    if (error instanceof CrmApiError) throw error;
    throw new CrmApiError("crm_unavailable", "The CRM connection is temporarily unavailable.", 503);
  }
}

export async function authenticateCrmRequest(request: Request, dependencies: Dependencies = productionDependencies): Promise<CrmAuthenticatedContext> {
  const connection = await authenticateCrmService(request, dependencies);
  const token = request.headers.get("x-crm-user-token");
  if (!token || token.length > 16_000 || /\s/.test(token))
    throw new CrmApiError("crm_sign_in_required", "Sign into the CRM again.", 401);
  try {
    const user = await dependencies.verifyUser(connection, token);
    return { connection, requester: verifiedRequester(user, connection.agencyDomain) };
  } catch (error) {
    if (error instanceof CrmApiError) throw error;
    throw new CrmApiError("crm_unavailable", "CRM identity verification is temporarily unavailable.", 503);
  }
}
