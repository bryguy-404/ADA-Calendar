import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("./server/supabase", () => ({ getSupabaseAdminClient: vi.fn(), getSupabaseServerClient: vi.fn() }));
vi.mock("./server/auth", () => ({ getLiveActor: vi.fn() }));
import { getSupabaseAdminClient, getSupabaseServerClient } from "./server/supabase";
import { getLiveActor } from "./server/auth";
import { GET, POST } from "../app/api/admin/crm/route";
import { crmSetupActionSchema, suggestCrmClients } from "./crm-setup";
const rpc = vi.fn(), createUser = vi.fn();
const body = { type: "create", crmOrigin: "https://crm.example.invalid", crmAuthUrl: "https://fictional.supabase.co", crmPublicKey: "sb_publishable_fixture", agencyDomain: "example.invalid" };
const request = (input: unknown = body, origin = "https://calendar.example.invalid") => new Request("https://calendar.example.invalid/api/admin/crm", { method: "POST", headers: { origin, "Content-Type": "application/json" }, body: JSON.stringify(input) });
beforeEach(() => {
  vi.stubEnv("APP_URL", "https://calendar.example.invalid");
  vi.mocked(getLiveActor).mockResolvedValue({ id: "owner", role: "owner", email: "owner@example.invalid", name: "Owner" });
  vi.mocked(getSupabaseServerClient).mockResolvedValue({ rpc } as unknown as Awaited<ReturnType<typeof getSupabaseServerClient>>);
  vi.mocked(getSupabaseAdminClient).mockReturnValue({ auth: { admin: { createUser } } } as unknown as ReturnType<typeof getSupabaseAdminClient>);
  rpc.mockResolvedValue({ data: { connections: [], mappings: [] }, error: null });
  createUser.mockResolvedValue({ data: { user: { id: "20000000-0000-4000-8000-000000000010" } }, error: null });
});
afterEach(() => { vi.resetAllMocks(); vi.unstubAllEnvs(); });
describe("owner CRM setup", () => {
  it("requires a live owner before Auth administration or setup reads", async () => {
    vi.mocked(getLiveActor).mockResolvedValue({ id: "viewer", role: "viewer", email: "viewer@example.invalid", name: "Viewer" });
    expect((await GET()).status).toBe(403); expect((await POST(request())).status).toBe(403);
    expect(createUser).not.toHaveBeenCalled(); expect(rpc).not.toHaveBeenCalled();
  });
  it("rejects cross-origin mutation before reading the body or provisioning", async () => {
    expect((await POST(request(body, "https://other.invalid"))).status).toBe(403);
    expect(createUser).not.toHaveBeenCalled();
  });
  it("creates a banned nonmember without invitation and exposes the credential once", async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    const result = await response.json(); expect(result.credential).toMatch(/^ada_crm_v1_/);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(createUser).toHaveBeenCalledWith(expect.objectContaining({ ban_duration: "876000h", app_metadata: { ada_crm_principal: true } }));
    const action = rpc.mock.calls.find(call => call[0] === "manage_crm_connection")?.[1].p_action;
    expect(action.credentialHash).toMatch(/^[a-f0-9]{64}$/); expect(JSON.stringify(action)).not.toContain(result.credential);
    expect(action.enabled).toBeUndefined(); expect(action.principalUserId).toBe("20000000-0000-4000-8000-000000000010");
    expect(JSON.stringify(await (await GET()).json())).not.toContain(result.credential);
  });
  it("refuses private keys and caller-supplied identities", async () => {
    expect((await POST(request({ ...body, crmPublicKey: "sb_secret_private" }))).status).toBe(400);
    expect((await POST(request({ ...body, principalUserId: "somebody" }))).status).toBe(400);
    expect(createUser).not.toHaveBeenCalled();
  });
  it("sanitizes failures without leaking submitted keys or provider errors", async () => {
    createUser.mockResolvedValue({ data: { user: null }, error: { message: "PRIVATE_PROVIDER" } });
    const response = await POST(request());
    expect(response.status).toBe(503); expect(await response.text()).not.toContain("PRIVATE_PROVIDER");
  });
  it("only suggests exact names/aliases and still requires explicit mapping IDs", () => {
    const clients = [{ id: "one", name: "First", aliases: ["CRM Alias"] }, { id: "two", name: "CRM Alias", aliases: [] }];
    expect(suggestCrmClients(" crm  alias ", clients)).toEqual(clients);
    expect(suggestCrmClients("CRM", clients)).toEqual([]);
    expect(crmSetupActionSchema.safeParse({ type: "map", connectionId: "20000000-0000-4000-8000-000000000010", externalClientId: "client", name: "First" }).success).toBe(false);
  });
});
