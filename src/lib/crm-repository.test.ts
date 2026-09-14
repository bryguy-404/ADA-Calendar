import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const rpc = vi.hoisted(() => vi.fn());
vi.mock("./server/supabase", () => ({ getSupabaseAdminClient: () => ({ rpc }) }));
import { readCrmSchedule, saveCrmPreview } from "./server/crm-repository";
import { prepareCrmPreview } from "./server/crm-planning";
import { crmTestNow, crmTestContext, crmTestPreviewId, crmTestInput, crmTestState } from "./test-fixtures/crm";

beforeEach(() => { vi.stubGlobal("fetch", vi.fn(() => { throw new Error("No network in repository tests"); })); });
afterEach(() => { rpc.mockReset(); vi.unstubAllGlobals(); });
describe("private CRM snapshot and preview persistence", () => {
  it("reads a single coherent context including more than 1,000 historical sessions", async () => {
    const snapshot = crmTestState();
    snapshot.sessions = Array.from({ length: 1001 }, (_, i) => ({ id: "history-" + i, workItemId: "historical", start: "2026-01-05T14:00:00Z", end: "2026-01-05T14:15:00Z", status: "completed", protected: false, usesReserve: false }));
    rpc.mockResolvedValue({ data: { snapshot, mapping: { calendarClientId: "calendar-client", revision: 7 } }, error: null });
    const result = await readCrmSchedule(crmTestContext, "crm-client");
    expect(result.snapshot.sessions).toHaveLength(1001); expect(result.mapping?.revision).toBe(7);
    expect(rpc).toHaveBeenCalledExactlyOnceWith("read_crm_schedule_context", { p_integration_id: crmTestContext.connection.id, p_external_client_id: "crm-client" });
    expect(result.snapshot).not.toHaveProperty("emailDrafts");
  });
  it("rejects revoked connections, cross-workspace results and malformed data without details", async () => {
    rpc.mockResolvedValueOnce({ data: null, error: null });
    await expect(readCrmSchedule(crmTestContext)).rejects.toMatchObject({ status: 401 });
    for (const data of [{ snapshot: { ...crmTestState(), workspaceId: "20000000-0000-4000-8000-000000000099" }, mapping: null }, { private: "invalid" }]) {
      rpc.mockResolvedValue({ data, error: null });
      await expect(readCrmSchedule(crmTestContext)).rejects.toMatchObject({ status: 503 });
    }
  });
  it("persists the bound identity, commands, mapping revision, clock and fingerprint", async () => {
    const preview = prepareCrmPreview(crmTestContext, { snapshot: crmTestState(), mapping: { calendarClientId: "calendar-client", revision: 2 } }, crmTestInput(), crmTestPreviewId, crmTestNow);
    rpc.mockResolvedValue({ error: null }); await saveCrmPreview(crmTestContext, preview);
    expect(rpc).toHaveBeenCalledExactlyOnceWith("create_crm_preview", {
      p_integration_id: crmTestContext.connection.id, p_preview_id: crmTestPreviewId,
      p_requester_subject: crmTestContext.requester.subject, p_requester_email: crmTestContext.requester.email,
      p_base_version: 0, p_mapping_revision: 2, p_input: preview.input, p_commands: preview.commands,
      p_fingerprint: preview.fingerprint, p_created_at: crmTestNow,
    });
    rpc.mockResolvedValueOnce({ error: { code: "40001", message: "private details" } });
    await expect(saveCrmPreview(crmTestContext, preview)).rejects.toMatchObject({ status: 409 });
    rpc.mockResolvedValueOnce({ error: { code: "42501", message: "private details" } });
    await expect(saveCrmPreview(crmTestContext, preview)).rejects.toMatchObject({ status: 401 });
  });
});
