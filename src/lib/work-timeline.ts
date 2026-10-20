import { localDate, minutesBetween } from "./time";
import type { WorkItem, WorkSession } from "./types";

export function effectiveTimelineMode(item: WorkItem, sessions: readonly WorkSession[]): "bookings" | "span" {
  return item.timelineMode ?? (item.estimatedMinutes === null || !sessions.some(session => session.workItemId === item.id && session.status === "planned") ? "span" : "bookings");
}

/** Read-only display projection; never invents reservations or rewrites legacy JSON. */
export function workTimeline(item: WorkItem, sessions: readonly WorkSession[], timeZone: string): { mode: "bookings" | "span"; start: string; end: string | null } | null {
  if (item.status === "completed") {
    const dates = sessions.filter(session => session.workItemId === item.id && session.status === "completed")
      .map(session => localDate(session.start, timeZone)).sort();
    const completed = localDate(item.completedAt ?? item.updatedAt, timeZone);
    return { mode: "bookings", start: dates[0] ?? completed, end: dates.at(-1) ?? completed };
  }
  const mode = effectiveTimelineMode(item, sessions);
  if (mode === "bookings") {
    const dates = sessions.filter(session => session.workItemId === item.id && session.status !== "cancelled").map(session => localDate(session.start, timeZone)).sort();
    return dates.length ? { mode, start: dates[0], end: dates.at(-1)! } : null;
  }
  let end = item.windowEnd;
  if (item.status === "cancelled") {
    const closed = localDate(item.completedAt ?? item.updatedAt, timeZone);
    end = end && end < closed ? end : closed;
  }
  return { mode, start: item.windowStart, end };
}

/** Calendar display only. Completion markers are never synthetic work sessions. */
export function calendarHistory(items: readonly WorkItem[], sessions: readonly WorkSession[], timeZone: string) {
  const visibleItems = items.filter(item => item.status !== "cancelled");
  const byId = new Map(visibleItems.map(item => [item.id, item]));
  const visibleSessions = sessions.filter(session => {
    const item = byId.get(session.workItemId);
    return item && session.status !== "cancelled" && (item.status !== "completed" || session.status === "completed");
  });
  const recorded = new Set(visibleSessions.filter(session => session.status === "completed").map(session => session.workItemId));
  const completions = visibleItems.filter(item => item.status === "completed" && !recorded.has(item.id))
    .map(item => ({ item, date: localDate(item.completedAt ?? item.updatedAt, timeZone) }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.item.id.localeCompare(b.item.id));
  return { items: visibleItems, sessions: visibleSessions, completions };
}

/** Completed hours are display history; only planned sessions can reserve or move. */
export function workDaySummary(itemId: string, sessions: readonly WorkSession[], date: string, timeZone: string) {
  const onDay = sessions.filter(session => session.workItemId === itemId && localDate(session.start, timeZone) === date);
  const plannedSessions = onDay.filter(session => session.status === "planned");
  const completedSessions = onDay.filter(session => session.status === "completed");
  const total = (entries: WorkSession[]) => entries.reduce((sum, session) => sum + minutesBetween(session.start, session.end), 0);
  return { plannedSessions, completedSessions, plannedMinutes: total(plannedSessions), completedMinutes: total(completedSessions) };
}
