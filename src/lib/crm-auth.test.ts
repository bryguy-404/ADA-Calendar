import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const database = vi.hoisted(() => ({ admin: vi.fn() }));
vi.mock("./server/supabase", () => ({ getSupabaseAdminClient: database.admin }));
import { authenticateCrmRequest, authenticateCrmService, verifyCrmUser } from "./server/crm-auth";
import { credentialHash, issueCrmCredential, isCrmPublicKey, matchesCrmCredential, parseCrmCredential } from "./server/crm-credentials";
import type { CrmConnection } from "./crm-integration";

const connectionId = "10000000-0000-4000-8000-000000000001";
const issued = issueCrmCredential(connectionId);
const connection: CrmConnection = {
  id: connectionId, workspaceId: "10000000-0000-4000-8000-000000000002",
  principalUserId: "10000000-0000-4000-8000-000000000003",
  crmOrigin: "https://crm.example.invalid", crmAuthUrl: "https://fictional-crm.supabase.co",
  crmPublicKey: "sb_publishable_fictional_fixture", agencyDomain: "example.invalid",
  credentialHash: issued.hash, enabled: true,
};
const verifiedUser = {
  id: "10000000-0000-4000-8000-000000000004", email: "Teammate@example.invalid",
  email_confirmed_at: "2026-09-01T12:00:00Z",
  user_metadata: { name: "Calendar Owner", role: "owner", workspaceId: "other" },
};
const dependencies = {
  enabled: vi.fn(() => true), connection: vi.fn(async () => connection as CrmConnection | null),
  consumeBudget: vi.fn(async () => true), verifyUser: vi.fn(async (): Promise<unknown> => verifiedUser),
};
function request(extra: Record<string, string> = {}) {
  return new Request("https://calendar.example.invalid/api/integrations/crm/v1/status", {
    headers: { authorization: "Bearer " + issued.token, "x-crm-user-token": "fixture-user-token", ...extra },
  });
}
beforeEach(() => {
  database.admin.mockImplementation(() => { throw new Error("Live database prohibited in unit tests"); });
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Network prohibited in unit tests"); }));
  dependencies.enabled.mockReturnValue(true); dependencies.connection.mockResolvedValue(connection);
  dependencies.consumeBudget.mockResolvedValue(true); dependencies.verifyUser.mockResolvedValue(verifiedUser);
});

describe("production connection lookup boundary", () => {
  function storedConnection(overrides: Record<string, unknown> = {}) {
    const lookup = vi.fn(async () => ({ error: null, data: {
      id: connection.id, workspace_id: connection.workspaceId, principal_user_id: connection.principalUserId,
      crm_origin: connection.crmOrigin, crm_auth_url: connection.crmAuthUrl, crm_public_key: connection.crmPublicKey,
      agency_domain: connection.agencyDomain, credential_hash: connection.credentialHash, enabled: true, ...overrides,
    } }));
    const query = { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), maybeSingle: lookup };
    const db = { from: vi.fn(() => query), rpc: vi.fn(async () => ({ data: true, error: null })) };
    database.admin.mockReturnValue(db); vi.stubEnv("ADA_CRM_INTEGRATION_ENABLED", "true");
    return { db, query };
  }
  it("maps the private database record and checks the budget before verifying the teammate", async () => {
    const { db, query } = storedConnection();
    vi.mocked(fetch).mockResolvedValueOnce(Response.json(verifiedUser));
    expect((await authenticateCrmRequest(request())).requester.subject).toBe(verifiedUser.id);
    expect(db.from).toHaveBeenCalledWith("crm_integrations");
    expect(query.eq).toHaveBeenCalledWith("id", connection.id);
    expect(db.rpc).toHaveBeenCalledWith("consume_crm_api_budget", { p_integration_id: connection.id });
  });
  it("rejects corrupt or unsafe stored configuration before making an external call", async () => {
    for (const override of [{ crm_public_key: "sb_secret_fixture" }, { crm_auth_url: "http://127.0.0.1" }, { workspace_id: "malformed" }]) {
      storedConnection(override);
      await expect(authenticateCrmRequest(request())).rejects.toMatchObject({ status: 503, code: "crm_unavailable" });
    }
    expect(fetch).not.toHaveBeenCalled();
  });
  it("fails closed when enabled without usable Calendar server credentials", async () => {
    vi.stubEnv("ADA_CRM_INTEGRATION_ENABLED", "true");
    await expect(authenticateCrmRequest(request())).rejects.toMatchObject({ status: 503, code: "crm_unavailable" });
    expect(fetch).not.toHaveBeenCalled();
  });
});
afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("CRM credentials", () => {
  it("issues independent secrets, stores a hash and detects tampering and revocation", () => {
    const second = issueCrmCredential(connectionId);
    expect(second.token).not.toBe(issued.token);
    expect(issued.hash).toBe(credentialHash(issued.token));
    expect(issued.hash).not.toContain(issued.token);
    expect(parseCrmCredential("Bearer " + issued.token)).toEqual({ connectionId, token: issued.token });
    expect(matchesCrmCredential(issued.token, issued.hash)).toBe(true);
    expect(matchesCrmCredential(issued.token, second.hash)).toBe(false);
    expect(matchesCrmCredential(issued.token, "malformed")).toBe(false);
    expect(matchesCrmCredential(issued.token + "tampered", issued.hash)).toBe(false);
    for (const authorization of [null, "", "Basic " + issued.token, "Bearer " + issued.token + "extra", "Bearer " + "a".repeat(201)])
      expect(parseCrmCredential(authorization)).toBeNull();
    expect(() => issueCrmCredential("not-a-uuid")).toThrow();
  });
  it("accepts public Auth keys and rejects admin or malformed keys", () => {
    const jwt = (role: string) => "header." + Buffer.from(JSON.stringify({ role })).toString("base64url") + ".signature";
    expect(isCrmPublicKey(connection.crmPublicKey)).toBe(true);
    expect(isCrmPublicKey(jwt("anon"))).toBe(true);
    for (const key of [jwt("service_role"), "sb_secret_fixture", "garbage", "a".repeat(4097)])
      expect(isCrmPublicKey(key)).toBe(false);
  });
});

describe("independent CRM connection and teammate verification", () => {
  it("uses only the verified CRM identity, without accepting profile authority or a Calendar login", async () => {
    const result = await authenticateCrmRequest(request(), dependencies);
    expect(result.requester).toEqual({ subject: verifiedUser.id, email: "teammate@example.invalid", name: "teammate@example.invalid" });
    expect(dependencies.verifyUser).toHaveBeenCalledWith(connection, "fixture-user-token");
    expect(await authenticateCrmService(new Request(request().url, { headers: { authorization: "Bearer " + issued.token } }), dependencies)).toEqual(connection);
  });
  it("fails closed when disabled, even in demo mode", async () => {
    dependencies.enabled.mockReturnValue(false);
    await expect(authenticateCrmRequest(request(), dependencies)).rejects.toMatchObject({ status: 503, code: "crm_disabled" });
    expect(dependencies.connection).not.toHaveBeenCalled();
    vi.stubEnv("ADA_CRM_INTEGRATION_ENABLED", "false"); vi.stubEnv("ADA_DEMO_MODE", "true");
    await expect(authenticateCrmRequest(request())).rejects.toMatchObject({ status: 503, code: "crm_disabled" });
  });
  it("rejects browser-origin traffic, Calendar cookies and forged service credentials before Auth", async () => {
    await expect(authenticateCrmRequest(request({ origin: "https://crm.example.invalid" }), dependencies)).rejects.toMatchObject({ status: 403 });
    await expect(authenticateCrmRequest(request({ authorization: "Bearer " + issueCrmCredential(connectionId).token }), dependencies)).rejects.toMatchObject({ status: 401 });
    await expect(authenticateCrmRequest(new Request(request().url, { headers: { cookie: "sb-calendar-auth-token=fixture" } }), dependencies)).rejects.toMatchObject({ status: 401 });
    expect(dependencies.verifyUser).not.toHaveBeenCalled();
    expect(dependencies.consumeBudget).not.toHaveBeenCalled();
  });
  it("denies unknown, disabled and mismatched connections without revealing which condition applied", async () => {
    for (const value of [null, { ...connection, enabled: false }, { ...connection, id: verifiedUser.id }]) {
      dependencies.connection.mockResolvedValue(value);
      await expect(authenticateCrmRequest(request(), dependencies)).rejects.toMatchObject({ code: "crm_unauthorized", status: 401 });
    }
    expect(dependencies.verifyUser).not.toHaveBeenCalled();
  });
  it("enforces the connection budget before making an external Auth request", async () => {
    dependencies.consumeBudget.mockResolvedValue(false);
    await expect(authenticateCrmRequest(request(), dependencies)).rejects.toMatchObject({ status: 429 });
    expect(dependencies.verifyUser).not.toHaveBeenCalled();
  });
  it("requires an actual agency user token and verified agency email", async () => {
    for (const token of ["", "bad token", "a".repeat(16_001)])
      await expect(authenticateCrmRequest(request({ "x-crm-user-token": token }), dependencies)).rejects.toMatchObject({ status: 401 });
    for (const user of [
      { ...verifiedUser, email_confirmed_at: null }, { ...verifiedUser, id: undefined },
      { ...verifiedUser, email: "outside@other.invalid" }, { ...verifiedUser, email: "outside@sub.example.invalid" },
      { ...verifiedUser, is_anonymous: true }, { ...verifiedUser, banned_until: "2199-01-01T00:00:00Z" },
    ]) {
      dependencies.verifyUser.mockResolvedValue(user);
      await expect(authenticateCrmRequest(request(), dependencies)).rejects.toMatchObject({ status: expect.any(Number) });
    }
  });
  it("sanitizes database, network and malformed provider failures", async () => {
    dependencies.connection.mockRejectedValueOnce(new Error("private database credential"));
    await expect(authenticateCrmRequest(request(), dependencies)).rejects.toMatchObject({ status: 503, message: "The CRM connection is temporarily unavailable." });
    dependencies.verifyUser.mockRejectedValueOnce(new Error("private user token"));
    await expect(authenticateCrmRequest(request(), dependencies)).rejects.toMatchObject({ status: 503, message: "CRM identity verification is temporarily unavailable." });
    dependencies.verifyUser.mockResolvedValue({ private: "malformed provider data" });
    await expect(authenticateCrmRequest(request(), dependencies)).rejects.toMatchObject({ status: 401 });
  });
});

describe("pinned CRM Auth transport", () => {
  it("uses the configured project and public key, disables caches/redirects and sets a timeout", async () => {
    const transport = vi.fn<typeof fetch>(async () => Response.json(verifiedUser));
    expect(await verifyCrmUser(connection, "user-token", transport)).toEqual(verifiedUser);
    expect(transport).toHaveBeenCalledWith(connection.crmAuthUrl + "/auth/v1/user", expect.objectContaining({
      cache: "no-store", redirect: "error", signal: expect.any(AbortSignal),
      headers: { apikey: connection.crmPublicKey, Authorization: "Bearer user-token" },
    }));
  });
  it("refuses unpinned URLs and private keys before making a network request", async () => {
    const transport = vi.fn<typeof fetch>();
    for (const crmAuthUrl of ["http://localhost", "https://evil.invalid", connection.crmAuthUrl + "/redirect", "https://fake.supabase.co@evil.invalid", connection.crmAuthUrl + ":1234"])
      await expect(verifyCrmUser({ ...connection, crmAuthUrl }, "fixture", transport)).rejects.toThrow();
    await expect(verifyCrmUser({ ...connection, crmPublicKey: "sb_secret_fixture" }, "fixture", transport)).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
  });
  it("rejects revoked tokens, unavailable Auth, malformed JSON and oversized responses", async () => {
    await expect(verifyCrmUser(connection, "fixture", async () => new Response("private", { status: 401 }))).rejects.toMatchObject({ status: 401 });
    for (const response of [new Response("private", { status: 503 }), new Response("not-json"), new Response("a".repeat(64_001))])
      await expect(verifyCrmUser(connection, "fixture", async () => response)).rejects.toThrow();
  });
});
