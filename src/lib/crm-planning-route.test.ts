import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("./server/crm-auth", async original => ({ ...await original<typeof import("./server/crm-auth")>(), authenticateCrmRequest: vi.fn() }));
vi.mock("./server/crm-repository", () => ({ readCrmSchedule: vi.fn(), saveCrmPreview: vi.fn() }));
import { authenticateCrmRequest, CrmApiError } from "./server/crm-auth";
import { readCrmSchedule, saveCrmPreview } from "./server/crm-repository";
import { readCrmJson } from "./server/crm-http";
import { GET } from "../app/api/integrations/crm/v1/availability/route";
import { POST } from "../app/api/integrations/crm/v1/previews/route";
import { crmTestNow, crmTestDay, crmTestContext, crmTestState, crmTestInput } from "./test-fixtures/crm";

const root = "https://calendar.example.invalid/api/integrations/crm/v1/";
const send = (body: unknown = crmTestInput()) => POST(new Request(root + "previews", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(crmTestNow));
  vi.mocked(authenticateCrmRequest).mockResolvedValue(crmTestContext);
  vi.mocked(readCrmSchedule).mockResolvedValue({ snapshot: crmTestState(), mapping: { calendarClientId: "calendar-client", revision: 1 } });
  vi.mocked(saveCrmPreview).mockResolvedValue();
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("No network in route tests"); }));
});
afterEach(() => { vi.resetAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("CRM availability and previews HTTP boundary", () => {
  it("returns public availability without recording anything", async () => {
    const response = await GET(new Request(root + "availability?startDate=" + crmTestDay + "&endDate=" + crmTestDay));
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("private, no-store");
    const body = await response.json(); expect(body.days[0].availableMinutes).toBe(450);
    expect(body.bookingEnabled).toBe(false); expect(JSON.stringify(body)).not.toContain("PRIVATE");
    expect(saveCrmPreview).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
  it("checks identity before parsing a request or reading any workload", async () => {
    vi.mocked(authenticateCrmRequest).mockRejectedValue(new CrmApiError("crm_unauthorized", "Invalid connection.", 401));
    expect((await send({ role: "owner" })).status).toBe(401);
    expect((await GET(new Request(root + "availability"))).status).toBe(401);
    expect(readCrmSchedule).not.toHaveBeenCalled(); expect(saveCrmPreview).not.toHaveBeenCalled();
  });
  it("rejects invalid or excessive date ranges and unknown query options", async () => {
    for (const query of ["startDate=bad&endDate=2026-09-15", "startDate=2026-02-30&endDate=2026-03-01", "startDate=2026-09-15&endDate=2027-01-01", "startDate=2026-09-15&endDate=2026-09-15&role=owner"])
      expect((await GET(new Request(root + "availability?" + query))).status).toBe(400);
    expect(readCrmSchedule).not.toHaveBeenCalled();
  });
  it("saves the private preview before returning only its public review", async () => {
    const response = await send(), body = await response.json();
    expect(response.status).toBe(200); expect(body.status).toBe("fits");
    expect(body.bookingEnabled).toBe(false); expect(body).not.toHaveProperty("commands");
    expect(JSON.stringify(body)).not.toContain("PRIVATE");
    expect(saveCrmPreview).toHaveBeenCalledWith(crmTestContext, expect.objectContaining({
      input: crmTestInput(), mappingRevision: 1,
      response: expect.objectContaining({ previewId: body.previewId, expiresAt: "2026-09-15T12:15:00Z" }),
      commands: [expect.objectContaining({ item: expect.objectContaining({ requesterId: crmTestContext.connection.principalUserId, priorityId: "normal", description: "PRIVATE_DESCRIPTION" }) })],
    }));
    expect(response.headers.has("set-cookie")).toBe(false);
    expect(response.headers.has("access-control-allow-origin")).toBe(false);
  });
  it("rejects missing estimates, caller identity and unmapped clients", async () => {
    for (const input of [{ ...crmTestInput(), estimatedMinutes: null }, { ...crmTestInput(), actorId: "owner" }, { ...crmTestInput(), overrideProtected: true }])
      expect((await send(input)).status).toBe(400);
    expect(readCrmSchedule).not.toHaveBeenCalled();
    vi.mocked(readCrmSchedule).mockResolvedValue({ snapshot: crmTestState(), mapping: null });
    expect((await send()).status).toBe(422); expect(saveCrmPreview).not.toHaveBeenCalled();
  });
  it("returns stale preview errors without automatically regenerating or retrying", async () => {
    vi.mocked(saveCrmPreview).mockRejectedValue(new CrmApiError("crm_preview_stale", "Request a fresh preview.", 409));
    expect((await send()).status).toBe(409);
    expect(readCrmSchedule).toHaveBeenCalledOnce(); expect(saveCrmPreview).toHaveBeenCalledOnce();
  });
  it("sanitizes malformed JSON and internal failures", async () => {
    const malformed = await POST(new Request(root + "previews", { method: "POST", headers: { "content-type": "application/json" }, body: "SECRET_BAD_JSON" }));
    expect(malformed.status).toBe(400); expect(await malformed.text()).not.toContain("SECRET");
    vi.mocked(readCrmSchedule).mockRejectedValue(new Error("SECRET_DATABASE_DETAIL"));
    const failure = await send(); expect(failure.status).toBe(503); expect(await failure.text()).not.toContain("SECRET");
  });
  it("bounds the body with and without an honest Content-Length", async () => {
    for (const length of ["262145", "1"]) {
      const response = await POST(new Request(root + "previews", { method: "POST", headers: { "content-type": "application/json", "content-length": length }, body: "a".repeat(262145) }));
      expect(response.status).toBe(413);
    }
    expect((await POST(new Request(root + "previews", { method: "POST", body: "{}" }))).status).toBe(415);
    expect(readCrmSchedule).not.toHaveBeenCalled();
  });
  it("cancels a stalled upload instead of waiting indefinitely", async () => {
    vi.useFakeTimers(); const cancel = vi.fn();
    const body = new ReadableStream({ cancel });
    const promise = readCrmJson(new Request(root + "previews", { method: "POST", headers: { "content-type": "application/json" }, body, duplex: "half" } as RequestInit));
    const assertion = expect(promise).rejects.toMatchObject({ status: 408 });
    await vi.advanceTimersByTimeAsync(8000); await assertion; expect(cancel).toHaveBeenCalledOnce();
  });
});
