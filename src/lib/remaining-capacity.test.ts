import { afterEach, describe, expect, it, vi } from "vitest";
import { createDemoState, DEMO_MEMBERS } from "./fixtures";
import { dayCapacity, planCommands } from "./scheduler";
import { localDateTime } from "./time";
import { newWorkItem } from "./work";
import type { WorkSession } from "./types";

const day = "2026-09-14", owner = DEMO_MEMBERS[0], requester = DEMO_MEMBERS[1];
const at = (clock: string, date = day) => localDateTime(date, clock, "America/Indiana/Indianapolis");
function fixture() {
  const state = createDemoState(at("08:00"));
  state.settings.reserveMinutes = 0;
  state.blocks = []; state.sessions = [];
  state.items = [newWorkItem(owner, day, { id: "work", clientId: state.clients[0].id, title: "Fictional work", estimatedMinutes: 180, remainingMinutes: 180 })];
  return state;
}
function session(start: string, end: string, status: WorkSession["status"] = "planned"): WorkSession {
  return { id: `work-${start}`, workItemId: "work", start: at(start), end: at(end), status, protected: false, usesReserve: false };
}
afterEach(() => vi.useRealTimers());

describe("hours still available to book", () => {
  it.each([
    ["08:00", 450], ["09:00", 450], ["11:30", 300], ["12:00", 270],
    ["12:15", 270], ["12:30", 270], ["16:00", 60], ["16:01", 45],
    ["16:45", 15], ["16:45:01", 0], ["17:00", 0], ["18:00", 0],
  ])("counts only remaining bookable openings at %s", (clock, available) => {
    expect(dayCapacity(fixture(), day, at(clock))).toEqual({ capacityMinutes: 450, plannedMinutes: 0, availableMinutes: available });
  });

  it("uses the real clock by default, closes past days and preserves future capacity", () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date(at("16:00")));
    const state = fixture();
    expect(dayCapacity(state, day).availableMinutes).toBe(60);
    expect(dayCapacity(state, "2026-09-11").availableMinutes).toBe(0);
    expect(dayCapacity(state, "2026-09-15").availableMinutes).toBe(450);
    expect(dayCapacity(state, "2026-09-19").availableMinutes).toBe(0);
    expect(dayCapacity(state, "2026-11-02", "2026-11-02T21:00:00Z").availableMinutes).toBe(60);
  });

  it("deducts only the future part of an unfinished session without reporting progress", () => {
    const state = fixture(); state.sessions = [session("09:00", "11:00"), session("15:30", "16:30")];
    const before = structuredClone(state);
    expect(dayCapacity(state, day, at("16:00"))).toEqual({ capacityMinutes: 450, plannedMinutes: 180, availableMinutes: 30 });
    expect(dayCapacity(state, day, at("17:00")).availableMinutes).toBe(0);
    expect(state).toEqual(before);
  });

  it("finishing elapsed work never reopens its past hours, and finishing early releases only usable time", () => {
    const state = fixture(); state.sessions = [session("09:00", "11:00"), session("16:00", "17:00")];
    const now = at("16:00");
    expect(dayCapacity(state, day, now).availableMinutes).toBe(0);
    const first = planCommands(state, [{ type: "complete_session", sessionId: state.sessions[0].id, remainingMinutes: 60 }], owner, { now });
    expect(first.status, JSON.stringify(first.conflicts)).toBe("ready");
    const afterFirst = { ...state, items: first.items, sessions: first.sessions };
    expect(dayCapacity(afterFirst, day, now).availableMinutes).toBe(0);
    const finished = planCommands(afterFirst, [{ type: "complete_day", itemId: "work", date: day }], owner, { now });
    expect(finished.status, JSON.stringify(finished.conflicts)).toBe("ready");
    const after = { ...state, items: finished.items, sessions: finished.sessions };
    expect(dayCapacity(after, day, now)).toEqual({ capacityMinutes: 450, plannedMinutes: 0, availableMinutes: 60 });
    expect(dayCapacity(after, day, at("16:30")).availableMinutes).toBe(30);
    expect(dayCapacity(after, day, at("17:00")).availableMinutes).toBe(0);
    expect(after.items[0].remainingMinutes).toBe(0);
    expect(after.sessions.every(s => s.status === "completed")).toBe(true);
  });

  it("keeps lunch, overlapping blocks, saved reserve and unusable partial slots out of openings", () => {
    const state = fixture();
    state.blocks = [{ id: "meeting", title: "Fictional meeting", kind: "meeting", start: at("11:30"), end: at("13:00") },
      { id: "time-off", title: "Fictional time off", kind: "time_off", start: at("12:45"), end: at("13:15") }];
    expect(dayCapacity(state, day, at("11:00"))).toEqual({ capacityMinutes: 375, plannedMinutes: 0, availableMinutes: 255 });
    state.blocks = [{ id: "odd-time", title: "Fictional meeting", kind: "meeting", start: at("16:07"), end: at("16:23") }];
    expect(dayCapacity(state, day, at("16:00")).availableMinutes).toBe(30);
    state.blocks = []; state.settings.reserveMinutes = 60;
    expect(dayCapacity(state, day, at("15:30")).availableMinutes).toBe(30);
    expect(dayCapacity(state, day, at("16:00")).availableMinutes).toBe(0);
    expect(state.settings.reserveMinutes).toBe(60);
  });

  it("matches requester clean-fit booking limits after completion and rejects past exact times", () => {
    const state = fixture(); state.sessions = [session("09:00", "11:00", "completed")];
    const now = at("16:00"), available = dayCapacity(state, day, now).availableMinutes;
    const work = (minutes: number) => newWorkItem(requester, day, { id: "new-work", clientId: state.clients[0].id, title: "Fictional request", estimatedMinutes: minutes, remainingMinutes: minutes });
    for (const minutes of [available, available + 15, 120]) {
      const proposal = planCommands(state, [{ type: "create", item: work(minutes), bookingWindow: { startDate: day, endDate: day } }], requester, { now });
      expect(proposal.status === "ready").toBe(minutes === available);
      if (proposal.status === "ready") expect(proposal.sessions.find(s => s.workItemId === "new-work")).toMatchObject({ start: now, end: at("17:00") });
    }
    const past = planCommands(state, [{ type: "create", item: work(60), sessions: [{ ...session("15:00", "16:00"), workItemId: "new-work" }] }], requester, { now });
    expect(past.status).not.toBe("ready");
    expect(planCommands(state, [{ type: "create", item: work(15), bookingWindow: { startDate: day, endDate: day } }], requester, { now: at("17:00") }).status).not.toBe("ready");
  });
});
