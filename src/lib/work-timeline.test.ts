import { describe, expect, it } from "vitest";
import { DEMO_MEMBERS } from "./fixtures";
import { newWorkItem } from "./work";
import { calendarHistory, effectiveTimelineMode, workDaySummary, workTimeline } from "./work-timeline";
import { localDateTime } from "./time";
import type { WorkSession } from "./types";

const zone = "America/Indiana/Indianapolis";
const task = () => newWorkItem(DEMO_MEMBERS[0], "2026-09-09", { id: "test", clientId: "client", title: "Fictional work" });
const session = (date: string): WorkSession => ({ id: date, workItemId: "test", start: localDateTime(date, "09:00", zone), end: localDateTime(date, "10:00", zone), status: "planned", protected: false, usesReserve: false });

describe("display timelines without scheduling authority", () => {
  it("follows booked days instead of old display dates or forecasts", () => {
    const item = { ...task(), windowEnd: "2026-12-31", forecastDate: "2027-01-01" };
    expect(workTimeline(item, [session("2026-09-11")], zone)).toEqual({ mode: "bookings", start: "2026-09-11", end: "2026-09-11" });
    expect(workTimeline(item, [], zone)).toBeNull();
  });
  it("keeps completed days in a regular display ribbon while excluding cancellations", () => {
    const item = task();
    const sessions: WorkSession[] = [
      { ...session("2026-09-09"), status: "completed" },
      session("2026-09-10"),
      { ...session("2026-09-18"), status: "cancelled" },
    ];
    const before = JSON.stringify({ item, sessions });
    expect(workTimeline(item, sessions, zone)).toEqual({ mode: "bookings", start: "2026-09-09", end: "2026-09-10" });
    expect(workTimeline(item, sessions.slice(0, 1), zone)).toEqual({ mode: "bookings", start: "2026-09-09", end: "2026-09-09" });
    expect(workTimeline(item, sessions.slice(2), zone)).toBeNull();
    expect(JSON.stringify({ item, sessions })).toBe(before);
  });
  it("preserves the span of legacy known work with completed history and no planned bookings", () => {
    const item = { ...task(), windowEnd: "2026-12-31" };
    delete item.timelineMode;
    const done: WorkSession = { ...session("2026-09-09"), status: "completed" };
    const before = JSON.stringify(item);
    expect(effectiveTimelineMode(item, [done])).toBe("span");
    expect(workTimeline(item, [done], zone)).toEqual({ mode: "span", start: "2026-09-09", end: "2026-12-31" });
    expect(JSON.stringify(item)).toBe(before);
  });
  it("separates completed amounts from the planned IDs and hours available to move on a mixed day", () => {
    const date = "2026-09-09";
    const done: WorkSession = { ...session(date), id: "done", status: "completed" };
    const planned = { ...session(date), id: "planned", start: localDateTime(date, "13:00", zone), end: localDateTime(date, "15:00", zone) };
    const cancelled: WorkSession = { ...session(date), id: "cancelled", status: "cancelled" };
    const other = { ...session(date), id: "other", workItemId: "other" };
    expect(workDaySummary("test", [done, planned, cancelled, other, session("2026-09-10")], date, zone)).toEqual({
      plannedSessions: [planned], completedSessions: [done], plannedMinutes: 120, completedMinutes: 60,
    });
  });
  it("keeps ongoing work open with no bookings and after later estimating", () => {
    const item = { ...task(), timelineMode: "span" as const, estimatedMinutes: null, remainingMinutes: null, windowEnd: null };
    expect(workTimeline(item, [], zone)).toEqual({ mode: "span", start: "2026-09-09", end: null });
    expect(workTimeline({ ...item, estimatedMinutes: 180, remainingMinutes: 180 }, [session("2026-10-15")], zone)).toEqual(workTimeline(item, [], zone));
  });
  it("infers legacy ongoing and unbooked spans without changing their JSON", () => {
    const item = task(); delete item.timelineMode; delete item.dateConstraints;
    const before = JSON.stringify(item);
    expect(effectiveTimelineMode(item, [])).toBe("span");
    expect(effectiveTimelineMode(item, [session("2026-09-11")])).toBe("bookings");
    expect(effectiveTimelineMode({ ...item, estimatedMinutes: null, remainingMinutes: 0 }, [session("2026-09-11")])).toBe("span");
    expect(JSON.stringify(item)).toBe(before);
  });
  it("closes open spans only on explicit completion or cancellation", () => {
    const item = { ...task(), timelineMode: "span" as const, windowEnd: null, completedAt: "2026-09-11T16:00:00Z" };
    expect(workTimeline({ ...item, status: "completed" }, [], zone)?.end).toBe("2026-09-11");
    expect(workTimeline({ ...item, completedAt: null, status: "cancelled", updatedAt: "2026-09-12T16:00:00Z" }, [], zone)?.end).toBe("2026-09-12");
    expect(workTimeline({ ...item, completedAt: null }, [], zone)?.end).toBeNull();
  });
  it("uses recorded work dates for closed projects, excluding old windows and future bookings", () => {
    const item = { ...task(), status: "completed" as const, timelineMode: "span" as const, windowEnd: null, completedAt: "2026-10-20T16:00:00Z" };
    const done: WorkSession[] = ["2026-09-09", "2026-09-11"].map(date => ({ ...session(date), status: "completed" }));
    const sessions = [...done, session("2026-12-31"), { ...session("2026-09-18"), status: "cancelled" as const }];
    const before = JSON.stringify({ item, sessions });
    expect(workTimeline(item, sessions, zone)).toEqual({ mode: "bookings", start: "2026-09-09", end: "2026-09-11" });
    expect(calendarHistory([item], sessions, zone)).toEqual({ items: [item], sessions: done, completions: [] });
    expect(JSON.stringify({ item, sessions })).toBe(before);
  });
  it("shows a dated marker without inventing hours when completion has no recorded sessions", () => {
    const item = { ...task(), status: "completed" as const, completedAt: "2026-10-21T01:00:00Z" };
    const sessions = [session("2026-10-22")];
    expect(calendarHistory([item], sessions, zone)).toEqual({ items: [item], sessions: [], completions: [{ item, date: "2026-10-20" }] });
    expect(workTimeline(item, sessions, zone)).toEqual({ mode: "bookings", start: "2026-10-20", end: "2026-10-20" });
    const legacy = { ...item, completedAt: null, updatedAt: "2026-10-19T01:00:00Z" };
    expect(calendarHistory([legacy], [], zone).completions[0].date).toBe("2026-10-18");
  });
  it("respects project filters and cancellations, and restores planned bookings when reopened", () => {
    const item = { ...task(), status: "completed" as const };
    const done: WorkSession = { ...session("2026-09-09"), status: "completed" };
    const planned = session("2026-09-10");
    for (const items of [[], [{ ...item, status: "cancelled" as const }]]) {
      expect(calendarHistory(items, [done, planned], zone)).toEqual({ items: [], sessions: [], completions: [] });
    }
    expect(calendarHistory([{ ...item, status: "planned" }], [done, planned], zone).sessions).toEqual([done, planned]);
  });
});
