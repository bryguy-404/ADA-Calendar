import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("./server/supabase", () => ({ getSupabaseAdminClient: vi.fn() }));
vi.mock("./server/crm-auth", async original => ({ ...await original<typeof import("./server/crm-auth")>(), authenticateCrmRequest: vi.fn(), authenticateCrmService: vi.fn() }));
vi.mock("./server/crm-submissions", async original => ({ ...await original<typeof import("./server/crm-submissions")>(), submitCrmTask: vi.fn() }));
import { getSupabaseAdminClient } from "./server/supabase";
import { authenticateCrmRequest, authenticateCrmService, CrmApiError } from "./server/crm-auth";
import { submitCrmTask } from "./server/crm-submissions";
import { POST as book } from "../app/api/integrations/crm/v1/bookings/route";
import { POST as ask } from "../app/api/integrations/crm/v1/requests/route";
import { POST as reply } from "../app/api/integrations/crm/v1/replies/route";
import { GET as operation } from "../app/api/integrations/crm/v1/operations/[operationId]/route";
import { GET as changes } from "../app/api/integrations/crm/v1/changes/route";
import { POST as settle } from "../app/api/integrations/crm/v1/operations/[operationId]/settle/route";
import { POST as maintenance } from "../app/api/integrations/crm/v1/maintenance/route";
import { crmTestContext as context, crmTestPreviewId as previewId } from "./test-fixtures/crm";
const root = "https://calendar.example.invalid/api/integrations/crm/v1/", operationId = "20000000-0000-4000-8000-000000000006";
const rpc = vi.fn(), maybeSingle = vi.fn(), limit = vi.fn();
let chain: { select: ReturnType<typeof vi.fn>; eq: ReturnType<typeof vi.fn>; gt: ReturnType<typeof vi.fn>; order: ReturnType<typeof vi.fn>; limit: typeof limit; maybeSingle: typeof maybeSingle };
const task = { externalTaskId: "task", workItemId: previewId, requestId: null, requestStatus: null, status: "planned", title: "Task", client: { id: "client", name: "Client" }, estimatedMinutes: 60, remainingMinutes: 60, priorityId: "normal", targetDate: null, deadline: null, forecastDate: null, timeZone: "America/Indiana/Indianapolis", version: 1, decisionNote: null, sessions: [] };
const result = { apiVersion: "1" as const, operationId, status: "completed" as const, task, sequence: 1 };
const post = (path: string, body: unknown) => new Request(root + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
beforeEach(() => {
  vi.stubEnv("ADA_CRM_INTEGRATION_ENABLED", "true"); vi.stubEnv("ADA_CRM_BOOKING_ENABLED", "true");
  vi.mocked(authenticateCrmRequest).mockResolvedValue(context); vi.mocked(authenticateCrmService).mockResolvedValue(context.connection);
  chain = { select: vi.fn(() => chain), eq: vi.fn(() => chain), gt: vi.fn(() => chain), order: vi.fn(() => chain), limit, maybeSingle };
  vi.mocked(getSupabaseAdminClient).mockReturnValue({ from: vi.fn(() => chain), rpc } as unknown as ReturnType<typeof getSupabaseAdminClient>);
});
afterEach(() => { vi.resetAllMocks(); vi.unstubAllEnvs(); });
describe("CRM transaction and recovery HTTP boundary", () => {
  it("settles uncertain operations using only service authority and strips stored private fields", async () => {
    rpc.mockResolvedValue({ data: { ...result, privateSnapshot: "SECRET" }, error: null });
    const response = await settle(post("settle", {}), { params: Promise.resolve({ operationId }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(result);
    expect(rpc).toHaveBeenCalledWith("settle_crm_operation", { p_integration_id: context.connection.id, p_credential_hash: context.connection.credentialHash, p_operation_id: operationId });
    expect(authenticateCrmRequest).not.toHaveBeenCalled();
    rpc.mockResolvedValue({ data: { apiVersion: "1", operationId, status: "rejected" }, error: null });
    vi.stubEnv("ADA_CRM_BOOKING_ENABLED", "false");
    expect((await settle(post("settle", {}), { params: Promise.resolve({ operationId }) })).status).toBe(200);
    expect((await settle(post("settle", { cancelWork: true }), { params: Promise.resolve({ operationId }) })).status).toBe(400);
    vi.mocked(authenticateCrmService).mockRejectedValue(new CrmApiError("denied", "Denied", 401));
    rpc.mockClear();
    expect((await settle(post("settle", {}), { params: Promise.resolve({ operationId }) })).status).toBe(401);
    expect(rpc).not.toHaveBeenCalled();
  });
  it("reports a closed operation as rejected even when it never reached preparation", async () => {
    maybeSingle.mockResolvedValueOnce({ data: null, error: null }).mockResolvedValueOnce({ data: { operation_id: operationId }, error: null });
    const response = await operation(new Request(root + "operations/" + operationId), { params: Promise.resolve({ operationId }) });
    expect(await response.json()).toEqual({ apiVersion: "1", operationId, status: "rejected" });
  });
  it("bounds maintenance output and does not accept caller cleanup criteria", async () => {
    rpc.mockResolvedValue({ data: 500, error: null });
    expect(await (await maintenance(post("maintenance", {}))).json()).toEqual({ apiVersion: "1", removed: 500 });
    expect((await maintenance(post("maintenance", { before: "2099-01-01" }))).status).toBe(400);
    rpc.mockResolvedValue({ data: 501, error: null });
    expect((await maintenance(post("maintenance", {}))).status).toBe(503);
  });
  it.each([["bookings", book, "booking"], ["requests", ask, "request"]] as const)("%s accepts only a reviewed intent and authenticates first", async (path, handler, kind) => {
    vi.mocked(submitCrmTask).mockResolvedValue(result as Awaited<ReturnType<typeof submitCrmTask>>);
    const response = await handler(post(path, { operationId, previewId }));
    expect(response.status).toBe(200);
    expect(submitCrmTask).toHaveBeenCalledWith(context, { operationId, previewId, note: "" }, kind);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect((await handler(post(path, { operationId, previewId, overrideProtected: true }))).status).toBe(400);
    vi.mocked(submitCrmTask).mockClear();
    vi.mocked(authenticateCrmRequest).mockRejectedValue(new CrmApiError("denied", "Denied", 401));
    expect((await handler(post(path, { invalid: true }))).status).toBe(401); expect(submitCrmTask).not.toHaveBeenCalled();
  });
  it("replies bind the verified human and cannot carry schedule edits", async () => {
    rpc.mockResolvedValue({ data: result, error: null });
    const input = { operationId, externalTaskId: "task", message: "Use the next opening." };
    expect((await reply(post("replies", input))).status).toBe(200);
    expect(rpc).toHaveBeenCalledWith("reply_crm_request", expect.objectContaining({ p_requester_subject: context.requester.subject, p_requester_email: context.requester.email, p_credential_hash: context.connection.credentialHash, p_message: input.message }));
    expect((await reply(post("replies", { ...input, commands: [] }))).status).toBe(400);
    vi.stubEnv("ADA_CRM_BOOKING_ENABLED", "false"); expect((await reply(post("replies", input))).status).toBe(503);
  });
  it("worker recovery needs no saved human token and never returns raw operation input", async () => {
    maybeSingle.mockResolvedValue({ data: { status: "completed", result: { ...result, input: "PRIVATE", task: { ...task, description: "PRIVATE" } } }, error: null });
    const response = await operation(new Request(root + "operations/" + operationId), { params: Promise.resolve({ operationId }) });
    expect(response.status).toBe(200); expect(await response.json()).toEqual(result);
    expect(authenticateCrmService).toHaveBeenCalledOnce(); expect(authenticateCrmRequest).not.toHaveBeenCalled();
    expect(chain.eq).toHaveBeenCalledWith("integration_id", context.connection.id);
    expect(chain.eq).toHaveBeenCalledWith("operation_id", operationId);
  });
  it("unknown operations report not_found, and recovery still works with new bookings disabled", async () => {
    vi.stubEnv("ADA_CRM_BOOKING_ENABLED", "false"); maybeSingle.mockResolvedValue({ data: null, error: null });
    expect(await (await operation(new Request(root + "operations/" + operationId), { params: Promise.resolve({ operationId }) })).json()).toEqual({ apiVersion: "1", operationId, status: "not_found" });
  });
  it("ordered changes filter private data and advance only through returned rows", async () => {
    limit.mockResolvedValue({ data: [1, 2, 3].map(sequence => ({ sequence, kind: "schedule_updated", body: { ...task, description: "PRIVATE" } })), error: null });
    const response = await changes(new Request(root + "changes?after=0&limit=2"));
    const data = await response.json(); expect(data.nextCursor).toBe(2); expect(data.hasMore).toBe(true); expect(data.changes).toHaveLength(2);
    expect(JSON.stringify(data)).not.toContain("PRIVATE"); expect(chain.eq).toHaveBeenCalledWith("integration_id", context.connection.id);
    expect(chain.order).toHaveBeenCalledWith("sequence"); expect(limit).toHaveBeenCalledWith(3);
    limit.mockResolvedValue({ data: [], error: null });
    expect((await (await changes(new Request(root + "changes?after=2"))).json()).nextCursor).toBe(2);
  });
  it("denies revoked connections and invalid cursors before feed reads", async () => {
    expect((await changes(new Request(root + "changes?after=-1"))).status).toBe(400);
    expect((await changes(new Request(root + "changes?limit=101"))).status).toBe(400);
    vi.mocked(authenticateCrmService).mockRejectedValue(new CrmApiError("disabled", "Disabled", 401));
    expect((await changes(new Request(root + "changes"))).status).toBe(401); expect(getSupabaseAdminClient).not.toHaveBeenCalled();
  });
});
