import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDemoState, DEMO_MEMBERS } from "./fixtures";
import { newWorkItem } from "./work";
import { localDateTime, minutesBetween } from "./time";
import type { PersonalNote } from "./notes";
import type { WorkspaceChatResponse } from "./workspace-chat";
import { workspaceChatRequestSchema } from "./workspace-chat";

vi.mock("server-only", () => ({}));
const { parse } = vi.hoisted(() => ({ parse: vi.fn() }));
vi.mock("openai", () => ({ default: class { responses = { parse }; } }));
import { compileWorkspaceChatIntent, deterministicChatAnswer, interpretWorkspaceChat, readWorkspaceChatRecord, requestsReorder, workspaceChatContext, workspaceChatDate, workspaceChatRecord, workspaceChatReservationUsd, workspaceBookingAmount, workspaceBookingDates, workspaceChatMessageDate } from "./server/workspace-chat";

const owner = DEMO_MEMBERS[0], day = "2026-09-09", now = "2026-09-09T12:00:00Z";
const at = (clock: string) => localDateTime(day, clock, "America/Indiana/Indianapolis");
function fixture() {
  const state = createDemoState(now);
  state.settings.reserveMinutes = 0; state.blocks = []; state.requests = []; state.events = []; state.notifications = [];
  state.clients = [{ id: "oral", name: "Oral Surgery Michiana", aliases: ["Oral Surgery"] }, { id: "tree", name: "Higher Ground Tree Care", aliases: ["Higher Ground"] }, { id: "tyler", name: "Tech Tyler", aliases: ["Tyler"] }, { id: "cidwp", name: "CIDWP", aliases: [] }];
  state.items = state.clients.map((client, index) => newWorkItem(owner, day, { id: client.id, clientId: client.id, title: ["Website edits", "Higher Ground form", "Fix WordPress header", "Homepage demo"][index], remainingMinutes: index === 3 ? 120 : 60, estimatedMinutes: index === 3 ? 120 : 60, minimumSessionMinutes: 60, windowEnd: "2026-12-31", webKind: index === 3 ? "build" : "edit" }));
  state.sessions = state.items.map((item, index) => ({ id: `s-${item.id}`, workItemId: item.id, start: at(["09:00", "10:00", "11:00", "12:30"][index]), end: at(["10:00", "11:00", "12:00", "14:30"][index]), protected: false, status: "planned" as const, usesReserve: false }));
  return state;
}
function intent(text: string, patch: Record<string, unknown> = {}) {
  return { intent: "reorder", message: "Preview", date: day, orderMode: "ordered", references: ["Tyler", "Higher Ground", "Oral Surgery", "Homepage demo"], sourceQuote: text, sources: [], overrideProtected: false, edit: null, ...patch };
}
const reorderText = "Put Tyler first, Higher Ground second, Oral Surgery third and Homepage demo last today.";
function bookingIntent(text: string, edit: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return intent(text, { intent: "edit", references: [], orderMode: null, edit: { kind: "resize", reference: "Homepage demo", sourceDate: null, targetDate: null, endDate: null, minutes: null, amountMode: null, sourceStartTime: null, targetStartTime: null, dayHours: [], ...edit }, ...extra });
}
beforeEach(() => { parse.mockReset().mockRejectedValue(new Error("Unexpected provider call in isolated test")); });

describe("workspace helper evidence and deterministic facts", () => {
  it("resolves selected days and explicit spoken dates without guessing contradictions", () => {
    expect(workspaceChatDate("Put Tyler first", day, "2026-09-14")).toEqual({ date: "2026-09-14" });
    expect(workspaceChatDate("Put Tyler first tomorrow", day, "2026-09-14")).toEqual({ date: "2026-09-10" });
    expect(workspaceChatDate("Friday September 11", day)).toEqual({ date: "2026-09-11" });
    expect(workspaceChatDate("Friday the 10th", day).error).toMatch(/do not match/);
    expect(workspaceChatDate("tomorrow 2026-09-11", day).error).toBeTruthy();
    expect(workspaceChatDate("2026-02-30", day).error).toBeTruthy();
    expect(workspaceChatDate("tomorrow", "2026-12-31")).toEqual({ date: "2027-01-01" });
    expect(workspaceChatDate("next Monday", day)).toEqual({ date: "2026-09-14" });
    expect(workspaceChatDate("Put Tyler first on 9/10", day)).toEqual({ date: "2026-09-10" });
    expect(workspaceChatDate("Put Tyler first on the 10th", day)).toEqual({ date: "2026-09-10" });
    expect(workspaceChatDate("Put Tyler first on 10 September", day)).toEqual({ date: "2026-09-10" });
    expect(workspaceChatDate("Put Tyler first in 4 days", day).error).toBeTruthy();
  });
  it("answers daily agenda in actual clock order with correct capacity and no mutation", () => {
    const state = fixture(), before = structuredClone(state);
    const answer = deterministicChatAnswer("What do I have to do today in order?", state, day, undefined, day, now)!;
    expect(answer.intent).toBe("agenda"); expect(answer.reply.message).toContain("5h planned · 2.5h left to book");
    expect(answer.reply.message.indexOf("Oral Surgery")).toBeLessThan(answer.reply.message.indexOf("Tech Tyler"));
    expect(answer.reply.message).toContain("12:30 PM–2:30 PM");
    expect(state).toEqual(before);
  });
  it("answers weekly totals rather than inferring unknown effort or completed work", () => {
    const state = fixture(); state.items.push(newWorkItem(owner, day, { id: "unknown", clientId: "oral", status: "waiting", estimatedMinutes: null, remainingMinutes: null, windowEnd: "2026-12-31" }));
    const answer = deterministicChatAnswer("How busy am I this week?", state, day, undefined, day, now)!;
    expect(answer.reply.message).toContain("5h planned of 37.5h capacity (13% booked)"); expect(answer.reply.message).toContain("17.5h left to book");
    expect(answer.reply.message).toContain("Hours left exclude elapsed time");
    state.settings.reserveMinutes = 60;
    expect(deterministicChatAnswer("How busy am I this week?", state, day)!.reply.message).toContain("32.5h capacity");
    expect(deterministicChatAnswer("How busy am I this week?", state, "2026-09-23", undefined, day)!.reply.message).toContain("Week of Mon, Sep 7");
    expect(deterministicChatAnswer("How busy am I next week?", state, "2026-09-23", undefined, day)!.reply.message).toContain("Week of Mon, Sep 14");
    expect(deterministicChatAnswer("How busy am I that week?", state, "2026-09-23", undefined, day)!.reply.message).toContain("Week of Mon, Sep 21");
  });
  it("grounds daily and weekly availability in the supplied current time, including model context", () => {
    const state = fixture(), clock = at("16:00");
    expect(deterministicChatAnswer("What do I have to do today?", state, day, undefined, day, clock)!.reply.message).toContain("5h planned · 1h left to book");
    expect(deterministicChatAnswer("How busy am I this week?", state, day, undefined, day, clock)!.reply.message).toContain("16h left to book");
    const context = workspaceChatContext(state, owner, [], "What do I have to do today?", day, clock);
    expect(context.data.dayFacts).toContain("1h left to book");
    expect(context.data.weekFacts).toContain("16h left to book");
    expect(compileWorkspaceChatIntent(intent("What do I have to do today?", { intent: "agenda" }), "What do I have to do today?", state, owner, day, clock, "capacity-clock", []).reply.message).toContain("1h left to book");
  });
  it("counts only saved active web builds, not notes, edits, or cancelled/completed builds", () => {
    const state = fixture();
    state.items.push({ ...state.items[3], id: "complete-build", status: "completed" }, { ...state.items[3], id: "cancelled-build", status: "cancelled" });
    expect(deterministicChatAnswer("How many websites do I have to build from scratch?", state, day)!.reply.message).toContain("1 active website-build project is saved");
  });
  it("keeps private notes and other requesters' requests out of requester context", () => {
    const state = fixture(); const note: PersonalNote = { id: "secret", title: "Private ideas", body: "Confidential private notes", version: 1, createdAt: now, updatedAt: now };
    state.requests = [{ id: "other", requesterId: "william", requesterName: "William", status: "pending", note: "Private requester words", createdAt: now, resolvedAt: null, proposal: { summary: ["Private summary"] } as never }];
    const ownerData = workspaceChatContext(state, owner, [note], "What is in my notes?", day, now);
    expect(JSON.stringify(ownerData.data)).toContain("Confidential private notes");
    const requesterData = workspaceChatContext(state, DEMO_MEMBERS[1], [note], "What is in my notes?", day, now);
    expect(JSON.stringify(requesterData)).not.toContain("Confidential private notes"); expect(JSON.stringify(requesterData)).not.toContain("Private requester words");
  });
  it("labels note excerpts and retrieved coverage rather than claiming full content", () => {
    const notes = Array.from({ length: 14 }, (_, index) => ({ id: `note-${index}`, title: `Saved idea ${index}`, body: "x".repeat(13_000), version: 1, createdAt: now, updatedAt: now }));
    const context = workspaceChatContext(fixture(), owner, notes, "Saved ideas", day, now);
    expect(context.data.noteCoverage).toMatchObject({ total: 14, included: 12 }); expect(context.data.notes.every(note => note.bodyTruncated)).toBe(true);
    expect(workspaceChatReservationUsd("Saved ideas", context)).toBeGreaterThan(0);
  });
  it.each(["What if we put Tyler first?", "Maybe rearrange my day", "Don't put Tyler first", "> Put Tyler first", "The client said put Tyler first"])("does not authorize changes from: %s", text => {
    expect(requestsReorder(text)).toBe(false);
    const result = compileWorkspaceChatIntent(intent(text), text, fixture(), owner, day, now, "test", []);
    expect(result.command).toBeUndefined(); expect(result.reply.kind).toBe("clarification");
  });
  it("blocks create/delete/complete actions and rejects extra model command fields", () => {
    for (const text of ["Create a task for Tyler", "Delete the Tyler task", "Complete Tyler"])
      expect(deterministicChatAnswer(text, fixture(), day)!.reply.message).toContain("cannot create");
    const result = compileWorkspaceChatIntent({ ...intent(reorderText), commands: [{ type: "create" }] }, reorderText, fixture(), owner, day, now, "test", []);
    expect(result.command).toBeUndefined();
    expect(workspaceChatRequestSchema.safeParse({ action: "confirm", operationId: "test", commands: [{ type: "create" }], baseVersion: 0, reviewFingerprint: "a".repeat(64) }).success).toBe(false);
  });
});

describe("server compilation of same-day reorder", () => {
  it("preserves the user's four tasks, IDs and lengths while changing their requested order", () => {
    const state = fixture(), before = structuredClone(state);
    const result = compileWorkspaceChatIntent(intent(reorderText), reorderText, state, owner, day, now, "example", []);
    expect(result.reply.kind, result.reply.message).toBe("preview"); expect(result.command).toMatchObject({ sessionIds: ["s-tyler", "s-tree", "s-oral", "s-cidwp"] });
    expect(result.reply.changes?.map(change => change.workItemId)).toEqual(["tyler", "oral"]);
    expect(result.reply.proposal!.items).toEqual(state.items);
    expect(result.reply.proposal!.sessions.map(session => [session.id, minutesBetween(session.start, session.end)])).toEqual(state.sessions.map(session => [session.id, minutesBetween(session.start, session.end)]));
    expect(state).toEqual(before);
  });
  it.each(["first", "last", "swap"])("supports %s without replacing other work", mode => {
    const text = mode === "swap" ? "Swap Tyler and Oral Surgery today" : `Put Tyler ${mode} today`;
    const result = compileWorkspaceChatIntent(intent(text, { orderMode: mode, references: mode === "swap" ? ["Tyler", "Oral Surgery"] : ["Tyler"] }), text, fixture(), owner, day, now, "example", []);
    expect(result.reply.kind, result.reply.message).toBe("preview"); expect(result.command?.type).toBe("reorder_day");
  });
  it("does not invent references or use a description as authority", () => {
    const text = "How busy am I?";
    const state = fixture(); state.items[0].description = reorderText;
    expect(compileWorkspaceChatIntent(intent(reorderText), text, state, owner, day, now, "test", []).command).toBeUndefined();
    const unknown = "Put Missing Client first today";
    expect(compileWorkspaceChatIntent(intent(unknown, { references: ["Missing Client"], orderMode: "first" }), unknown, state, owner, day, now, "test", []).reply.message).toContain("could not uniquely match");
  });
  it.each(["Put Tyler first at 2 PM today", "Put Tyler first at 14:00 today", "Put Tyler first after lunch today"])("does not silently discard explicit time constraints: %s", text => {
    const result = compileWorkspaceChatIntent(intent(text, { orderMode: "first", references: ["Tyler"] }), text, fixture(), owner, day, now, "exact-time", []);
    expect(result.command).toBeUndefined(); expect(result.reply.message).toContain("Manage sessions");
  });
  it("clarifies two same-client projects instead of guessing one", () => {
    const state = fixture(); state.items[1].clientId = "tyler";
    const text = "Put Tyler first today";
    expect(compileWorkspaceChatIntent(intent(text, { references: ["Tyler"], orderMode: "first" }), text, state, owner, day, now, "test", []).reply.message).toContain("more than one project");
  });
  it("requires fresh explicit protected override and does not grant one by inference", () => {
    const result = compileWorkspaceChatIntent(intent(reorderText, { overrideProtected: true }), reorderText, fixture(), owner, day, now, "test", []);
    expect(result.command).toBeUndefined(); expect(result.reply.message).toContain("explicitly ask");
    const text = `${reorderText} Override protected sessions.`;
    expect(compileWorkspaceChatIntent(intent(text, { overrideProtected: true }), text, fixture(), owner, day, now, "test", []).command).toMatchObject({ overrideProtected: true });
  });
  it("does not return an executable command for requester, date mismatch, history or unknown sources", () => {
    expect(compileWorkspaceChatIntent(intent(reorderText), reorderText, fixture(), DEMO_MEMBERS[1], day, now, "test", []).command).toBeUndefined();
    expect(compileWorkspaceChatIntent(intent(reorderText, { date: "2026-09-10" }), reorderText, fixture(), owner, day, now, "test", []).command).toBeUndefined();
    expect(compileWorkspaceChatIntent(intent(reorderText), reorderText, fixture(), owner, day, at("15:00"), "test", []).command).toBeUndefined();
    const raw = intent("What notes?", { intent: "answer", sources: ["note:forged"] });
    expect(compileWorkspaceChatIntent(raw, "What notes?", fixture(), owner, day, now, "test", []).reply.kind).toBe("clarification");
  });
  it("turns an already-correct order into an answer without a commit proposal", () => {
    const text = "Put Oral Surgery first today";
    const result = compileWorkspaceChatIntent(intent(text, { orderMode: "first", references: ["Oral Surgery"] }), text, fixture(), owner, day, now, "test", []);
    expect(result.reply.kind).toBe("answer"); expect(result.reply.proposal).toBeUndefined(); expect(result.reply.message).toContain("already in that order");
  });
});

describe("private conversation and provider boundaries", () => {
  const response: WorkspaceChatResponse = { reply: { kind: "answer", message: "Private answer", sources: [] }, operationId: "hello", stateVersion: 0, asOf: now };
  it("bounds history and rejects foreign actor/workspace/role, other namespace, and expired records", () => {
    const state = fixture(); let record = workspaceChatRecord(owner, state, response, "What is tomorrow?", day, "agenda");
    for (let i = 0; i < 20; i++) record = workspaceChatRecord(owner, state, response, "x".repeat(6000), day, "answer", record);
    expect(record.turns.length).toBeLessThanOrEqual(10); expect(record.turns.reduce((sum, turn) => sum + turn.user.length + turn.assistant.length, 0)).toBeLessThanOrEqual(24_000);
    expect(readWorkspaceChatRecord(record, owner, state, now)).toEqual(record);
    for (const bad of [{ ...record, actorId: "other" }, { ...record, actorRole: "requester" }, { ...record, workspaceId: "other" }, { ...record, namespace: "assistant" }, { ...record, createdAt: "2026-09-07T12:00:00Z" }, { ...record, turns: Array(11).fill(record.turns[0]) }]) expect(() => readWorkspaceChatRecord(bad, owner, state, now)).toThrow(/Start a new chat/);
  });
  it("continues an agenda follow-up with fresh data, not the previous answer's hours", () => {
    const state = fixture(), previous = workspaceChatRecord(owner, state, response, "What is tomorrow?", day, "agenda");
    state.sessions = [];
    expect(deterministicChatAnswer("What about tomorrow?", state, "2026-09-10", previous)!.reply.message).toContain("No work sessions");
  });
  it("handles deterministic facts without any provider call", async () => {
    await interpretWorkspaceChat("How busy am I this week?", fixture(), owner, [], { date: day, now, operationId: "facts", demo: false });
    expect(parse).not.toHaveBeenCalled();
  });
  it("uses strict same-model Responses output and private sources without exposing tools", async () => {
    const note: PersonalNote = { id: "note", title: "Build ideas", body: "Saved idea, not a project", version: 1, createdAt: now, updatedAt: now };
    parse.mockResolvedValue({ output_parsed: intent("", { intent: "answer", message: "Your note lists a saved idea, not a booked project.", sources: ["note:note"] }), usage: { input_tokens: 100, output_tokens: 20 } });
    vi.stubEnv("OPENAI_API_KEY", "fake-test-key-never-sent");
    try {
      const result = await interpretWorkspaceChat("What does my Build ideas note say?", fixture(), owner, [note], { date: day, now, operationId: "notes", demo: false });
      expect(result.reply.sources).toEqual([{ kind: "note", id: "note", title: "Build ideas" }]);
      expect(parse).toHaveBeenCalledWith(expect.objectContaining({ model: "gpt-5.6-sol", store: false, text: expect.objectContaining({ format: expect.objectContaining({ type: "json_schema", strict: true }) }) }));
      expect(parse.mock.calls[0][0]).not.toHaveProperty("tools");
    } finally { vi.unstubAllEnvs(); }
  });
});

describe("existing-project booking edits", () => {
  it("distinguishes final totals, signed deltas and before/after hours", () => {
    expect(workspaceBookingAmount("Reduce it from 2 hours to 1 hour", "resize")).toEqual({ beforeMinutes: 120, minutes: 60, mode: "total" });
    expect(workspaceBookingAmount("Increase it from 1 to 2 hours", "resize")).toEqual({ beforeMinutes: 60, minutes: 120, mode: "total" });
    expect(workspaceBookingAmount("Shorten it by half an hour", "resize")).toEqual({ minutes: -30, mode: "delta" });
    expect(workspaceBookingAmount("Make it an hour and a half", "resize")).toEqual({ minutes: 90, mode: "total" });
    expect(workspaceBookingAmount("Add 1 more hour", "add")).toEqual({ minutes: 60, mode: "delta" });
    expect(workspaceBookingAmount("Add -1 hour", "add").error).toBeTruthy();
    expect(workspaceBookingAmount("Add 1/2 hour", "add").error).toBeTruthy();
    expect(workspaceBookingAmount("Reduce from 2 hours to 1 hour and 30 minutes", "resize").error).toBeTruthy();
    expect(workspaceBookingAmount("Shorten it by 30 minutes", "resize")).toEqual({ minutes: -30, mode: "delta" });
    expect(workspaceBookingAmount("Add 2 hours each working day", "add")).toEqual({ minutes: 120, mode: "per_day" });
    expect(workspaceBookingAmount("Move it tomorrow", "move")).toEqual({ mode: "all" });
  });
  it("keeps source and destination dates separate from the amount numbers", () => {
    expect(workspaceBookingDates("Reduce Homepage demo from 2 hours to 1 hour tomorrow", "resize", day, day)).toMatchObject({ sourceDate: "2026-09-10", targetDate: "2026-09-10" });
    expect(workspaceBookingDates("Move 1 hour of Homepage demo from today to tomorrow", "transfer", day, day)).toMatchObject({ sourceDate: day, targetDate: "2026-09-10" });
    expect(workspaceBookingDates("Move Homepage demo to tomorrow from today", "move", day, day)).toMatchObject({ sourceDate: day, targetDate: "2026-09-10" });
    expect(workspaceBookingDates("Add 1 hour each day from September 14 to September 18", "add", day, day)).toMatchObject({ targetDate: "2026-09-14", endDate: "2026-09-18" });
    expect(workspaceChatMessageDate("Move Homepage demo to tomorrow", day, day)).toEqual({ date: day });
  });
  it("shortens an existing two-hour booking without changing its estimate or identity", () => {
    const state = fixture(); state.items[3].minimumSessionMinutes = 120;
    const text = "Reduce Homepage demo from 2 hours to 1 hour today";
    const result = compileWorkspaceChatIntent(bookingIntent(text, {}), text, state, owner, day, now, "resize", []);
    expect(result.reply.kind, result.reply.message).toBe("preview");
    expect(result.command).toEqual({ type: "resize_booking", sessionId: "s-cidwp", minutes: 60 });
    expect(result.reply.totals).toEqual({ beforeMinutes: 120, afterMinutes: 60, deltaMinutes: -60 });
    expect(result.reply.proposal!.items[3]).toMatchObject({ remainingMinutes: 120, estimatedMinutes: 120 });
    expect(result.reply.changes![0]).toMatchObject({ sessionId: "s-cidwp", kind: "resized", beforeStart: at("12:30"), afterStart: at("12:30") });
  });
  it("adds hours to an existing unknown-total waiting project and explicitly previews resumption", () => {
    const state = fixture(); state.items[3].status = "waiting"; state.items[3].estimatedMinutes = state.items[3].remainingMinutes = null; state.sessions = state.sessions.filter(session => session.workItemId !== "cidwp");
    const text = "Add 1 hour to Homepage demo tomorrow";
    const result = compileWorkspaceChatIntent(bookingIntent(text, { kind: "add" }), text, state, owner, day, now, "add", []);
    expect(result.reply.kind, result.reply.message).toBe("preview");
    expect(result.command).toMatchObject({ type: "add_booking", itemId: "cidwp", request: { minutes: 60, startDate: "2026-09-10", endDate: "2026-09-10", resumeWaiting: true } });
    expect(result.reply.details?.[0]).toContain("Resume this waiting project");
    expect(result.reply.totals).toEqual({ beforeMinutes: 0, afterMinutes: 60, deltaMinutes: 60 });
    expect(result.reply.changes![0].beforeStart).toBeNull();
    expect(result.reply.proposal!.items[3]).toMatchObject({ estimatedMinutes: null, remainingMinutes: null });
  });
  it("adds hours across a grounded range with explicit each-day distribution", () => {
    const state = fixture(); state.items[3].estimatedMinutes = state.items[3].remainingMinutes = null;
    const text = "Add 1 hour to Homepage demo each day from September 14 to September 18";
    const result = compileWorkspaceChatIntent(bookingIntent(text, { kind: "add" }), text, state, owner, day, now, "range", []);
    expect(result.reply.kind, result.reply.message).toBe("preview");
    expect(result.command).toMatchObject({ type: "add_booking", request: { distribution: "per_day", minutes: 60, startDate: "2026-09-14", endDate: "2026-09-18" } });
    expect(result.reply.totals?.deltaMinutes).toBe(300); expect(result.reply.dayImpacts).toHaveLength(5);
  });
  it.each([false, true])("moves existing hours across days without adding effort (partial=%s)", partial => {
    const state = fixture(), text = partial ? "Move 1 hour of Homepage demo from today to tomorrow" : "Move Homepage demo from today to tomorrow";
    const result = compileWorkspaceChatIntent(bookingIntent(text, { kind: partial ? "transfer" : "move" }), text, state, owner, day, now, "move", []);
    expect(result.reply.kind, result.reply.message).toBe("preview"); expect(result.command).toMatchObject({ type: "move_booking", sessionId: "s-cidwp", date: "2026-09-10" });
    expect(result.reply.totals?.deltaMinutes).toBe(0); expect(result.reply.dayImpacts?.map(impact => impact.date)).toEqual([day, "2026-09-10"]);
    if (partial) expect(result.reply.changes?.map(change => change.kind).sort()).toEqual(["added", "resized"]);
    else expect(result.reply.changes?.[0]).toMatchObject({ sessionId: "s-cidwp", kind: "moved" });
  });
  it("supports an explicitly requested destination clock instead of inventing a time", () => {
    const state = fixture(), text = "Move Homepage demo from today to tomorrow at 2 PM";
    const result = compileWorkspaceChatIntent(bookingIntent(text, { kind: "move", targetStartTime: "14:00" }), text, state, owner, day, now, "clock", []);
    expect(result.reply.kind, result.reply.message).toBe("preview"); expect(result.command).toMatchObject({ type: "move_booking", startTime: "14:00" });
  });
  it("cannot silently change known effort or guess among multiple same-day bookings", () => {
    const state = fixture(), text = "Add 1 hour to Homepage demo tomorrow";
    const added = compileWorkspaceChatIntent(bookingIntent(text, { kind: "add" }), text, state, owner, day, now, "too-much", []);
    expect(added.reply.kind).toBe("clarification"); expect(added.reply.proposal!.items[3].remainingMinutes).toBe(120);
    state.sessions.push({ ...state.sessions[3], id: "second-demo", start: at("15:00"), end: at("16:00") });
    const resize = "Resize the Homepage demo booking to 1 hour today";
    expect(compileWorkspaceChatIntent(bookingIntent(resize, {}), resize, state, owner, day, now, "ambiguous", []).reply.message).toContain("multiple bookings");
  });
  it("grounds new amounts/dates and rejects forged proposals, zero duration and old override permission", () => {
    const state = fixture(), text = "Reduce Homepage demo from 2 hours to 1 hour today";
    expect(compileWorkspaceChatIntent(bookingIntent(text, { minutes: 120 }), text, state, owner, day, now, "wrong-hours", []).command).toBeUndefined();
    expect(compileWorkspaceChatIntent(bookingIntent(text, { sourceDate: "2026-09-10" }), text, state, owner, day, now, "wrong-date", []).command).toBeUndefined();
    expect(compileWorkspaceChatIntent(bookingIntent(text, {}, { overrideProtected: true }), text, state, owner, day, now, "override", []).command).toBeUndefined();
    const zero = "Make Homepage demo 0 hours today";
    expect(compileWorkspaceChatIntent(bookingIntent(zero, {}), zero, state, owner, day, now, "zero", []).command).toBeUndefined();
  });
  it.each([
    "Reduce both Oral Surgery and Homepage demo to 1 hour today",
    "Reduce Homepage demo to 1 hour and move Tyler tomorrow",
    "Reduce Homepage demo and Oral Surgery to 1 hour today",
  ])("does not drop part of a compound booking request: %s", text => {
    const result = compileWorkspaceChatIntent(bookingIntent(text, {}), text, fixture(), owner, day, now, "compound", []);
    expect(result.reply.kind).toBe("clarification"); expect(result.command).toBeUndefined();
  });
  it("does not ignore incomplete or invalid clock instructions", () => {
    for (const text of ["Move Homepage demo tomorrow at 2", "Move Homepage demo tomorrow at 25 PM"]) {
      const result = compileWorkspaceChatIntent(bookingIntent(text, { kind: "move" }), text, fixture(), owner, day, now, "unclear-clock", []);
      expect(result.reply.kind).toBe("clarification"); expect(result.command).toBeUndefined();
    }
  });
  it("uses only a server-verified focused task for pronoun follow-ups", () => {
    const state = fixture(), text = "Reduce Homepage demo from 2 hours to 1 hour today";
    const first = compileWorkspaceChatIntent(bookingIntent(text, {}), text, state, owner, day, now, "first", []);
    const response: WorkspaceChatResponse = { reply: first.reply, operationId: "first", stateVersion: state.version, asOf: now, contextDate: day };
    const previous = workspaceChatRecord(owner, state, response, text, day, "edit", undefined, first.command);
    const followup = "Move it to tomorrow";
    const result = compileWorkspaceChatIntent(bookingIntent(followup, { kind: "move", reference: null }), followup, state, owner, day, now, "followup", [], previous);
    expect(result.reply.kind, result.reply.message).toBe("preview"); expect(result.command).toMatchObject({ sessionId: "s-cidwp", date: "2026-09-10" });
    expect(compileWorkspaceChatIntent(bookingIntent(followup, { kind: "move", reference: null }), followup, state, owner, day, now, "no-focus", []).command).toBeUndefined();
  });
});
