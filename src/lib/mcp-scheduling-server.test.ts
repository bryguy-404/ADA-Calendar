import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fixture, booking } from "./mcp/test-fixtures";
import { DEMO_MEMBERS } from "./fixtures";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => ({ value: "bryan" }), set: vi.fn() }) }));
vi.mock("./server/supabase", () => ({ getSupabaseAdminClient: vi.fn(), getSupabaseServerClient: vi.fn(), clearSupabaseSessionCookies: vi.fn() }));
vi.mock("./server/assistant", () => ({ interpretInput: vi.fn(), assistantReservationUsd: vi.fn(), inspectAudioRecording: vi.fn(), transcribeAudio: vi.fn() }));
vi.mock("./server/service", async () => {
  const demo = await import("./server/demo-store");
  return { currentActor: vi.fn(async () => DEMO_MEMBERS[0]), demoEnabled: () => true,
    store: { getState: vi.fn(async (id: string) => demo.getDemoState(demo.demoActor(id))),
      commit: demo.commitDemoProposal, hasCommittedOperation: demo.hasCommittedDemoOperation } };
});
import { prepareSchedule, commitSchedule } from "./server/mcp-scheduling";
import { POST } from "../app/api/[...path]/route";
import { currentActor, store } from "./server/service";
import { getDemoState } from "./server/demo-store";
import type { PrepareScheduleInput } from "./mcp/scheduling-contract";

const origin = "http://localhost:3000", owner = DEMO_MEMBERS[0];
let directory: string;
const send = (action: string, input: unknown, actorId = owner.id, workspaceId = "fictional-workspace", requestOrigin = origin) => POST(new NextRequest(origin + "/api/mcp-scheduling/" + action, {
  method: "POST", headers: { origin: requestOrigin, "content-type": "application/json" }, body: JSON.stringify({ actorId, workspaceId, input }),
}), { params: Promise.resolve({ path: ["mcp-scheduling", action] }) });
const request = (): PrepareScheduleInput => ({ workspaceId: "fictional-workspace", baseVersion: 17, operationId: randomUUID(), change: { kind: "create", task: {
  clientId: "becht", title: "FICTIONAL durable task", description: "Fictional source only", category: "web", webKind: "edit", estimatedMinutes: null,
  windowStart: "2026-11-03", windowEnd: null, targetDate: "2026-11-20", deadline: null, minimumSessionMinutes: 15, references: ["https://example.test/brief"],
}, booking: { startDate: "2026-11-03", endDate: "2026-11-03", minutes: 60, distribution: "total" } } });
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "ada-scheduling-server-"));
  vi.stubEnv("ADA_DEMO_MODE", "true"); vi.stubEnv("ADA_DATA_DIR", directory); vi.stubEnv("APP_URL", origin);
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-11-02T13:00:00Z"));
  const state = fixture(); state.mode = "demo"; state.actor = owner;
  state.sessions = [booking("website", "2026-10-30", "completed"), booking("website", "2026-10-29", "cancelled")];
  state.events = []; state.notifications = []; state.requests = [];
  await writeFile(path.join(directory, "ada-demo.json"), JSON.stringify(state));
  vi.mocked(currentActor).mockResolvedValue(owner);
});
afterEach(async () => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.clearAllMocks(); await rm(directory, { recursive: true, force: true }); });
const commitInput = (preview: Awaited<ReturnType<typeof prepareSchedule>>) => ({ workspaceId: preview.source.workspaceId,
  operationId: preview.operationId, baseVersion: preview.baseVersion, reviewFingerprint: preview.reviewFingerprint });
describe("durable scoped MCP scheduling server", () => {
  it("prepares without scheduling/mail; delayed commit saves exact IDs, persists a receipt and retries without duplicates", async () => {
    const before = await getDemoState(owner), input = request();
    const prepared = await prepareSchedule(owner, input, before);
    expect(await getDemoState(owner)).toEqual(before);
    vi.setSystemTime(new Date("2026-11-02T13:02:00Z"));
    const result = await commitSchedule(owner, commitInput(prepared), await getDemoState(owner));
    expect(result.receipt.outcome).toBe("committed");
    const after = await getDemoState(owner);
    expect(after.version).toBe(18); expect(after.events).toHaveLength(1);
    expect(after.sessions.filter(s => s.workItemId === "website")).toEqual(before.sessions);
    expect(after.items.find(i => i.id === input.operationId)?.createdAt).toBe("2026-11-02T13:02:00.000Z");
    const readPrepared = await prepareSchedule(owner, input, after);
    expect(readPrepared.diff).toEqual(prepared.diff);
    expect((await commitSchedule(owner, commitInput(readPrepared), after)).receipt.outcome).toBe("replayed");
    expect(await getDemoState(owner)).toEqual(after);
    expect(JSON.stringify(after)).not.toContain("mcpScheduleOperations");
  });
  it("rejects a changed retry and altered fingerprint or stale version", async () => {
    const input = request(), before = await getDemoState(owner), preview = await prepareSchedule(owner, input, before);
    expect(await send("prepare", { ...input, change: { kind: "ongoing", workItemId: "website", unknownEffort: true } })).toHaveProperty("status", 409);
    expect(await send("commit", { ...commitInput(preview), reviewFingerprint: "0".repeat(64) })).toHaveProperty("status", 409);
    expect(await send("prepare", { ...request(), baseVersion: 16 })).toHaveProperty("status", 409);
    expect(await getDemoState(owner)).toEqual(before);
  });
  it("serializes concurrent commits against one base version; the loser never displaces the winner", async () => {
    const before = await getDemoState(owner), a = await prepareSchedule(owner, request(), before), b = await prepareSchedule(owner, request(), before);
    const replies = await Promise.all([send("commit", commitInput(a)), send("commit", commitInput(b))]);
    expect(replies.map(r => r.status).sort()).toEqual([200, 409]);
    expect((await getDemoState(owner)).events).toHaveLength(1);
  });
  it("reconciles a commit whose response was lost, and an uncertain ledger read", async () => {
    const preview = await prepareSchedule(owner, request(), await getDemoState(owner)), original = store.commit;
    vi.spyOn(store, "commit").mockImplementationOnce(async (...args) => { await original(...args); throw new Error("Lost connection after commit"); });
    const lost = await send("commit", commitInput(preview)); expect(lost.status).toBe(503); expect((await lost.json()).code).toBe("save_uncertain");
    vi.spyOn(store, "hasCommittedOperation").mockRejectedValueOnce(new Error("Connection unavailable"));
    expect((await send("commit", commitInput(preview))).status).toBe(503);
    const retry = await send("commit", commitInput(preview)); expect(retry.status).toBe(200); expect((await retry.json()).receipt.outcome).toBe("replayed");
    expect((await getDemoState(owner)).events).toHaveLength(1);
  });
  it("rejects requester/viewer, changed session identity, wrong workspace, external origin and unauthenticated calls", async () => {
    const before = await getDemoState(owner);
    for (const actor of [DEMO_MEMBERS[1], DEMO_MEMBERS[3]]) {
      vi.mocked(currentActor).mockResolvedValue(actor);
      expect((await send("prepare", request(), actor.id)).status).toBe(403);
    }
    vi.mocked(currentActor).mockResolvedValue(owner);
    expect((await send("prepare", request(), "someone-else")).status).toBe(403);
    expect((await send("prepare", request(), owner.id, "other-workspace")).status).toBe(403);
    expect((await send("prepare", request(), owner.id, before.workspaceId, "https://example.test")).status).not.toBe(200);
    vi.mocked(currentActor).mockRejectedValueOnce(new Error("Sign in required"));
    expect((await send("prepare", request())).status).not.toBe(200);
    expect(await getDemoState(owner)).toEqual(before);
  });
  it("keeps replay readback current after another legitimate context edit", async () => {
    const input = request(), preview = await prepareSchedule(owner, input, await getDemoState(owner));
    await commitSchedule(owner, commitInput(preview), await getDemoState(owner));
    const { saveTaskContext } = await import("./server/task-context");
    await saveTaskContext(owner, { workspaceId: input.workspaceId, workItemId: input.operationId, operationId: randomUUID(), baseVersion: 18, patch: { title: "Later legitimate title" } }, await getDemoState(owner));
    expect((await commitSchedule(owner, commitInput(preview), await getDemoState(owner))).source.scheduleVersion).toBe(19);
    expect((await getDemoState(owner)).items.find(i => i.id === input.operationId)?.title).toBe("Later legitimate title");
  });
});

