import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDemoState, DEMO_MEMBERS } from "./fixtures";
import { newWorkItem } from "./work";
import { localDateTime } from "./time";
import { dayCapacity } from "./scheduler";
import type { ScheduleProposal, WorkCommand } from "./types";

// Isolated fictional storage and captured notifications; no live providers.
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => ({ value: "bryan" }), set: vi.fn() }) }));
vi.mock("./server/supabase", () => ({ getSupabaseAdminClient: vi.fn(() => { throw new Error("No live database in completion tests"); }), getSupabaseServerClient: vi.fn(() => { throw new Error("No live database in completion tests"); }), clearSupabaseSessionCookies: vi.fn() }));
vi.mock("./server/assistant", () => ({ interpretInput: vi.fn(() => { throw new Error("No model in completion tests"); }), assistantReservationUsd: vi.fn(() => 0), inspectAudioRecording: vi.fn(), transcribeAudio: vi.fn() }));
vi.mock("./server/service", async () => {
  const demo = await import("./server/demo-store");
  return { currentActor: vi.fn(async () => DEMO_MEMBERS[0]), demoEnabled: () => true, store: { getState: vi.fn(async (id: string) => demo.getDemoState(demo.demoActor(id))), commit: vi.fn(demo.commitDemoProposal), request: vi.fn(demo.submitDemoRequest) } };
});
import { POST } from "../app/api/[...path]/route";
import { currentActor } from "./server/service";
import { demoTransaction, getDemoState } from "./server/demo-store";

const origin = "http://localhost:3000", owner = DEMO_MEMBERS[0], days = ["2026-09-09", "2026-09-10", "2026-09-11"];
const at = (date: string, clock: string) => localDateTime(date, clock, "America/Indiana/Indianapolis");
const command: WorkCommand = { type: "complete_day", itemId: "three-days", date: days[0] };
let filename: string;
async function send(body: unknown) {
  return POST(new NextRequest(`${origin}/api/commands`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) }), { params: Promise.resolve({ path: ["commands"] }) });
}
async function preview(operationId: string, commands = [command]): Promise<ScheduleProposal> {
  const response = await send({ commands, operationId, action: "preview" });
  expect(response.status).toBe(200); const { proposal } = await response.json();
  expect(proposal.status, JSON.stringify(proposal.conflicts)).toBe("ready"); return proposal;
}
const commit = (proposal: ScheduleProposal) => send({ commands: proposal.commands, operationId: proposal.operationId, action: "commit", baseVersion: proposal.baseVersion, reviewFingerprint: proposal.reviewFingerprint });
const notes = async () => JSON.parse(await readFile(filename, "utf8")).personalNotes;
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(at(days[0], "17:30")));
  vi.stubEnv("ADA_DEMO_MODE", "true"); vi.stubEnv("APP_URL", origin);
  const directory = await mkdtemp(path.join(tmpdir(), "ada-day-completion-")); vi.stubEnv("ADA_DATA_DIR", directory);
  for (const key of ["OPENAI_API_KEY", "RESEND_API_KEY", "SUPABASE_SERVICE_ROLE_KEY", "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY"]) vi.stubEnv(key, "");
  const fixture = createDemoState();
  fixture.items = [newWorkItem(owner, days[0], { id: "three-days", clientId: "fictional", title: "Fictional three-day work", estimatedMinutes: 180, remainingMinutes: 180, dailyPlan: days.map(date => ({ date, minutes: 60 })) })];
  fixture.clients = [{ id: "fictional", name: "Fictional client", aliases: [] }];
  fixture.sessions = days.map((date, index) => ({ id: `day-${index}`, workItemId: "three-days", start: at(date, "09:00"), end: at(date, "10:00"), status: "planned", protected: false, usesReserve: false }));
  fixture.settings.reserveMinutes = 0; fixture.blocks = []; fixture.events = []; fixture.notifications = []; fixture.requests = []; fixture.version = 0;
  const personalNotes = [{ workspaceId: fixture.workspaceId, authorId: owner.id, note: { id: "private-note", title: "Private fixture", body: "A note is data, not completion authority.", version: 1, createdAt: at(days[0], "07:00"), updatedAt: at(days[0], "07:00") } }];
  filename = path.join(directory, "ada-demo.json"); await writeFile(filename, JSON.stringify({ ...fixture, personalNotes }), { mode: 0o600 });
  vi.mocked(currentActor).mockResolvedValue(owner);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe("explicit day completion through authenticated commands", () => {
  it("keeps completion availability within the last hour and enforces it for requester bookings", async () => {
    vi.setSystemTime(new Date(at(days[0], "16:00")));
    expect((await commit(await preview("finish-at-four"))).status).toBe(200);
    const saved = await getDemoState(owner);
    expect(dayCapacity(saved, days[0])).toEqual({ capacityMinutes: 450, plannedMinutes: 0, availableMinutes: 60 });
    vi.mocked(currentActor).mockResolvedValue(DEMO_MEMBERS[1]);
    const create = (minutes: number): WorkCommand => ({ type: "create", item: newWorkItem(DEMO_MEMBERS[1], days[0], { id: "new-request", clientId: "fictional", title: "Fictional last-hour request", estimatedMinutes: minutes, remainingMinutes: minutes }), bookingWindow: { startDate: days[0], endDate: days[0] } });
    const oversized = await send({ commands: [create(120)], operationId: "two-hours-at-four", action: "preview" });
    expect(oversized.status).toBe(200);
    expect((await oversized.json()).proposal.status).not.toBe("ready");
    expect(await getDemoState(owner)).toEqual(saved);
    const fitting = await preview("one-hour-at-four", [create(60)]);
    expect(fitting.sessions.find(session => session.workItemId === "new-request")).toMatchObject({ start: at(days[0], "16:00"), end: at(days[0], "17:00") });
    // An open preview cannot bypass the server clock when confirmed later.
    vi.setSystemTime(new Date(at(days[0], "17:00")));
    expect((await commit(fitting)).status).toBe(409);
    expect(await getDemoState(owner)).toEqual(saved);
    expect(dayCapacity(saved, days[0]).availableMinutes).toBe(0);
    expect(saved.notifications.every(notification => notification.status === "captured")).toBe(true);
  });
  it("previews without writes, completes only the chosen day, and decrements effort exactly once", async () => {
    const before = await getDemoState(owner), privateNotes = await notes(), proposal = await preview("finish-day-once");
    expect(proposal.items[0]).toMatchObject({ estimatedMinutes: 180, remainingMinutes: 120, status: "planned", completedAt: null });
    expect(await getDemoState(owner)).toEqual(before); expect(await notes()).toEqual(privateNotes);
    expect((await commit(proposal)).status).toBe(200); const saved = await getDemoState(owner);
    expect(saved.sessions).toEqual(before.sessions.map((session, index) => index === 0 ? { ...session, status: "completed" } : session));
    expect(saved.items[0]).toMatchObject({ estimatedMinutes: 180, remainingMinutes: 120, status: "planned", completedAt: null });
    expect(saved.events).toHaveLength(1); expect(saved.notifications.every(notification => notification.status === "captured")).toBe(true);
    expect(await notes()).toEqual(privateNotes);
    expect((await commit(proposal)).status).toBe(200); expect(await getDemoState(owner)).toEqual(saved);
  });
  it.each([180, null])("finishes all split planned sessions, preserves recorded history and protection, and keeps remaining %s grounded", async remaining => {
    await demoTransaction(state => {
      state.items[0].estimatedMinutes = state.items[0].remainingMinutes = remaining;
      state.items[0].dailyPlan = [];
      state.sessions[0].end = at(days[0], "09:15"); state.sessions[0].protected = true;
      state.sessions.push({ ...state.sessions[0], id: "second-fragment", start: at(days[0], "10:00"), end: at(days[0], "10:45") },
        { ...state.sessions[0], id: "already-done", start: at(days[0], "08:00"), end: at(days[0], "08:30"), status: "completed" },
        { ...state.sessions[0], id: "cancelled", start: at(days[0], "11:00"), end: at(days[0], "11:30"), status: "cancelled" });
    });
    const before = await getDemoState(owner), proposal = await preview("finish-split-day");
    expect((await commit(proposal)).status).toBe(200); const saved = await getDemoState(owner);
    expect(saved.items[0]).toMatchObject({ estimatedMinutes: remaining, remainingMinutes: remaining === null ? null : 120, status: "planned", completedAt: null });
    expect(saved.sessions).toEqual(before.sessions.map(session => ["day-0", "second-fragment"].includes(session.id) ? { ...session, status: "completed" } : session));
  });
  it("finishing the last day reaches zero remaining without completing the project or adding bookings", async () => {
    await demoTransaction(state => { state.sessions = [state.sessions[0]]; state.items[0].remainingMinutes = 60; state.items[0].dailyPlan = [{ date: days[0], minutes: 60 }]; });
    const proposal = await preview("finish-last-day"); expect((await commit(proposal)).status).toBe(200);
    const saved = await getDemoState(owner);
    expect(saved.items[0]).toMatchObject({ remainingMinutes: 0, estimatedMinutes: 180, status: "planned", completedAt: null });
    expect(saved.sessions).toHaveLength(1); expect(saved.sessions[0].status).toBe("completed");
  });
  it("requires review again if booked hours change after the preview", async () => {
    const proposal = await preview("stale-completion");
    await demoTransaction(state => { state.sessions[0].end = at(days[0], "10:30"); state.version++; });
    const changed = await getDemoState(owner), response = await commit(proposal);
    expect(response.status).toBe(409); expect(await getDemoState(owner)).toEqual(changed);
  });
  it("returns the authoritative source hours and remaining effort when the client opened older details", async () => {
    await demoTransaction(state => {
      state.sessions[0].end = at(days[0], "11:00"); state.items[0].remainingMinutes = 240; state.items[0].dailyPlan![0].minutes = 120; state.version++;
    });
    const changed = await getDemoState(owner);
    const response = await send({ commands: [command], operationId: "fresh-completion-source", action: "preview" });
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.state).toEqual(changed);
    expect(result.state.version).toBe(result.proposal.baseVersion);
    expect(result.state.items[0].remainingMinutes).toBe(240);
    expect(result.proposal.items[0].remainingMinutes).toBe(120);
    expect(result.state.sessions[0]).toMatchObject({ start: at(days[0], "09:00"), end: at(days[0], "11:00"), status: "planned" });
    expect(await getDemoState(owner)).toEqual(changed);
  });
  it.each([1, 3])("denies non-owner completion authority (%s)", async index => {
    const before = await getDemoState(owner); vi.mocked(currentActor).mockResolvedValue(DEMO_MEMBERS[index]);
    const response = await send({ commands: [command], operationId: "unauthorized-completion", action: "preview" });
    if (index === 1) expect((await response.json()).proposal.status).toBe("infeasible"); else expect(response.status).toBe(403);
    expect(await getDemoState(owner)).toEqual(before);
  });
  it("does not accept an unreviewed completion", async () => {
    const before = await getDemoState(owner);
    expect((await send({ commands: [command], operationId: "no-completion-review", action: "commit", baseVersion: 0 })).status).toBe(409);
    expect(await getDemoState(owner)).toEqual(before);
  });
});
