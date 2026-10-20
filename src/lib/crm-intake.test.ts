import { beforeEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("./server/supabase", () => ({ getSupabaseAdminClient: vi.fn() }));
vi.mock("./server/crm-repository", () => ({ readCrmSchedule: vi.fn() }));
import { getSupabaseAdminClient } from "./server/supabase";
import { readCrmSchedule } from "./server/crm-repository";
import { crmIntakeSchema, receiveCrmIntake } from "./server/crm-intake";
import { crmTestContext as context, crmTestState } from "./test-fixtures/crm";
const input = crmIntakeSchema.parse({ operationId: "20000000-0000-4000-8000-000000000006", externalTaskId: "fixture-intake", externalClientId: "crm-client", title: "Fictional assignment", due: null, requesterSubject: context.requester.subject, requesterEmail: context.requester.email });
const result = { apiVersion: "1", operationId: input.operationId, status: "completed", sequence: 1, task: {
  externalTaskId: input.externalTaskId, workItemId: `crm-intake-${input.operationId}`, requestId: null, requestStatus: null, status: "waiting", title: input.title,
  client: { id: "calendar-client", name: "Fictional Client" }, estimatedMinutes: null, remainingMinutes: null, priorityId: "normal", targetDate: null,
  deadline: null, forecastDate: null, timeZone: "America/Indiana/Indianapolis", version: 1, decisionNote: null, sessions: [],
} };
const rpc = vi.fn(), maybeSingle = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  const chain = { select: vi.fn(() => chain), eq: vi.fn(() => chain), maybeSingle };
  vi.mocked(getSupabaseAdminClient).mockReturnValue({ from: () => chain, rpc } as unknown as ReturnType<typeof getSupabaseAdminClient>);
  maybeSingle.mockResolvedValue({ data: null, error: null }); rpc.mockResolvedValue({ data: result, error: null });
  vi.mocked(readCrmSchedule).mockResolvedValue({ snapshot: crmTestState(), mapping: { calendarClientId: "calendar-client", revision: 1 } });
});
it("receives work without effort, dates or a booking and preserves all capacity", async () => {
  expect(await receiveCrmIntake(context.connection, input)).toEqual(result);
  const proposal = rpc.mock.calls[0][1].p_proposal;
  expect(proposal.items).toHaveLength(1);
  expect(proposal.items[0]).toMatchObject({ status: "waiting", estimatedMinutes: null, remainingMinutes: null, deadline: null });
  expect(proposal.sessions).toEqual([]); expect(proposal.blocks).toEqual([]);
  expect(proposal.requiresApproval).toBe(false);
});
it("replays a saved operation without recreating work and rejects changed intent", async () => {
  maybeSingle.mockResolvedValue({ data: { input, result }, error: null });
  expect(await receiveCrmIntake(context.connection, input)).toEqual(result);
  expect(rpc).not.toHaveBeenCalled(); expect(readCrmSchedule).not.toHaveBeenCalled();
  await expect(receiveCrmIntake(context.connection, { ...input, title: "Changed" })).rejects.toMatchObject({ status: 409 });
});
it("unknown companies require mapping and outside requester domains are rejected", async () => {
  vi.mocked(readCrmSchedule).mockResolvedValue({ snapshot: crmTestState(), mapping: null });
  await expect(receiveCrmIntake(context.connection, input)).rejects.toMatchObject({ code: "crm_client_unmapped" });
  await expect(receiveCrmIntake(context.connection, { ...input, requesterEmail: "outside@example.com" })).rejects.toMatchObject({ status: 403 });
  expect(rpc).not.toHaveBeenCalled();
});
it("rejects scheduling commands, roles, overrides and company data at intake", () => {
  for (const field of ["sessions", "commands", "role", "overrideProtected", "company", "estimatedMinutes"])
    expect(crmIntakeSchema.safeParse({ ...input, [field]: "unauthorized" }).success).toBe(false);
});
