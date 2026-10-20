import { describe, expect, it } from "vitest";
import { createDemoState, DEMO_MEMBERS } from "./fixtures";
import { planCommands } from "./scheduler";
import { completedDayFromCommands, undoUnavailableReason } from "./undo";
import { localDateTime } from "./time";
import { newWorkItem } from "./work";
import type { AppState, WorkCommand, WorkEvent } from "./types";

const day = "2026-09-09", next = "2026-09-10", zone = "America/Indiana/Indianapolis";
const at = (date: string, time: string) => localDateTime(date, time, zone);
const now = at(day, "18:00");
const command: WorkCommand = { type: "complete_day", itemId: "project", date: day };
function finished(remaining: number | null = 240): Omit<AppState, "events"> & { events: WorkEvent[] } {
  const state = createDemoState(); state.settings.reserveMinutes = 0; state.blocks = [];
  state.items = [newWorkItem(DEMO_MEMBERS[0], day, { id: "project", clientId: state.clients[0].id, title: "Fictional day work", estimatedMinutes: remaining, remainingMinutes: remaining })];
  state.sessions = [
    { id: "selected", workItemId: "project", start: at(day, "09:00"), end: at(day, "10:00"), status: "planned", protected: true, usesReserve: false },
    { id: "split", workItemId: "project", start: at(day, "11:00"), end: at(day, "12:00"), status: "planned", protected: false, usesReserve: false },
    { id: "next", workItemId: "project", start: at(next, "09:00"), end: at(next, "10:00"), status: "planned", protected: false, usesReserve: false },
    { id: "history", workItemId: "project", start: at(day, "08:00"), end: at(day, "08:30"), status: "completed", protected: true, usesReserve: false },
    { id: "cancelled", workItemId: "project", start: at(day, "12:00"), end: at(day, "12:30"), status: "cancelled", protected: false, usesReserve: false },
  ];
  const before = structuredClone({ items: state.items, sessions: state.sessions, blocks: state.blocks });
  const proposal = planCommands(state, [command], state.actor, { now, operationId: "finish-day" });
  expect(proposal.status, JSON.stringify(proposal.conflicts)).toBe("ready");
  const event: WorkEvent = { id: "event", operationId: proposal.operationId, actorId: state.actor.id, actorName: state.actor.name,
    type: "schedule_changed", summary: proposal.summary, itemIds: proposal.affectedItemIds, createdAt: now, version: state.version + 1,
    before, after: structuredClone({ items: proposal.items, sessions: proposal.sessions, blocks: proposal.blocks }), undoneBy: null,
    completedDay: completedDayFromCommands([command]) };
  return { ...state, items: proposal.items, sessions: proposal.sessions, blocks: proposal.blocks, events: [event], version: event.version };
}

describe("exact latest day-completion Undo", () => {
  it.each([240, null])("allows its own split/protected completion while preserving old history and remaining %s", remaining => {
    const state = finished(remaining);
    expect(undoUnavailableReason(state, state.events[0], now)).toBeNull();
    expect(state.events[0].before.items[0].remainingMinutes).toBe(remaining);
    expect(state.items[0].remainingMinutes).toBe(remaining === null ? null : 120);
    state.sessions.reverse();
    expect(undoUnavailableReason(state, state.events[0], now)).toBeNull();
  });
  it("derives only a single validated complete_day identity, never prose or broader commands", () => {
    expect(completedDayFromCommands([command])).toEqual({ itemId: "project", date: day });
    for (const commands of [undefined, [], [command, command], [{ ...command, date: "2026-02-31" }], [{ ...command, extra: true }], [{ type: "complete_session", sessionId: "selected" }]])
      expect(completedDayFromCommands(commands)).toBeUndefined();
    const state = finished(); delete state.events[0].completedDay;
    expect(undoUnavailableReason(state, state.events[0], now)).toContain("completed or cancelled");
  });
  it.each([{ itemId: "other", date: day }, { itemId: "project", date: next }])("does not authorize another item or date %j", completedDay => {
    const state = finished(); state.events[0].completedDay = completedDay;
    expect(undoUnavailableReason(state, state.events[0], now)).toContain("completed or cancelled");
  });
  it("requires the latest not-yet-undone event", () => {
    const state = finished(); state.version++;
    expect(undoUnavailableReason(state, state.events[0], now)).toContain("latest unchanged");
    state.version--; state.events[0].undoneBy = "corrective";
    expect(undoUnavailableReason(state, state.events[0], now)).toContain("latest unchanged");
  });
  it.each(["selected", "item", "block", "missing-session"])('rejects a changed current snapshot (%s)', change => {
    const state = finished();
    if (change === "selected") state.sessions[0].protected = false;
    if (change === "item") state.items[0].remainingMinutes = 999;
    if (change === "block") state.blocks.push({ id: "new", title: "Later meeting", start: at(next, "14:00"), end: at(next, "15:00"), kind: "meeting" });
    if (change === "missing-session") state.sessions.pop();
    expect(undoUnavailableReason(state, state.events[0], now)).toContain("completed or cancelled");
  });
  it.each(["selected", "history", "cancelled"])('cannot alter an original source or unrelated history (%s)', id => {
    const state = finished(), original = state.events[0].before.sessions.find(session => session.id === id)!;
    original.end = at(day, "11:45");
    expect(undoUnavailableReason(state, state.events[0], now)).toContain("completed or cancelled");
  });
});
