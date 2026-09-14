import { describe, expect, it } from "vitest";
import { DEFAULT_PRIORITIES, DEFAULT_SETTINGS } from "./defaults";
import { commandSchema } from "./schemas";
import { dayCapacity, planCommands, validateSchedule } from "./scheduler";
import { localDateTime, minutesBetween } from "./time";
import { newWorkItem } from "./work";
import type { Actor, ScheduleSnapshot, UnavailableBlock, WorkSession } from "./types";

const owner: Actor = { id: "owner", name: "Bryan", email: "owner@example.test", role: "owner" };
const today = "2026-09-09", tomorrow = "2026-09-10";
const at = (clock: string, day = tomorrow) => localDateTime(day, clock, DEFAULT_SETTINGS.timeZone);
const now = at("08:00", today);
const meeting = (patch: Partial<UnavailableBlock> = {}): UnavailableBlock => ({ id: "meeting", title: "Fictional client review", start: at("10:00"), end: at("11:00"), kind: "meeting", ...patch });
const session = (patch: Partial<WorkSession> = {}): WorkSession => ({ id: "work-session", workItemId: "work", start: at("09:00"), end: at("12:00"), protected: false, status: "planned", usesReserve: false, ...patch });
function snapshot(sessions: WorkSession[] = []): ScheduleSnapshot {
  return { workspaceId: "fixture", version: 3, settings: { ...DEFAULT_SETTINGS, reserveMinutes: 0 },
    priorities: structuredClone(DEFAULT_PRIORITIES), clients: [{ id: "client", name: "Fictional client", aliases: [] }], blocks: [], sessions,
    items: sessions.length ? [newWorkItem(owner, tomorrow, { id: "work", clientId: "client", title: "Fictional work", estimatedMinutes: 180, remainingMinutes: 180, minimumSessionMinutes: 15 })] : [] };
}
const minutes = (sessions: WorkSession[]) => sessions.reduce((sum, work) => sum + minutesBetween(work.start, work.end), 0);

describe("fixed meetings and work capacity", () => {
  it("books tomorrow's new work around a saved meeting without inventing project effort", () => {
    const base = snapshot();
    const reserved = planCommands(base, [{ type: "block", block: meeting() }], owner, { now });
    expect(reserved.status).toBe("ready");
    expect(reserved.items).toEqual([]);
    expect(reserved.sessions).toEqual([]);
    expect(reserved.summary).toEqual(["Added meeting: Fictional client review."]);
    const occupied = { ...base, blocks: reserved.blocks };
    expect(dayCapacity(occupied, tomorrow, now)).toEqual({ plannedMinutes: 0, capacityMinutes: 390, availableMinutes: 390 });
    const work = newWorkItem(owner, tomorrow, { id: "work", clientId: "client", title: "Fictional work", estimatedMinutes: 450, remainingMinutes: 450, minimumSessionMinutes: 15 });
    const proposal = planCommands(occupied, [{ type: "create", item: work, smartFit: { startDate: tomorrow, endDate: "2026-09-11", minutes: 450, distribution: "total" } }], owner, { now });
    expect(proposal.status).toBe("ready");
    expect(proposal.blocks).toEqual([meeting()]);
    expect(minutes(proposal.sessions)).toBe(450);
    expect(proposal.sessions.filter(work => work.start < at("17:00"))).toEqual([
      expect.objectContaining({ start: at("09:00"), end: at("10:00") }),
      expect.objectContaining({ start: at("11:00"), end: at("12:00") }),
      expect.objectContaining({ start: at("12:30"), end: at("17:00") }),
    ]);
    expect(proposal.sessions.at(-1)).toMatchObject({ start: at("09:00", "2026-09-11"), end: at("10:00", "2026-09-11") });
    expect(validateSchedule({ ...occupied, ...proposal }, now)).toEqual([]);
    expect(occupied.settings.reserveMinutes).toBe(0);
  });

  it("replans existing work and reports what moved without changing unrelated sessions", () => {
    const fixed = session({ id: "later-session", start: at("14:00"), end: at("15:00") });
    const base = snapshot([session({ end: at("11:00") }), fixed]);
    const proposal = planCommands(base, [{ type: "block", block: meeting() }], owner, { now });
    expect(proposal.status).toBe("ready");
    expect(minutes(proposal.sessions)).toBe(180);
    expect(proposal.sessions).toContainEqual(fixed);
    expect(proposal.items[0]).toMatchObject({ estimatedMinutes: 180, remainingMinutes: 180 });
    expect(proposal.summary).toContain("Moved remaining work for Fictional work; forecast 2026-09-10.");
    expect(validateSchedule({ ...base, ...proposal }, now)).toEqual([]);
  });

  it("requires an explicit owner override for protected work and keeps its replacement protected", () => {
    const base = snapshot([session({ protected: true })]);
    const blocked = planCommands(base, [{ type: "block", block: meeting() }], owner, { now });
    expect(blocked.conflicts[0].code).toBe("protected_session");
    expect(blocked.sessions).toEqual(base.sessions);
    expect(blocked.blocks).toEqual([]);
    const approved = planCommands(base, [{ type: "block", block: meeting(), overrideProtected: true }], owner, { now });
    expect(approved.status).toBe("ready");
    expect(minutes(approved.sessions)).toBe(180);
    expect(approved.sessions.every(work => work.protected)).toBe(true);
  });

  it.each(["09:30", "13:00"])("preserves started and historical work when the clock is %s", clock => {
    const base = snapshot([session()]);
    const result = planCommands(base, [{ type: "block", block: meeting(), overrideProtected: true }], owner, { now: at(clock) });
    expect(result.status).toBe("infeasible");
    expect(result.conflicts[0].code).toBe("historical_session");
    expect(result.sessions).toEqual(base.sessions);
    expect(result.items).toEqual(base.items);
    expect(result.blocks).toEqual([]);
  });

  it("keeps a firm deadline atomic when a meeting leaves insufficient capacity", () => {
    const base = snapshot([session()]);
    base.items[0] = { ...base.items[0], deadline: tomorrow, dateConstraints: { earliestStart: tomorrow, allowedDates: [] } };
    const proposal = planCommands(base, [{ type: "block", block: meeting({ start: at("09:00"), end: at("17:00") }) }], owner, { now });
    expect(proposal.status).toBe("infeasible");
    expect(proposal.conflicts[0].code).toBe("firm_deadline");
    expect(proposal.sessions).toEqual(base.sessions);
    expect(proposal.blocks).toEqual([]);
  });

  it("does not silently lose an unknown-total reservation", () => {
    const base = snapshot([session()]);
    base.items[0] = { ...base.items[0], estimatedMinutes: null, remainingMinutes: null };
    const proposal = planCommands(base, [{ type: "block", block: meeting() }], owner, { now });
    expect(proposal.conflicts[0].code).toBe("unknown_effort_displacement");
    expect(proposal.sessions).toEqual(base.sessions);
    expect(proposal.blocks).toEqual([]);
  });

  it("does not expand an intentionally partial booking when a meeting displaces it", () => {
    const base = snapshot([session({ end: at("11:00") })]);
    base.items[0] = { ...base.items[0], estimatedMinutes: 600, remainingMinutes: 600 };
    const proposal = planCommands(base, [{ type: "block", block: meeting() }], owner, { now });
    expect(proposal.status).toBe("infeasible");
    expect(proposal.conflicts[0].code).toBe("partial_booking_displacement");
    expect(proposal.sessions).toEqual(base.sessions);
    expect(minutes(proposal.sessions)).toBe(120);
    expect(proposal.items).toEqual(base.items);
    expect(proposal.blocks).toEqual([]);
  });

  it("updates and removes a fixed meeting without moving unaffected work", () => {
    const base = snapshot([session({ end: at("10:00") })]);
    base.blocks = [meeting()];
    const edited = meeting({ start: at("11:00"), end: at("12:00") });
    const update = planCommands(base, [{ type: "block", block: edited }], owner, { now });
    expect(update.status).toBe("ready");
    expect(update.blocks).toEqual([edited]);
    expect(update.sessions).toEqual(base.sessions);
    const removal = planCommands({ ...base, blocks: update.blocks }, [{ type: "block", block: edited, remove: true }], owner, { now });
    expect(removal.status).toBe("ready");
    expect(removal.blocks).toEqual([]);
    expect(removal.sessions).toEqual(base.sessions);
    expect(dayCapacity({ ...base, blocks: [] }, tomorrow).capacityMinutes).toBe(450);
  });

  it.each(["requester", "viewer"] as const)("rejects %s meeting changes", role => {
    const base = snapshot();
    const result = planCommands(base, [{ type: "block", block: meeting() }], { ...owner, role }, { now });
    expect(result.conflicts[0].code).toBe("forbidden");
    expect(result.blocks).toEqual([]);
  });

  it("validates meeting names and positive clock ranges at the request boundary", () => {
    for (const block of [meeting({ title: "   " }), meeting({ end: at("10:00") }), meeting({ end: at("09:00") }), meeting({ start: "2026-09-10T10:00:00" })])
      expect(commandSchema.safeParse({ type: "block", block }).success).toBe(false);
    const result = commandSchema.parse({ type: "block", block: meeting({ title: " Client review " }) });
    expect(result).toMatchObject({ block: { title: "Client review" } });
  });
});
