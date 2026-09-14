import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("./server/crm-auth", async original => ({ ...await original<typeof import("./server/crm-auth")>(), authenticateCrmRequest: vi.fn() }));
import { authenticateCrmRequest, CrmApiError } from "./server/crm-auth";
import { GET } from "../app/api/integrations/crm/v1/status/route";

afterEach(() => vi.resetAllMocks());
describe("CRM foundation handshake", () => {
  it("confirms authentication without exposing workload, identity or credentials or enabling bookings", async () => {
    vi.mocked(authenticateCrmRequest).mockResolvedValue({ connection: { credentialHash: "private", workspaceId: "private" }, requester: { email: "private" } } as Awaited<ReturnType<typeof authenticateCrmRequest>>);
    const response = await GET(new Request("https://calendar.example.invalid/api/integrations/crm/v1/status"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ apiVersion: "1", status: "authenticated", bookingEnabled: false, capabilities: ["connection_check", "availability", "previews"] });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.has("access-control-allow-origin")).toBe(false);
    expect(response.headers.has("set-cookie")).toBe(false);
  });
  it("returns sanitized errors and a retry interval for rate limits", async () => {
    vi.mocked(authenticateCrmRequest).mockRejectedValueOnce(new CrmApiError("crm_rate_limited", "Try again shortly.", 429));
    const limited = await GET(new Request("https://calendar.example.invalid/api/integrations/crm/v1/status"));
    expect(limited.status).toBe(429); expect(limited.headers.get("retry-after")).toBe("60");
    vi.mocked(authenticateCrmRequest).mockRejectedValueOnce(new Error("secret database details"));
    const failed = await GET(new Request("https://calendar.example.invalid/api/integrations/crm/v1/status"));
    expect(failed.status).toBe(503); expect(await failed.text()).not.toContain("secret");
    expect(failed.headers.get("cache-control")).toBe("private, no-store");
  });
});
