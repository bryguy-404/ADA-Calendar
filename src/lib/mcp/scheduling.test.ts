import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { fixture, at, now, booking } from "./test-fixtures";
import { assertScope, availableSlots, discover, exactDiff, preparePlan } from "./scheduling-plan";
import { prepareScheduleSchema, type PrepareScheduleInput, type ScheduleIntent } from "./scheduling-contract";
import { planCommands } from "../scheduler";
import { newWorkItem } from "../work";

const input = (change: ScheduleIntent): PrepareScheduleInput => ({ workspaceId: "fictional-workspace", baseVersion: 17, operationId: randomUUID(), change });
const task = () => ({ clientId: "becht", title: "FICTIONAL new website", description: "Source: fictional brief", category: "web" as const, webKind: "edit" as const,
  estimatedMinutes: null, windowStart: "2026-11-02", windowEnd: null, targetDate: "2026-11-10", deadline: null, minimumSessionMinutes: 15, references: ["https://example.test/brief"] });
const fit = { startDate: "2026-11-02", endDate: "2026-11-03", minutes: 120, distribution: "total" as const };
describe("compact scheduling plans", () => {
  it("discovers exact clients and unscheduled waiting tasks with version-bound pagination", () => {
    const s = fixture(); s.items[0].status = "waiting";
    expect(discover(s, { kind: "tasks", unscheduledOnly: true }).results).toHaveLength(1);
    expect(discover(s, { kind: "clients", query: "becht" }).results[0].id).toBe("becht");
    expect(() => discover(s, { kind: "tasks", offset: 1 })).toThrow();
    expect(() => discover(s, { kind: "tasks", baseVersion: 16 })).toThrow(/changed/);
  });
  it("creates waiting unscheduled work with source fields and no inferred bookings", () => {
    const s = fixture(), request = input({ kind: "create", task: task() });
    const { proposal } = preparePlan(s, s.actor, request, now);
    expect(proposal.sessions).toEqual([]);
    expect(proposal.items.at(-1)).toMatchObject({ ...task(), id: request.operationId, status: "waiting", remainingMinutes: null });
  });
  it("freezes scheduled creation IDs across replans and preserves partial unknown effort", () => {
    const s = fixture(), request = input({ kind: "create", task: task(), booking: fit });
    const { proposal } = preparePlan(s, s.actor, request, now);
    expect(proposal.sessions).toHaveLength(1);
    const later = planCommands(s, proposal.commands, s.actor, { operationId: request.operationId, now: "2026-11-02T13:01:00Z" });
    expect(later.sessions).toEqual(proposal.sessions);
    expect(exactDiff(s, later)).toEqual(exactDiff(s, proposal));
  });
  it("books a known-estimate partial portion without auto-filling the remainder", () => {
    const s = fixture(); s.items[0].remainingMinutes = 600; s.items[0].estimatedMinutes = 600;
    const { proposal } = preparePlan(s, s.actor, input({ kind: "book", workItemId: "website", booking: fit }), now);
    expect(proposal.sessions).toHaveLength(1); expect(proposal.items[0].remainingMinutes).toBe(600);
    expect(proposal.items[0].forecastDate).toBeNull();
  });
  it("fits multiple slots around lunch and existing bookings without altering any existing record", () => {
    const s = fixture(); s.items[0].remainingMinutes = null; s.items[0].estimatedMinutes = null;
    s.items.push(newWorkItem(s.actor, "2026-11-02", { id: "other", title: "FICTIONAL other", clientId: "becht", estimatedMinutes: 60, remainingMinutes: 60 }));
    s.sessions = [booking("other")];
    const { proposal } = preparePlan(s, s.actor, input({ kind: "book", workItemId: "website", booking: { ...fit, minutes: 450 } }), now);
    expect(proposal.sessions.filter(v => v.workItemId === "website").length).toBeGreaterThan(1);
    expect(proposal.sessions.find(v => v.id === s.sessions[0].id)).toEqual(s.sessions[0]);
    expect(proposal.items.find(v => v.id === "other")).toEqual(s.items[1]);
  });
  it("ongoing with unknown effort preserves protected bookings, history, context and milestone/deadline", () => {
    const s = fixture(); s.items[0].targetDate = "2026-11-06"; s.items[0].deadline = "2026-11-20";
    s.sessions = [booking("website"), booking("website", "2026-10-30", "completed"), booking("website", "2026-10-29", "cancelled")];
    s.sessions[0].protected = true;
    const { proposal } = preparePlan(s, s.actor, input({ kind: "ongoing", workItemId: "website", unknownEffort: true }), now);
    expect(proposal.sessions).toEqual(s.sessions);
    expect(proposal.items[0]).toMatchObject({ timelineMode: "span", windowEnd: null, estimatedMinutes: null, remainingMinutes: null, targetDate: "2026-11-06", deadline: "2026-11-20" });
  });
  it("allows ongoing unscheduled waiting work without changing its status", () => {
    const s = fixture(); s.items[0].status = "waiting";
    const { proposal } = preparePlan(s, s.actor, input({ kind: "ongoing", workItemId: "website", unknownEffort: true }), now);
    expect(proposal.items[0].status).toBe("waiting"); expect(proposal.sessions).toEqual([]);
  });
  it("moves only exact planned IDs with unchanged duration and explicit protected override", () => {
    const s = fixture(); s.sessions = [booking("website")]; s.sessions[0].protected = true;
    const move = { sessionId: s.sessions[0].id, start: at("2026-11-03", "10:00"), end: at("2026-11-03", "11:00"), overrideProtected: false };
    expect(() => preparePlan(s, s.actor, input({ kind: "reschedule", moves: [move] }), now)).toThrow(/protected/);
    const { proposal } = preparePlan(s, s.actor, input({ kind: "reschedule", moves: [{ ...move, overrideProtected: true }] }), now);
    expect(proposal.sessions).toEqual([{ ...s.sessions[0], start: move.start, end: move.end }]);
    expect(() => preparePlan(s, s.actor, input({ kind: "reschedule", moves: [{ ...move, end: at("2026-11-03", "12:00") }] }), now)).toThrow(/duration/);
  });
  it("rejects overlap with unrelated planned work and meetings without displacement", () => {
    const s = fixture(); s.sessions = [booking("website")];
    s.blocks = [{ id: "meeting", title: "Fictional meeting", kind: "meeting", start: at("2026-11-03", "10:00"), end: at("2026-11-03", "11:00") }];
    const request = input({ kind: "reschedule", moves: [{ sessionId: s.sessions[0].id, start: s.blocks[0].start, end: s.blocks[0].end, overrideProtected: false }] });
    expect(() => preparePlan(s, s.actor, request, now)).toThrow();
    s.blocks = []; s.items.push(newWorkItem(s.actor, "2026-11-03", { id: "other", title: "FICTIONAL other", clientId: "becht" }));
    s.sessions.push({ ...booking("other", "2026-11-03"), start: request.change.kind === "reschedule" ? request.change.moves[0].start : "", end: at("2026-11-03", "11:00") });
    expect(() => preparePlan(s, s.actor, request, now)).toThrow();
  });
  it("respects saved reserve, weekdays, lunch, elapsed time and DST in availability", () => {
    const s = fixture(); s.settings.reserveMinutes = 60;
    const result = availableSlots(s, { startDate: "2027-03-12", endDate: "2027-03-15" }, now);
    expect(result.days[1].openings).toEqual([]); expect(result.days[2].openings).toEqual([]);
    expect(result.days[0].openings[0].start).toBe("2027-03-12T14:00:00Z");
    expect(result.days[3].openings[0].start).toBe("2027-03-15T13:00:00Z");
    expect(availableSlots(s, { startDate: "2026-11-02", endDate: "2026-11-02" }, at("2026-11-02", "17:00")).days[0].openings).toEqual([]);
    expect(() => availableSlots(s, { startDate: "2026-11-02", endDate: "2026-12-02" }, now)).toThrow();
  });
  it("rejects unsupported status/completion fields and catches altered history", () => {
    expect(() => prepareScheduleSchema.parse({ ...input({ kind: "ongoing", workItemId: "website", unknownEffort: false }), status: "completed" })).toThrow();
    const s = fixture(); s.sessions = [booking("website", "2026-10-30", "completed")];
    const request = input({ kind: "ongoing", workItemId: "website", unknownEffort: true }), { proposal } = preparePlan(s, s.actor, request, now);
    proposal.sessions[0].status = "cancelled";
    expect(() => assertScope(s, proposal, request)).toThrow(/history/);
  });
});
