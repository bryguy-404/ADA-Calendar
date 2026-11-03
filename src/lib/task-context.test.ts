import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { planCommands } from "./scheduler";
import { taskContextRequestSchema } from "./task-context";
import { emptyWorkContext } from "./work-context";
import { booking, fixture, now } from "./mcp/test-fixtures";
import type { TaskContextPatch, WorkCommand } from "./types";

export function contextFixture() {
  const state = fixture();
  state.items[0] = { ...state.items[0], status: "waiting", blockedReason: "Old dependency", timelineMode: undefined,
    forecastDate: "2026-11-06", workContext: { ...emptyWorkContext(), manualOnly: true, progressNote: "Keep this", materialsNote: "Keep source" } };
  state.sessions = [booking("website", "2026-11-04"), booking("website", "2026-10-29"), booking("website", "2026-10-30", "completed"), booking("website", "2026-10-28", "cancelled")]
    .map(session => ({ ...session, protected: true, focusOverrideMinutes: 15 }));
  return state;
}
const command = (patch: TaskContextPatch): WorkCommand => ({ type: "context_update", itemId: "website", patch });
describe("scoped task context scheduler", () => {
  it("changes a waiting reason without touching planned/past/completed/cancelled/protected bookings, effort, dates, status or legacy metadata", () => {
    const state = contextFixture(), before = structuredClone(state);
    const result = planCommands(state, [command({ blockedReason: "Verified live; awaiting policy copy" })], state.actor, { now });
    expect(result.status).toBe("ready");
    expect(result.sessions).toEqual(before.sessions); expect(result.blocks).toEqual(before.blocks);
    expect(result.items).toEqual([{ ...before.items[0], blockedReason: "Verified live; awaiting policy copy", updatedAt: now }]);
    expect(state).toEqual(before);
  });
  it("merges supplied context fields and preserves omissions, manual flags and references", () => {
    const state = contextFixture(); state.items[0].references = ["Original email"];
    const result = planCommands(state, [command({ workContext: { requestedResult: "Prepare a draft", requirementsNote: "Clinical review required" } })], state.actor, { now });
    expect(result.status).toBe("ready");
    expect(result.items[0]).toEqual({ ...state.items[0], updatedAt: now, workContext: { ...state.items[0].workContext, requestedResult: "Prepare a draft", requirementsNote: "Clinical review required" } });
    expect(result.sessions).toEqual(state.sessions);
  });
  it("supports explicit empty strings, empty references and a cleared reason without dropping other fields", () => {
    const state = contextFixture();
    const result = planCommands(state, [command({ references: [], blockedReason: null, workContext: { progressNote: "", materialsNote: "" } })], state.actor, { now });
    expect(result.items[0]).toMatchObject({ references: [], blockedReason: null, status: "waiting", workContext: { manualOnly: true, progressNote: "", materialsNote: "" } });
  });
  it.each(["planned", "completed", "cancelled"] as const)("does not use a reason patch to transition %s work", status => {
    const state = contextFixture(); state.items[0].status = status;
    const result = planCommands(state, [command({ blockedReason: "No transition" })], state.actor, { now });
    expect(result.status).toBe("infeasible"); expect(result.items).toEqual(state.items);
    expect(planCommands(state, [command({ description: "Context only" })], state.actor, { now }).status).toBe("ready");
  });
  it.each(["requester", "viewer"] as const)("rejects %s updates", role => {
    const state = contextFixture();
    expect(planCommands(state, [command({ description: "Denied" })], { ...state.actor, role }, { now }).status).toBe("infeasible");
  });
  it("rejects mixed scheduling and context commands and unknown IDs", () => {
    const state = contextFixture();
    expect(planCommands(state, [command({ description: "A" }), { type: "status", itemId: "website", status: "completed" }], state.actor, { now }).status).toBe("infeasible");
    expect(planCommands(state, [{ ...command({ description: "A" }), itemId: "elsewhere" } as WorkCommand], state.actor, { now }).status).toBe("infeasible");
  });
  it.each([{}, { workContext: {} }, { status: "completed" }, { remainingMinutes: 0 }, { windowStart: "2026-11-04" }, { workContext: { execute: true } }, { workContext: null }, { references: null }])("strictly rejects an invalid patch %j", patch => {
    expect(taskContextRequestSchema.safeParse({ workspaceId: "workspace", workItemId: "website", baseVersion: 1, operationId: randomUUID(), patch }).success).toBe(false);
  });
});
