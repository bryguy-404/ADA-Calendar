import { describe, expect, it } from "vitest";
import { DEFAULT_PRIORITIES, DEFAULT_SETTINGS } from "./defaults";
import { dayCapacity, planCommands, validateSchedule } from "./scheduler";
import { addDays, dayOfWeek, localDate, localDateTime, minutesBetween, nextWorkDate } from "./time";
import type { Actor, ScheduleProposal, ScheduleSnapshot, WorkItem, WorkSession } from "./types";

const DAY = "2026-09-07";
const zone = DEFAULT_SETTINGS.timeZone;
const at = (time: string, date = DAY) => localDateTime(date, time, zone);
const NOW = at("08:00");
const owner: Actor = { id: "bryan", name: "Bryan", email: "bryan@example.test", role: "owner" };
const requester: Actor = { id: "william", name: "William", email: "william@example.test", role: "requester" };

function item(id: string, minutes = 60, patch: Partial<WorkItem> = {}): WorkItem {
  return {
    id, clientId: "client", title: id, description: "", category: "web", webKind: "edit",
    requesterId: null, requestedBy: "Bryan", priorityId: "normal", requestedPriorityId: null,
    status: "planned", estimatedMinutes: minutes, remainingMinutes: minutes,
    windowStart: DAY, windowEnd: null, targetDate: DAY, deadline: null, forecastDate: null,
    completedAt: null, blockedReason: null, minimumSessionMinutes: 15, allowedDates: [],
    checklist: [], progressTotal: null, progressCompleted: 0, updateDate: null,
    references: [], createdAt: NOW, updatedAt: NOW, ...patch,
  };
}

function session(workItemId: string, start: string, end: string, patch: Partial<WorkSession> = {}): WorkSession {
  return { id: `${workItemId}-${start}`, workItemId, start: at(start), end: at(end), protected: false, status: "planned", usesReserve: false, ...patch };
}

function snapshot(items: WorkItem[] = [], sessions: WorkSession[] = []): ScheduleSnapshot {
  return { workspaceId: "workspace", version: 7, settings: structuredClone(DEFAULT_SETTINGS), clients: [{ id: "client", name: "Test client", aliases: [] }], priorities: structuredClone(DEFAULT_PRIORITIES), items, sessions, blocks: [] };
}

function apply(base: ScheduleSnapshot, proposal: ScheduleProposal): ScheduleSnapshot {
  return { ...base, items: proposal.items, sessions: proposal.sessions, blocks: proposal.blocks, version: base.version + 1 };
}

const sessionsFor = (proposal: ScheduleProposal, id: string) => proposal.sessions.filter((entry) => entry.workItemId === id && entry.status === "planned");
const total = (sessions: WorkSession[]) => sessions.reduce((sum, entry) => sum + minutesBetween(entry.start, entry.end), 0);

describe("working-time arithmetic", () => {
  it("uses the workspace timezone across DST and skips weekends", () => {
    expect(localDateTime("2026-10-30", "09:00", zone)).toBe("2026-10-30T13:00:00Z");
    expect(localDateTime("2026-11-02", "09:00", zone)).toBe("2026-11-02T14:00:00Z");
    expect(nextWorkDate("2026-10-31", DEFAULT_SETTINGS)).toBe("2026-11-02");
    expect(dayOfWeek(DAY)).toBe(1);
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(localDate("2026-09-08T01:00:00Z", zone)).toBe(DAY);
  });

  it("offers 390 ordinary minutes; project spans alone reserve nothing", () => {
    const base = snapshot([item("month-long software", 600, { category: "software", windowEnd: "2026-09-30" })]);
    expect(dayCapacity(base, DAY, NOW)).toEqual({ plannedMinutes: 0, availableMinutes: 390, capacityMinutes: 390 });
    expect(dayCapacity(base, "2026-09-12", NOW)).toEqual({ plannedMinutes: 0, availableMinutes: 0, capacityMinutes: 0 });
  });

  it("offers 450 ordinary minutes when the workspace disables reserve, with weekends still closed", () => {
    const base = snapshot();
    base.settings.reserveMinutes = 0;
    expect(dayCapacity(base, DAY, NOW)).toEqual({ plannedMinutes: 0, availableMinutes: 450, capacityMinutes: 450 });
    expect(dayCapacity(base, "2026-09-12", NOW)).toEqual({ plannedMinutes: 0, availableMinutes: 0, capacityMinutes: 0 });
    expect(dayCapacity(base, "2026-09-13", NOW)).toEqual({ plannedMinutes: 0, availableMinutes: 0, capacityMinutes: 0 });
    expect(validateSchedule(base, NOW)).toEqual([]);
    expect(DEFAULT_SETTINGS.reserveMinutes).toBe(60);
  });

  it("deducts unavailable time once even when it overlaps lunch", () => {
    const base = snapshot();
    base.blocks.push({ id: "meeting", title: "Meeting", start: at("11:30"), end: at("13:00"), kind: "meeting" });
    expect(dayCapacity(base, DAY, NOW)).toEqual({ plannedMinutes: 0, availableMinutes: 330, capacityMinutes: 330 });
  });
});

describe("deterministic effort allocation", () => {
  it("fills a 450-minute Friday with zero reserve while preserving lunch and the weekend boundary", () => {
    const friday = "2026-09-11";
    const base = snapshot();
    base.settings.reserveMinutes = 0;
    const work = item("weekend-spanning edit", 480, { windowStart: friday, targetDate: friday });
    const result = planCommands(base, [{ type: "create", item: work }], owner, { now: at("08:00", friday) });
    expect(result.status).toBe("ready");
    expect(sessionsFor(result, work.id)).toEqual([
      expect.objectContaining({ start: at("09:00", friday), end: at("12:00", friday), usesReserve: false }),
      expect.objectContaining({ start: at("12:30", friday), end: at("17:00", friday), usesReserve: false }),
      expect.objectContaining({ start: at("09:00", "2026-09-14"), end: at("09:30", "2026-09-14"), usesReserve: false }),
    ]);
    expect(dayCapacity(apply(base, result), friday, NOW)).toEqual({ plannedMinutes: 450, availableMinutes: 0, capacityMinutes: 450 });
    expect(validateSchedule(apply(base, result), at("08:00", friday))).toEqual([]);
  });

  it.each([owner, requester])("lets a $role book 16:00–17:00 normally after disabling reserve without moving existing sessions", (actor) => {
    const old = item("existing", 390, { forecastDate: DAY });
    const base = snapshot([old], [session(old.id, "09:00", "12:00", { protected: true }), session(old.id, "12:30", "16:00")]);
    const original = structuredClone(base);
    expect(dayCapacity(base, DAY, NOW)).toEqual({ plannedMinutes: 390, availableMinutes: 0, capacityMinutes: 390 });
    const updated = { ...base, settings: { ...base.settings, reserveMinutes: 0 } };
    expect(dayCapacity(updated, DAY, NOW)).toEqual({ plannedMinutes: 390, availableMinutes: 60, capacityMinutes: 450 });
    const work = item("normal edit", 60, { deadline: DAY });
    const result = planCommands(updated, [{ type: "create", item: work }], actor, { now: NOW });
    expect(result.status).toBe("ready");
    expect(result.requiresApproval).toBe(false);
    expect(result.conflicts).toEqual([]);
    expect(sessionsFor(result, work.id)).toEqual([
      expect.objectContaining({ start: at("16:00"), end: at("17:00"), usesReserve: false, protected: false }),
    ]);
    expect(sessionsFor(result, old.id)).toEqual(original.sessions);
    expect(result.items.find((entry) => entry.id === old.id)).toEqual(original.items[0]);
    expect(result.affectedItemIds).toEqual([work.id]);
    expect(dayCapacity(apply(updated, result), DAY, NOW)).toEqual({ plannedMinutes: 450, availableMinutes: 0, capacityMinutes: 450 });
    expect(validateSchedule(apply(updated, result), NOW)).toEqual([]);
    expect(base).toEqual(original);
  });

  it("splits work across lunch and weekdays without changing the input", () => {
    const base = snapshot();
    const original = JSON.stringify(base);
    const command = { type: "create" as const, item: item("build", 480, { category: "software", minimumSessionMinutes: 120 }) };
    const result = planCommands(base, [command], owner, { now: NOW, operationId: "stable-operation" });
    expect(result.status).toBe("ready");
    expect(result.baseVersion).toBe(7);
    expect(result.operationId).toBe("stable-operation");
    expect(total(sessionsFor(result, "build"))).toBe(480);
    expect(sessionsFor(result, "build").every((entry) => minutesBetween(entry.start, entry.end) >= 15)).toBe(true);
    expect(result.items[0].forecastDate).toBe("2026-09-08");
    expect(result.items[0].targetDate).toBe(DAY);
    expect(validateSchedule(apply(base, result), NOW)).toEqual([]);
    expect(JSON.stringify(base)).toBe(original);
    const repeated = planCommands(base, [command], owner, { now: NOW });
    expect(repeated.sessions.map(({ start, end }) => [start, end])).toEqual(result.sessions.map(({ start, end }) => [start, end]));
  });

  it("rounds a short estimate into slots without changing the estimate", () => {
    const result = planCommands(snapshot(), [{ type: "create", item: item("quick edit", 20) }], owner, { now: NOW });
    expect(result.status).toBe("ready");
    expect(total(result.sessions)).toBe(30);
    expect(result.items[0].remainingMinutes).toBe(20);
  });

  it.each(["deadline", "allowed dates"] as const)("allocates %s constraints before higher-priority flexible work", (restriction) => {
    const constrained = item("z-constrained", 180, restriction === "deadline" ? { deadline: DAY } : { dateConstraints: { earliestStart: null, allowedDates: [DAY] } });
    const flexible = item("a-flexible", 390, { priorityId: "high" });
    const result = planCommands(snapshot(), [{ type: "create", item: flexible }, { type: "create", item: constrained }], owner, { now: NOW });
    expect(result.status).toBe("ready");
    expect(sessionsFor(result, constrained.id)).toEqual([expect.objectContaining({ start: at("09:00"), end: at("12:00") })]);
    expect(result.items.find(work => work.id === flexible.id)?.forecastDate).toBe("2026-09-08");
    expect(validateSchedule(apply(snapshot(), result), NOW)).toEqual([]);
  });

  it("orders hard deadlines by the last eligible day before applying priority", () => {
    const later = item("a-later-high", 390, { priorityId: "high", deadline: "2026-09-08" });
    const earlier = item("z-earlier-normal", 180, { deadline: DAY });
    const result = planCommands(snapshot(), [{ type: "create", item: later }, { type: "create", item: earlier }], owner, { now: NOW });
    expect(result.status).toBe("ready");
    expect(sessionsFor(result, earlier.id)[0].start).toBe(at("09:00"));
    expect(sessionsFor(result, later.id)[0].start).toBe(at("12:30"));
  });

  it("uses priority, then target, then stable creation time with ID only as a final tie", () => {
    const high = item("z-high", 30, { priorityId: "high", targetDate: "2026-09-09", createdAt: "2026-09-03T12:00:00Z" });
    const early = item("z-early-target", 30, { targetDate: DAY, createdAt: "2026-09-03T12:00:00Z" });
    const older = item("z-old", 30, { targetDate: "2026-09-08", createdAt: "2026-09-01T12:00:00Z" });
    const newer = item("a-new", 30, { targetDate: "2026-09-08", createdAt: "2026-09-02T12:00:00Z" });
    const tied = item("b-new", 30, { targetDate: "2026-09-08", createdAt: newer.createdAt });
    const items = [tied, newer, older, early, high];
    const base = snapshot(items);
    const result = planCommands(base, items.map(work => ({ type: "schedule", itemId: work.id })), owner, { now: NOW });
    expect(result.status).toBe("ready");
    expect([...result.sessions].sort((a, b) => a.start.localeCompare(b.start)).map(session => session.workItemId)).toEqual([high.id, early.id, older.id, newer.id, tied.id]);
  });

  it("never places new work in the past", () => {
    const result = planCommands(snapshot(), [{ type: "create", item: item("late edit", 30) }], owner, { now: at("14:07") });
    expect(result.status).toBe("ready");
    expect(result.sessions[0].start).toBe(at("14:15"));
  });

  it("aligns work after a meeting that ends between scheduling increments", () => {
    const base = snapshot();
    base.blocks.push({ id: "meeting", title: "Meeting", start: at("09:00"), end: at("09:07"), kind: "meeting" });
    const result = planCommands(base, [{ type: "create", item: item("edit", 30) }], owner, { now: NOW });
    expect(result.status).toBe("ready");
    expect(result.sessions[0].start).toBe(at("09:15"));
  });

  it("preserves unaffected sessions and forecasts exactly", () => {
    const old = item("existing", 60, { forecastDate: DAY });
    const held = session(old.id, "13:00", "14:00");
    const base = snapshot([old], [held]);
    const result = planCommands(base, [{ type: "create", item: item("new", 30) }], owner, { now: NOW });
    expect(result.status).toBe("ready");
    expect(result.sessions.find((entry) => entry.id === held.id)).toEqual(held);
    expect(result.items.find((entry) => entry.id === old.id)).toEqual(old);
    expect(result.affectedItemIds).toEqual(["new"]);
  });

  it("fits hours across shorter openings without a project focus minimum", () => {
    const base = snapshot([item("other", 180)], [session("other", "09:00", "11:00"), session("other", "13:30", "14:30")]);
    const result = planCommands(base, [{ type: "create", item: item("focus", 180, { minimumSessionMinutes: 120, deadline: DAY }) }], owner, { now: NOW });
    expect(result.status).toBe("ready");
    expect(total(sessionsFor(result,"focus"))).toBe(180);
    expect(result.sessions.slice(0,base.sessions.length)).toEqual(base.sessions);
  });

  it("respects allowed dates and real deadlines", () => {
    const base = snapshot();
    const result = planCommands(base, [{ type: "create", item: item("deadline", 480, { deadline: DAY, allowedDates: [DAY] }) }], owner, { now: NOW });
    expect(result.status).toBe("infeasible");
    expect(result.items).toEqual([]);
    expect(result.conflicts[0].code).toBe("firm_deadline");
  });

  it("rolls back the entire batch when its second command is impossible", () => {
    const base = snapshot();
    const result = planCommands(base, [{ type: "create", item: item("small", 30) }, { type: "create", item: item("impossible", 600, { deadline: DAY }) }], owner, { now: NOW });
    expect(result.status).toBe("infeasible");
    expect(result.items).toEqual([]);
    expect(result.sessions).toEqual([]);
  });
});

describe("requester authority and collision previews", () => {
  it("accepts clean fit at Normal priority and preserves the requested priority separately", () => {
    const result = planCommands(snapshot(), [{ type: "create", item: item("requested", 60, { priorityId: "urgent" }), urgent: true }], requester, { now: NOW });
    expect(result.status).toBe("ready");
    expect(result.items[0]).toMatchObject({ requesterId: requester.id, requestedBy: requester.name, priorityId: "normal", requestedPriorityId: "urgent" });
    expect(result.sessions.every((entry) => !entry.usesReserve)).toBe(true);
  });

  it("requires a supplied estimate and rejects viewer writes and requester edits", () => {
    const old = item("existing");
    const base = snapshot([old]);
    const noEstimate = planCommands(base, [{ type: "create", item: item("missing", 30, { estimatedMinutes: null }) }], requester, { now: NOW });
    expect(noEstimate.status).toBe("infeasible");
    expect(noEstimate.conflicts[0].code).toBe("missing_estimate");
    expect(planCommands(base, [{ type: "update", itemId: old.id, patch: { title: "Changed" } }], requester, { now: NOW }).conflicts[0].code).toBe("forbidden");
    expect(planCommands(base, [{ type: "create", item: item("blocked") }], { ...requester, role: "viewer" }, { now: NOW }).conflicts[0].code).toBe("forbidden");
  });

  it("shows displacement and clean-fit alternatives without changing existing work", () => {
    const old = item("existing", 390, { forecastDate: DAY });
    const base = snapshot([old], [session(old.id, "09:00", "12:00"), session(old.id, "12:30", "16:00")]);
    const result = planCommands(base, [{ type: "create", item: item("requested", 60, { requestedPriorityId: "high" }) }], requester, { now: NOW });
    expect(result.status).toBe("approval_required");
    expect(result.requiresApproval).toBe(true);
    expect(result.conflicts[0].code).toBe("displacement_approval");
    expect(result.affectedItemIds).toContain(old.id);
    expect(result.items.find((entry) => entry.id === old.id)?.forecastDate).toBe("2026-09-08");
    expect(result.alternatives.length).toBeGreaterThan(0);
    expect(localDate(result.alternatives[0].start, zone)).toBe("2026-09-08");
    expect(base.items[0].forecastDate).toBe(DAY);
  });

  it("does not authorize displacement when a requester passes the approval option", () => {
    const old = item("existing", 390);
    const base = snapshot([old], [session(old.id, "09:00", "12:00"), session(old.id, "12:30", "16:00")]);
    const result = planCommands(base, [{ type: "create", item: item("request", 60) }], requester, { now: NOW, approveDisplacement: true });
    expect(result.status).toBe("approval_required");
  });

  it("recomputes stale same-slot previews against the new version instead of silently overlapping", () => {
    const base = snapshot();
    const firstCommand = { type: "create" as const, item: item("first", 30), sessions: [session("first", "09:00", "09:30")] };
    const secondCommand = { type: "create" as const, item: item("second", 30), sessions: [session("second", "09:00", "09:30")] };
    const first = planCommands(base, [firstCommand], requester, { now: NOW });
    const stale = planCommands(base, [secondCommand], requester, { now: NOW });
    expect(first.status).toBe("ready"); expect(stale.status).toBe("ready");
    const committed = apply(base, first);
    const recomputed = planCommands(committed, [secondCommand], requester, { now: NOW });
    expect(recomputed.baseVersion).toBe(8);
    expect(recomputed.status).toBe("approval_required");
    expect(recomputed.sessions).toEqual(committed.sessions);
    expect(recomputed.conflicts.some((entry) => entry.code === "overlap")).toBe(true);
  });

  it("cannot consume reserve through a supplied session", () => {
    const result = planCommands(snapshot(), [{ type: "create", item: item("it", 30, { category: "it" }), sessions: [session("it", "16:00", "16:30", { usesReserve: true })] }], requester, { now: NOW });
    expect(result.status).toBe("infeasible");
    expect(result.conflicts[0].code).toBe("invalid_session");
  });

  it("owner approval reruns the proposal while retaining its requester origin", () => {
    const old = item("existing", 390);
    const base = snapshot([old], [session(old.id, "09:00", "12:00"), session(old.id, "12:30", "16:00")]);
    const newWork = item("request", 60, { requesterId: requester.id, requestedBy: requester.name, priorityId: "high", requestedPriorityId: "high" });
    const result = planCommands(base, [{ type: "create", item: newWork }], owner, { now: NOW, approveDisplacement: true });
    expect(result.status).toBe("ready");
    expect(result.items.find((entry) => entry.id === newWork.id)).toMatchObject({ requesterId: requester.id, requestedBy: requester.name, priorityId: "high" });
    expect(result.affectedItemIds).toContain(old.id);
  });

  it("honors the owner's reviewed priority instead of promoting a requester's suggestion", () => {
    const newWork = item("request", 60, { requesterId: requester.id, requestedBy: requester.name, priorityId: "low", requestedPriorityId: "urgent" });
    const result = planCommands(snapshot(), [{ type: "create", item: newWork }], owner, { now: NOW, approveDisplacement: true });
    expect(result.status).toBe("ready");
    expect(result.items[0]).toMatchObject({ priorityId: "low", requestedPriorityId: "urgent", requesterId: requester.id });
  });

  it("accepts explicitly supplied short sessions without project focus limits", () => {
    const result = planCommands(snapshot(), [{ type: "create", item: item("focus", 120, { minimumSessionMinutes: 120 }), sessions: [session("focus", "09:00", "10:00"), session("focus", "11:00", "12:00")] }], requester, { now: NOW });
    expect(result.status).toBe("ready");
    expect(total(result.sessions)).toBe(120); expect(result.sessions).toHaveLength(2);
  });
});

describe("interruptions and reserve accounting", () => {
  it.each(["web", "software"] as const)("allows owner-authorized urgent %s work to use reserve, but not requester urgency", (category) => {
    const work = item("unexpected", 60, { category, minimumSessionMinutes: category === "software" ? 120 : 15 });
    const result = planCommands(snapshot(), [{ type: "create", item: work, urgent: true }], owner, { now: at("16:00") });
    expect(result.status).toBe("ready");
    expect(sessionsFor(result, work.id)).toEqual([expect.objectContaining({ start: at("16:00"), end: at("17:00"), usesReserve: true })]);
    expect(validateSchedule(apply(snapshot(), result), at("16:00"))).toEqual([]);
    const denied = planCommands(snapshot(), [{ type: "create", item: work, urgent: true }], requester, { now: at("16:00") });
    expect(denied.status).toBe("approval_required");
    expect(denied.sessions.every(session => !session.usesReserve)).toBe(true);
    const explicit = planCommands(snapshot(), [{ type: "create", item: work, sessions: [session(work.id, "16:00", "17:00", { usesReserve: true })] }], requester, { now: at("16:00") });
    expect(explicit.status).toBe("infeasible");
    expect(explicit.conflicts.some(conflict => conflict.code === "invalid_session")).toBe(true);
  });

  it("exchanges earlier IT interruption time for reserve once, retaining reported progress", () => {
    const old = item("landing batch", 390, { remainingMinutes: 330, forecastDate: DAY });
    const base = snapshot([old], [session(old.id, "09:00", "12:00"), session(old.id, "12:30", "16:00")]);
    const result = planCommands(base, [{ type: "create", item: item("outage", 60, { category: "it", priorityId: "urgent" }), urgent: true }], owner, { now: at("10:00") });
    expect(result.status).toBe("ready");
    expect(sessionsFor(result, "outage")[0]).toMatchObject({ start: at("10:00"), end: at("11:00"), usesReserve: true });
    const remaining = sessionsFor(result, old.id).filter((entry) => entry.end > at("10:00"));
    expect(total(remaining)).toBe(330);
    expect(result.items.find((entry) => entry.id === old.id)?.remainingMinutes).toBe(330);
    expect(result.items.find((entry) => entry.id === old.id)?.forecastDate).toBe(DAY);
    expect(validateSchedule(apply(base, result), at("10:00"))).toEqual([]);
    expect(dayCapacity(apply(base, result), DAY, NOW)).toEqual({ plannedMinutes: 390, availableMinutes: 0, capacityMinutes: 390 });
  });

  it("never recovers reserve that already elapsed", () => {
    const priorIT = item("morning outage", 60, { category: "it", remainingMinutes: 0, status: "completed", completedAt: at("11:00") });
    const base = snapshot([priorIT], [session(priorIT.id, "10:00", "11:00", { usesReserve: true, status: "completed" })]);
    const result = planCommands(base, [{ type: "create", item: item("late work", 60) }], owner, { now: at("16:30") });
    expect(result.status).toBe("ready");
    const work = sessionsFor(result, "late work");
    expect(work[0]).toMatchObject({ start: at("16:30"), end: at("17:00") });
    expect(work[1].start).toBe(at("09:00", "2026-09-08"));
    expect(total(work)).toBe(60);
  });

  it("keeps used reserve released after the IT task is explicitly completed", () => {
    const old = item("outage", 60, { category: "it", priorityId: "urgent" });
    const other = item("shifted work", 60);
    const base = snapshot([old, other], [session(old.id, "10:00", "11:00", { usesReserve: true }), session(other.id, "16:00", "17:00")]);
    const result = planCommands(base, [{ type: "status", itemId: old.id, status: "completed" }], owner, { now: at("11:00") });
    expect(result.status).toBe("ready");
    expect(result.sessions.find((entry) => entry.workItemId === old.id)?.status).toBe("completed");
    expect(validateSchedule(apply(base, result), at("11:00"))).toEqual([]);
  });

  it("replans ordinary work when a cancelled future outage no longer consumes reserve", () => {
    const outage = item("outage", 60, { category: "it" });
    const ordinary = item("ordinary", 60);
    const base = snapshot([outage, ordinary], [session(outage.id, "09:00", "10:00", { usesReserve: true }), session(ordinary.id, "16:00", "17:00")]);
    const result = planCommands(base, [{ type: "status", itemId: outage.id, status: "cancelled" }], owner, { now: NOW });
    expect(result.status).toBe("ready");
    expect(sessionsFor(result, ordinary.id)[0]).toMatchObject({ start: at("09:00"), end: at("10:00") });
    expect(validateSchedule(apply(base, result), NOW)).toEqual([]);
  });

  it("uses a clean later placement when earlier time is protected", () => {
    const old = item("firm focused work", 180, { minimumSessionMinutes: 180, deadline: DAY });
    const base = snapshot([old], [session(old.id, "09:00", "12:00", { protected: true })]);
    base.blocks.push({ id: "meeting", title: "Meeting", start: at("13:00"), end: at("14:00"), kind: "meeting" });
    const result = planCommands(base, [{ type: "create", item: item("urgent edit", 30, { priorityId: "urgent", deadline: DAY }), urgent: true }], owner, { now: NOW });
    expect(result.status).toBe("ready");
    expect(sessionsFor(result, "urgent edit")[0]).toMatchObject({ start: at("12:30"), end: at("13:00") });
    expect(sessionsFor(result, old.id)).toEqual(base.sessions);
  });

  it("does not silently override protected sessions for an urgent task", () => {
    const old = item("protected software", 390, { category: "software", minimumSessionMinutes: 120 });
    const base = snapshot([old], [session(old.id, "09:00", "12:00", { protected: true }), session(old.id, "12:30", "16:00", { protected: true })]);
    // A one-hour urgent job could fit the open reserve without disturbing protection.
    const incoming = item("urgent ordinary task", 90, { priorityId: "urgent", deadline: DAY });
    const denied = planCommands(base, [{ type: "create", item: incoming, urgent: true }], owner, { now: NOW });
    expect(denied.status).toBe("infeasible");
    expect(denied.sessions).toEqual(base.sessions);
    const permitted = planCommands(base, [{ type: "create", item: incoming, urgent: true, overrideProtected: true }], owner, { now: NOW });
    expect(permitted.status).toBe("ready");
    expect(sessionsFor(permitted, old.id).every((entry) => entry.protected)).toBe(true);
  });

  it("an override for one protected move does not authorize moving another project’s protection", () => {
    const first = item("first", 60);
    const second = item("second", 60);
    const firstSession = session(first.id, "09:00", "10:00", { protected: true });
    const secondSession = session(second.id, "10:00", "11:00", { protected: true });
    const base = snapshot([first, second], [firstSession, secondSession]);
    const result = planCommands(base, [{ type: "move", sessionId: firstSession.id, start: at("10:00"), end: at("11:00"), overrideProtected: true }], owner, { now: NOW });
    expect(result.status).toBe("infeasible");
    expect(result.conflicts[0]).toMatchObject({ code: "protected_session", itemIds: [second.id] });
    expect(result.sessions).toEqual(base.sessions);
  });
});

describe("explicit status, effort and hard constraints", () => {
  it("time passing never completes work or deducts remaining effort", () => {
    const old = item("unfinished", 60);
    const base = snapshot([old], [session(old.id, "09:00", "10:00")]);
    const result = planCommands(base, [{ type: "schedule", itemId: old.id }], owner, { now: at("11:00") });
    expect(result.status).toBe("ready");
    expect(result.items[0]).toMatchObject({ status: "planned", remainingMinutes: 60, completedAt: null });
    expect(sessionsFor(result, old.id)[0].start).toBe(at("11:00"));
    expect(total(sessionsFor(result, old.id))).toBe(60);
  });

  it("partial progress shrinks future work but does not infer completion from counts", () => {
    const old = item("batch", 180, { progressTotal: 8 });
    const base = snapshot([old], [session(old.id, "09:00", "12:00")]);
    const result = planCommands(base, [{ type: "progress", itemId: old.id, remainingMinutes: 60, progressCompleted: 3 }], owner, { now: NOW });
    expect(result.status).toBe("ready");
    expect(total(sessionsFor(result, old.id))).toBe(60);
    expect(result.items[0]).toMatchObject({ remainingMinutes: 60, progressCompleted: 3, status: "planned", completedAt: null });
    const counted = planCommands(base, [{ type: "progress", itemId: old.id, progressCompleted: 8 }], owner, { now: NOW });
    expect(counted.items[0]).toMatchObject({ remainingMinutes: 180, status: "planned" });
    const zero = planCommands(base, [{ type: "progress", itemId: old.id, remainingMinutes: 0 }], owner, { now: NOW });
    expect(zero.status).toBe("ready");
    expect(zero.items[0].status).toBe("planned");
    expect(zero.sessions).toEqual([]);
  });

  it("preserves reported completed effort when the total estimate changes", () => {
    const old = item("software", 300, { remainingMinutes: 180 });
    const result = planCommands(snapshot([old]), [{ type: "update", itemId: old.id, patch: { estimatedMinutes: 360 } }], owner, { now: NOW });
    expect(result.status).toBe("ready");
    expect(result.items[0].remainingMinutes).toBe(240);
    expect(total(result.sessions)).toBe(240);
  });

  it("keeps waiting dependencies visible but frees executable sessions; resuming replans", () => {
    const old = item("waiting build", 60);
    const base = snapshot([old], [session(old.id, "09:00", "10:00")]);
    const waiting = planCommands(base, [{ type: "status", itemId: old.id, status: "waiting", reason: "Waiting for credentials" }], owner, { now: NOW });
    expect(waiting.status).toBe("ready");
    expect(waiting.sessions).toEqual([]);
    expect(waiting.items[0]).toMatchObject({ status: "waiting", remainingMinutes: 60, blockedReason: "Waiting for credentials", targetDate: DAY });
    const resumed = planCommands(apply(base, waiting), [{ type: "status", itemId: old.id, status: "planned" }], owner, { now: NOW });
    expect(resumed.status).toBe("ready");
    expect(total(resumed.sessions)).toBe(60);
  });

  it("completion is explicit and releases its own protected future work", () => {
    const old = item("done", 60);
    const base = snapshot([old], [session(old.id, "09:00", "10:00", { protected: true })]);
    const result = planCommands(base, [{ type: "status", itemId: old.id, status: "completed" }], owner, { now: NOW });
    expect(result.status).toBe("ready");
    expect(result.items[0]).toMatchObject({ status: "completed", remainingMinutes: 0, completedAt: NOW });
    expect(result.sessions).toEqual([]);
  });

  it("explicit session completion honors reported remaining effort without completing the project", () => {
    const old = item("project", 120);
    const first = session(old.id, "09:00", "10:00", { protected: true });
    const second = session(old.id, "10:00", "11:00");
    const base = snapshot([old], [first, second]);
    const result = planCommands(base, [{ type: "complete_session", sessionId: first.id, remainingMinutes: 60 }], owner, { now: NOW });
    expect(result.status).toBe("ready");
    expect(result.sessions.find((entry) => entry.id === first.id)?.status).toBe("completed");
    expect(sessionsFor(result, old.id)).toEqual([second]);
    expect(result.items[0]).toMatchObject({ remainingMinutes: 60, status: "planned", completedAt: null });
  });

  it("session completion does not infer effort and early-completed reservations never reoccupy future time", () => {
    const old = item("project", 60);
    const held = session(old.id, "09:00", "10:00");
    const base = snapshot([old], [held]);
    const result = planCommands(base, [{ type: "complete_session", sessionId: held.id }], owner, { now: NOW });
    expect(result.status).toBe("ready");
    expect(result.items[0].remainingMinutes).toBe(60);
    expect(total(sessionsFor(result, old.id))).toBe(60);
    expect(result.sessions.find((entry) => entry.id === held.id)?.status).toBe("completed");
    expect(validateSchedule(apply(base, result), at("15:00", "2026-09-08"))).toEqual([]);
    expect(planCommands(base, [{ type: "complete_session", sessionId: held.id }], requester, { now: NOW }).conflicts[0].code).toBe("forbidden");
  });

  it("requires an explicit override to change an existing firm deadline", () => {
    const old = item("firm", 60, { deadline: DAY });
    const base = snapshot([old]);
    const denied = planCommands(base, [{ type: "update", itemId: old.id, patch: { deadline: "2026-09-08" } }], owner, { now: NOW });
    expect(denied.status).toBe("infeasible");
    expect(denied.conflicts[0].code).toBe("firm_deadline");
    const accepted = planCommands(base, [{ type: "update", itemId: old.id, patch: { deadline: "2026-09-08" }, overrideDeadline: true }], owner, { now: NOW });
    expect(accepted.status).toBe("ready");
    expect(accepted.items[0].deadline).toBe("2026-09-08");
  });

  it("records a client-update event without claiming completion or changing the schedule", () => {
    const old = item("landing batch", 120);
    const base = snapshot([old], [session(old.id, "09:00", "11:00")]);
    const result = planCommands(base, [{ type: "client_update", itemId: old.id, message: "Reported three completed pages." }], owner, { now: NOW });
    expect(result.status).toBe("ready");
    expect(result.items).toEqual(base.items);
    expect(result.sessions).toEqual(base.sessions);
    expect(result.affectedItemIds).toEqual([old.id]);
    expect(result.summary[0]).toContain("Reported three completed pages.");
  });

  it("moves work around a meeting without shifting protected sessions", () => {
    const old = item("ordinary", 180);
    const base = snapshot([old], [session(old.id, "09:00", "12:00")]);
    const result = planCommands(base, [{ type: "block", block: { id: "meeting", title: "Meeting", start: at("10:00"), end: at("11:00"), kind: "meeting" } }], owner, { now: NOW });
    expect(result.status).toBe("ready");
    expect(total(sessionsFor(result, old.id))).toBe(180);
    expect(validateSchedule(apply(base, result), NOW)).toEqual([]);
    const protectedBase = snapshot([old], [session(old.id, "09:00", "12:00", { protected: true })]);
    const denied = planCommands(protectedBase, result.commands, owner, { now: NOW });
    expect(denied.status).toBe("infeasible");
    expect(denied.conflicts[0].code).toBe("protected_session");
  });

  it("honors an exact owner move and replans the ordinary session it displaces", () => {
    const first = item("first", 60);
    const second = item("second", 60);
    const firstSession = session(first.id, "09:00", "10:00");
    const secondSession = session(second.id, "10:00", "11:00");
    const base = snapshot([first, second], [firstSession, secondSession]);
    const result = planCommands(base, [{ type: "move", sessionId: secondSession.id, start: at("09:00"), end: at("10:00") }], owner, { now: NOW });
    expect(result.status).toBe("ready");
    expect(sessionsFor(result, second.id)[0]).toMatchObject({ id: secondSession.id, start: at("09:00"), end: at("10:00") });
    expect(sessionsFor(result, first.id)[0]).toMatchObject({ start: at("10:00"), end: at("11:00") });
    expect(result.affectedItemIds).toEqual(expect.arrayContaining([first.id, second.id]));
  });
});

describe("scheduler safety across varied workloads", () => {
  it("maintains hard invariants and requester isolation through seeded mixed workloads", () => {
    let seed = 0xada2026;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 0x1_0000_0000; };
    let base = snapshot();
    for (let index = 0; index < 70; index++) {
      const startDate = addDays(DAY, Math.floor(random() * 12));
      const category = (["web", "it", "landings", "software"] as const)[Math.floor(random() * 4)];
      const priorityId = (["urgent", "high", "normal", "low"] as const)[Math.floor(random() * 4)];
      const actor = random() < 0.35 ? requester : owner;
      const work = item(`varied-${index}`, 15 * (1 + Math.floor(random() * 32)), {
        category, priorityId, minimumSessionMinutes: category === "software" ? 120 : 15,
        windowStart: startDate, targetDate: addDays(startDate, Math.floor(random() * 4)),
        deadline: random() < 0.2 ? addDays(startDate, 3) : null,
      });
      const before = JSON.stringify(base);
      const proposal = planCommands(base, [{ type: "create", item: work, urgent: priorityId === "urgent" }], actor, { now: NOW });
      expect(JSON.stringify(base), `Input changed at operation ${index}`).toBe(before);
      expect(validateSchedule({ ...base, items: proposal.items, sessions: proposal.sessions, blocks: proposal.blocks }, NOW), `Invalid proposal at operation ${index}`).toEqual([]);
      if (proposal.status !== "ready") continue;
      if (actor.role === "requester") {
        for (const previous of base.items) expect(proposal.items.find((entry) => entry.id === previous.id)).toEqual(previous);
        for (const previous of base.sessions) expect(proposal.sessions.find((entry) => entry.id === previous.id)).toEqual(previous);
      }
      base = apply(base, proposal);
      for (const active of base.items.filter((entry) => entry.status === "planned" || entry.status === "in_progress")) {
        const reservedMinutes = total(base.sessions.filter((entry) => entry.workItemId === active.id && entry.status === "planned"));
        expect(reservedMinutes).toBeGreaterThanOrEqual(active.remainingMinutes ?? 0);
        expect(reservedMinutes - (active.remainingMinutes ?? 0)).toBeLessThan(15);
      }
    }
    expect(base.items.length).toBeGreaterThan(20);
  }, 20_000);

  it("reports malformed settings and timestamps instead of throwing during validation", () => {
    const base = snapshot([item("work", 60)], [session("work", "09:00", "10:00"), session("work", "11:00", "12:00", { id: "broken", start: "invalid", usesReserve: true })]);
    expect(validateSchedule(base, NOW).some((entry) => entry.code === "invalid_session")).toBe(true);
    expect(validateSchedule({ ...base, settings: { ...base.settings, timeZone: "invalid" } }, NOW)[0].code).toBe("invalid_settings");
    expect(validateSchedule(base, "not a timestamp")[0].code).toBe("invalid_now");
  });
});
