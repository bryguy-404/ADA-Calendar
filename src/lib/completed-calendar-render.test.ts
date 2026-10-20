import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Agenda, MonthCalendar } from "../components/calendar";
import { createDemoState, DEMO_MEMBERS } from "./fixtures";
import { dayCapacity } from "./scheduler";
import { localDateTime } from "./time";
import type { AppState, WorkSession } from "./types";
import { newWorkItem } from "./work";

const today = "2026-09-09", tomorrow = "2026-09-10";
function fixture(mixed = false): AppState {
  const state = { ...createDemoState("2026-09-09T18:00:00Z"), actor: DEMO_MEMBERS[0], mode: "demo" as const, aiUsageUsd: 0 } as AppState;
  state.clients = [{ id: "cedar", name: "Cedar", aliases: [] }];
  state.items = [newWorkItem(state.actor, today, { id: "project", clientId: "cedar", title: "Fictional work", estimatedMinutes: 180, remainingMinutes: 120 })];
  const session = (id: string, date: string, status: WorkSession["status"], start = "09:00", end = "10:00"): WorkSession => ({ id, workItemId: "project", start: localDateTime(date, start, state.settings.timeZone), end: localDateTime(date, end, state.settings.timeZone), status, protected: false, usesReserve: false });
  state.sessions = [session("done", today, "completed"), session("next", tomorrow, "planned"), session("cancelled", today, "cancelled", "11:00", "12:00")];
  if (mixed) state.sessions.push(session("today-planned", today, "planned", "13:00", "14:00"));
  state.blocks = []; state.events = []; state.settings.reserveMinutes = 0;
  return state;
}
function props(state: AppState) {
  return { state, items: state.items, date: today, onSelect: () => {}, onDate: () => {}, onMoveBookings: () => {} };
}

describe("completed hours in calendar rendering", () => {
  it("keeps today's done marker while only tomorrow has a movable booking and consumes capacity", () => {
    const state = fixture(), before = JSON.stringify(state);
    const html = renderToStaticMarkup(createElement(MonthCalendar, props(state)));
    expect(html).toContain('data-completed-date="2026-09-09"');
    expect(html).toContain("1h done");
    expect(html).not.toContain('data-booking-date="2026-09-09"');
    expect(html).not.toContain('aria-label="Move Cedar · Fictional work on Sep 9"');
    expect(html).toContain('aria-label="Move Cedar · Fictional work on Sep 10"');
    expect(dayCapacity(state, today).plannedMinutes).toBe(0);
    expect(dayCapacity(state, tomorrow).plannedMinutes).toBe(60);
    expect(JSON.stringify(state)).toBe(before);
  });
  it("shows completed and planned amounts separately on a mixed day without making completed hours a booking", () => {
    const state = fixture(true), html = renderToStaticMarkup(createElement(MonthCalendar, props(state)));
    expect(html).toContain("completed-day-mixed");
    expect(html).toContain('aria-label="1h planned"');
    expect(html).toContain('data-completed-date="2026-09-09"');
    expect(html).toContain('aria-label="Move Cedar · Fictional work on Sep 9"');
    expect(html).not.toContain("2h planned");
    expect(dayCapacity(state, today).plannedMinutes).toBe(60);
  });
  it("keeps done sessions in the agenda, excludes cancelled sessions and preserves project filters", () => {
    const state = fixture(), html = renderToStaticMarkup(createElement(Agenda, props(state)));
    expect(html).toContain("completed-agenda-session");
    expect(html).toContain('data-session-id="done"');
    expect(html).toContain('data-session-id="next"');
    expect(html).not.toContain('data-session-id="cancelled"');
    expect(html).toContain("1h done");
    const hidden = renderToStaticMarkup(createElement(Agenda, { ...props(state), items: [] }));
    expect(hidden).not.toContain('data-session-id="done"');
  });
  it("retains a closed project's exact worked dates without spanning gaps or reserving future capacity", () => {
    const state = fixture();
    state.items[0] = { ...state.items[0], status: "completed", timelineMode: "span", windowEnd: null, completedAt: "2026-09-12T12:00:00Z" };
    state.sessions[1].status = "cancelled";
    state.sessions.push({ ...state.sessions[0], id: "earlier", start: localDateTime("2026-09-07", "09:00", state.settings.timeZone), end: localDateTime("2026-09-07", "10:00", state.settings.timeZone) });
    const before = JSON.stringify(state);
    const html = renderToStaticMarkup(createElement(MonthCalendar, props(state)));
    expect(html.match(/class="project-ribbon-lane /g)).toHaveLength(2);
    expect(html).toContain('data-completed-date="2026-09-07"');
    expect(html).toContain('data-completed-date="2026-09-09"');
    expect(html).not.toContain('data-booking-date=');
    expect(html).not.toContain('class="ribbon-span"');
    expect(html).not.toContain('class="booking-move-handle"');
    expect(dayCapacity(state, tomorrow).plannedMinutes).toBe(0);
    const agenda = renderToStaticMarkup(createElement(Agenda, { ...props(state), date: "2026-09-07" }));
    expect(agenda).toContain('data-session-id="earlier"');
    expect(agenda).toContain('data-session-id="done"');
    expect(agenda).not.toContain('data-session-id="next"');
    expect(JSON.stringify(state)).toBe(before);
  });
  it("shows completed projects without hours as one dated marker in month and agenda", () => {
    const state = fixture();
    state.items[0] = { ...state.items[0], status: "completed", completedAt: "2026-09-10T01:00:00Z" };
    state.sessions = [];
    for (const component of [MonthCalendar, Agenda]) {
      const html = renderToStaticMarkup(createElement(component, props(state)));
      expect(html).toContain('data-project-completion-id="project" data-completed-date="2026-09-09"');
      expect(html).toContain("No hours recorded");
      expect(html).not.toContain("1h done");
      expect(html).not.toContain('data-booking-date=');
      expect(renderToStaticMarkup(createElement(component, { ...props(state), items: [] }))).not.toContain('data-project-completion-id=');
    }
    expect(state.sessions).toEqual([]);
  });
});
