import { dayCapacity } from "./scheduler";
import { dayOfWeek, isDate, isInstant, localDate, minutesBetween } from "./time";
import type { AppState, ScheduleProposal } from "./types";

export interface CalendarBookingMoveSelection { sessionIds: string[]; date: string }
export const CALENDAR_MOVE_PREFIX = "calendar-move-";

/** Convenience checks for calendar controls. The server always validates again. */
export function calendarBookingMoveSourceUnavailableReason(state: AppState, sessionIds: string[], now: string): string | null {
  if (state.actor.role !== "owner") return "Only Bryan can move existing booked hours.";
  if (!isInstant(now)) return "Refresh the calendar to check the current time.";
  if (!sessionIds.length || sessionIds.length > 100 || new Set(sessionIds).size !== sessionIds.length) return "Choose the booked hours from one project on one day.";
  const sessions = sessionIds.map(id => state.sessions.find(session => session.id === id));
  if (sessions.some(session => !session)) return "These bookings changed. Refresh the calendar before moving them.";
  const booked = sessions.filter(session => session !== undefined);
  if (booked.some(session => session.status !== "planned")) return "Completed or cancelled bookings cannot be moved.";
  if (booked.some(session => !isInstant(session.start))) return "These bookings changed. Refresh the calendar before moving them.";
  if (booked.some(session => session.protected)) return "These booked hours are protected. Use Edit hours for an explicit owner override.";
  if (booked.some(session => session.usesReserve)) return "These booked hours use interruption reserve. Use Edit hours to keep its permissions explicit.";
  if (new Set(booked.map(session => session.workItemId)).size !== 1 || new Set(booked.map(session => localDate(session.start, state.settings.timeZone))).size !== 1) return "Move one project's booked hours from one day at a time.";
  const allOnDay = state.sessions.filter(session => session.workItemId === booked[0].workItemId && session.status === "planned" && localDate(session.start, state.settings.timeZone) === localDate(booked[0].start, state.settings.timeZone));
  if (allOnDay.length !== booked.length || allOnDay.some(session => !sessionIds.includes(session.id))) return "This project's booked hours changed. Select its day segment again to move all of those hours together.";
  const item = state.items.find(item => item.id === booked[0].workItemId);
  if (!item || !["planned", "in_progress"].includes(item.status)) return "Only an active project's booked hours can be moved.";
  return null;
}

/** The server planner checks capacity, deadlines and explicit date constraints. */
export function calendarBookingMoveTargetUnavailableReason(state: AppState, sourceDate: string, date: string, now: string): string | null {
  if (!isDate(date) || !isDate(sourceDate) || !isInstant(now)) return "Choose a valid calendar day.";
  if (date === sourceDate) return "These booked hours are already on that day.";
  if (date < localDate(now, state.settings.timeZone)) return "Booked hours cannot be moved into the past.";
  if (!state.settings.weekdays.includes(dayOfWeek(date))) return "Choose one of your working days.";
  return null;
}

export function latestCalendarBookingMove(state: AppState) {
  if (state.actor.role !== "owner") return undefined;
  return state.events.filter(event => event.actorId === state.actor.id && /^calendar-move-[a-f0-9-]{36}$/i.test(event.operationId) && event.type !== "schedule_undone")
    .sort((a, b) => b.version - a.version)[0];
}

export function calendarBookingMovePreview(state: AppState, proposal: ScheduleProposal, selection: CalendarBookingMoveSelection, now = new Date().toISOString()) {
  const command = proposal.commands[0];
  if (proposal.actorId !== state.actor.id || proposal.baseVersion !== state.version || proposal.commands.length !== 1 || command?.type !== "move_bookings" || command.date !== selection.date ||
    [...command.sessionIds].sort().join("\n") !== [...selection.sessionIds].sort().join("\n")) return null;
  if (new Set(proposal.sessions.map(session => session.id)).size !== proposal.sessions.length ||
    JSON.stringify(proposal.blocks) !== JSON.stringify(state.blocks) || proposal.items.length !== state.items.length ||
    state.items.some(item => {
      const next = proposal.items.find(candidate => candidate.id === item.id);
      return !next || next.remainingMinutes !== item.remainingMinutes || next.estimatedMinutes !== item.estimatedMinutes;
    })) return null;
  const before = selection.sessionIds.map(id => state.sessions.find(session => session.id === id));
  if (before.some(session => !session)) return null;
  const sources = before.filter(session => session !== undefined).sort((a, b) => a.start.localeCompare(b.start));
  if (!sources.length || new Set(sources.map(session => session.workItemId)).size !== 1 || new Set(sources.map(session => localDate(session.start, state.settings.timeZone))).size !== 1) return null;
  const itemId = sources[0].workItemId;
  const selectedIds = new Set(selection.sessionIds);
  const untouched = state.sessions.filter(session => !selectedIds.has(session.id));
  if (untouched.some(session => JSON.stringify(proposal.sessions.find(next => next.id === session.id)) !== JSON.stringify(session))) return null;
  const untouchedIds = new Set(untouched.map(session => session.id));
  const after = proposal.sessions.filter(session => !untouchedIds.has(session.id)).sort((a, b) => a.start.localeCompare(b.start));
  if (!after.length || after.some(session => !isInstant(session.start) || !isInstant(session.end) || minutesBetween(session.start, session.end) <= 0 || session.workItemId !== itemId || session.status !== "planned" || session.protected || session.usesReserve || localDate(session.start, state.settings.timeZone) !== selection.date)) return null;
  const minutes = sources.reduce((sum, session) => sum + minutesBetween(session.start, session.end), 0);
  if (after.reduce((sum, session) => sum + minutesBetween(session.start, session.end), 0) !== minutes || sources.some(session => !after.some(next => next.id === session.id))) return null;
  const item = state.items.find(item => item.id === itemId);
  const sourceDate = localDate(sources[0].start, state.settings.timeZone);
  const dates = [...new Set([sourceDate, selection.date])].sort();
  return { before: sources, after, minutes, title: item?.title ?? "Work", clientName: state.clients.find(client => client.id === item?.clientId)?.name ?? "Client",
    days: dates.map(date => ({ date, before: dayCapacity(state, date, now), after: dayCapacity({ ...state, ...proposal }, date, now) })) };
}
