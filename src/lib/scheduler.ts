import type {
  Actor, ScheduleAlternative, ScheduleConflict, ScheduleProposal, ScheduleSnapshot,
  UnavailableBlock, WorkCommand, WorkItem, WorkSession,
} from "./types";
import {
  addDays, addMinutes, ceilToSlot, dayOfWeek, instantFromMs, instantMs, isDate, isInstant,
  localDate, localDateTime, maxDate, minutesBetween,
} from "./time";
import { bookingWindowSchema, commandSchema } from "./schemas";
import { effectiveTimelineMode } from "./work-timeline";

type Interval = { start: number; end: number };
type PlanOptions = { now?: string; operationId?: string; approveDisplacement?: boolean };
type Allocation = { sessions: WorkSession[]; missing: number; missingDate?: string };
const MINUTE = 60_000;
const HORIZON_DAYS = 366;
const schedulingFields = new Set(["estimatedMinutes", "remainingMinutes", "targetDate", "deadline", "dateConstraints", "dailyPlan", "priorityId", "status"]);

const clone = <T>(value: T): T => structuredClone(value);
const uuid = () => crypto.randomUUID();
const liveItem = (item: WorkItem) => item.status === "planned" || item.status === "in_progress";
// Completed reservations are history, not capacity. In particular an early completion
// must not turn back into occupied time when its original planned date eventually arrives.
const activeSession = (session: WorkSession) => session.status === "planned";
const planned = (session: WorkSession) => session.status === "planned";
const overlap = (a: Interval, b: Interval) => a.start < b.end && b.start < a.end;
const range = (value: { start: string; end: string }): Interval => ({ start: instantMs(value.start), end: instantMs(value.end) });
const duration = (interval: Interval) => Math.max(0, (interval.end - interval.start) / MINUTE);
const conflict = (code: string, message: string, itemIds: string[] = []): ScheduleConflict => ({ code, message, itemIds });
const rank = (snapshot: ScheduleSnapshot, item: WorkItem) => snapshot.priorities.find((priority) => priority.id === item.priorityId)?.rank ?? 2;
const earliestWorkDate = (item: WorkItem) => item.dateConstraints?.earliestStart ?? null;
const allowedWorkDates = (item: WorkItem) => item.dateConstraints?.allowedDates ?? [];
const permitsDate = (item: WorkItem, date: string) => (!earliestWorkDate(item) || date >= earliestWorkDate(item)!)
  && (!item.deadline || date <= item.deadline) && (!allowedWorkDates(item).length || allowedWorkDates(item).includes(date));
const latchTimeline = (item: WorkItem, sessions: WorkSession[]) => { item.timelineMode ??= effectiveTimelineMode(item, sessions); };

function dayBounds(snapshot: ScheduleSnapshot, date: string) {
  const s = snapshot.settings;
  const start = instantMs(localDateTime(date, s.dayStart, s.timeZone));
  const end = instantMs(localDateTime(date, s.dayEnd, s.timeZone));
  const lunch = { start: instantMs(localDateTime(date, s.lunchStart, s.timeZone)), end: instantMs(localDateTime(date, s.lunchEnd, s.timeZone)) };
  const reserveStart = instantMs(localDateTime(date, s.reserveStart, s.timeZone));
  return { start, end, lunch, reserve: { start: reserveStart, end: Math.min(end, reserveStart + s.reserveMinutes * MINUTE) } };
}

function settingsConflicts(snapshot: ScheduleSnapshot, now: string): ScheduleConflict[] {
  if (!isInstant(now)) return [conflict("invalid_now", "The scheduling clock is invalid.")];
  const settings = snapshot.settings;
  try {
    const date = localDate(now, settings.timeZone);
    const bounds = dayBounds(snapshot, date);
    if (!settings.weekdays.length || settings.weekdays.some((day) => !Number.isInteger(day) || day < 1 || day > 7) ||
      !Number.isInteger(settings.slotMinutes) || settings.slotMinutes <= 0 || !Number.isFinite(settings.reserveMinutes) || settings.reserveMinutes < 0 ||
      bounds.end <= bounds.start || bounds.lunch.start < bounds.start || bounds.lunch.end > bounds.end || bounds.lunch.end < bounds.lunch.start ||
      bounds.reserve.start < bounds.start || bounds.reserve.start + settings.reserveMinutes * MINUTE > bounds.end || overlap(bounds.lunch, bounds.reserve)) {
      return [conflict("invalid_settings", "Working hours, lunch, reserve, weekdays, and scheduling increments must describe a valid workday.")];
    }
  } catch { return [conflict("invalid_settings", "Workspace hours or timezone are invalid.")]; }
  return [];
}

function merge(intervals: Interval[]): Interval[] {
  const sorted = intervals.filter((part) => part.end > part.start).sort((a, b) => a.start - b.start || a.end - b.end);
  const result: Interval[] = [];
  for (const part of sorted) {
    const last = result.at(-1);
    if (last && part.start <= last.end) last.end = Math.max(last.end, part.end);
    else result.push({ ...part });
  }
  return result;
}

function subtract(whole: Interval, occupied: Interval[]): Interval[] {
  let cursor = whole.start;
  const result: Interval[] = [];
  for (const part of merge(occupied)) {
    if (part.end <= cursor || part.start >= whole.end) continue;
    if (part.start > cursor) result.push({ start: cursor, end: Math.min(part.start, whole.end) });
    cursor = Math.max(cursor, part.end);
    if (cursor >= whole.end) break;
  }
  if (cursor < whole.end) result.push({ start: cursor, end: whole.end });
  return result;
}

/** Owner-authorized unexpected work may occur earlier than the displayed reserve. Its minutes release
 * equivalent *still usable* reserve capacity; elapsed reserve time is never recreated. */
function reserveBlock(snapshot: ScheduleSnapshot, date: string, now: string): Interval | null {
  const { reserve } = dayBounds(snapshot, date);
  const nowMs = instantMs(now);
  const usableStart = Math.max(reserve.start, nowMs);
  if (usableStart >= reserve.end) return null;
  // Explicit completion reports work done even when its scheduled end remains
  // in the future. Preserve the reserve it already released for other bookings.
  const consumed = snapshot.sessions.filter((session) => session.status !== "cancelled" && session.usesReserve && isInstant(session.start) && isInstant(session.end) && localDate(session.start, snapshot.settings.timeZone) === date)
    .reduce((sum, session) => sum + minutesBetween(session.start, session.end), 0);
  const released = Math.min(snapshot.settings.reserveMinutes, consumed, duration({ start: usableStart, end: reserve.end }));
  const start = usableStart + released * MINUTE;
  return start < reserve.end ? { start, end: reserve.end } : null;
}

function freeIntervals(snapshot: ScheduleSnapshot, date: string, now: string, useReserve: boolean, ignore: Set<string> = new Set()): Interval[] {
  if (!snapshot.settings.weekdays.includes(dayOfWeek(date))) return [];
  const bounds = dayBounds(snapshot, date);
  const start = Math.max(bounds.start, instantMs(ceilToSlot(now, date, snapshot.settings)));
  if (start >= bounds.end) return [];
  const occupied: Interval[] = [bounds.lunch, ...snapshot.blocks.map(range)];
  for (const session of snapshot.sessions) {
    if (activeSession(session) && !ignore.has(session.id)) occupied.push(range(session));
  }
  if (!useReserve) {
    const reserved = reserveBlock(snapshot, date, now);
    if (reserved) occupied.push(reserved);
  }
  return subtract({ start, end: bounds.end }, occupied);
}

function futureMinutes(session: WorkSession, now: string): number {
  return planned(session) ? Math.max(0, (instantMs(session.end) - Math.max(instantMs(session.start), instantMs(now))) / MINUTE) : 0;
}

// Explicit owner edits follow booking status: the clock does not complete work.
const bookedMinutes = (session: WorkSession) => planned(session) ? minutesBetween(session.start, session.end) : 0;

/** Existing elapsed reservations may predate a saved progress estimate. Explicit
 * edits keep that balance without permitting any new excess over the estimate. */
function explicitReservationLimit(snapshot: ScheduleSnapshot, item: WorkItem, dailyPlan = false): number {
  if (item.remainingMinutes === null) return Number.POSITIVE_INFINITY;
  const slot = snapshot.settings.slotMinutes, original = snapshot.items.find(prior => prior.id === item.id);
  const priorTotal = dailyPlan ? original?.dailyPlan?.reduce((sum, day) => sum + day.minutes, 0) ?? 0
    : snapshot.sessions.filter(session => session.workItemId === item.id).reduce((sum, session) => sum + bookedMinutes(session), 0);
  const priorExcess = original?.remainingMinutes !== undefined && original.remainingMinutes !== null
    ? Math.max(0, priorTotal - Math.ceil(original.remainingMinutes / slot) * slot) : 0;
  return Math.ceil(item.remainingMinutes / slot) * slot + priorExcess;
}

function target(item: WorkItem): string | null {
  return [item.targetDate, item.deadline].filter((date): date is string => !!date).sort()[0] ?? null;
}

type AllocationOptions = { useReserve?: boolean; ignore?: Set<string>; until?: string; from?: string; dates?: Set<string>; additionalMinutes?: number; dailyLimits?: Map<string, number> };
function allocation(snapshot: ScheduleSnapshot, item: WorkItem, now: string, options: AllocationOptions = {}): Allocation {
  if (item.dailyPlan?.length && liveItem(item)) {
    // Resolve each quota separately. Neither a soft target nor an automatic replan
    // may turn a daily instruction into an earliest-fit total.
    const sessions: WorkSession[] = [];
    for (const day of [...item.dailyPlan].sort((a, b) => a.date.localeCompare(b.date))) {
      const onDay = snapshot.sessions.filter(s => s.workItemId === item.id && localDate(s.start, snapshot.settings.timeZone) === day.date);
      const part = allocation({ ...snapshot, sessions: snapshot.sessions.filter(s => s.workItemId !== item.id || onDay.includes(s)) },
        { ...item, dailyPlan: undefined, remainingMinutes: day.minutes, dateConstraints: { earliestStart: day.date, allowedDates: [day.date] } }, now, { ...options, from: day.date, until: day.date });
      sessions.push(...part.sessions);
      if (part.missing) return { sessions, missing: part.missing, missingDate: day.date };
    }
    return { sessions, missing: 0 };
  }
  const ignore = options.ignore ?? new Set<string>();
  const existing = snapshot.sessions.filter((session) => session.workItemId === item.id && !ignore.has(session.id));
  const reservedEffort = Math.ceil((item.remainingMinutes ?? 0) / snapshot.settings.slotMinutes) * snapshot.settings.slotMinutes;
  let missing = options.additionalMinutes ?? Math.max(0, Math.ceil((reservedEffort - existing.reduce((sum, session) => sum + futureMinutes(session, now), 0)) / snapshot.settings.slotMinutes) * snapshot.settings.slotMinutes);
  if (!liveItem(item) || missing === 0) return { sessions: [], missing: 0 };
  const first = maxDate(earliestWorkDate(item) ?? localDate(now, snapshot.settings.timeZone), localDate(now, snapshot.settings.timeZone), options.from ?? localDate(now, snapshot.settings.timeZone));
  const last = [addDays(first, HORIZON_DAYS), item.deadline, options.until].filter((date): date is string => !!date).sort()[0];
  const sessions: WorkSession[] = [];
  const allowed = new Set(allowedWorkDates(item));
  const minimum = snapshot.settings.slotMinutes;
  for (let date = first; date <= last && missing > 0; date = addDays(date, 1)) {
    if (allowed.size && !allowed.has(date)) continue;
    if (options.dates && !options.dates.has(date)) continue;
    let dailyRoom = options.dailyLimits?.get(date) ?? (options.dailyLimits ? 0 : Number.POSITIVE_INFINITY);
    for (const free of freeIntervals(snapshot, date, now, !!options.useReserve, ignore)) {
      const alignedStart = instantMs(ceilToSlot(instantFromMs(free.start), date, snapshot.settings));
      const available = Math.min(dailyRoom, Math.floor(duration({ start: alignedStart, end: free.end }) / snapshot.settings.slotMinutes) * snapshot.settings.slotMinutes);
      const effectiveMinimum = Math.min(minimum, missing);
      if (available < effectiveMinimum) continue;
      const take = Math.min(available, missing);
      if (take < effectiveMinimum) continue;
      const start = instantFromMs(alignedStart);
      sessions.push({ id: uuid(), workItemId: item.id, start, end: addMinutes(start, take), protected: false, status: "planned", usesReserve: !!options.useReserve });
      missing -= take;
      dailyRoom -= take;
      if (missing <= 0) break;
    }
  }
  return { sessions, missing };
}

function itemConflicts(snapshot: ScheduleSnapshot, item: WorkItem): ScheduleConflict[] {
  const errors: ScheduleConflict[] = [];
  const add = (code: string, message: string) => errors.push(conflict(code, message, [item.id]));
  if (!snapshot.clients.some((client) => client.id === item.clientId)) add("unknown_client", `Choose an existing client for “${item.title}”.`);
  if (!item.title.trim()) add("missing_title", "Work needs a title.");
  if (!snapshot.priorities.some((priority) => priority.id === item.priorityId)) add("unknown_priority", `“${item.title}” has an unknown priority.`);
  if (item.estimatedMinutes !== null && (!Number.isFinite(item.estimatedMinutes) || item.estimatedMinutes <= 0)) add("missing_estimate", `“${item.title}” needs a positive effort estimate or an explicitly unknown total.`);
  if (item.remainingMinutes !== null && (!Number.isFinite(item.remainingMinutes) || item.remainingMinutes < 0)) add("invalid_remaining", `“${item.title}” needs a nonnegative remaining-effort estimate.`);
  if (liveItem(item) && (item.estimatedMinutes === null) !== (item.remainingMinutes === null)) add("missing_estimate", `“${item.title}” needs consistent total and remaining estimates; unknown totals use explicit sessions only.`);
  if (!isDate(item.windowStart) || [item.windowEnd, item.targetDate, item.deadline, item.updateDate, earliestWorkDate(item), ...allowedWorkDates(item)].some((date) => date !== null && !isDate(date))) add("invalid_date", `“${item.title}” has an invalid calendar date.`);
  if (item.deadline && earliestWorkDate(item) && item.deadline < earliestWorkDate(item)!) add("deadline_before_start", `“${item.title}” has a firm deadline before its earliest allowed start.`);
  if (item.progressCompleted < 0 || (item.progressTotal !== null && item.progressCompleted > item.progressTotal)) add("invalid_progress", `“${item.title}” has an invalid progress count.`);
  if (item.dailyPlan?.length) {
    if (item.dailyPlan.length > 366 || item.dailyPlan.reduce((sum, day) => sum + day.minutes, 0) > 100_000 || new Set(item.dailyPlan.map(day => day.date)).size !== item.dailyPlan.length || item.dailyPlan.some(day => !isDate(day.date) || !Number.isInteger(day.minutes) || day.minutes < 15 || day.minutes > 480 || day.minutes % snapshot.settings.slotMinutes !== 0))
      add("invalid_daily_plan", "Daily hours need unique dates and positive 15-minute amounts.");
    if (item.dailyPlan.some(day => !permitsDate(item, day.date)))
      add("outside_allowed_dates", "Daily hours must use the task’s allowed dates.");
  }
  return errors;
}

// Unknown is not zero. The first explicitly supplied remaining-hours estimate
// establishes the total only when there was no estimate; later progress must
// preserve the original total and must not implicitly resume waiting work.
function initializeEstimate(item: WorkItem, remaining: number | null | undefined) {
  if (item.estimatedMinutes === null && remaining !== null && remaining !== undefined && Number.isFinite(remaining) && remaining > 0)
    item.estimatedMinutes = remaining;
}

/** Checks hard calendar invariants. Missing future effort is validated by the planner for
 * changed work, not by treating the passage of time as implicit task completion. */
export function validateSchedule(snapshot: ScheduleSnapshot, now = new Date().toISOString()): ScheduleConflict[] {
  const settingsErrors = settingsConflicts(snapshot, now);
  if (settingsErrors.length) return settingsErrors;
  const errors: ScheduleConflict[] = [];
  const ids = new Set<string>();
  for (const item of snapshot.items) {
    if (ids.has(item.id)) errors.push(conflict("duplicate_item", "Two work items have the same identifier.", [item.id]));
    ids.add(item.id);
    errors.push(...itemConflicts(snapshot, item));
  }
  const sessionIds = new Set<string>();
  const valid: WorkSession[] = [];
  for (const session of snapshot.sessions) {
    if (sessionIds.has(session.id)) errors.push(conflict("duplicate_session", "Two work sessions have the same identifier.", [session.workItemId]));
    sessionIds.add(session.id);
    if (session.focusOverrideMinutes !== undefined && (!Number.isInteger(session.focusOverrideMinutes) || session.focusOverrideMinutes < snapshot.settings.slotMinutes || session.focusOverrideMinutes > 480 || session.focusOverrideMinutes % snapshot.settings.slotMinutes !== 0))
      errors.push(conflict("invalid_focus_override", "Legacy booking metadata must use positive 15-minute increments.", [session.workItemId]));
    if (!activeSession(session)) continue;
    const item = snapshot.items.find((candidate) => candidate.id === session.workItemId);
    if (!item) { errors.push(conflict("unknown_work", "A session refers to missing work.", [session.workItemId])); continue; }
    if (!isInstant(session.start) || !isInstant(session.end) || minutesBetween(session.start, session.end) <= 0) { errors.push(conflict("invalid_session", `“${item.title}” has an invalid session.`, [item.id])); continue; }
    valid.push(session);
    const date = localDate(session.start, snapshot.settings.timeZone);
    const bounds = dayBounds(snapshot, date);
    const part = range(session);
    if (!snapshot.settings.weekdays.includes(dayOfWeek(date)) || part.start < bounds.start || part.end > bounds.end || overlap(part, bounds.lunch)) errors.push(conflict("outside_work_hours", `“${item.title}” must fit working hours and avoid lunch.`, [item.id]));
    if (planned(session) && part.end > instantMs(now) && !liveItem(item)) errors.push(conflict("inactive_work", `“${item.title}” cannot reserve work time while ${item.status}.`, [item.id]));
    if (planned(session) && part.start >= instantMs(now)) {
      const scheduledMinutes = minutesBetween(session.start, session.end);
      if (minutesBetween(instantFromMs(bounds.start), session.start) % snapshot.settings.slotMinutes !== 0 || scheduledMinutes % snapshot.settings.slotMinutes !== 0) errors.push(conflict("slot_alignment", `“${item.title}” must use ${snapshot.settings.slotMinutes}-minute scheduling increments.`, [item.id]));
    }
    if (planned(session) && ((earliestWorkDate(item) && date < earliestWorkDate(item)!) || (allowedWorkDates(item).length > 0 && !allowedWorkDates(item).includes(date)))) errors.push(conflict("outside_allowed_dates", `“${item.title}” is outside its explicit scheduling limits.`, [item.id]));
    if (planned(session) && item.deadline && date > item.deadline) errors.push(conflict("firm_deadline", `“${item.title}” would miss its firm deadline of ${item.deadline}.`, [item.id]));
    if (planned(session) && part.end > instantMs(now) && !session.usesReserve) {
      const reserved = reserveBlock(snapshot, date, now);
      if (reserved && overlap(part, reserved)) errors.push(conflict("unexpected_work_reserve", `“${item.title}” occupies unallocated unexpected-work reserve.`, [item.id]));
    }
    if (snapshot.blocks.some((block) => isInstant(block.start) && isInstant(block.end) && overlap(part, range(block)))) errors.push(conflict("unavailable", `“${item.title}” overlaps unavailable time.`, [item.id]));
  }
  valid.sort((a, b) => instantMs(a.start) - instantMs(b.start) || a.id.localeCompare(b.id));
  for (let i = 0; i < valid.length; i++) {
    for (let j = i + 1; j < valid.length && instantMs(valid[j].start) < instantMs(valid[i].end); j++) {
      if (overlap(range(valid[i]), range(valid[j]))) errors.push(conflict("overlap", "Two work sessions overlap.", [...new Set([valid[i].workItemId, valid[j].workItemId])]));
    }
  }
  for (const block of snapshot.blocks) if (!isInstant(block.start) || !isInstant(block.end) || minutesBetween(block.start, block.end) <= 0) errors.push(conflict("invalid_block", "Unavailable time needs a valid start and end."));
  for (const item of snapshot.items.filter(item => item.dailyPlan?.length)) {
    const totals = new Map<string, number>();
    for (const session of valid.filter(s => s.workItemId === item.id && futureMinutes(s, now) > 0)) {
      const date = localDate(session.start, snapshot.settings.timeZone);
      totals.set(date, (totals.get(date) ?? 0) + futureMinutes(session, now));
    }
    for (const [date, minutes] of totals) if (minutes > (item.dailyPlan!.find(day => day.date === date)?.minutes ?? 0))
      errors.push(conflict("daily_hours", `“${item.title}” exceeds its daily hours on ${date}. Adjust that day’s plan explicitly.`, [item.id]));
  }
  return errors;
}

/** Planned work and capacity are whole-day totals. Availability is only the
 * still-bookable openings, using the same clock and increments as allocation. */
export function dayOpenings(snapshot: ScheduleSnapshot, date: string, now = new Date().toISOString()): { start: string; end: string }[] {
  const slot = snapshot.settings.slotMinutes;
  return freeIntervals(snapshot, date, now, false).flatMap(part => {
    const start = ceilToSlot(instantFromMs(part.start), date, snapshot.settings);
    const minutes = Math.floor(duration({ start: instantMs(start), end: part.end }) / slot) * slot;
    return minutes > 0 ? [{ start, end: addMinutes(start, minutes) }] : [];
  });
}

export function dayCapacity(snapshot: ScheduleSnapshot, date: string, now = new Date().toISOString()): { plannedMinutes: number; availableMinutes: number; capacityMinutes: number } {
  if (!snapshot.settings.weekdays.includes(dayOfWeek(date))) return { plannedMinutes: 0, availableMinutes: 0, capacityMinutes: 0 };
  const bounds = dayBounds(snapshot, date);
  const sessions = snapshot.sessions.filter((session) => activeSession(session) && localDate(session.start, snapshot.settings.timeZone) === date);
  const reserveUsed = Math.min(snapshot.settings.reserveMinutes, sessions.filter((session) => session.usesReserve).reduce((sum, session) => sum + minutesBetween(session.start, session.end), 0));
  const unavailable = [bounds.lunch, bounds.reserve, ...snapshot.blocks.map(range)];
  const capacityMinutes = subtract({ start: bounds.start, end: bounds.end }, unavailable).reduce((sum, part) => sum + duration(part), 0);
  const plannedMinutes = Math.max(0, sessions.reduce((sum, session) => sum + minutesBetween(session.start, session.end), 0) - reserveUsed);
  const availableMinutes = dayOpenings(snapshot, date, now).reduce((sum, part) => sum + minutesBetween(part.start, part.end), 0);
  return { plannedMinutes, availableMinutes, capacityMinutes };
}

function cancelFuture(snapshot: ScheduleSnapshot, itemId: string, now: string, overrideProtected: boolean): ScheduleConflict | null {
  const affected = snapshot.sessions.filter((session) => session.workItemId === itemId && planned(session) && instantMs(session.end) > instantMs(now));
  if (!overrideProtected && affected.some((session) => session.protected)) return conflict("protected_session", "This change would remove protected work time. Bryan must explicitly override it.", [itemId]);
  for (const session of affected) removeFutureSession(snapshot, session, now);
  return null;
}

function removeFutureSession(snapshot: ScheduleSnapshot, session: WorkSession, now: string) {
  if (instantMs(session.start) < instantMs(now) && instantMs(session.end) > instantMs(now)) session.end = now;
  else snapshot.sessions = snapshot.sessions.filter((candidate) => candidate.id !== session.id);
}

function refreshForecasts(snapshot: ScheduleSnapshot, now: string, affected: Set<string>) {
  for (const item of snapshot.items) {
    if (!affected.has(item.id)) continue;
    if (item.remainingMinutes === null) { item.forecastDate = null; continue; }
    const dates = snapshot.sessions.filter((session) => session.workItemId === item.id && planned(session) && instantMs(session.end) > instantMs(now)).map((session) => localDate(session.end, snapshot.settings.timeZone));
    item.forecastDate = dates.sort().at(-1) ?? (item.status === "completed" && item.completedAt ? localDate(item.completedAt, snapshot.settings.timeZone) : null);
  }
}

function changes(before: ScheduleSnapshot, after: ScheduleSnapshot): string[] {
  const affected = new Set<string>();
  const itemMap = new Map(before.items.map((item) => [item.id, item]));
  for (const item of after.items) if (JSON.stringify(itemMap.get(item.id)) !== JSON.stringify(item)) affected.add(item.id);
  const sessionsBefore = new Map(before.sessions.map((session) => [session.id, session]));
  const sessionsAfter = new Map(after.sessions.map((session) => [session.id, session]));
  for (const session of [...before.sessions, ...after.sessions]) if (JSON.stringify(sessionsBefore.get(session.id)) !== JSON.stringify(sessionsAfter.get(session.id))) affected.add(session.workItemId);
  return [...affected];
}

function alternatives(snapshot: ScheduleSnapshot, item: WorkItem, now: string): ScheduleAlternative[] {
  const result: ScheduleAlternative[] = [];
  let from = maxDate(earliestWorkDate(item) ?? localDate(now, snapshot.settings.timeZone), localDate(now, snapshot.settings.timeZone));
  for (let i = 0; i < 3; i++) {
    const found = allocation(snapshot, item, now, { from });
    if (found.missing > 0 || !found.sessions.length) break;
    const start = found.sessions[0].start;
    const end = found.sessions.at(-1)!.end;
    result.push({ start, end, label: `${localDate(start, snapshot.settings.timeZone)}–${localDate(end, snapshot.settings.timeZone)} · no existing work moves`, sessions: found.sessions });
    from = addDays(localDate(start, snapshot.settings.timeZone), 1);
  }
  return result;
}

function trimExcess(snapshot: ScheduleSnapshot, item: WorkItem, now: string, override: boolean): ScheduleConflict | null {
  if (item.remainingMinutes === null) return null;
  const reservedEffort = Math.ceil((item.remainingMinutes ?? 0) / snapshot.settings.slotMinutes) * snapshot.settings.slotMinutes;
  let excess = Math.floor((snapshot.sessions.filter((session) => session.workItemId === item.id).reduce((sum, session) => sum + futureMinutes(session, now), 0) - reservedEffort) / snapshot.settings.slotMinutes) * snapshot.settings.slotMinutes;
  const candidates = snapshot.sessions.filter((session) => session.workItemId === item.id && futureMinutes(session, now) > 0).sort((a, b) => instantMs(b.end) - instantMs(a.end));
  for (const session of candidates) {
    if (excess <= 0) break;
    if (session.protected && !override) return conflict("protected_session", `Reducing “${item.title}” would change protected time; explicitly override it.`, [item.id]);
    const take = Math.min(excess, futureMinutes(session, now));
    const newEnd = addMinutes(session.end, -take);
    if (instantMs(newEnd) <= Math.max(instantMs(session.start), instantMs(now))) snapshot.sessions = snapshot.sessions.filter((candidate) => candidate.id !== session.id);
    else session.end = newEnd;
    excess -= take;
  }
  return null;
}

/** Smart fitting is an append-only scheduling operation, not ordinary replanning.
 * Keep it separate so a priority, target, or adjacent edit cannot authorize displacement. */
function planSmartFits(snapshot: ScheduleSnapshot, commands: WorkCommand[], actor: Actor, now: string, result: ScheduleProposal): ScheduleProposal {
  const draft = clone(snapshot);
  const summary: string[] = [];
  const changed = new Set<string>();
  const fail = (errors: ScheduleConflict[]): ScheduleProposal => ({ ...result, status: "infeasible", conflicts: errors });
  try {
    for (const input of commands) {
      const parsed = commandSchema.safeParse(input);
      if (!parsed.success) return fail([conflict("invalid_smart_fit", "Smart fit needs valid dates, a range of at most 366 days, and positive hours in 15-minute increments.")]);
      const command = parsed.data;
      if (command.type !== "fit" && !(command.type === "create" && command.smartFit))
        return fail([conflict("smart_fit_mixed_commands", "Preview smart-fit additions separately from other edits or rescheduling. Existing bookings will stay unchanged.")]);
      if (command.type === "create" && (command.sessions !== undefined || command.urgent || command.overrideProtected || command.overrideDeadline))
        return fail([conflict("smart_fit_override", "Smart fit uses open time only. Do not combine it with exact sessions or override permissions.")]);
      const request = command.type === "fit" ? command.request : command.smartFit!;
      let item: WorkItem;
      if (command.type === "create") {
        item = clone(command.item);
        item.timelineMode ??= item.estimatedMinutes === null ? "span" : "bookings";
        if (draft.items.some(old => old.id === item.id)) return fail([conflict("duplicate_item", "This work item already exists.", [item.id])]);
        if (actor.role === "requester") {
          if (item.estimatedMinutes === null || item.estimatedMinutes <= 0)
            return fail([conflict("missing_estimate", "New requests need a positive effort estimate.", [item.id])]);
          item.requestedPriorityId = item.requestedPriorityId ?? item.priorityId;
          item.priorityId = snapshot.priorities.find(priority => priority.id === "normal")?.id ?? snapshot.priorities.find(priority => priority.rank === 2)?.id ?? snapshot.priorities.at(-1)?.id ?? "normal";
          item.requesterId = actor.id; item.requestedBy = actor.name;
          item.status = "planned"; item.remainingMinutes = item.estimatedMinutes; item.completedAt = null;
          item.progressCompleted = 0; item.checklist = item.checklist.map(entry => ({ ...entry, done: false }));
        }
        item.createdAt = now; item.updatedAt = now; item.forecastDate = null;
        draft.items.push(item);
      } else {
        const existing = draft.items.find(candidate => candidate.id === command.itemId);
        if (!existing) return fail([conflict("unknown_work", "Choose an existing project before fitting more hours.", [command.itemId])]);
        item = existing;
      }
      latchTimeline(item, snapshot.sessions);
      if (item.status === "waiting") {
        if (!request.resumeWaiting) return fail([conflict("smart_fit_waiting", `Confirm that “${item.title}” should resume when these hours are booked.`, [item.id])]);
        item.status = "planned"; item.blockedReason = null; item.completedAt = null;
      }
      if (!liveItem(item)) return fail([conflict("inactive_work", `Reopen “${item.title}” before adding work sessions.`, [item.id])]);

      const workingDates: string[] = [];
      for (let date = request.startDate; date <= request.endDate; date = addDays(date, 1))
        if (draft.settings.weekdays.includes(dayOfWeek(date)) && (!request.dates || request.dates.includes(date))) workingDates.push(date);
      if (!workingDates.length) return fail([conflict("smart_fit_dates", "The selected range contains no working days. Choose a workday; no hours were booked.", [item.id])]);
      const eligible = workingDates.filter(date => permitsDate(item, date));
      if (!eligible.length || request.distribution === "per_day" && eligible.length !== workingDates.length)
        return fail([conflict("outside_allowed_dates", "These hours must fit the project’s earliest start, allowed work dates, and firm deadline. Adjust the selected range; nothing has changed.", [item.id])]);
      const requestedMinutes = request.minutes * (request.distribution === "per_day" ? workingDates.length : 1);
      if (requestedMinutes > 100_000) return fail([conflict("invalid_smart_fit", "The requested bookings exceed the supported 100,000-minute total.", [item.id])]);
      if (command.type === "create" && request.distribution === "per_day") {
        const dailyPlan = workingDates.map(date => ({ date, minutes: request.minutes }));
        if (item.dailyPlan?.length && JSON.stringify([...item.dailyPlan].sort((a, b) => a.date.localeCompare(b.date))) !== JSON.stringify(dailyPlan))
          return fail([conflict("daily_hours", "The new project’s daily plan disagrees with its smart-fit hours. Use one consistent daily amount.", [item.id])]);
        // This is a new project and the per-day budget was explicitly requested.
        // Persist it so later scheduling never packs these hours into fewer days.
        item.dailyPlan = dailyPlan;
      }
      const itemErrors = itemConflicts(draft, item);
      if (itemErrors.length) return fail(itemErrors);
      const alreadyReserved = draft.sessions.filter(session => session.workItemId === item.id).reduce((sum, session) => sum + futureMinutes(session, now), 0);
      if (item.remainingMinutes !== null && alreadyReserved + requestedMinutes > Math.ceil(item.remainingMinutes / draft.settings.slotMinutes) * draft.settings.slotMinutes)
        return fail([conflict("smart_fit_effort", `“${item.title}” has only ${Number((Math.max(0, item.remainingMinutes - alreadyReserved) / 60).toFixed(2))} unreserved remaining hours. Update its remaining-effort estimate separately before booking more; the estimate has not changed.`, [item.id])]);
      const dailyLimits = item.dailyPlan?.length ? new Map(item.dailyPlan.map(day => [day.date, Math.max(0, day.minutes - draft.sessions.filter(session => session.workItemId === item.id && localDate(session.start, draft.settings.timeZone) === day.date).reduce((sum, session) => sum + futureMinutes(session, now), 0))])) : undefined;
      const chunks = request.distribution === "per_day" ? workingDates.map(date => ({ dates: [date], minutes: request.minutes })) : [{ dates: eligible, minutes: request.minutes }];
      for (const chunk of chunks) {
        const schedulingItem = { ...item, dailyPlan: undefined, dateConstraints: { earliestStart: chunk.dates[0], allowedDates: chunk.dates } };
        const found = allocation(draft, schedulingItem, now, { additionalMinutes: chunk.minutes, until: chunk.dates.at(-1), dailyLimits });
        if (found.missing) return fail([conflict("smart_fit_capacity", `“${item.title}” cannot fit ${Number((chunk.minutes / 60).toFixed(2))} hours ${chunk.dates.length === 1 ? `on ${chunk.dates[0]}` : `from ${request.startDate} through ${request.endDate}`} in the available openings. Lunch, meetings, existing bookings, daily limits, and elapsed time are kept clear. Choose different dates or fewer hours; nothing has changed.`, [item.id])]);
        draft.sessions.push(...found.sessions);
      }
      item.updatedAt = now;
      changed.add(item.id);
      summary.push(`${command.type === "create" ? "Added" : "Booked more time for"} ${item.title}: ${Number((requestedMinutes / 60).toFixed(2))}h ${request.distribution === "per_day" ? `(${Number((request.minutes / 60).toFixed(2))}h each working day)` : "total"} from ${request.startDate} through ${request.endDate}. Existing bookings stay unchanged.${item.remainingMinutes === null ? " The project total stays unknown." : ""}`);
    }
    const errors = validateSchedule(draft, now);
    if (errors.length) return fail(errors);
    refreshForecasts(draft, now, changed);
    // A last booked date is not a finish forecast when this append leaves some
    // estimated effort unreserved. Smart fit never schedules that remainder.
    for (const item of draft.items.filter(item => changed.has(item.id) && item.remainingMinutes !== null)) {
      const reserved = draft.sessions.filter(session => session.workItemId === item.id).reduce((sum, session) => sum + futureMinutes(session, now), 0);
      if (reserved < Math.ceil(item.remainingMinutes! / draft.settings.slotMinutes) * draft.settings.slotMinutes) item.forecastDate = null;
    }
    return { ...result, items: draft.items, sessions: draft.sessions, blocks: draft.blocks, affectedItemIds: [...changed], summary };
  } catch (error) {
    return fail([conflict("invalid_smart_fit", error instanceof Error ? error.message : "The requested smart-fit booking is invalid.")]);
  }
}

/** Reordering is a permutation of existing reservations, never a general replan.
 * Every unselected reservation stays fixed, as do selected protected anchors
 * without an explicit owner override. Greedy earliest placement preserves the
 * requested order while leaving the maximum space for each following block. */
function planDayOrder(snapshot: ScheduleSnapshot, commands: WorkCommand[], now: string, result: ScheduleProposal): ScheduleProposal {
  const fail = (errors: ScheduleConflict[]): ScheduleProposal => ({ ...result, status: "infeasible", conflicts: errors });
  if (commands.length !== 1) return fail([conflict("reorder_mixed_commands", "Rearrange one day separately from other changes. Nothing has changed.")]);
  const parsed = commandSchema.safeParse(commands[0]);
  if (!parsed.success || parsed.data.type !== "reorder_day")
    return fail([conflict("invalid_reorder", "Choose a valid day and a unique ordered list of its existing work sessions.")]);
  const command = parsed.data;
  const draft = clone(snapshot);
  const changed = new Set<string>();
  try {
    if (command.date < localDate(now, draft.settings.timeZone))
      return fail([conflict("historical_session", "Past days cannot be rearranged. Choose a day with work that has not started.")]);
    const selected: WorkSession[] = [];
    for (const id of command.sessionIds) {
      const session = draft.sessions.find(candidate => candidate.id === id);
      if (!session) return fail([conflict("unknown_session", "A selected session no longer exists. Refresh the day before rearranging it.")]);
      if (!isInstant(session.start) || !isInstant(session.end) || minutesBetween(session.start, session.end) <= 0)
        return fail([conflict("invalid_session", "A selected session has invalid times. Correct it before rearranging the day.", [session.workItemId])]);
      if (!planned(session) || instantMs(session.start) < instantMs(now))
        return fail([conflict("historical_session", "Completed, cancelled, or already-started sessions cannot be rearranged. Only select work that has not started.", [session.workItemId])]);
      if (localDate(session.start, draft.settings.timeZone) !== command.date || localDate(session.end, draft.settings.timeZone) !== command.date)
        return fail([conflict("reorder_day_mismatch", "Every selected session must already belong to the chosen day. Rearranging never moves work to another day.", [session.workItemId])]);
      const item = draft.items.find(candidate => candidate.id === session.workItemId);
      if (!item) return fail([conflict("unknown_work", "A selected session's project no longer exists.", [session.workItemId])]);
      if (!liveItem(item)) return fail([conflict("inactive_work", `“${item.title}” is ${item.status}; only active booked work can be rearranged.`, [item.id])]);
      selected.push(session);
    }
    const ignore = new Set(selected.filter(session => !session.protected || command.overrideProtected).map(session => session.id));
    let cursor = Math.max(dayBounds(draft, command.date).start, instantMs(ceilToSlot(now, command.date, draft.settings)));
    for (const session of selected) {
      if (session.protected && !command.overrideProtected) {
        if (cursor > instantMs(session.start))
          return fail([conflict("protected_session", "This order would move protected work. Bryan must explicitly authorize a protected-time override, or choose an order that keeps it in place.", [session.workItemId])]);
        cursor = instantMs(session.end);
        continue;
      }
      const length = minutesBetween(session.start, session.end);
      let placement: Interval | undefined;
      for (const free of freeIntervals(draft, command.date, now, false, ignore)) {
        const start = instantMs(ceilToSlot(instantFromMs(Math.max(cursor, free.start)), command.date, draft.settings));
        if (start + length * MINUTE <= free.end) { placement = { start, end: start + length * MINUTE }; break; }
      }
      if (!placement) return fail([conflict("reorder_capacity", "This order cannot fit on the chosen day without splitting a session or changing other bookings. Lunch, unavailable time, protected work, saved reserve, and elapsed time stay unchanged. Try a different order; nothing has changed.", [session.workItemId])]);
      const start = instantFromMs(placement.start), end = instantFromMs(placement.end);
      if (instantMs(session.start) !== placement.start || instantMs(session.end) !== placement.end) {
        changed.add(session.workItemId);
        session.start = start; session.end = end;
      }
      ignore.delete(session.id);
      cursor = placement.end;
    }
    const errors = validateSchedule(draft, now);
    if (errors.length) return fail(errors);
    return { ...result, sessions: draft.sessions, affectedItemIds: [...changed],
      summary: changed.size
        ? [`Rearranged ${selected.length} existing work ${selected.length === 1 ? "session" : "sessions"} on ${command.date}. Session lengths, projects, and other bookings are unchanged.`]
        : [`These sessions are already in the requested order at the earliest available times on ${command.date}. Nothing changed.`],
    };
  } catch (error) {
    return fail([conflict("invalid_reorder", error instanceof Error ? error.message : "The requested order is invalid; nothing has changed.")]);
  }
}

type BookingEdit = Extract<WorkCommand, { type: "resize_booking" | "move_booking" | "move_bookings" | "add_booking" | "set_day_hours" }>;
const isBookingEdit = (command: WorkCommand): command is BookingEdit => ["resize_booking", "move_booking", "move_bookings", "add_booking", "set_day_hours"].includes(command.type);

/** Keep the chosen day's hours on that day, splitting around unavailable time.
 * Original session order stays stable and each session retains its ID on its
 * first fragment; the caller gives further fragments deterministic IDs. */
function placeBookingGroup(snapshot: ScheduleSnapshot, sessions: WorkSession[], date: string, now: string): Map<string, Interval[]> | null {
  const slot = snapshot.settings.slotMinutes;
  const gaps = freeIntervals(snapshot, date, now, false, new Set(sessions.map(session=>session.id))).map(gap=>{
    const start=instantMs(ceilToSlot(instantFromMs(gap.start),date,snapshot.settings));
    return {start,slots:Math.max(0,Math.floor((gap.end-start)/MINUTE/slot))};
  }).filter(gap=>gap.slots>0);
  const pieces=sessions.map(session=>({session,slots:minutesBetween(session.start,session.end)/slot}))
    .sort((a,b)=>instantMs(a.session.start)-instantMs(b.session.start) || a.session.id.localeCompare(b.session.id));
  if(pieces.some(piece=>!Number.isInteger(piece.slots)||piece.slots<1)) throw new Error("Existing sessions must use positive scheduling increments before they can be moved.");
  if(pieces.reduce((sum,piece)=>sum+piece.slots,0)>gaps.reduce((sum,gap)=>sum+gap.slots,0)) return null;
  const placements=new Map<string,Interval[]>();
  let gapIndex=0;
  for(const piece of pieces){
    let remaining=piece.slots;
    const fragments:Interval[]=[];
    while(remaining>0){
      const gap=gaps[gapIndex],take=Math.min(remaining,gap.slots),end=gap.start+take*slot*MINUTE;
      fragments.push({start:gap.start,end});gap.start=end;gap.slots-=take;remaining-=take;
      if(!gap.slots)gapIndex++;
    }
    placements.set(piece.session.id,fragments);
  }
  return placements;
}
// Deterministic opaque identifiers, not authorization tokens. A collision is
// rejected before writing; neither a retry nor a hash collision can replace work.
function bookingSessionId(workspaceId: string, operationId: string, index: number): string {
  const input = `${workspaceId}\n${operationId}\n${index}`;
  const hashes = [2166136261, 2246822507, 3266489909, 668265263].map(seed => {
    let hash = seed;
    for (let i = 0; i < input.length; i++) hash = Math.imul(hash ^ input.charCodeAt(i), 16777619);
    return (hash >>> 0).toString(16).padStart(8, "0");
  });
  return `booking-${hashes.join("")}-${index}`;
}

/** Record one day's actual completion without running the effort planner. */
function planDayCompletion(snapshot: ScheduleSnapshot, commands: WorkCommand[], now: string, result: ScheduleProposal): ScheduleProposal {
  const fail = (errors: ScheduleConflict[]): ScheduleProposal => ({ ...result, status: "infeasible", conflicts: errors });
  if (commands.length !== 1) return fail([conflict("completion_mixed_commands", "Finish one booked day separately from other changes.")]);
  const parsed = commandSchema.safeParse(commands[0]);
  if (!parsed.success || parsed.data.type !== "complete_day") return fail([conflict("invalid_completion", "Choose an existing project and a valid day to finish.")]);
  const command = parsed.data, draft = clone(snapshot), item = draft.items.find(candidate => candidate.id === command.itemId);
  if (!item) return fail([conflict("unknown_work", "This project no longer exists. No work was marked complete.", [command.itemId])]);
  if (item.status === "completed" || item.status === "cancelled") return fail([conflict("inactive_work", "Reopen this project before finishing another booked day.", [item.id])]);
  try {
    const selected = draft.sessions.filter(session => session.workItemId === item.id && planned(session) && localDate(session.start, draft.settings.timeZone) === command.date);
    if (!selected.length) return { ...result, summary: ["This day has no planned hours left to finish. Nothing changed."] };
    if (selected.some(session => !isInstant(session.start) || !isInstant(session.end) || minutesBetween(session.start, session.end) <= 0))
      return fail([conflict("invalid_session", "A booking on this day has invalid times. No work was marked complete.", [item.id])]);
    const recordedMinutes = selected.reduce((sum, session) => sum + minutesBetween(session.start, session.end), 0);
    // Legacy elapsed bookings can end between whole minutes. Stored estimates
    // use whole minutes; round the day's sum once, never each separate session.
    const completedMinutes = Math.round(recordedMinutes);
    const beforeRemaining = item.remainingMinutes;
    latchTimeline(item, snapshot.sessions);
    for (const session of selected) session.status = "completed";
    if (item.remainingMinutes !== null) item.remainingMinutes = Math.max(0, item.remainingMinutes - completedMinutes);
    let releasedUnbookedQuota = false;
    if (item.dailyPlan !== undefined) item.dailyPlan = item.dailyPlan.flatMap(day => {
      if (day.date !== command.date) return [day];
      const minutes = Math.max(0, day.minutes - completedMinutes);
      // Keep any leftover estimate, but do not retain an invalid dated quota
      // left by a legacy booking ending between scheduling increments.
      if (minutes % 15 !== 0) { releasedUnbookedQuota = true; return []; }
      return minutes ? [{ ...day, minutes }] : [];
    });
    const errors = validateSchedule(draft, now);
    if (errors.length) return fail(errors);
    item.updatedAt = now;
    refreshForecasts(draft, now, new Set([item.id]));
    const stillBooked = draft.sessions.filter(session => session.workItemId === item.id).reduce((sum, session) => sum + bookedMinutes(session), 0);
    if (item.remainingMinutes !== null && stillBooked < Math.ceil(item.remainingMinutes / draft.settings.slotMinutes) * draft.settings.slotMinutes) item.forecastDate = null;
    return { ...result, items: draft.items, sessions: draft.sessions, affectedItemIds: [item.id], summary: [
      `Finish ${Number((recordedMinutes / 60).toFixed(2))}h for ${item.title} on ${command.date}.`,
      item.remainingMinutes === null ? "The ongoing project total stays unknown." : `Remaining work: ${Number((beforeRemaining! / 60).toFixed(2))}h → ${Number((item.remainingMinutes / 60).toFixed(2))}h.`,
      ...(releasedUnbookedQuota ? ["The leftover estimate stays unbooked."] : []),
      "Other booked days stay unchanged. Project status stays unchanged.",
    ] };
  } catch (error) {
    return fail([conflict("invalid_completion", error instanceof Error ? error.message : "This booked day could not be completed.")]);
  }
}

/** Set only the named days' booked totals. Other days, reservations, estimates
 * and completed work are not reconstructed by the general effort planner. */
function planDayHours(snapshot: ScheduleSnapshot, command: Extract<WorkCommand, { type: "set_day_hours" }>, now: string, result: ScheduleProposal): ScheduleProposal {
  const fail = (errors: ScheduleConflict[]): ScheduleProposal => ({ ...result, status: "infeasible", conflicts: errors });
  const draft = clone(snapshot), item = draft.items.find(candidate => candidate.id === command.itemId);
  if (!item) return fail([conflict("unknown_work", "Choose an existing project before changing its booked days.", [command.itemId])]);
  if (["completed", "cancelled"].includes(item.status)) return fail([conflict("inactive_work", `Reopen “${item.title}” before changing its booked hours.`, [item.id])]);
  const summary: string[] = [], beforeRemaining = item.remainingMinutes;
  const dayChanges: { date: string; minutes: number; before: number; sessions: WorkSession[] }[] = [];
  try {
    for (const day of [...command.days].sort((a, b) => a.date.localeCompare(b.date))) {
      const sessions = draft.sessions.filter(session => session.workItemId === item.id && planned(session) && localDate(session.start, draft.settings.timeZone) === day.date);
      if (sessions.some(session => !isInstant(session.start) || !isInstant(session.end) || minutesBetween(session.start, session.end) <= 0))
        return fail([conflict("invalid_session", "A booking on one of these days has invalid times.", [item.id])]);
      const before = sessions.reduce((sum, session) => sum + minutesBetween(session.start, session.end), 0);
      if (before === day.minutes) continue;
      if (day.date < localDate(now, draft.settings.timeZone) && day.minutes > before)
        return fail([conflict("historical_session", "Hours can be reduced or removed from a past day. Choose today or a future day to add work.", [item.id])]);
      if (day.minutes > before && !permitsDate(item, day.date))
        return fail([conflict("outside_allowed_dates", `${day.date} is outside this project's explicit scheduling limits or firm deadline. Nothing changed.`, [item.id])]);
      dayChanges.push({ ...day, before, sessions });
    }
    if (!dayChanges.length) return { ...result, summary: ["These days already have the requested hours. Nothing changed."] };
    latchTimeline(item, snapshot.sessions);
    if (item.status === "waiting" && dayChanges.some(day => day.minutes > 0)) {
      item.status = "planned"; item.blockedReason = null; item.completedAt = null;
      summary.push(`${item.title}: Waiting → Planned when these hours are confirmed.`);
    }
    const delta = dayChanges.reduce((sum, day) => sum + day.minutes - day.before, 0);
    if (item.remainingMinutes !== null) {
      item.remainingMinutes = Math.max(0, item.remainingMinutes + delta);
      if (item.remainingMinutes > 100_000) return fail([conflict("invalid_remaining", "The changed hours exceed the supported remaining-effort total.", [item.id])]);
    }
    let newIndex = 0;
    for (const day of dayChanges) {
      if (day.minutes < day.before) {
        let release = day.before - day.minutes;
        for (const session of [...day.sessions].sort((a, b) => instantMs(b.start) - instantMs(a.start) || b.id.localeCompare(a.id))) {
          if (!release) break;
          if (session.protected && !command.overrideProtected)
            return fail([conflict("protected_session", "Reducing these hours would change protected work. Bryan must explicitly authorize that override.", [item.id])]);
          if (session.usesReserve)
            return fail([conflict("booking_reserve", "These hours use interruption reserve. Use exact session editing to keep its permissions explicit.", [item.id])]);
          const minutes = minutesBetween(session.start, session.end), take = Math.min(release, minutes);
          if (take === minutes) draft.sessions = draft.sessions.filter(candidate => candidate.id !== session.id);
          else session.end = addMinutes(session.end, -take);
          release -= take;
        }
      } else {
        const schedulingItem = { ...item, dailyPlan: undefined, dateConstraints: { earliestStart: day.date, allowedDates: [day.date] } };
        const found = allocation(draft, schedulingItem, now, { additionalMinutes: day.minutes - day.before, from: day.date, until: day.date });
        if (found.missing) return fail([conflict("booking_capacity", `The requested ${day.minutes / 60}h cannot fit on ${day.date}. Choose fewer hours or another day; nothing moved or spilled into another date.`, [item.id])]);
        for (const session of found.sessions) {
          session.id = bookingSessionId(draft.workspaceId, result.operationId, newIndex++);
          if (draft.sessions.some(existing => existing.id === session.id)) return fail([conflict("duplicate_session", "A booking identifier already exists. Refresh and preview a new operation.", [item.id])]);
          draft.sessions.push(session);
        }
      }
      if (item.dailyPlan !== undefined) {
        item.dailyPlan = item.dailyPlan.filter(row => row.date !== day.date);
        if (day.minutes > 0) item.dailyPlan.push({ date: day.date, minutes: day.minutes });
        item.dailyPlan.sort((a, b) => a.date.localeCompare(b.date));
      }
      summary.push(`${item.title} on ${day.date}: ${day.before / 60}h → ${day.minutes / 60}h.`);
    }
    const reserved = draft.sessions.filter(session => session.workItemId === item.id).reduce((sum, session) => sum + bookedMinutes(session), 0);
    if (reserved > explicitReservationLimit(snapshot, item))
      return fail([conflict("booking_effort", "These bookings exceed the changed remaining hours. No days changed.", [item.id])]);
    const errors = validateSchedule(draft, now);
    if (errors.length) return fail(errors);
    item.updatedAt = now;
    refreshForecasts(draft, now, new Set([item.id]));
    if (item.remainingMinutes !== null && reserved < Math.ceil(item.remainingMinutes / draft.settings.slotMinutes) * draft.settings.slotMinutes) item.forecastDate = null;
    const unbookedBefore = beforeRemaining === null ? 0 : Math.max(0, beforeRemaining - snapshot.sessions.filter(session => session.workItemId === item.id).reduce((sum, session) => sum + bookedMinutes(session), 0));
    summary.push(item.remainingMinutes === null ? "The ongoing project total stays unknown."
      : `Remaining work: ${beforeRemaining! / 60}h → ${item.remainingMinutes / 60}h.${unbookedBefore > 0 ? " Any previously unbooked work stays unbooked." : ""}`);
    summary.push("Other booked days stay unchanged. Removing hours does not complete work.");
    return { ...result, items: draft.items, sessions: draft.sessions, affectedItemIds: [item.id], summary };
  } catch (error) {
    return fail([conflict("invalid_booking_edit", error instanceof Error ? error.message : "The requested day hours are invalid.")]);
  }
}

/** A booking edit changes reserved time only. It must never invoke the general
 * replanner, which could silently refill a shortened booking from project effort. */
function planBookingEdit(snapshot: ScheduleSnapshot, commands: WorkCommand[], now: string, result: ScheduleProposal): ScheduleProposal {
  const fail = (errors: ScheduleConflict[]): ScheduleProposal => ({ ...result, status: "infeasible", conflicts: errors });
  if (commands.length !== 1) return fail([conflict("booking_mixed_commands", "Preview one booking edit separately from other changes.")]);
  const parsed = commandSchema.safeParse(commands[0]);
  if (!parsed.success || !isBookingEdit(parsed.data)) return fail([conflict("invalid_booking_edit", "Choose valid dates and hours in 15-minute increments. Use day-hours editing to remove a booked day.")]);
  if (parsed.data.type === "set_day_hours") return planDayHours(snapshot, parsed.data, now, result);
  const command = parsed.data, draft = clone(snapshot), summary: string[] = [];
  try {
    const source = command.type !== "add_booking" ? draft.sessions.find(session => session.id === (command.type === "move_bookings" ? command.sessionIds[0] : command.sessionId)) : undefined;
    if (command.type !== "add_booking" && !source) return fail([conflict("unknown_session", "Choose an existing booked session before editing its hours.")]);
    const itemId = command.type === "add_booking" ? command.itemId : source!.workItemId;
    const item = draft.items.find(candidate => candidate.id === itemId);
    if (!item) return fail([conflict("unknown_work", "This project no longer exists. No new project was created.", [itemId])]);
    latchTimeline(item, snapshot.sessions);
    if (source && (!isInstant(source.start) || !isInstant(source.end) || minutesBetween(source.start, source.end) <= 0)) return fail([conflict("invalid_session", "The selected booking has invalid times.", [item.id])]);
    if (source && !planned(source)) return fail([conflict("historical_session", "Completed or cancelled sessions remain history and cannot be edited here.", [item.id])]);
    if (source?.protected && command.type !== "add_booking" && (command.type === "move_bookings" || !command.overrideProtected)) return fail([conflict("protected_session", command.type === "move_bookings" ? "This segment contains protected time. Use Manage sessions with an explicit override instead." : "Changing this protected booking requires Bryan's explicit override.", [item.id])]);
    if (item.status === "waiting" && command.type === "add_booking" && command.request.resumeWaiting) {
      item.status = "planned"; item.blockedReason = null;
      summary.push(`Resume ${item.title} when these hours are booked.`);
    }
    if (!liveItem(item)) return fail([conflict(item.status === "waiting" ? "booking_waiting" : "inactive_work", item.status === "waiting" ? `Confirm that “${item.title}” should resume when these hours are booked.` : `“${item.title}” is ${item.status}. This chat cannot reopen it.`, [item.id])]);
    const allowed = (date: string) => permitsDate(item, date);
    const totalsBefore = new Map<string, number>();
    for (const session of snapshot.sessions.filter(s => s.workItemId === item.id && planned(s))) {
      const date = localDate(session.start, draft.settings.timeZone);
      totalsBefore.set(date, (totalsBefore.get(date) ?? 0) + bookedMinutes(session));
    }
    let newIndex = 0;
    const append = (session: WorkSession) => {
      const id = bookingSessionId(draft.workspaceId, result.operationId, newIndex++);
      if (draft.sessions.some(existing => existing.id === id)) throw new Error("This booking identifier already exists. Refresh and preview a new operation; no bookings were replaced.");
      session.id = id; draft.sessions.push(session);
    };
    const place = (date: string, minutes: number, ignore: Set<string>, startTime?: string, prefer?: string): Interval | undefined => {
      for (const free of freeIntervals(draft, date, now, false, ignore)) {
        const requested = startTime ? instantMs(localDateTime(date, startTime, draft.settings.timeZone)) : prefer ? instantMs(prefer) : undefined;
        if (requested !== undefined) {
          if (requested >= free.start && requested + minutes * MINUTE <= free.end) return { start: requested, end: requested + minutes * MINUTE };
          continue;
        }
        const start = instantMs(ceilToSlot(instantFromMs(free.start), date, draft.settings));
        if (start + minutes * MINUTE <= free.end) return { start, end: start + minutes * MINUTE };
      }
      return undefined;
    };
    const changedDates = new Set<string>();
    if (command.type === "move_bookings") {
      const selected:WorkSession[]=[],sourceDate=localDate(source!.start,draft.settings.timeZone);
      for(const id of command.sessionIds){
        const session=draft.sessions.find(candidate=>candidate.id===id);
        if(!session)return fail([conflict("unknown_session","One of these bookings no longer exists. Refresh the calendar before moving it.",[item.id])]);
        if(!isInstant(session.start)||!isInstant(session.end)||minutesBetween(session.start,session.end)<=0)return fail([conflict("invalid_session","One of these bookings has invalid times.",[item.id])]);
        if(session.workItemId!==item.id||localDate(session.start,draft.settings.timeZone)!==sourceDate)return fail([conflict("booking_group","Move booked sessions from one project on one source day at a time.",[item.id])]);
        if(!planned(session))return fail([conflict("historical_session","Completed or cancelled sessions remain history and cannot move with the month segment.",[item.id])]);
        if(session.protected)return fail([conflict("protected_session","This segment contains protected time. Use Manage sessions with an explicit override instead.",[item.id])]);
        if(session.usesReserve)return fail([conflict("booking_reserve","This segment uses interruption reserve. Use Manage sessions to keep its reserve permissions explicit.",[item.id])]);
        selected.push(session);
      }
      const daySessions=draft.sessions.filter(session=>session.workItemId===item.id&&planned(session)&&localDate(session.start,draft.settings.timeZone)===sourceDate);
      if(daySessions.length!==selected.length||daySessions.some(session=>!command.sessionIds.includes(session.id)))
        return fail([conflict("booking_group_changed","This project's bookings on that day changed. Refresh the calendar and move the complete booked segment again.",[item.id])]);
      if(command.date===sourceDate)return {...result,summary:["These bookings are already on that day. Nothing changed."]};
      if(!allowed(command.date)){
        const label=(date:string)=>new Intl.DateTimeFormat("en-US",{month:"short",day:"numeric",year:"numeric",timeZone:"UTC"}).format(new Date(`${date}T12:00:00Z`));
        let message:string;
        if(earliestWorkDate(item)&&command.date<earliestWorkDate(item)!)message=`${label(command.date)} is before this project's earliest start, ${label(earliestWorkDate(item)!)}. Open Edit work to change its explicit scheduling limits if the work can begin sooner. Nothing moved.`;
        else if(item.deadline&&command.date>item.deadline)message=`${label(command.date)} is after this project's firm deadline, ${label(item.deadline)}. Changing that deadline requires Bryan's explicit override. Nothing moved.`;
        else{
          const dates=[...new Set(allowedWorkDates(item))].sort();
          const shown=dates.slice(0,6).map(label).join("; ");
          message=`${label(command.date)} is not an allowed work date for this project. Allowed work dates: ${shown}${dates.length>6?`; and ${dates.length-6} more`:""}. Open Edit work and adjust its explicit scheduling limits, then try the move again. Display dates do not restrict moving work. Nothing moved.`;
        }
        return fail([conflict("outside_allowed_dates",message,[item.id])]);
      }
      if(command.date<localDate(now,draft.settings.timeZone))return fail([conflict("historical_session","Work cannot be moved into a past day.",[item.id])]);
      const placements=placeBookingGroup(draft,selected,command.date,now);
      if(!placements)return fail([conflict("booking_capacity","All of these hours cannot fit into the openings on that day without changing other work. Choose another day; no bookings moved.",[item.id])]);
      const hours=selected.reduce((sum,session)=>sum+minutesBetween(session.start,session.end),0)/60;
      let fragments=0;
      for(const session of [...selected].sort((a,b)=>instantMs(a.start)-instantMs(b.start)||a.id.localeCompare(b.id))){
        const intervals=placements.get(session.id)!,original={...session};
        session.start=instantFromMs(intervals[0].start);session.end=instantFromMs(intervals[0].end);fragments+=intervals.length;
        for(const placement of intervals.slice(1))append({...original,start:instantFromMs(placement.start),end:instantFromMs(placement.end)});
      }
      changedDates.add(sourceDate);changedDates.add(command.date);
      summary.push(`Move ${hours}h for ${item.title} from ${sourceDate} to ${command.date}${fragments>selected.length?`, split across ${fragments} available openings`:""}. The chosen day's total and all other booked days stay unchanged.`);
    } else if (command.type === "add_booking") {
      const request = command.request;
      const dates: string[] = [];
      for (let date = request.startDate; date <= request.endDate; date = addDays(date, 1))
        if (draft.settings.weekdays.includes(dayOfWeek(date)) && (!request.dates || request.dates.includes(date))) dates.push(date);
      const eligible = dates.filter(allowed);
      if (!dates.length) return fail([conflict("booking_dates", "Choose a range containing a configured working day.", [item.id])]);
      if (!eligible.length || request.distribution === "per_day" && eligible.length !== dates.length) return fail([conflict("outside_allowed_dates", "The requested bookings must respect the project's earliest start, allowed work dates, and firm deadline.", [item.id])]);
      const total = request.minutes * (request.distribution === "per_day" ? dates.length : 1);
      if (total > 100_000) return fail([conflict("invalid_booking_edit", "The requested hours exceed the supported total.", [item.id])]);
      const chunks = request.distribution === "per_day" ? eligible.map(date => ({ dates: [date], minutes: request.minutes })) : [{ dates: eligible, minutes: request.minutes }];
      for (const chunk of chunks) {
        const schedulingItem = { ...item, dailyPlan: undefined, dateConstraints: { earliestStart: chunk.dates[0], allowedDates: chunk.dates } };
        const found = allocation(draft, schedulingItem, now, { additionalMinutes: chunk.minutes, until: chunk.dates.at(-1) });
        if (found.missing) return fail([conflict("booking_capacity", `These hours cannot fit from ${chunk.dates[0]} through ${chunk.dates.at(-1)} without changing existing bookings. Choose fewer hours or other dates.`, [item.id])]);
        for (const session of found.sessions) { append(session); changedDates.add(localDate(session.start, draft.settings.timeZone)); }
      }
      summary.push(`Add ${total / 60}h to existing project ${item.title}${request.distribution === "per_day" ? ` (${request.minutes / 60}h each working day)` : ""}.`);
    } else {
      const session = source!, sourceDate = localDate(session.start, draft.settings.timeZone), oldMinutes = minutesBetween(session.start, session.end);
      if (session.usesReserve) return fail([conflict("booking_reserve", "This session uses explicitly reserved interruption time. Use Manage sessions to edit it with its reserve permissions; this chat will not transfer or expand reserve use.", [item.id])]);
      changedDates.add(sourceDate);
      if (command.type === "resize_booking") {
        if (command.minutes === oldMinutes) return { ...result, summary: ["This booking already has those hours. Nothing changed."] };
        const found = command.minutes < oldMinutes ? { start: instantMs(session.start), end: instantMs(addMinutes(session.start, command.minutes)) }
          : place(sourceDate, command.minutes, new Set([session.id]), undefined, session.start) ?? place(sourceDate, command.minutes, new Set([session.id]));
        if (!found) return fail([conflict("booking_capacity", "The larger booking cannot fit on that day without changing other sessions. Choose fewer hours or another day.", [item.id])]);
        session.start = instantFromMs(found.start); session.end = instantFromMs(found.end);
        summary.push(`Change ${item.title} on ${sourceDate} from ${oldMinutes / 60}h to ${command.minutes / 60}h${command.minutes < oldMinutes ? "; released time is unbooked, not completed work" : ""}.`);
      } else {
        const minutes = command.minutes ?? oldMinutes;
        if (minutes > oldMinutes) return fail([conflict("booking_transfer_hours", "You cannot move more hours than this booking contains. Adding hours is a separate explicit request.", [item.id])]);
        if (!allowed(command.date)) return fail([conflict("outside_allowed_dates", "The destination must respect this project's earliest start, allowed dates, and firm deadline. Those limits have not changed.", [item.id])]);
        if (command.date < localDate(now, draft.settings.timeZone)) return fail([conflict("historical_session", "Work cannot be moved into a past day.", [item.id])]);
        if (minutes < oldMinutes && command.date === sourceDate) return fail([conflict("booking_transfer_day", "Choose a different destination day when moving part of a booking.", [item.id])]);
        const transferred = minutes === oldMinutes ? session : { ...session };
        const ignore = minutes === oldMinutes ? new Set([session.id]) : new Set<string>();
        if (minutes < oldMinutes) session.end = addMinutes(session.start, oldMinutes - minutes);
        const found = place(command.date, minutes, ignore, command.startTime);
        if (!found) return fail([conflict("booking_capacity", command.startTime ? "The requested exact time is unavailable or outside working hours. No other time was substituted." : "That booking cannot fit on the destination day without splitting it or changing other bookings.", [item.id])]);
        transferred.start = instantFromMs(found.start); transferred.end = instantFromMs(found.end);
        if (minutes < oldMinutes) append(transferred);
        changedDates.add(command.date);
        summary.push(`Move ${minutes / 60}h of ${item.title} from ${sourceDate} to ${command.date}${minutes < oldMinutes ? `; ${(oldMinutes - minutes) / 60}h stays on ${sourceDate}` : "; keep the same session"}.`);
      }
    }
    const totalsAfter = new Map<string, number>();
    for (const session of draft.sessions.filter(s => s.workItemId === item.id && planned(s))) {
      const date = localDate(session.start, draft.settings.timeZone);
      totalsAfter.set(date, (totalsAfter.get(date) ?? 0) + bookedMinutes(session));
    }
    const reserved = [...totalsAfter.values()].reduce((sum, value) => sum + value, 0);
    if (reserved > explicitReservationLimit(snapshot, item))
      return fail([conflict("booking_effort", "These bookings exceed the project's remaining-effort estimate. Change the estimate separately if more work is needed; the estimate has not changed.", [item.id])]);
    if (item.dailyPlan?.length) {
      const plan = new Map(item.dailyPlan.map(day => [day.date, day.minutes]));
      for (const date of changedDates) {
        const before = totalsBefore.get(date) ?? 0, after = totalsAfter.get(date) ?? 0, quota = plan.get(date) ?? 0;
        // Fill an existing unused quota before expanding it. A released booking
        // reduces only its own quota; other dates and unbooked hours are retained.
        const next = Math.max(after, quota + Math.min(0, after - before));
        if (next) plan.set(date, next); else plan.delete(date);
        if (next !== quota) summary.push(`Daily booking plan on ${date}: ${quota / 60}h → ${next / 60}h.`);
      }
      item.dailyPlan = [...plan].map(([date, minutes]) => ({ date, minutes })).sort((a, b) => a.date.localeCompare(b.date));
      if (item.dailyPlan.reduce((sum, day) => sum + day.minutes, 0) > explicitReservationLimit(snapshot, item, true))
        return fail([conflict("daily_hours_total", "The changed daily booking plan exceeds remaining effort. Adjust its other daily commitments separately; no estimate was changed.", [item.id])]);
    }
    const errors = validateSchedule(draft, now);
    if (errors.length) return fail(errors);
    const sessionsChanged = JSON.stringify(draft.sessions) !== JSON.stringify(snapshot.sessions);
    if (!sessionsChanged) return { ...result, summary: ["The booking is already at that time. Nothing changed."] };
    item.updatedAt = now;
    refreshForecasts(draft, now, new Set([item.id]));
    if (item.remainingMinutes !== null && reserved < Math.ceil(item.remainingMinutes / draft.settings.slotMinutes) * draft.settings.slotMinutes) item.forecastDate = null;
    summary.push(`Project total and remaining effort stay ${item.remainingMinutes === null ? "unknown" : "unchanged"}. Other bookings are unchanged.`);
    return { ...result, items: draft.items, sessions: draft.sessions, affectedItemIds: [item.id], summary };
  } catch (error) {
    return fail([conflict("invalid_booking_edit", error instanceof Error ? error.message : "The requested booking edit is invalid.")]);
  }
}

/** Pure, deterministic placement decisions. IDs identify the proposal; callers MUST
 * commit against baseVersion atomically and rerun this function after any version race. */
export function planCommands(snapshot: ScheduleSnapshot, commands: WorkCommand[], actor: Actor, options: PlanOptions = {}): ScheduleProposal {
  const now = options.now ?? new Date().toISOString();
  const result: ScheduleProposal = { id: uuid(), operationId: options.operationId ?? uuid(), baseVersion: snapshot.version, actorId: actor.id, commands: clone(commands), status: "ready", requiresApproval: false, items: clone(snapshot.items), sessions: clone(snapshot.sessions), blocks: clone(snapshot.blocks), affectedItemIds: [], summary: [], conflicts: [], alternatives: [], createdAt: now };
  const fail = (errors: ScheduleConflict[], status: "infeasible" | "approval_required" = "infeasible"): ScheduleProposal => ({ ...result, status, requiresApproval: status === "approval_required", conflicts: errors, items: clone(snapshot.items), sessions: clone(snapshot.sessions), blocks: clone(snapshot.blocks) });
  if (actor.role === "viewer") return fail([conflict("forbidden", "Viewers cannot change or book work.")]);
  const settingsErrors = settingsConflicts(snapshot, now);
  if (settingsErrors.length) return fail(settingsErrors);
  if (actor.role !== "owner" && commands.some((command) => command.type !== "create")) return fail([conflict("forbidden", "Requesters can submit new work, but cannot edit existing work.")]);
  if (actor.role !== "owner" && commands.some((command) => ("overrideProtected" in command && command.overrideProtected) || ("overrideDeadline" in command && command.overrideDeadline))) return fail([conflict("forbidden", "Only Bryan can authorize protected-time or deadline overrides.")]);
  if (actor.role !== "owner" && commands.some(command => command.type === "create" && command.sessions?.some(session => session.focusOverrideMinutes !== undefined))) return fail([conflict("forbidden", "Only Bryan can authorize a booking-specific shorter focus session.")]);
  if (commands.some(command => command.type === "complete_day")) return planDayCompletion(snapshot, commands, now, result);
  if (commands.some(command => command.type === "create" && command.bookingWindow && (command.smartFit || command.sessions !== undefined)))
    return fail([conflict("invalid_input", "Choose one initial booking method for each new task.")]);
  if (commands.some(isBookingEdit)) return planBookingEdit(snapshot, commands, now, result);
  if (commands.some(command => command.type === "reorder_day")) return planDayOrder(snapshot, commands, now, result);
  if (commands.some(command => command.type === "fit" || command.type === "create" && command.smartFit))
    return planSmartFits(snapshot, commands, actor, now, result);
  const draft = clone(snapshot);
  const bookingWindows = new Map<string, { startDate: string; endDate: string; dates: Set<string> }>();
  // These dates belong to this creation/approval only. Saved items remain flexible.
  const allocate = (source: ScheduleSnapshot, item: WorkItem, allocationOptions: AllocationOptions = {}) => {
    const window = bookingWindows.get(item.id);
    return allocation(source, item, now, window ? { ...allocationOptions, dates: window.dates,
      from: maxDate(window.startDate, allocationOptions.from ?? window.startDate),
      until: [window.endDate, allocationOptions.until].filter((date): date is string => !!date).sort()[0] } : allocationOptions);
  };
  const scheduleIds = new Set<string>();
  const explicitIds = new Set<string>();
  const urgentIds = new Set<string>();
  const replacementProtected = new Set<string>();
  const forcedDisplacedIds = new Set<string>();
  const completedDailyIds = new Set<string>();
  const preserveReservationIds = new Set<string>();
  const globalProtectedOverride = actor.role === "owner" && commands.some((command) => "overrideProtected" in command && command.overrideProtected && (command.type === "create" || command.type === "block" || command.type === "schedule" && command.urgent));
  const individuallyOverridden = new Set(actor.role === "owner" ? commands.flatMap((command) => {
    if (!("overrideProtected" in command) || !command.overrideProtected) return [];
    if ("itemId" in command) return [command.itemId];
    if (command.type === "move") return snapshot.sessions.filter((session) => session.id === command.sessionId).map((session) => session.workItemId);
    return [];
  }) : []);
  const protectedOverride = (itemId: string) => globalProtectedOverride || individuallyOverridden.has(itemId);
  const changedBlocks: UnavailableBlock[] = [];
  const summaries: string[] = [];
  const errors: ScheduleConflict[] = [];
  try {
    for (const command of commands) {
      // Day ordering is handled atomically above and cannot enter broad replanning.
      if (command.type === "reorder_day") return fail([conflict("reorder_mixed_commands", "Rearrange one day separately from other changes.")]);
      if (command.type === "complete_day") return fail([conflict("completion_mixed_commands", "Finish one booked day separately from other changes.")]);
      if (isBookingEdit(command)) return fail([conflict("booking_mixed_commands", "Preview booking edits separately from other changes.")]);
      if (command.type === "create") {
        const item = clone(command.item);
        if (command.bookingWindow) {
          const parsed = bookingWindowSchema.safeParse(command.bookingWindow);
          if (!parsed.success) { errors.push(conflict("invalid_booking_window", "Choose valid initial booking dates within one year.", [item.id])); continue; }
          const window = parsed.data, dates = new Set<string>();
          for (let date = window.startDate; date <= window.endDate; date = addDays(date, 1))
            if (!window.dates || window.dates.includes(date)) dates.add(date);
          bookingWindows.set(item.id, { startDate: window.startDate, endDate: window.endDate, dates });
        }
        item.timelineMode ??= item.estimatedMinutes === null ? "span" : "bookings";
        if (draft.items.some((existing) => existing.id === item.id)) { errors.push(conflict("duplicate_item", "This work item already exists.", [item.id])); continue; }
        if (actor.role === "requester") {
          if (item.estimatedMinutes === null || item.estimatedMinutes <= 0) {
            errors.push(conflict("missing_estimate", "New requests need a positive effort estimate.", [item.id]));
            continue;
          }
          item.requestedPriorityId = item.requestedPriorityId ?? item.priorityId;
          item.priorityId = snapshot.priorities.find((priority) => priority.id === "normal")?.id ?? snapshot.priorities.find((priority) => priority.rank === 2)?.id ?? snapshot.priorities.at(-1)?.id ?? "normal";
          item.requesterId = actor.id; item.requestedBy = actor.name;
          item.status = "planned"; item.remainingMinutes = item.estimatedMinutes; item.completedAt = null;
          item.progressCompleted = 0; item.checklist = item.checklist.map((entry) => ({ ...entry, done: false }));
        }
        item.createdAt = now; item.updatedAt = now; item.forecastDate = null;
        if (liveItem(item) && item.remainingMinutes === null && !command.sessions?.length && !item.dailyPlan?.length) {
          errors.push(conflict("missing_sessions", "Unknown-total projects need explicit work sessions, or can be saved as waiting work.", [item.id]));
          continue;
        }
        draft.items.push(item); scheduleIds.add(item.id);
        if (actor.role === "owner" && (command.urgent || rank(draft, item) === 0)) urgentIds.add(item.id);
        if (command.sessions?.length) {
          explicitIds.add(item.id);
          for (const session of command.sessions) {
            if (session.workItemId !== item.id || session.status !== "planned" || (actor.role !== "owner" && (session.usesReserve || session.protected))) errors.push(conflict("invalid_session", "Requested work sessions contain unsupported settings.", [item.id]));
            draft.sessions.push(clone(session));
          }
        }
        summaries.push(`Added ${item.title}.`);
        continue;
      }
      if (command.type === "block") {
        if (!isInstant(command.block.start) || !isInstant(command.block.end) || minutesBetween(command.block.start, command.block.end) <= 0) { errors.push(conflict("invalid_block", "Unavailable time needs a valid start and end.")); continue; }
        if (!command.block.title.trim()) { errors.push(conflict("invalid_block", "Meetings and time off need a title.")); continue; }
        const index = draft.blocks.findIndex((block) => block.id === command.block.id);
        if (command.remove) {
          if (index < 0) errors.push(conflict("unknown_block", "This unavailable block no longer exists."));
          else draft.blocks.splice(index, 1);
        } else {
          if (index >= 0) draft.blocks[index] = clone(command.block); else draft.blocks.push(clone(command.block));
          changedBlocks.push(command.block);
        }
        summaries.push(`${command.remove ? "Removed" : index >= 0 ? "Updated" : "Added"} ${command.block.kind === "meeting" ? "meeting" : "time off"}: ${command.block.title}.`);
        continue;
      }
      if (command.type === "move") {
        const session = draft.sessions.find((entry) => entry.id === command.sessionId);
        if (!session) { errors.push(conflict("unknown_session", "The work session no longer exists.")); continue; }
        if (session.protected && !command.overrideProtected) { errors.push(conflict("protected_session", "Bryan must explicitly override this protected session before moving it.", [session.workItemId])); continue; }
        if (!planned(session)) { errors.push(conflict("historical_session", "Completed or cancelled sessions remain history and cannot be moved.", [session.workItemId])); continue; }
        if (!isInstant(command.start) || !isInstant(command.end) || instantMs(command.start) < instantMs(now) || minutesBetween(command.start, command.end) <= 0) { errors.push(conflict("past_session", "New work sessions must start in the future and have positive duration.", [session.workItemId])); continue; }
        if (minutesBetween(session.start, session.end) !== minutesBetween(command.start, command.end)) { errors.push(conflict("move_duration", "Moving a session must preserve its duration; update the effort estimate separately.", [session.workItemId])); continue; }
        const movedItem = draft.items.find(item => item.id === session.workItemId);
        if (movedItem) latchTimeline(movedItem, snapshot.sessions);
        const sourceDate = localDate(session.start, draft.settings.timeZone), destinationDate = localDate(command.start, draft.settings.timeZone);
        const movedMinutes = minutesBetween(session.start, session.end);
        session.start = command.start; session.end = command.end;
        if (movedItem?.dailyPlan?.length && sourceDate !== destinationDate) {
          const quotas = new Map(movedItem.dailyPlan.map(day => [day.date, day.minutes]));
          const sourceQuota = Math.max(0, (quotas.get(sourceDate) ?? 0) - movedMinutes);
          if (sourceQuota) quotas.set(sourceDate, sourceQuota); else quotas.delete(sourceDate);
          const destinationBooked = draft.sessions.filter(s => s.workItemId === movedItem.id && localDate(s.start, draft.settings.timeZone) === destinationDate).reduce((sum, s) => sum + bookedMinutes(s), 0);
          quotas.set(destinationDate, Math.max(quotas.get(destinationDate) ?? 0, destinationBooked));
          movedItem.dailyPlan = [...quotas].sort(([a], [b]) => a.localeCompare(b)).map(([date, minutes]) => ({ date, minutes }));
        }
        scheduleIds.add(session.workItemId); explicitIds.add(session.workItemId);
        summaries.push("Moved a work session.");
        continue;
      }
      if (command.type === "complete_session") {
        const session = draft.sessions.find((entry) => entry.id === command.sessionId);
        if (!session || session.status === "cancelled") { errors.push(conflict("unknown_session", "This work session is no longer available.")); continue; }
        if (session.status === "completed") { summaries.push("This work session is already complete."); continue; }
        const item = draft.items.find((entry) => entry.id === session.workItemId);
        if (!item) { errors.push(conflict("unknown_work", "This session’s work item is no longer available.", [session.workItemId])); continue; }
        latchTimeline(item, snapshot.sessions);
        if (item.dailyPlan?.length) {
          completedDailyIds.add(item.id);
          const date = localDate(session.start, draft.settings.timeZone);
          const released = minutesBetween(session.start, session.end);
          item.dailyPlan = item.dailyPlan.map(day => day.date === date ? { ...day, minutes: Math.max(0, day.minutes - released) } : day).filter(day => day.minutes > 0);
        }
        session.status = "completed";
        if (instantMs(session.start) >= instantMs(now)) session.usesReserve = false;
        else if (instantMs(session.end) > instantMs(now)) session.end = now;
        if (command.remainingMinutes !== undefined) { item.remainingMinutes = command.remainingMinutes; initializeEstimate(item, command.remainingMinutes); }
        item.updatedAt = now;
        scheduleIds.add(item.id);
        summaries.push(`Completed a work session for ${item.title}; ${command.remainingMinutes === undefined ? "the project’s remaining-effort estimate is unchanged" : `remaining effort is ${command.remainingMinutes} minutes`}.`);
        continue;
      }
      const item = draft.items.find((entry) => entry.id === command.itemId);
      if (!item) { errors.push(conflict("unknown_work", "This work item no longer exists.", [command.itemId])); continue; }
      if (command.type === "client_update") { summaries.push(`Client update for ${item.title}: ${command.message}`); continue; }
      latchTimeline(item, snapshot.sessions);
      if (command.type === "update") {
        const patch = clone(command.patch);
        const protectedFields = ["id", "createdAt", "completedAt", "forecastDate", "requesterId", "requestedBy"];
        if (protectedFields.some((key) => key in patch)) { errors.push(conflict("immutable_field", "This update includes fields that must be changed through their dedicated action.", [item.id])); continue; }
        if (patch.status === "completed") { errors.push(conflict("completion_command", "Use an explicit completion action to finish work.", [item.id])); continue; }
        if ("deadline" in patch && item.deadline && patch.deadline !== item.deadline && !command.overrideDeadline) { errors.push(conflict("firm_deadline", "Changing a firm deadline requires Bryan’s explicit override.", [item.id])); continue; }
        if (patch.estimatedMinutes !== undefined && patch.estimatedMinutes !== null && patch.remainingMinutes === undefined) patch.remainingMinutes = Math.max(0, patch.estimatedMinutes - Math.max(0, (item.estimatedMinutes ?? 0) - (item.remainingMinutes ?? 0)));
        const firstEstimate = item.estimatedMinutes === null;
        Object.assign(item, patch);
        if (firstEstimate) initializeEstimate(item, patch.remainingMinutes);
        if (Object.keys(patch).some((key) => schedulingFields.has(key))) scheduleIds.add(item.id);
        item.updatedAt = now; summaries.push(`Updated ${item.title}.`);
      } else if (command.type === "progress") {
        if (command.remainingMinutes !== undefined) { item.remainingMinutes = command.remainingMinutes; initializeEstimate(item, command.remainingMinutes); scheduleIds.add(item.id); }
        if (command.progressCompleted !== undefined) item.progressCompleted = command.progressCompleted;
        if (command.checklist !== undefined) item.checklist = clone(command.checklist);
        item.updatedAt = now; summaries.push(`Updated progress on ${item.title}.`);
      } else if (command.type === "status") {
        if (["planned", "in_progress"].includes(command.status) && item.remainingMinutes === null && command.remainingMinutes === undefined
          && !draft.sessions.some(session => session.workItemId === item.id && futureMinutes(session, now) > 0)
          && !item.dailyPlan?.length && !commands.some(next => next.type === "schedule" && next.itemId === item.id && next.sessions?.length)) {
          errors.push(conflict("missing_estimate", "Resume this work with an estimate or explicitly dated work sessions.", [item.id]));
          continue;
        }
        if (command.remainingMinutes !== undefined) {
          if (!Number.isFinite(command.remainingMinutes) || command.remainingMinutes < 0) {
            errors.push(conflict("invalid_remaining", "Remaining effort must be a nonnegative number.", [item.id]));
            continue;
          }
          item.remainingMinutes = command.remainingMinutes;
          initializeEstimate(item, command.remainingMinutes);
        }
        item.status = command.status; item.updatedAt = now;
        item.blockedReason = command.status === "waiting" ? command.reason ?? "Waiting for a dependency" : null;
        if (command.status === "completed") { item.remainingMinutes = 0; item.completedAt = now; }
        else item.completedAt = null;
        scheduleIds.add(item.id); summaries.push(`${command.status === "completed" ? "Completed" : "Changed status of"} ${item.title}${command.status === "completed" ? "." : ` to ${command.status}.`}`);
      } else if (command.type === "schedule") {
        if (item.remainingMinutes === null && command.sessions === undefined && !item.dailyPlan?.length) {
          errors.push(conflict("missing_sessions", "The project total is unknown. Give the date, start and end for the session to book.", [item.id]));
          continue;
        }
        scheduleIds.add(item.id);
        if (command.urgent || rank(draft, item) === 0) urgentIds.add(item.id);
        if (command.sessions) {
          if (command.sessions.some((session) => session.workItemId !== item.id || session.status !== "planned")) {
            errors.push(conflict("invalid_session", "Replacement sessions must belong to this work item and be planned.", [item.id]));
            continue;
          }
          {
            // Only planned bookings are editable sources, regardless of their
            // clock time. Completed/cancelled rows are retained as history.
            const unchanged = new Set(draft.sessions.filter(old => command.sessions!.some(next => JSON.stringify(next) === JSON.stringify(old))).map(session => session.id));
            const replaced = draft.sessions.filter(session => session.workItemId === item.id && planned(session) && !unchanged.has(session.id));
            if (command.sessions.some(session => !unchanged.has(session.id) && (!isInstant(session.start) || instantMs(session.start) < instantMs(now)))) {
              errors.push(conflict("past_session", "Changed or new exact bookings must start in usable future time. Use day hours to reduce a past booking.", [item.id]));
              continue;
            }
            if (!command.overrideProtected && replaced.some(session => session.protected)) errors.push(conflict("protected_session", "This change would remove protected work time. Bryan must explicitly override it.", [item.id]));
            else {
              const replacedIds = new Set(replaced.map(session => session.id));
              draft.sessions = draft.sessions.filter(session => !replacedIds.has(session.id));
              draft.sessions.push(...clone(command.sessions.filter(session => !unchanged.has(session.id))));
              explicitIds.add(item.id);
            }
          }
        } else if (urgentIds.has(item.id)) {
          const ownSessions = draft.sessions.filter((session) => session.workItemId === item.id && planned(session) && instantMs(session.end) > instantMs(now));
          if (!command.overrideProtected && ownSessions.some((session) => session.protected)) errors.push(conflict("protected_session", "Moving this work earlier would change protected time; explicitly override it.", [item.id]));
          else for (const session of ownSessions) {
            if (session.protected) replacementProtected.add(item.id);
            removeFutureSession(draft, session, now);
          }
        }
        summaries.push(`Scheduled ${item.title}.`);
      }
    }
    if (errors.length) return fail(errors);
    for (const id of explicitIds) {
      const original = snapshot.items.find(item => item.id === id), item = draft.items.find(item => item.id === id);
      if (!original || !item) continue;
      // An exact replacement states how much time to reserve, including fewer
      // hours or no future sessions. An explicit effort edit in this same
      // transaction does not authorize filling any unreserved remainder.
      if (commands.some(command => command.type === "schedule" && command.itemId === id && command.sessions !== undefined
        || command.type === "move" && snapshot.sessions.some(session => session.id === command.sessionId && session.workItemId === id))) {
        preserveReservationIds.add(id);
        continue;
      }
      if (original.remainingMinutes === null || original.remainingMinutes !== item.remainingMinutes || original.estimatedMinutes !== item.estimatedMinutes) continue;
      const originallyReserved = snapshot.sessions.filter(session => session.workItemId === id).reduce((sum, session) => sum + futureMinutes(session, now), 0);
      if (originallyReserved < Math.ceil(original.remainingMinutes / draft.settings.slotMinutes) * draft.settings.slotMinutes) preserveReservationIds.add(id);
    }
    for (const id of scheduleIds) {
      const item = draft.items.find((entry) => entry.id === id)!;
      errors.push(...itemConflicts(draft, item));
      if (errors.length) continue;
      if (!liveItem(item)) {
        if (explicitIds.has(id) || commands.some(command => command.type === "schedule" && command.itemId === id)) {
          errors.push(conflict("inactive_work", `“${item.title}” is ${item.status}. Resume it with an effort estimate before scheduling time.`, [id]));
          continue;
        }
        // Explicit completion/cancellation releases its own reservation, including protected
        // time. Merely pausing/waiting still needs permission to remove protected sessions.
        const release = cancelFuture(draft, id, now, protectedOverride(id) || item.status === "completed" || item.status === "cancelled");
        if (release) errors.push(release);
        if (item.status === "completed") for (const session of draft.sessions) {
          if (session.workItemId === id && planned(session) && instantMs(session.end) <= instantMs(now)) session.status = "completed";
        }
        continue;
      }
      if (item.dailyPlan?.length && item.remainingMinutes !== null && item.dailyPlan.reduce((sum, day) => sum + day.minutes, 0) > (preserveReservationIds.has(id) ? explicitReservationLimit(snapshot, item, true) : Math.ceil(item.remainingMinutes / draft.settings.slotMinutes) * draft.settings.slotMinutes)) {
        errors.push(conflict("daily_hours_total", `The daily hours for “${item.title}” exceed its remaining effort. Adjust the daily plan along with the remaining hours.`, [id]));
        continue;
      }
      if (!explicitIds.has(id) && commands.some(command => command.type === "update" && command.itemId === id && command.patch.dailyPlan !== undefined)) {
        const cancellation = cancelFuture(draft, id, now, protectedOverride(id));
        if (cancellation) { errors.push(cancellation); continue; }
      }
      const invalid = draft.sessions.filter((session) => session.workItemId === id && planned(session) && (
        (instantMs(session.end) <= instantMs(now) && !explicitIds.has(id)) || !permitsDate(item, localDate(session.start, draft.settings.timeZone))
      ));
      for (const session of invalid) {
        if (preserveReservationIds.has(id)) { errors.push(conflict("outside_allowed_dates", `The supplied booking for “${item.title}” is outside its explicit scheduling limits or firm deadline. Review Scheduling limits in Edit details.`, [id])); continue; }
        if (session.protected && instantMs(session.end) > instantMs(now) && !protectedOverride(id)) errors.push(conflict("protected_session", `Changing “${item.title}” would move protected time.`, [id]));
        else {
          if (session.protected && instantMs(session.end) > instantMs(now)) replacementProtected.add(id);
          draft.sessions = draft.sessions.filter((entry) => entry.id !== session.id);
        }
      }
      if (preserveReservationIds.has(id)) {
        const reserved = draft.sessions.filter(session => session.workItemId === id).reduce((sum, session) => sum + bookedMinutes(session), 0);
        if (reserved > explicitReservationLimit(snapshot, item)) errors.push(conflict("booking_effort", "These explicit bookings exceed remaining effort. Reduce the booked hours or explicitly update remaining effort.", [id]));
        continue;
      }
      const trimming = trimExcess(draft, item, now, protectedOverride(id));
      if (trimming) errors.push(trimming);
    }
    if (errors.length) return fail(errors);
    // A meeting changes availability, not how much project effort the owner
    // chose to reserve. Broad effort allocation cannot safely reconstruct an
    // intentionally partial booking; require its explicit move instead.
    const partiallyBookedIds = new Set(commands.every(command => command.type === "block") ? snapshot.items.filter(item => {
      if (item.remainingMinutes === null || item.dailyPlan?.length) return false;
      const reserved = snapshot.sessions.filter(session => session.workItemId === item.id).reduce((sum, session) => sum + futureMinutes(session, now), 0);
      return reserved > 0 && reserved < Math.ceil(item.remainingMinutes / draft.settings.slotMinutes) * draft.settings.slotMinutes;
    }).map(item => item.id) : []);
    for (const block of changedBlocks) {
      const collisions = draft.sessions.filter((session) => planned(session) && overlap(range(session), range(block)));
      for (const session of collisions) {
        if (instantMs(session.start) < instantMs(now)) errors.push(conflict("historical_session", "This meeting or time off overlaps work that has already started. Finish or update that work explicitly before changing its reserved time.", [session.workItemId]));
        else if (session.protected && !protectedOverride(session.workItemId)) errors.push(conflict("protected_session", "Unavailable time would displace a protected session; explicitly override it.", [session.workItemId]));
        else if (partiallyBookedIds.has(session.workItemId)) errors.push(conflict("partial_booking_displacement", "This project has only some of its remaining effort booked. Move its overlapping sessions explicitly before adding or moving this meeting or time off; its booked hours have not changed.", [session.workItemId]));
        else {
          if (session.protected) replacementProtected.add(session.workItemId);
          removeFutureSession(draft, session, now); scheduleIds.add(session.workItemId); forcedDisplacedIds.add(session.workItemId);
        }
      }
    }
    if (errors.length) return fail(errors);
    if (actor.role === "owner" || actor.role === "requester") {
      // A precise owner placement authorizes ordinary displacement at that position.
      // Requester exact-slot collisions remain proposals, never implicit edits.
      const explicitSessions = draft.sessions.filter((session) => explicitIds.has(session.workItemId) && futureMinutes(session, now) > 0);
      for (const fixed of explicitSessions) {
        const collisions = draft.sessions.filter((session) => session.workItemId !== fixed.workItemId && planned(session) && overlap(range(session), range(fixed)));
        for (const session of collisions) {
          if (explicitIds.has(session.workItemId)) { errors.push(conflict("overlap", "Two explicitly requested work sessions overlap.", [fixed.workItemId, session.workItemId])); continue; }
          if (instantMs(session.start) < instantMs(now)) { errors.push(conflict("historical_session", "This placement overlaps another planned booking whose time has started. Move that booking explicitly first.", [session.workItemId])); continue; }
          if (session.protected && !protectedOverride(session.workItemId)) { errors.push(conflict("protected_session", "This placement would move protected work; explicitly override it.", [session.workItemId])); continue; }
          if (actor.role === "requester") {
            const other = snapshot.items.find(item => item.id === session.workItemId)!;
            const reserved = snapshot.sessions.filter(prior => prior.workItemId === other.id).reduce((sum, prior) => sum + futureMinutes(prior, now), 0);
            if (other.remainingMinutes === null || reserved < Math.ceil(other.remainingMinutes / draft.settings.slotMinutes) * draft.settings.slotMinutes) {
              errors.push(conflict("partial_booking_displacement", "Move this project's bookings explicitly before using their time; its chosen booked hours cannot be automatically reconstructed.", [other.id]));
              continue;
            }
          }
          if (session.protected) replacementProtected.add(session.workItemId);
          removeFutureSession(draft, session, now);
          scheduleIds.add(session.workItemId); forcedDisplacedIds.add(session.workItemId);
        }
      }
    }
    // Cancelling/reducing an unexpected-work reservation can close capacity it previously released.
    // Replan affected ordinary sessions instead of leaving a hidden reserve violation.
    const reserveDependent = draft.sessions.filter((session) => {
      if (!planned(session) || session.usesReserve || instantMs(session.end) <= instantMs(now)) return false;
      const reserved = reserveBlock(draft, localDate(session.start, draft.settings.timeZone), now);
      return reserved && overlap(range(session), reserved);
    });
    for (const session of reserveDependent) {
      if (explicitIds.has(session.workItemId) || actor.role !== "owner") continue;
      if (session.protected && !protectedOverride(session.workItemId)) { errors.push(conflict("protected_session", "Changing unexpected-work reserve would move protected work; explicitly override it.", [session.workItemId])); continue; }
      if (session.protected) replacementProtected.add(session.workItemId);
      removeFutureSession(draft, session, now);
      scheduleIds.add(session.workItemId); forcedDisplacedIds.add(session.workItemId);
    }
    if (errors.length) return fail(errors);

    // Allocate fixed/restricted work before flexible priority work. Within restricted
    // work, an earlier final eligible day and fewer allowed days are tighter limits.
    // Urgency affects priority, never permission to break a hard date or protection.
    const hardWindow = (item: WorkItem) => {
      const lastAllowed = [...allowedWorkDates(item)].sort().at(-1);
      const bookingWindow = bookingWindows.get(item.id);
      return {
        constrained: !!item.deadline || !!lastAllowed || !!bookingWindow,
        end: [item.deadline, lastAllowed, bookingWindow?.endDate].filter((date): date is string => !!date).sort()[0] ?? "9999",
        days: Math.min(new Set(allowedWorkDates(item)).size || Number.MAX_SAFE_INTEGER, bookingWindow?.dates.size ?? Number.MAX_SAFE_INTEGER),
      };
    };
    const compareWork = (a: WorkItem, b: WorkItem) => {
      const aWindow = hardWindow(a); const bWindow = hardWindow(b);
      const effectiveRank = (item: WorkItem) => urgentIds.has(item.id) ? Math.min(0, rank(draft, item)) : rank(draft, item);
      return Number(explicitIds.has(b.id)) - Number(explicitIds.has(a.id)) ||
        Number(bWindow.constrained) - Number(aWindow.constrained) ||
        aWindow.end.localeCompare(bWindow.end) || aWindow.days - bWindow.days ||
        effectiveRank(a) - effectiveRank(b) || (target(a) ?? "9999").localeCompare(target(b) ?? "9999") ||
        a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
    };
    const queue = [...scheduleIds].map((id) => draft.items.find((item) => item.id === id)!).filter(liveItem).sort(compareWork);
    const requester = actor.role === "requester";
    const displacedIds = new Set<string>(forcedDisplacedIds);
    const settledIds = new Set<string>();
    let requiresApproval = requester && forcedDisplacedIds.size > 0;
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const item = queue[cursor];
      // Explicitly completing one daily booking releases it; it does not book
      // that same effort again or silently change the project estimate.
      if (completedDailyIds.has(item.id)) continue;
      // Manual replacements and moves of partial bookings preserve the owner's
      // reservation decision without filling unreserved estimated effort.
      if (preserveReservationIds.has(item.id)) continue;
      settledIds.add(item.id);
      const incomingRequest = requester && !snapshot.items.some((existing) => existing.id === item.id);
      const desiredEnd = target(item);
      const useReserve = !requester && urgentIds.has(item.id);
      const urgent = urgentIds.has(item.id);
      const ownerApproved = actor.role === "owner" && !!options.approveDisplacement;
      const accept = (sessions: WorkSession[]) => draft.sessions.push(...sessions.map((session) => ({ ...session, protected: replacementProtected.has(item.id) || session.protected })));
      const clean = allocate(draft, item, { until: desiredEnd ?? undefined, useReserve });
      if (item.dailyPlan?.length) {
        // Day entry stays clean-fit. Only an incoming request or its owner review
        // can use the existing displacement proposal path within these dates.
        if (clean.missing && !(bookingWindows.has(item.id) && (incomingRequest || ownerApproved))) {
          errors.push(conflict("daily_capacity", `“${item.title}” cannot fit its requested hours on ${clean.missingDate}. Choose a different date or adjust that day’s hours; no days have been changed.`, [item.id]));
          break;
        }
        if (explicitIds.has(item.id) && clean.sessions.length) {
          errors.push(conflict("daily_hours", "The supplied sessions do not match every daily-hour amount. Adjust the daily plan explicitly.", [item.id]));
          break;
        }
        if (!clean.missing) { accept(clean.sessions); continue; }
      }
      if (!urgent && clean.missing === 0) { accept(clean.sessions); continue; }
      if (explicitIds.has(item.id)) {
        if (clean.missing === 0) { accept(clean.sessions); continue; }
        errors.push(conflict("insufficient_sessions", `The supplied sessions do not fit the remaining effort for “${item.title}”.`, [item.id]));
        break;
      }
      // Borrow only lower-ranked work (or equal-ranked work for an explicit urgent action).
      // Requester priority is considered solely in the approval preview, never on clean fit.
      const requestedRank = incomingRequest && item.requestedPriorityId ? draft.priorities.find((priority) => priority.id === item.requestedPriorityId)?.rank ?? rank(draft, item) : rank(draft, item);
      const movable = draft.sessions.filter((session) => {
        const other = draft.items.find((candidate) => candidate.id === session.workItemId);
        return other && other.id !== item.id && planned(session) && instantMs(session.end) > instantMs(now) &&
          (!session.protected || protectedOverride(other.id)) && !explicitIds.has(other.id) && !settledIds.has(other.id) &&
          (rank(draft, other) > requestedRank || ((urgent || incomingRequest || ownerApproved) && rank(draft, other) === requestedRank));
      });
      const ignore = new Set(movable.map((session) => session.id));
      const borrowed = allocate(draft, item, { until: desiredEnd ?? undefined, useReserve, ignore });
      const hasEarlierPlacement = borrowed.sessions.length > 0 && (clean.missing > 0 || !clean.sessions.length || instantMs(borrowed.sessions[0].start) < instantMs(clean.sessions[0].start));
      if (borrowed.missing === 0 && hasEarlierPlacement) {
        const overlaps = movable.filter((session) => borrowed.sessions.some((added) => overlap(range(session), range(added))));
        // Prove the displaced work still fits before accepting a seemingly attractive
        // earlier slot. Otherwise a valid clean placement could be rejected needlessly.
        const trial = clone(draft);
        for (const old of overlaps) removeFutureSession(trial, trial.sessions.find((session) => session.id === old.id)!, now);
        trial.sessions.push(...borrowed.sessions.map((session) => ({ ...session, protected: replacementProtected.has(item.id) || session.protected })));
        const displaced = [...new Set(overlaps.map((session) => session.workItemId))].map((id) => trial.items.find((entry) => entry.id === id)!).sort(compareWork);
        let repairable = true;
        for (const displacedItem of displaced) {
          const repair = allocate(trial, displacedItem);
          if (repair.missing > 0) { repairable = false; break; }
          const keepProtected = replacementProtected.has(displacedItem.id) || overlaps.some((session) => session.workItemId === displacedItem.id && session.protected);
          trial.sessions.push(...repair.sessions.map((session) => ({ ...session, protected: keepProtected })));
        }
        if (repairable) {
          draft.sessions = trial.sessions;
          for (const displacedItem of displaced) {
            displacedIds.add(displacedItem.id);
            if (overlaps.some((session) => session.workItemId === displacedItem.id && session.protected)) replacementProtected.add(displacedItem.id);
          }
          if (requester && overlaps.length) requiresApproval = true;
          continue;
        }
      }
      if (clean.missing === 0) { accept(clean.sessions); continue; }
      if (!incomingRequest) {
        const later = allocate(draft, item, { useReserve });
        if (later.missing === 0) {
          accept(later.sessions);
          if (desiredEnd) summaries.push(`${item.title} is forecast after its requested target ${desiredEnd}; its firm deadline is unchanged.`);
          continue;
        }
      }
      if (incomingRequest) result.alternatives.push(...alternatives(draft, item, now));
      errors.push(conflict(item.deadline ? "firm_deadline" : "capacity", `The remaining ${item.remainingMinutes} minutes for “${item.title}” cannot fit ${item.deadline ? `before its firm deadline ${item.deadline}` : "within the requested dates and available openings"}.`, [item.id]));
      break;
    }
    if (errors.length) return fail(errors, requester ? "approval_required" : "infeasible");
    const validation = validateSchedule(draft, now);
    // Explicitly supplied sessions may never create past work, even if other historical
    // sessions are retained as history in the same snapshot.
    const oldSessions = new Map(snapshot.sessions.map((session) => [session.id, session]));
    for (const session of draft.sessions) {
      const original = oldSessions.get(session.id);
      if (planned(session) && (!original || original.start !== session.start) && instantMs(session.start) < instantMs(now)) validation.push(conflict("past_session", "A new work session cannot be scheduled in the past.", [session.workItemId]));
    }
    if (validation.length) return fail(validation, requester ? "approval_required" : "infeasible");
    // Unknown remaining effort cannot reconstruct displaced reservations. Never
    // silently drop them during automatic replanning; ask for an explicit move.
    for (const item of snapshot.items.filter(entry => entry.remainingMinutes === null && liveItem(entry))) {
      const lost = snapshot.sessions.some(old => old.workItemId === item.id && futureMinutes(old, now) > 0
        && !draft.sessions.some(next => next.id === old.id && next.start === old.start && next.end === old.end && next.status === old.status)
        && !commands.some(command =>
          (command.type === "schedule" && command.itemId === item.id && command.sessions !== undefined)
          || (command.type === "status" && command.itemId === item.id && ["waiting", "completed", "cancelled"].includes(command.status))
          || ((command.type === "move" || command.type === "complete_session") && command.sessionId === old.id)
          || (command.type === "update" && command.itemId === item.id && command.patch.dailyPlan !== undefined)
          || ((command.type === "progress" || command.type === "update") && command.itemId === item.id && (command.type === "progress" ? command.remainingMinutes !== undefined : command.patch.remainingMinutes !== undefined && command.patch.remainingMinutes !== null))));
      if (lost) return fail([conflict("unknown_effort_displacement", `“${item.title}” has an unknown total. Move its booked sessions explicitly before changing time they occupy.`, [item.id])], requester ? "approval_required" : "infeasible");
    }
    refreshForecasts(draft, now, new Set([...scheduleIds, ...displacedIds]));
    for (const item of draft.items.filter(item => preserveReservationIds.has(item.id))) {
      const reserved = draft.sessions.filter(session => session.workItemId === item.id).reduce((sum, session) => sum + futureMinutes(session, now), 0);
      if (item.remainingMinutes !== null && reserved < Math.ceil(item.remainingMinutes / draft.settings.slotMinutes) * draft.settings.slotMinutes) item.forecastDate = null;
    }
    const affected = new Set(changes(snapshot, draft));
    for (const command of commands) if (command.type === "client_update") affected.add(command.itemId);
    for (const id of displacedIds) {
      const item = draft.items.find((entry) => entry.id === id)!;
      item.updatedAt = now;
      summaries.push(`Moved remaining work for ${item.title}${item.forecastDate ? `; forecast ${item.forecastDate}` : ""}.`);
    }
    result.items = draft.items; result.sessions = draft.sessions; result.blocks = draft.blocks;
    result.affectedItemIds = [...affected]; result.summary = summaries;
    result.requiresApproval = requiresApproval;
    result.status = requiresApproval ? "approval_required" : "ready";
    if (requiresApproval) {
      result.conflicts.push(conflict("displacement_approval", "This request would move existing work. Bryan must approve the displayed changes.", [...displacedIds]));
      for (const item of queue.filter((entry) => !snapshot.items.some((old) => old.id === entry.id))) result.alternatives.push(...alternatives(snapshot, item, now));
    }
    return result;
  } catch (error) {
    return fail([conflict("invalid_input", error instanceof Error ? error.message : "The proposed calendar change is invalid.")]);
  }
}
