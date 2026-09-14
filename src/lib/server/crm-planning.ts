import "server-only";
import { Temporal } from "temporal-polyfill";
import { dayCapacity, dayOpenings, planCommands, validateSchedule } from "../scheduler";
import { newWorkItem } from "../work";
import { addDays, addMinutes, localDate, localDateTime, minutesBetween } from "../time";
import type { Actor, ScheduleSnapshot, ScheduleProposal, WorkCommand, WorkSession } from "../types";
import { CRM_API_VERSION, CRM_PREVIEW_TTL_MINUTES, type CrmAuthenticatedContext, type CrmAvailability, type CrmPreview, type CrmTaskInput, type CrmTimeRange } from "../crm-integration";
import { CrmApiError } from "./crm-auth";
import { reviewFingerprint } from "./preview";
import { crmBookingEnabled } from "./crm-flags";

export interface CrmClientMapping { calendarClientId: string; revision: number }
export interface CrmScheduleContext { snapshot: ScheduleSnapshot; mapping: CrmClientMapping | null }
export interface CrmPreparedPreview {
  response: CrmPreview; input: CrmTaskInput; commands: WorkCommand[]; fingerprint: string;
  mappingRevision: number;
}

export function crmRequesterActor(context: CrmAuthenticatedContext): Actor {
  return { id: context.connection.principalUserId, role: "requester", name: context.requester.email.slice(0, 120), email: context.requester.email };
}

function assertSnapshot(snapshot: ScheduleSnapshot, context: CrmAuthenticatedContext, now: string) {
  if (snapshot.workspaceId !== context.connection.workspaceId || validateSchedule(snapshot, now).length)
    throw new CrmApiError("crm_schedule_unavailable", "Calendar availability needs an owner check. Try again after it is resolved.", 503);
}

function ranges(sessions: WorkSession[]): CrmTimeRange[] {
  return sessions.map(({ start, end }) => ({ start, end })).sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end));
}
function clientFor(snapshot: ScheduleSnapshot, clientId: string) {
  const client = snapshot.clients.find(entry => entry.id === clientId);
  if (!client) throw new CrmApiError("crm_client_unmapped", "Bryan needs to confirm this client's Calendar mapping.", 422);
  return { id: client.id, name: client.name };
}

/** Explicit projection only: descriptions, block titles, notes and arbitrary state never leave this server. */
export function crmAvailability(snapshot: ScheduleSnapshot, context: CrmAuthenticatedContext, startDate: string, endDate: string, now: string): CrmAvailability {
  assertSnapshot(snapshot, context, now);
  const today = localDate(now, snapshot.settings.timeZone);
  if (startDate < addDays(today, -366) || endDate > addDays(today, 366))
    throw new CrmApiError("crm_date_range", "Choose dates within one year of today.", 400);
  const days: CrmAvailability["days"] = [];
  for (let date = startDate; date <= endDate; date = addDays(date, 1)) {
    const dayStart = localDateTime(date, "00:00", snapshot.settings.timeZone);
    const dayEnd = localDateTime(addDays(date, 1), "00:00", snapshot.settings.timeZone);
    const sessions = snapshot.sessions.filter(session => session.status === "planned" && localDate(session.start, snapshot.settings.timeZone) === date);
    days.push({ date, ...dayCapacity(snapshot, date, now), openings: dayOpenings(snapshot, date, now),
      work: snapshot.items.filter(item => sessions.some(session => session.workItemId === item.id)).map(item => ({
        workItemId: item.id, title: item.title, client: clientFor(snapshot, item.clientId),
        sessions: ranges(sessions.filter(session => session.workItemId === item.id)),
      })),
      unavailable: snapshot.blocks.filter(block => Date.parse(block.start) < Date.parse(dayEnd) && Date.parse(block.end) > Date.parse(dayStart))
        .map(block => ({ title: "Unavailable", start: Date.parse(block.start) < Date.parse(dayStart) ? dayStart : block.start, end: Date.parse(block.end) > Date.parse(dayEnd) ? dayEnd : block.end })),
    });
  }
  return { apiVersion: CRM_API_VERSION, bookingEnabled: crmBookingEnabled(), timeZone: snapshot.settings.timeZone, asOf: now, baseVersion: snapshot.version, days };
}

function commandFor(snapshot: ScheduleSnapshot, input: CrmTaskInput, actor: Actor, clientId: string, id: string, now: string): Extract<WorkCommand, { type: "create" }> {
  const today = localDate(now, snapshot.settings.timeZone), scheduling = input.scheduling;
  const first = scheduling.mode === "due_by" ? today : scheduling.date;
  const item = newWorkItem(actor, first, {
    id, clientId, title: input.title, description: input.description, category: input.category, webKind: input.webKind,
    estimatedMinutes: input.estimatedMinutes, remainingMinutes: input.estimatedMinutes,
    targetDate: scheduling.date, windowEnd: scheduling.date,
    deadline: scheduling.mode === "due_by" && !scheduling.flexible ? scheduling.date : null,
    createdAt: now, updatedAt: now,
    ...(input.requestedPriorityId ? { requestedPriorityId: input.requestedPriorityId } : {}),
  });
  if (item.requestedPriorityId && !snapshot.priorities.some(priority => priority.id === item.requestedPriorityId))
    throw new CrmApiError("crm_priority_invalid", "Choose a current Calendar priority.", 400);
  if (scheduling.mode === "exact") {
    const start = localDateTime(scheduling.date, scheduling.startTime, snapshot.settings.timeZone);
    return { type: "create", item, sessions: [{ id: id + "-session", workItemId: id, start, end: addMinutes(start, input.estimatedMinutes), protected: false, usesReserve: false, status: "planned" }] };
  }
  if (scheduling.mode === "due_by" && scheduling.flexible)
    return { type: "create", item, smartFit: { startDate: today, endDate: addDays(today, 365), minutes: input.estimatedMinutes, distribution: "total" } };
  return { type: "create", item, bookingWindow: { startDate: first, endDate: scheduling.date } };
}

const publicConflictMessages: Record<string, string> = {
  displacement_approval: "This would move existing work. Bryan must approve the displayed changes.",
  protected_session: "Protected work occupies this time. Bryan must explicitly approve an override or choose another opening.",
  historical_session: "A conflicting booking has already reached its scheduled start. Bryan must move it explicitly before this placement can fit.",
  partial_booking_displacement: "A conflicting project needs an explicit owner move to preserve its booked hours.",
  unknown_effort_displacement: "A conflicting project has an unknown total and needs an explicit owner move.",
  firm_deadline: "The requested hours cannot fit before the firm due date. Later options require changing that date.",
  capacity: "The requested hours do not fit in the selected dates.",
  daily_capacity: "The requested hours do not fit on the selected day.",
  unavailable: "This time overlaps unavailable time.",
  overlap: "This time overlaps another booking.",
  working_hours: "Use available weekday working hours, excluding lunch and reserved time.",
  lunch: "The requested time overlaps lunch.",
  reserve: "The requested time uses reserved interruption capacity.",
  outside_work_hours: "Use available weekday working hours, excluding lunch.",
  unexpected_work_reserve: "The requested time uses reserved interruption capacity.",
  past_session: "New bookings must start in usable future time.",
};

function alternatives(snapshot: ScheduleSnapshot, input: CrmTaskInput, actor: Actor, clientId: string, id: string, now: string): CrmPreview["alternatives"] {
  const result: CrmPreview["alternatives"] = [], today = localDate(now, snapshot.settings.timeZone), last = addDays(today, 365);
  const flexible = commandFor(snapshot, { ...input, scheduling: { mode: "due_by", date: last, flexible: true } }, actor, clientId, id, now);
  for (let date = today; date <= last && result.length < 3; date = addDays(date, 1)) {
    let proposed: WorkSession[];
    let suggested: CrmTaskInput["scheduling"];
    if (input.scheduling.mode === "exact") {
      const opening = dayOpenings(snapshot, date, now).find(slot => minutesBetween(slot.start, slot.end) >= input.estimatedMinutes);
      if (!opening) continue;
      const startTime = Temporal.Instant.from(opening.start).toZonedDateTimeISO(snapshot.settings.timeZone).toPlainTime().toString().slice(0, 5);
      suggested = { mode: "exact", date, startTime };
      const exact = commandFor(snapshot, { ...input, scheduling: suggested }, actor, clientId, id, now);
      const checked = planCommands(snapshot, [exact], actor, { operationId: id, now });
      if (checked.status !== "ready" || checked.requiresApproval) continue;
      proposed = checked.sessions.filter(session => session.workItemId === id);
    } else {
      if (input.scheduling.mode === "day" && dayCapacity(snapshot, date, now).availableMinutes < input.estimatedMinutes) continue;
      const checked = planCommands(snapshot, [{ ...flexible, smartFit: {
        startDate: date, endDate: input.scheduling.mode === "day" ? date : last, minutes: input.estimatedMinutes, distribution: "total",
      } }], actor, { operationId: id, now });
      if (checked.status !== "ready" || checked.requiresApproval) {
        if (input.scheduling.mode === "due_by") break; // Remaining horizon has no complete fit.
        continue;
      }
      proposed = checked.sessions.filter(session => session.workItemId === id);
      if (!proposed.length) continue;
      date = localDate(proposed[0].start, snapshot.settings.timeZone);
      suggested = input.scheduling.mode === "day" ? { mode: "day", date }
        : { mode: "due_by", date: localDate(proposed.at(-1)!.end, snapshot.settings.timeZone), flexible: input.scheduling.flexible };
    }
    const requiresDeadlineChange = input.scheduling.mode === "due_by" && !input.scheduling.flexible && suggested.date > input.scheduling.date;
    // Earlier clean fits do not need to change an already-sufficient due date.
    if (input.scheduling.mode === "due_by" && suggested.date <= input.scheduling.date) suggested = input.scheduling;
    result.push({ scheduling: suggested, sessions: ranges(proposed), requiresDateChange: JSON.stringify(suggested) !== JSON.stringify(input.scheduling), requiresDeadlineChange });
  }
  return result;
}

export function prepareCrmPreview(context: CrmAuthenticatedContext, loaded: CrmScheduleContext, input: CrmTaskInput, previewId: string, now: string): CrmPreparedPreview {
  const { snapshot, mapping } = loaded;
  assertSnapshot(snapshot, context, now);
  if (!mapping) throw new CrmApiError("crm_client_unmapped", "Bryan needs to confirm this client's Calendar mapping.", 422);
  const today = localDate(now, snapshot.settings.timeZone);
  if (input.scheduling.date < today || input.scheduling.date > addDays(today, 365))
    throw new CrmApiError("crm_date_range", "Choose a scheduling date from today through the next year.", 400);
  const client = clientFor(snapshot, mapping.calendarClientId), actor = crmRequesterActor(context);
  const command = commandFor(snapshot, input, actor, client.id, previewId, now);
  const proposal: ScheduleProposal = planCommands(snapshot, [command], actor, { operationId: previewId, now });
  const changes = snapshot.items.flatMap(item => {
    const before = ranges(snapshot.sessions.filter(session => session.workItemId === item.id && session.status === "planned"));
    const after = ranges(proposal.sessions.filter(session => session.workItemId === item.id && session.status === "planned"));
    return JSON.stringify(before) === JSON.stringify(after) ? [] : [{ workItemId: item.id, title: item.title, client: clientFor(snapshot, item.clientId), before, after }];
  });
  const response: CrmPreview = {
    apiVersion: CRM_API_VERSION, previewId, bookingEnabled: crmBookingEnabled(), timeZone: snapshot.settings.timeZone,
    createdAt: now, expiresAt: addMinutes(now, CRM_PREVIEW_TTL_MINUTES), baseVersion: snapshot.version,
    status: proposal.status === "ready" && !proposal.requiresApproval ? "fits" : proposal.requiresApproval ? "needs_approval" : "cannot_fit",
    task: { externalTaskId: input.externalTaskId, title: input.title, client, estimatedMinutes: input.estimatedMinutes, scheduling: input.scheduling },
    proposedSessions: ranges(proposal.sessions.filter(session => session.workItemId === previewId)), changes,
    conflicts: proposal.conflicts.map(entry => ({ code: entry.code, message: publicConflictMessages[entry.code] ?? "The requested placement does not satisfy the current Calendar rules. Choose another opening or ask Bryan to review it." })),
    alternatives: proposal.status === "ready" && !proposal.requiresApproval ? [] : alternatives(snapshot, input, actor, client.id, previewId, now),
  };
  return { response, input, commands: [command], fingerprint: reviewFingerprint(proposal), mappingRevision: mapping.revision };
}
