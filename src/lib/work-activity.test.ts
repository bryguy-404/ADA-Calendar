import { describe, expect, it } from "vitest";
import { createDemoState } from "./fixtures";
import { planCommands } from "./scheduler";
import { activitySummary, compactActivity, hasEventSnapshots } from "./work-activity";
import { undoUnavailableReason } from "./undo";
import type { WorkEvent } from "./types";

const now = "2026-10-20T12:00:00.000Z";
function history(count = 200) {
  const state = createDemoState(now);
  const snapshot = { items: state.items, sessions: state.sessions, blocks: state.blocks };
  const events: WorkEvent[] = Array.from({ length: count }, (_, index) => ({
    id: `event-${index}`, operationId: `operation-${index}`, actorId: state.actor.id, actorName: state.actor.name,
    type: "schedule_changed", version: count - index, summary: ["Fictional saved work"], itemIds: [state.items[0].id],
    createdAt: now, undoneBy: null, before: snapshot, after: snapshot,
  }));
  return { state: { ...state, version: count }, events };
}

describe("compact activity with retained authoritative history", () => {
  it("keeps every activity entry and one exact Undo snapshot without modifying the ledger", () => {
    const { state, events } = history();
    const original = JSON.stringify(events);
    const compact = compactActivity(events);
    expect(compact).toHaveLength(200);
    expect(compact.filter(hasEventSnapshots)).toEqual([events[0]]);
    expect(compact.map(activitySummary)).toEqual(events.map(activitySummary));
    expect(JSON.stringify(compact).length).toBeLessThan(original.length / 50);
    expect(JSON.stringify(events)).toBe(original);
    expect(undoUnavailableReason({ ...state, events: compact }, compact[0], now)).toBeNull();
    expect(undoUnavailableReason({ ...state, events: compact }, compact[1], now)).toContain("latest unchanged");
  });

  it("chooses the highest version, and safely handles absent or raced Undo snapshots", () => {
    const { state, events } = history(3);
    expect(compactActivity([...events].reverse()).filter(hasEventSnapshots)).toEqual([events[0]]);
    expect(compactActivity([])).toEqual([]);
    const summaries = events.map(activitySummary);
    expect(undoUnavailableReason({ ...state, events: summaries }, summaries[0], now)).toContain("Refresh");
  });

  it("never reads unrelated activity or mail while cloning a scheduling draft", () => {
    const { state } = history();
    for (const key of ["events", "notifications", "emailDrafts"]) {
      Object.defineProperty(state, key, { enumerable: true, get: () => { throw new Error(`Planner copied ${key}`); } });
    }
    const result = planCommands(state, [{ type: "update", itemId: state.items[0].id, patch: { description: "Updated fictional description" } }], state.actor, { now });
    expect(result.status, JSON.stringify(result.conflicts)).toBe("ready");
    expect(result.items[0].description).toBe("Updated fictional description");
    expect(result).not.toHaveProperty("events");
  });
});
