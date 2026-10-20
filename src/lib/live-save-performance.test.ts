import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDemoState } from "./fixtures";
import { planCommands } from "./scheduler";
import { activitySummary, hasEventSnapshots } from "./work-activity";
import { withReviewFingerprint } from "./server/preview";
import type { AppState, ScheduleProposal, WorkEvent } from "./types";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), server: vi.fn(), admin: vi.fn(), rpc: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("./server/auth", () => ({ assertLiveActor: mocks.auth, requireOwner: (actor: { role: string }) => {
  if (actor.role !== "owner") throw new Error("Only owner");
} }));
vi.mock("./server/supabase", () => ({ getSupabaseServerClient: mocks.server, getSupabaseAdminClient: mocks.admin }));
import { commitLiveProposal, getLiveState, undoLiveEvent } from "./server/live-store";

const now = "2026-10-20T12:00:00.000Z";
type Query = { table: string; fields: string; limit?: number; filters: Record<string, unknown> };
let state: AppState, ledger: WorkEvent[], queries: Query[], commitFailure: boolean;
const snapshot = () => {
  const { workspaceId, version, settings, clients, priorities, items, sessions, blocks } = state;
  return structuredClone({ workspaceId, version, settings, clients, priorities, items, sessions, blocks });
};

beforeEach(() => {
  vi.resetAllMocks();
  state = createDemoState(now);
  // Historical sessions stay present even after many later saves.
  state.sessions[0].status = "completed";
  state.version = 200;
  const saved = snapshot();
  ledger = Array.from({ length: 200 }, (_, index) => ({
    id: `event-${200 - index}`, operationId: `operation-${200 - index}`, actorId: state.actor.id,
    actorName: state.actor.name, type: "schedule_changed", version: 200 - index,
    summary: ["Fictional saved change"], itemIds: [state.items[0].id], createdAt: now, undoneBy: null,
    before: saved, after: saved,
  }));
  state.events = ledger;
  queries = []; commitFailure = false;
  mocks.auth.mockResolvedValue(state.actor);
  mocks.rpc.mockImplementation(async (name: string, args?: { p_proposal: ScheduleProposal; p_event: WorkEvent }) => {
    if (name === "read_schedule_snapshot") return { data: snapshot(), error: null };
    if (name === "commit_schedule") {
      if (commitFailure) return { data: null, error: { message: "Schedule changed" } };
      const { p_proposal: proposal, p_event: event } = args!;
      state = { ...state, items: proposal.items, sessions: proposal.sessions, blocks: proposal.blocks, version: state.version + 1 };
      ledger.unshift(event);
      return { data: state.version, error: null };
    }
    throw new Error(`Unexpected RPC ${name}`);
  });
  mocks.server.mockResolvedValue({
    rpc: mocks.rpc,
    from: (table: string) => {
      const query: Query = { table, fields: "", filters: {} }; queries.push(query);
      const read = () => {
        if (table === "workspace_members") return { data: query.fields === "workspace_id" ? { workspace_id: state.workspaceId } : [], error: null };
        if (table !== "work_events") return { data: [], error: null };
        if (query.filters.operation_id) return { data: null, error: null };
        if (query.fields === "body,operation_payload") {
          // A broad history-body read is a regression, even if callers strip it later.
          if (query.limit !== 1 && !query.filters.id) throw new Error("Unbounded history snapshots");
          const event = query.filters.id ? ledger.find(event => event.id === query.filters.id) : ledger[0];
          return { data: event ? { body: structuredClone(event), operation_payload: [] } : null, error: null };
        }
        return { data: ledger.slice(0, query.limit).map(activitySummary), error: null };
      };
      const builder = {
        select: (fields: string) => { query.fields = fields; return builder; },
        eq: (field: string, value: unknown) => { query.filters[field] = value; return builder; },
        is: () => builder, gte: () => builder, order: () => builder,
        limit: (limit: number) => { query.limit = limit; return builder; },
        single: async () => read(), maybeSingle: async () => read(),
        then: (resolve: (value: ReturnType<typeof read>) => unknown) => Promise.resolve(read()).then(resolve),
      };
      return builder;
    },
  });
});

describe("bounded live reads and server-state reuse", () => {
  it("fetches summaries in SQL, preserves completed sessions, and reads only one full event", async () => {
    const original = JSON.stringify(ledger);
    const loaded = await getLiveState(state.actor.id);
    expect(loaded.events).toHaveLength(200);
    expect(loaded.events.filter(hasEventSnapshots)).toHaveLength(1);
    expect(loaded.sessions).toEqual(state.sessions);
    expect(loaded.events.map(activitySummary)).toEqual(ledger.map(activitySummary));
    expect(queries.find(q => q.fields.includes("summary:"))?.fields).toContain("summary:body->summary");
    expect(queries.filter(q => q.fields === "body,operation_payload")).toEqual([
      expect.objectContaining({ limit: 1, filters: { workspace_id: state.workspaceId } }),
    ]);
    expect(JSON.stringify(ledger)).toBe(original);
    expect(mocks.admin).not.toHaveBeenCalled();
  });

  it("reuses the route's state, rechecks identity, and reloads once after committing", async () => {
    const loaded = await getLiveState(state.actor.id), historical = structuredClone(state.sessions.filter(s => s.status === "completed"));
    const proposal = withReviewFingerprint(planCommands(loaded, [{ type: "update", itemId: loaded.items[0].id, patch: { description: "Revised fictional details" } }], loaded.actor, { now }));
    expect(proposal.status, JSON.stringify(proposal.conflicts)).toBe("ready");
    mocks.rpc.mockClear(); mocks.auth.mockClear();
    const result = await commitLiveProposal(loaded.actor, proposal, loaded);
    expect(mocks.rpc.mock.calls.map(call => call[0])).toEqual(["commit_schedule", "read_schedule_snapshot"]);
    expect(mocks.auth).toHaveBeenCalledWith(loaded.actor);
    expect(result.sessions.filter(s => s.status === "completed")).toEqual(historical);
    expect(result.items[0].description).toBe("Revised fictional details");
  });

  it("still denies revoked accounts, mismatched identities, and a concurrent SQL version change", async () => {
    const loaded = await getLiveState(state.actor.id);
    const proposal = withReviewFingerprint(planCommands(loaded, [{ type: "update", itemId: loaded.items[0].id, patch: { description: "Details" } }], loaded.actor, { now }));
    mocks.rpc.mockClear();
    mocks.auth.mockRejectedValueOnce(new Error("Membership revoked"));
    await expect(commitLiveProposal(loaded.actor, proposal, loaded)).rejects.toThrow("revoked");
    await expect(commitLiveProposal(loaded.actor, proposal, { ...loaded, actor: { ...loaded.actor, id: "other" } })).rejects.toThrow("does not match");
    expect(mocks.rpc).not.toHaveBeenCalled();
    const before = snapshot();
    commitFailure = true;
    await expect(commitLiveProposal(loaded.actor, proposal, loaded)).rejects.toThrow("Schedule changed");
    expect(snapshot()).toEqual(before);
  });

  it("loads the exact authoritative Undo event separately from activity summaries", async () => {
    const loaded = await getLiveState(state.actor.id), before = snapshot();
    const proposal = withReviewFingerprint(planCommands(loaded, [{ type: "update", itemId: loaded.items[0].id, patch: { description: "Undo this edit" } }], loaded.actor, { now }));
    const saved = await commitLiveProposal(loaded.actor, proposal, loaded);
    queries = [];
    const restored = await undoLiveEvent(loaded.actor, saved.events[0].id);
    expect(restored.items).toEqual(before.items);
    expect(restored.sessions).toEqual(before.sessions);
    expect(queries).toContainEqual(expect.objectContaining({
      table: "work_events", fields: "body,operation_payload", filters: { workspace_id: state.workspaceId, id: saved.events[0].id },
    }));
  });
});
