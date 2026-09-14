import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("./server/supabase", () => ({ getSupabaseAdminClient: () => { throw new Error("No live database in planning tests"); } }));
import { DEMO_MEMBERS } from "./fixtures";
import { newWorkItem } from "./work";
import { localDateTime, minutesBetween, addDays } from "./time";
import { crmAvailability, prepareCrmPreview } from "./server/crm-planning";
import { crmAvailabilityQuerySchema } from "./crm-integration";
import { crmTestNow, crmTestDay, crmTestContext, crmTestPreviewId as previewId, crmTestState, crmTestInput } from "./test-fixtures/crm";
import type { AppState, WorkSession } from "./types";

function session(state: AppState, id: string, start: string, end: string, protectedTime = false): WorkSession {
  return { id, workItemId: "existing", start: localDateTime(crmTestDay, start, state.settings.timeZone), end: localDateTime(crmTestDay, end, state.settings.timeZone), protected: protectedTime, status: "planned", usesReserve: false };
}
function existing(state: AppState, minutes = 60) {
  state.items = [newWorkItem(DEMO_MEMBERS[0], crmTestDay, { id: "existing", clientId: "calendar-client", title: "Existing agency work", description: "PRIVATE_EXISTING_DESCRIPTION", estimatedMinutes: minutes, remainingMinutes: minutes })];
  state.sessions = [session(state, "s1", "09:00", "10:00")];
}
function prepare(state: AppState, input = crmTestInput(), now = crmTestNow) {
  return prepareCrmPreview(crmTestContext, { snapshot: state, mapping: { calendarClientId: "calendar-client", revision: 1 } }, input, previewId, now);
}

describe("CRM availability uses the shared scheduler and a public projection", () => {
  it("preserves saved reserve, lunch, weekends and spans without reservations", () => {
    const state = crmTestState(); existing(state); state.sessions = [];
    expect(crmAvailability(state, crmTestContext, crmTestDay, crmTestDay, crmTestNow).days[0]).toMatchObject({ capacityMinutes: 450, availableMinutes: 450, plannedMinutes: 0, work: [] });
    state.settings.reserveMinutes = 60;
    expect(crmAvailability(state, crmTestContext, crmTestDay, crmTestDay, crmTestNow).days[0].availableMinutes).toBe(390);
    expect(crmAvailability(state, crmTestContext, "2026-09-19", "2026-09-20", crmTestNow).days.every(day => day.availableMinutes === 0 && day.openings.length === 0)).toBe(true);
  });
  it("exposes generic unavailable ranges and work hours without any private fields", () => {
    const state = crmTestState(); existing(state);
    state.blocks = [{ id: "PRIVATE_BLOCK_ID", title: "PRIVATE_APPOINTMENT", kind: "time_off", start: localDateTime(crmTestDay, "11:00", state.settings.timeZone), end: localDateTime(crmTestDay, "12:00", state.settings.timeZone) }];
    Object.assign(state, { personalNotes: ["PRIVATE_NOTES"], emailDrafts: ["PRIVATE_DRAFT"], transcripts: "PRIVATE_TRANSCRIPT", attachments: ["PRIVATE_ATTACHMENT"] });
    const before = structuredClone(state), response = crmAvailability(state, crmTestContext, crmTestDay, crmTestDay, crmTestNow);
    expect(response.days[0]).toMatchObject({ plannedMinutes: 60, availableMinutes: 330, unavailable: [{ title: "Unavailable" }], work: [{ title: "Existing agency work" }] });
    expect(JSON.stringify(response)).not.toContain("PRIVATE"); expect(response).not.toHaveProperty("workspaceId");
    expect(state).toEqual(before);
  });
  it("counts only usable future time and never marks elapsed bookings complete", () => {
    const state = crmTestState(); existing(state);
    const response = crmAvailability(state, crmTestContext, crmTestDay, crmTestDay, "2026-09-15T14:07:00Z");
    expect(response.days[0]).toMatchObject({ plannedMinutes: 60, availableMinutes: 375 });
    expect(response.days[0].openings[0].start).toBe(localDateTime(crmTestDay, "10:15", state.settings.timeZone));
    expect(state.sessions[0].status).toBe("planned");
  });
  it("bounds queries and fails closed on the wrong workspace or inconsistent state", () => {
    for (const query of [
      { startDate: crmTestDay, endDate: addDays(crmTestDay, 31) },
      { startDate: "2026-02-30", endDate: "2026-03-01" },
      { startDate: crmTestDay, endDate: "2026-09-14" },
    ]) expect(crmAvailabilityQuerySchema.safeParse(query).success).toBe(false);
    const state = crmTestState(); state.workspaceId = "wrong-workspace";
    expect(() => crmAvailability(state, crmTestContext, crmTestDay, crmTestDay, crmTestNow)).toThrow("owner check");
    const invalid = crmTestState(); existing(invalid); invalid.sessions.push({ ...invalid.sessions[0], id: "overlap" });
    expect(() => prepare(invalid)).toThrow("owner check");
  });
});

describe("CRM preview authority, dates and impact", () => {
  it("previews a clean day fit with required effort and no mutations or exposed authority", () => {
    const state = crmTestState(), before = structuredClone(state), result = prepare(state);
    expect(result.response).toMatchObject({ status: "fits", bookingEnabled: false, changes: [], baseVersion: 0, expiresAt: "2026-09-15T12:15:00Z" });
    expect(result.response.proposedSessions).toHaveLength(1);
    expect(minutesBetween(result.response.proposedSessions[0].start, result.response.proposedSessions[0].end)).toBe(60);
    expect(JSON.stringify(result.response)).not.toContain("PRIVATE");
    expect(result.commands[0]).toMatchObject({ type: "create", item: { requesterId: crmTestContext.connection.principalUserId, requestedBy: crmTestContext.requester.email, priorityId: "normal" } });
    expect(result.response).not.toHaveProperty("commands"); expect(result.response).not.toHaveProperty("fingerprint"); expect(state).toEqual(before);
  });
  it("requires owner-confirmed client mapping and valid dates", () => {
    const state = crmTestState();
    expect(() => prepareCrmPreview(crmTestContext, { snapshot: state, mapping: null }, crmTestInput(), previewId, crmTestNow)).toThrow("confirm");
    expect(() => prepare(state, crmTestInput({ mode: "day", date: "2026-09-14" }))).toThrow("today");
    expect(() => prepare(state, crmTestInput({ mode: "day", date: addDays(crmTestDay, 366) }))).toThrow("next year");
  });
  it("fits multi-day effort before a firm due date and keeps each day inside available hours", () => {
    const state = crmTestState();
    const input = { ...crmTestInput({ mode: "due_by", date: "2026-09-16", flexible: false }), estimatedMinutes: 900 };
    const result = prepare(state, input);
    expect(result.response).toMatchObject({ status: "fits", changes: [], alternatives: [] });
    expect(result.response.proposedSessions).toHaveLength(4);
    expect(result.response.proposedSessions.reduce((sum, slot) => sum + minutesBetween(slot.start, slot.end), 0)).toBe(900);
    expect(result.response.proposedSessions.at(-1)?.end).toBe(localDateTime("2026-09-16", "17:00", state.settings.timeZone));
    expect(result.commands[0]).toMatchObject({ item: { deadline: "2026-09-16", estimatedMinutes: 900, remainingMinutes: 900 } });
  });
  it("shows exact-time displacement as an approval proposal with before/after hours", () => {
    const state = crmTestState(); existing(state); const before = structuredClone(state);
    const result = prepare(state, crmTestInput({ mode: "exact", date: crmTestDay, startTime: "09:00" }));
    expect(result.response.status).toBe("needs_approval");
    expect(result.response.changes).toEqual([{ workItemId: "existing", title: "Existing agency work", client: { id: "calendar-client", name: "Fictional Client" },
      before: [{ start: localDateTime(crmTestDay, "09:00", state.settings.timeZone), end: localDateTime(crmTestDay, "10:00", state.settings.timeZone) }],
      after: [{ start: localDateTime(crmTestDay, "10:00", state.settings.timeZone), end: localDateTime(crmTestDay, "11:00", state.settings.timeZone) }],
    }]);
    expect(result.response.alternatives[0]).toMatchObject({ requiresDateChange: true, requiresDeadlineChange: false, scheduling: { mode: "exact", date: crmTestDay, startTime: "10:00" } });
    expect(state).toEqual(before);
  });
  it("requires explicit owner action for protected, partially booked, unknown-total or elapsed conflicts", () => {
    for (const variant of ["protected", "partial", "unknown", "elapsed"]) {
      const state = crmTestState(); existing(state); let now = crmTestNow;
      if (variant === "protected") state.sessions[0].protected = true;
      if (variant === "partial") state.items[0].remainingMinutes = state.items[0].estimatedMinutes = 120;
      if (variant === "unknown") state.items[0].remainingMinutes = state.items[0].estimatedMinutes = null;
      if (variant === "elapsed") now = "2026-09-15T13:15:00Z";
      const result = prepare(state, crmTestInput({ mode: "exact", date: crmTestDay, startTime: variant === "elapsed" ? "09:15" : "09:00" }), now);
      expect(result.response.status, variant).not.toBe("fits"); expect(result.response.changes, variant).toEqual([]);
    }
  });
  it("does not cross lunch or working-hour boundaries and keeps private block reasons hidden", () => {
    const state = crmTestState();
    state.blocks = [{ id: "PRIVATE_BLOCK", title: "PRIVATE_REASON", kind: "time_off", start: localDateTime(crmTestDay, "09:00", state.settings.timeZone), end: localDateTime(crmTestDay, "10:00", state.settings.timeZone) }];
    for (const startTime of ["09:00", "11:30", "16:30"]) {
      const result = prepare(state, crmTestInput({ mode: "exact", date: crmTestDay, startTime }));
      expect(result.response.status).not.toBe("fits"); expect(JSON.stringify(result.response)).not.toContain("PRIVATE");
      expect(result.response.alternatives.every(option => option.sessions.length === 1 && minutesBetween(option.sessions[0].start, option.sessions[0].end) === 60)).toBe(true);
    }
  });
  it("marks later alternatives as changes to a firm due date; explicitly flexible dates can fit later", () => {
    const state = crmTestState(); existing(state, 450);
    state.sessions = [session(state, "s1", "09:00", "12:00", true), session(state, "s2", "12:30", "17:00", true)];
    const firm = prepare(state, crmTestInput({ mode: "due_by", date: crmTestDay, flexible: false }));
    expect(firm.response.status).not.toBe("fits"); expect(firm.response.proposedSessions).toEqual([]);
    expect(firm.response.alternatives[0]).toMatchObject({ scheduling: { mode: "due_by", date: "2026-09-16", flexible: false }, requiresDateChange: true, requiresDeadlineChange: true });
    const flexible = prepare(state, crmTestInput({ mode: "due_by", date: crmTestDay, flexible: true }));
    expect(flexible.response).toMatchObject({ status: "fits", changes: [] });
    expect(flexible.response.proposedSessions[0].start).toBe(localDateTime("2026-09-16", "09:00", state.settings.timeZone));
  });
});
