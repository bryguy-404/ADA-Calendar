import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("./server/supabase", () => ({ getSupabaseAdminClient: vi.fn() }));
vi.mock("./server/crm-repository", () => ({ readCrmSchedule: vi.fn() }));
import { getSupabaseAdminClient } from "./server/supabase";
import { readCrmSchedule } from "./server/crm-repository";
import { submitCrmTask } from "./server/crm-submissions";
import { prepareCrmPreview } from "./server/crm-planning";
import { crmTestContext as context, crmTestPreviewId as previewId, crmTestInput, crmTestState, crmTestNow as now } from "./test-fixtures/crm";
import { crmOperationResultSchema, crmSubmissionSchema } from "./crm-integration";

const operationId = "20000000-0000-4000-8000-000000000006";
const submission = { operationId, previewId, note: "" };
const loaded = () => ({ snapshot: crmTestState(), mapping: { calendarClientId: "calendar-client", revision: 1 } });
export function publicResult() {
  return { apiVersion: "1", operationId, status: "completed", sequence: 1, task: {
    externalTaskId: "crm-task", workItemId: previewId, requestId: null, requestStatus: null, status: "planned", title: "New CRM task",
    client: { id: "calendar-client", name: "Fictional Client" }, estimatedMinutes: 60, remainingMinutes: 60, priorityId: "normal",
    targetDate: "2026-09-15", deadline: null, forecastDate: "2026-09-15", timeZone: "America/Indiana/Indianapolis", version: 1, decisionNote: null,
    sessions: [{ start: "2026-09-15T13:00:00Z", end: "2026-09-15T14:00:00Z", status: "planned" }],
  } };
}
function savedPreview(at = now) {
  const p = prepareCrmPreview(context, loaded(), crmTestInput(), previewId, at);
  return { id: previewId, integration_id: context.connection.id, requester_subject: context.requester.subject, requester_email: context.requester.email,
    external_task_id: p.input.externalTaskId, external_client_id: p.input.externalClientId, calendar_client_id: "calendar-client",
    mapping_revision: p.mappingRevision, base_version: p.response.baseVersion, input: p.input, commands: p.commands,
    review_fingerprint: p.fingerprint, created_at: p.response.createdAt, expires_at: p.response.expiresAt };
}
const rpc = vi.fn(), maybeSingle = vi.fn();
let chain: { select: ReturnType<typeof vi.fn>; eq: ReturnType<typeof vi.fn>; maybeSingle: typeof maybeSingle };
beforeEach(() => {
  vi.stubEnv("ADA_CRM_INTEGRATION_ENABLED", "true"); vi.stubEnv("ADA_CRM_BOOKING_ENABLED", "true");
  chain = { select: vi.fn(() => chain), eq: vi.fn(() => chain), maybeSingle };
  vi.mocked(getSupabaseAdminClient).mockReturnValue({ from: vi.fn(() => chain), rpc } as unknown as ReturnType<typeof getSupabaseAdminClient>);
  vi.mocked(readCrmSchedule).mockResolvedValue(loaded());
  rpc.mockResolvedValue({ data: publicResult(), error: null });
});
afterEach(() => { vi.resetAllMocks(); vi.unstubAllEnvs(); });
function reads(preview = savedPreview()) {
  maybeSingle.mockResolvedValueOnce({ data: null, error: null }).mockResolvedValueOnce({ data: preview, error: null });
}
describe("CRM reviewed submissions", () => {
  it("replans immutable commands with requester authority then commits once using the bound credential and intent", async () => {
    reads();
    expect(await submitCrmTask(context, submission, "booking", now)).toEqual(publicResult());
    expect(rpc).toHaveBeenCalledOnce();
    const [name, args] = rpc.mock.calls[0];
    expect(name).toBe("finalize_crm_submission");
    expect(args.p_proposal.actorId).toBe(context.connection.principalUserId);
    expect(args.p_proposal.operationId).toBe(`crm-${context.connection.id}-${operationId}`);
    expect(args.p_proposal.commands).toEqual(savedPreview().commands);
    expect(args.p_credential_hash).toBe(context.connection.credentialHash);
    expect(args.p_requester_subject).toBe(context.requester.subject);
  });
  it("returns completed retries after expiry without recalculating or making another write", async () => {
    maybeSingle.mockResolvedValue({ data: { requester_subject: context.requester.subject, requester_email: context.requester.email, kind: "booking", input: { previewId, note: "" }, status: "completed", result: publicResult() }, error: null });
    expect(await submitCrmTask(context, submission, "booking", "2026-10-01T12:00:00Z")).toEqual(publicResult());
    expect(readCrmSchedule).not.toHaveBeenCalled(); expect(rpc).not.toHaveBeenCalled();
  });
  it.each(["note", "kind", "requester_subject", "requester_email"])("rejects operation reuse with different %s", async field => {
    const prior = { requester_subject: context.requester.subject, requester_email: context.requester.email, kind: "booking", input: { previewId, note: "" }, status: "completed", result: publicResult() };
    if (field === "note") prior.input.note = "Changed"; else Object.assign(prior, { [field]: "different" });
    maybeSingle.mockResolvedValue({ data: prior, error: null });
    await expect(submitCrmTask(context, submission, "booking", now)).rejects.toMatchObject({ status: 409 });
    expect(rpc).not.toHaveBeenCalled();
  });
  it("denies another verified human's preview", async () => {
    reads({ ...savedPreview(), requester_subject: operationId });
    await expect(submitCrmTask(context, submission, "booking", now)).rejects.toMatchObject({ status: 403 });
    expect(rpc).not.toHaveBeenCalled();
  });
  it.each(["expiry", "version", "mapping", "fingerprint", "clock"])("requires a fresh review after %s changes", async change => {
    const preview = savedPreview(change === "clock" ? "2026-09-15T12:55:00Z" : now);
    if (change === "fingerprint") preview.review_fingerprint = "b".repeat(64);
    if (change === "version") preview.base_version += 1;
    if (change === "mapping") preview.mapping_revision += 1;
    reads(preview);
    await expect(submitCrmTask(context, submission, "booking", change === "expiry" ? "2026-09-15T12:16:00Z" : change === "clock" ? "2026-09-15T13:01:00Z" : now)).rejects.toMatchObject({ status: 409 });
    expect(rpc).not.toHaveBeenCalled();
  });
  it("does not convert a clean fit into an approval request", async () => {
    reads();
    await expect(submitCrmTask(context, submission, "request", now)).rejects.toMatchObject({ code: "crm_clean_fit" });
    expect(rpc).not.toHaveBeenCalled();
  });
  it("does not retry a changed database snapshot behind the user's review", async () => {
    reads(); rpc.mockResolvedValue({ error: { code: "40001", message: "PRIVATE_DATABASE" }, data: null });
    await expect(submitCrmTask(context, submission, "booking", now)).rejects.toMatchObject({ code: "crm_preview_stale" });
    expect(rpc).toHaveBeenCalledOnce();
  });
  it("treats an unreadable saved result as a recovery failure, not invalid user input", async () => {
    reads(); rpc.mockResolvedValue({ data: { secret: "PRIVATE" }, error: null });
    await expect(submitCrmTask(context, submission, "booking", now)).rejects.toMatchObject({ code: "crm_unavailable", status: 503 });
    expect(rpc).toHaveBeenCalledOnce();
  });
  it("fails closed while booking is disabled", async () => {
    vi.stubEnv("ADA_CRM_BOOKING_ENABLED", "false");
    await expect(submitCrmTask(context, submission, "booking", now)).rejects.toMatchObject({ status: 503 });
    expect(getSupabaseAdminClient).not.toHaveBeenCalled();
  });
  it("rejects caller commands and strips private response fields", () => {
    expect(crmSubmissionSchema.safeParse({ ...submission, commands: [] }).success).toBe(false);
    const result = publicResult();
    const safe = crmOperationResultSchema.parse({ ...result, secret: "PRIVATE", task: { ...result.task, description: "PRIVATE", blocks: [{ title: "PRIVATE" }] } });
    expect(JSON.stringify(safe)).not.toContain("PRIVATE");
  });
});
