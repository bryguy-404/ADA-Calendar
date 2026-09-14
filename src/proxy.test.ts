import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({ create: vi.fn(), claims: vi.fn() }));
vi.mock("@supabase/ssr", () => ({ createServerClient: mocks.create }));
import { proxy } from "./proxy";

describe("Supabase session proxy", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("ADA_DEMO_MODE", "false");
    vi.stubEnv("APP_URL", "https://ada.example.test");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://supabase.example.test");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "fixture-key");
    mocks.create.mockReset(); mocks.claims.mockReset();
    mocks.claims.mockResolvedValue({ data: null, error: null });
    mocks.create.mockReturnValue({ auth: { getClaims: mocks.claims } });
  });
  afterEach(() => vi.unstubAllEnvs());
  it("skips demo and unconfigured live mode without provider calls", async () => {
    vi.stubEnv("ADA_DEMO_MODE", "true");
    await proxy(new NextRequest("https://ada.example.test/"));
    vi.stubEnv("ADA_DEMO_MODE", "false");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    await proxy(new NextRequest("https://ada.example.test/"));
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("does not permit production demo bypass", async () => {
    vi.stubEnv("NODE_ENV", "production"); vi.stubEnv("ADA_DEMO_MODE", "true");
    await proxy(new NextRequest("https://ada.example.test/"));
    expect(mocks.claims).toHaveBeenCalledOnce();
  });
  it("passes refreshed cookies downstream and back to the same-origin browser", async () => {
    mocks.create.mockImplementation((_url, _key, options) => ({ auth: { getClaims: async () => {
      options.cookies.setAll([{ name: "sb-fixture-auth-token", value: "refreshed-fixture", options: { domain: "other.example.test", path: "/old", sameSite: "none" } }]);
    } } }));
    const request = new NextRequest("https://ada.example.test/", { headers: { origin: "https://ada.example.test" } });
    const response = await proxy(request);
    expect(request.cookies.get("sb-fixture-auth-token")?.value).toBe("refreshed-fixture");
    expect(response.cookies.get("sb-fixture-auth-token")).toMatchObject({ value: "refreshed-fixture", path: "/", sameSite: "lax", secure: true, httpOnly: true });
    expect(response.cookies.get("sb-fixture-auth-token")?.domain).toBeUndefined();
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
  it("does not rotate auth cookies for cross-origin requests or provider webhooks", async () => {
    await proxy(new NextRequest("https://ada.example.test/api/state", { headers: { origin: "https://other.example.test" } }));
    await proxy(new NextRequest("https://ada.example.test/api/email/webhook", { method: "POST" }));
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("leaves CRM machine authentication to its route without reading Calendar cookies", async () => {
    await proxy(new NextRequest("https://ada.example.test/api/integrations/crm/v1/status", { headers: { cookie: "sb-fixture-auth-token=fixture" } }));
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
