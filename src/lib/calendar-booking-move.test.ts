import { describe, expect, it } from "vitest";
import { createDemoState, DEMO_MEMBERS } from "./fixtures";
import { localDateTime } from "./time";
import { newWorkItem } from "./work";
import { calendarBookingMovePreview, calendarBookingMoveSourceUnavailableReason, calendarBookingMoveTargetUnavailableReason, latestCalendarBookingMove } from "./calendar-booking-move";
import { planCommands } from "./scheduler";
import type { AppState, WorkEvent } from "./types";

const day = "2026-09-09", target = "2026-09-10", now = "2026-09-09T12:00:00Z";
const operation = "calendar-move-11111111-1111-4111-8111-111111111111";
function fixture(): AppState {
  const state = { ...createDemoState(), actor: DEMO_MEMBERS[0], mode: "demo" as const, aiUsageUsd: 0 } as AppState;
  state.items = [newWorkItem(state.actor, day, { id: "project", clientId: state.clients[0].id, title: "Fictional grouped work", remainingMinutes: 120, estimatedMinutes: 120, minimumSessionMinutes: 60 })];
  const at = (time: string) => localDateTime(day, time, state.settings.timeZone);
  state.sessions = [
    { id: "morning", workItemId: "project", start: at("09:00"), end: at("10:00"), status: "planned", protected: false, usesReserve: false },
    { id: "afternoon", workItemId: "project", start: at("13:00"), end: at("14:00"), status: "planned", protected: false, usesReserve: false },
  ];
  state.blocks = []; state.events = []; state.settings.reserveMinutes = 0;
  return state;
}
function event(state: AppState, patch: Partial<WorkEvent> = {}): WorkEvent {
  const snapshot = { items: state.items, sessions: state.sessions, blocks: state.blocks };
  return { id: "move-event", operationId: operation, actorId: state.actor.id, actorName: state.actor.name, type: "schedule_changed", summary: ["Moved fictional hours"], itemIds: ["project"], createdAt: now, version: 1, before: snapshot, after: snapshot, undoneBy: null, ...patch };
}

describe("calendar booking move convenience checks", () => {
  it("allows planned booked segments before or after their scheduled times", () => {
    const state = fixture();
    expect(calendarBookingMoveSourceUnavailableReason(state, ["morning", "afternoon"], now)).toBeNull();
    expect(calendarBookingMoveSourceUnavailableReason(state, ["morning", "afternoon"], "2026-09-09T22:38:00Z")).toBeNull();
    expect(calendarBookingMoveSourceUnavailableReason(state, ["morning", "afternoon"], "2026-09-10T12:00:00Z")).toBeNull();
    expect(calendarBookingMoveSourceUnavailableReason(state, ["morning"], now)).toContain("changed");
    state.sessions = state.sessions.slice(0, 1);
    expect(calendarBookingMoveSourceUnavailableReason(state, ["morning"], now)).toBeNull();
  });
  it("does not turn a ribbon, missing session or duplicated ID into moveable hours", () => {
    const state = fixture();
    for (const ids of [[], ["missing"], ["morning", "morning"]]) expect(calendarBookingMoveSourceUnavailableReason(state, ids, now)).toBeTruthy();
  });
  it("rejects other actors, completed/cancelled/protected work and inactive projects", () => {
    const state = fixture(); state.actor = DEMO_MEMBERS[1];
    expect(calendarBookingMoveSourceUnavailableReason(state, ["morning"], now)).toContain("Only Bryan");
    state.actor = DEMO_MEMBERS[0]; state.sessions[0].protected = true;
    expect(calendarBookingMoveSourceUnavailableReason(state, ["morning"], now)).toContain("protected");
    state.sessions[0].protected = false;
    state.sessions[0].usesReserve = true;
    expect(calendarBookingMoveSourceUnavailableReason(state, ["morning"], now)).toContain("reserve");
    state.sessions[0].usesReserve = false;
    state.sessions[0].status = "completed";
    expect(calendarBookingMoveSourceUnavailableReason(state, ["morning"], now)).toContain("Completed or cancelled");
    state.sessions[0].status = "cancelled";
    expect(calendarBookingMoveSourceUnavailableReason(state, ["morning"], now)).toContain("Completed or cancelled");
    state.sessions[0].status = "planned"; state.items[0].status = "waiting";
    expect(calendarBookingMoveSourceUnavailableReason(state, ["morning", "afternoon"], now)).toContain("active");
  });
  it("does not mix projects or source days", () => {
    const state = fixture(); state.sessions[1].workItemId = "other";
    expect(calendarBookingMoveSourceUnavailableReason(state, ["morning", "afternoon"], now)).toContain("one day");
    state.sessions[1].workItemId = "project"; state.sessions[1].start = localDateTime(target, "13:00", state.settings.timeZone);
    expect(calendarBookingMoveSourceUnavailableReason(state, ["morning", "afternoon"], now)).toContain("one day");
  });
  it("uses workspace-local dates and saved working days without claiming the move fits", () => {
    const state = fixture();
    expect(calendarBookingMoveTargetUnavailableReason(state, day, target, now)).toBeNull();
    expect(calendarBookingMoveTargetUnavailableReason(state, day, day, now)).toContain("already");
    expect(calendarBookingMoveTargetUnavailableReason(state, day, "2026-09-08", now)).toContain("past");
    expect(calendarBookingMoveTargetUnavailableReason(state, day, "2026-09-12", now)).toContain("working");
    expect(calendarBookingMoveTargetUnavailableReason(state, day, "bad", now)).toContain("valid");
    state.settings.weekdays.push(6);
    expect(calendarBookingMoveTargetUnavailableReason(state, day, "2026-09-12", now)).toBeNull();
    // A weekday target can still be full: only the shared server planner can
    // decide whether clocks, focus, unavailable time and capacity all fit.
    state.blocks.push({ id: "day-off", title: "Unavailable", kind: "time_off", start: localDateTime(target, "09:00", state.settings.timeZone), end: localDateTime(target, "17:00", state.settings.timeZone) });
    expect(calendarBookingMoveTargetUnavailableReason(state, day, target, now)).toBeNull();
  });
});

describe("calendar move preview and persistent undo selection", () => {
  it("shows exact unchanged-duration group times and both days' availability", () => {
    const state = fixture(), selection = { sessionIds: ["morning", "afternoon"], date: target };
    const proposal = planCommands(state, [{ type: "move_bookings", ...selection }], state.actor, { now, operationId: operation });
    expect(proposal.status, JSON.stringify(proposal.conflicts)).toBe("ready");
    const details = calendarBookingMovePreview(state, proposal, selection, now);
    expect(details?.before).toHaveLength(2); expect(details?.minutes).toBe(120);
    expect(details?.days.map(day => day.date)).toEqual([day, target]);
    expect(details?.days[0].after.availableMinutes).toBe(450);
    expect(details?.days[1].after.availableMinutes).toBe(330);
  });
  it("binds a preview to its exact actor, version, session selection and target", () => {
    const state = fixture(), selection = { sessionIds: ["morning", "afternoon"], date: target };
    const proposal = planCommands(state, [{ type: "move_bookings", ...selection }], state.actor, { now, operationId: operation });
    expect(calendarBookingMovePreview({ ...state, version: state.version + 1 }, proposal, selection)).toBeNull();
    expect(calendarBookingMovePreview(state, { ...proposal, actorId: "other" }, selection)).toBeNull();
    expect(calendarBookingMovePreview(state, proposal, { ...selection, date: "2026-09-11" })).toBeNull();
    expect(calendarBookingMovePreview(state, proposal, { ...selection, sessionIds: ["morning"] })).toBeNull();
  });
  it("targets the latest saved own calendar move, not a newer unrelated event", () => {
    const state = fixture();
    state.events = [event(state), event(state, { id: "other-action", operationId: "normal-edit", version: 9 }), event(state, { id: "other-person", actorId: "other", version: 10 }), event(state, { id: "undo", type: "schedule_undone", version: 11 })];
    expect(latestCalendarBookingMove(state)?.id).toBe("move-event");
    state.events[0].undoneBy = "undo-event";
    expect(latestCalendarBookingMove(state)?.undoneBy).toBe("undo-event");
    state.actor = DEMO_MEMBERS[1]; expect(latestCalendarBookingMove(state)).toBeUndefined();
  });
});
