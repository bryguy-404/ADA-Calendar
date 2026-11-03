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
import { POST } from "../app/api/[...path]/route";
import { currentActor, store } from "./server/service";
import { getDemoState } from "./server/demo-store";

const origin = "http://localhost:3000", owner = DEMO_MEMBERS[0];
let directory: string;
const send = (body: unknown, requestOrigin = origin) => POST(new NextRequest(origin + "/api/task-context", {
  method: "POST", headers: { origin: requestOrigin, "content-type": "application/json" }, body: JSON.stringify(body),
}), { params: Promise.resolve({ path: ["task-context"] }) });
const input = (patch = { blockedReason: "Verified live; awaiting policy" }) => ({ workspaceId: "fictional-workspace", workItemId: "website", baseVersion: 17, operationId: randomUUID(), patch });
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "ada-context-server-"));
  vi.stubEnv("ADA_DEMO_MODE", "true"); vi.stubEnv("ADA_DATA_DIR", directory); vi.stubEnv("APP_URL", origin);
  const state = fixture(); state.mode = "demo"; state.actor = owner; state.items[0].status = "waiting";
  state.sessions = [booking("website", "2026-11-05"), booking("website", "2026-10-30", "completed"), booking("website", "2026-10-29", "cancelled")].map(session => ({ ...session, protected: true }));
  state.events = []; state.notifications = []; state.requests = [];
  await writeFile(path.join(directory, "ada-demo.json"), JSON.stringify(state));
  vi.mocked(currentActor).mockResolvedValue(owner);
});
afterEach(async () => { vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.clearAllMocks(); await rm(directory, { recursive: true, force: true }); });

describe("authorized task-context endpoint", () => {
  it("audits exactly one update, retains all scheduling data and queues no mail; stale exact retries reconcile", async () => {
    const before = await getDemoState(owner), request = input();
    expect((await send(request)).status).toBe(200);
    const after = await getDemoState(owner);
    expect(after.sessions).toEqual(before.sessions); expect(after.settings).toEqual(before.settings);
    expect(after.items).toEqual([{ ...before.items[0], blockedReason: request.patch.blockedReason, updatedAt: after.items[0].updatedAt }]);
    expect(after.version).toBe(18); expect(after.events).toHaveLength(1); expect(after.events[0].type).toBe("task_context_updated"); expect(after.notifications).toEqual([]);
    const replay = await send(request); expect(replay.status).toBe(200);
    expect((await replay.json()).receipt.outcome).toBe("replayed");
    expect(await getDemoState(owner)).toEqual(after);
    const changedRetry = await send({ ...request, patch: { blockedReason: "Different content" } });
    expect(changedRetry.status).toBe(409); expect(await getDemoState(owner)).toEqual(after);
  });
  it("rejects stale and concurrent changes and does not restore old context when replaying a prior save", async () => {
    const first = input(), second = input({ blockedReason: "Concurrent edit" });
    const results = await Promise.all([send(first), send(second)]);
    expect(results.map(result => result.status).sort()).toEqual([200, 409]);
    const winner = results[0].status === 200 ? first : second;
    expect((await send({ ...input({ blockedReason: "Latest correction" }), baseVersion: 18 })).status).toBe(200);
    const replay = await send(winner); expect(replay.status).toBe(200);
    expect((await replay.json()).state.items[0].blockedReason).toBe("Latest correction");
    expect((await getDemoState(owner)).events).toHaveLength(2);
  });
  it("keeps a reconciliation outage uncertain so the same saved operation can be retried safely", async () => {
    const request = input(); expect((await send(request)).status).toBe(200);
    vi.spyOn(store, "hasCommittedOperation").mockRejectedValueOnce(new Error("Database temporarily unavailable"));
    const uncertain = await send(request); expect(uncertain.status).toBe(503);
    expect((await uncertain.json()).code).toBe("save_uncertain");
    const retry = await send(request); expect(retry.status).toBe(200); expect((await retry.json()).receipt.outcome).toBe("replayed");
    expect((await getDemoState(owner)).events).toHaveLength(1);
  });
  it.each([1, 3])("rejects nonowner role %s", async index => {
    const before = await getDemoState(owner); vi.mocked(currentActor).mockResolvedValue(DEMO_MEMBERS[index]);
    expect((await send(input())).status).toBe(403); expect(await getDemoState(owner)).toEqual(before);
  });
  it("rejects wrong workspace, external origin, malformed patch and an unauthenticated caller without writes", async () => {
    const before = await getDemoState(owner);
    expect((await send({ ...input(), workspaceId: "other-workspace" })).status).toBe(403);
    expect((await send(input(), "https://untrusted.example")).status).not.toBe(200);
    expect((await send({ ...input(), patch: { status: "completed" } })).status).toBe(400);
    vi.mocked(currentActor).mockRejectedValue(new Error("Sign in required"));
    expect((await send(input())).status).not.toBe(200); expect(await getDemoState(owner)).toEqual(before);
  });
});
