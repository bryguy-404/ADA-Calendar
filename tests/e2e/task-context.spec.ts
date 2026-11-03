import { test, expect, type Page } from "@playwright/test";
import { fixture, booking, now } from "../../src/lib/mcp/test-fixtures";
import { planCommands } from "../../src/lib/scheduler";
import type { TaskContextRequest } from "../../src/lib/task-context";
import { asActor, origin, state as readState } from "./helpers";

async function setup(page: Page, width: number, loseResponse = false) {
  await asActor(page.request, "bryan");
  const stored = await readState(page.request), initial = fixture();
  let state = { ...initial, workspaceId: stored.workspaceId, actor: stored.actor, mode: "demo" as const, events: [], notifications: [] };
  state.items[0] = { ...state.items[0], title: "Fictional waiting context", status: "waiting", blockedReason: "Old dependency" };
  state.sessions = [booking("website", "2026-11-04"), booking("website", "2026-10-30", "completed"), booking("website", "2026-10-29", "cancelled")].map(session => ({ ...session, protected: true }));
  const before = structuredClone(state), requests: TaskContextRequest[] = [], committed = new Set<string>();
  await page.route(`${origin}/api/state`, route => route.fulfill({ json: state }));
  await page.route(`${origin}/api/task-context`, async route => {
    const input = route.request().postDataJSON() as TaskContextRequest; requests.push(input);
    const replayed = committed.has(input.operationId);
    if (!replayed) {
      if (input.baseVersion !== state.version) return route.fulfill({ status: 409, json: { code: "stale_version", error: "Calendar changed since your read. Reload the saved reason." } });
      const proposal = planCommands(state, [{ type: "context_update", itemId: input.workItemId, patch: input.patch }], state.actor, { now, operationId: input.operationId });
      expect(proposal.status).toBe("ready");
      state = { ...state, items: proposal.items, sessions: proposal.sessions, version: state.version + 1 };
      committed.add(input.operationId);
      if (loseResponse) { loseResponse = false; return route.abort("connectionreset"); }
    }
    await route.fulfill({ json: { state, receipt: { operationId: input.operationId, workItemId: input.workItemId, outcome: replayed ? "replayed" : "committed", notifications: "none" } } });
  });
  await page.setViewportSize({ width, height: 1000 }); await page.clock.setFixedTime(new Date(now));
  await page.goto("/?work=website");
  // Wait for an actual hydrated interaction before dispatching the fixture refresh.
  await page.getByRole("button", { name: "day", exact: true }).click();
  await expect(page.getByRole("button", { name: "day", exact: true })).toHaveClass(/active/);
  const loaded = page.waitForResponse(`${origin}/api/state`); await page.evaluate(() => window.dispatchEvent(new Event("focus"))); await loaded;
  await expect(page.getByRole("dialog", { name: "Fictional waiting context", exact: true })).toBeVisible();
  return { before, requests, current: () => state, concurrent: () => { state = { ...state, version: state.version + 1, items: state.items.map(item => ({ ...item, blockedReason: "Newer saved dependency" })) }; } };
}
for (const width of [1440, 390]) test(`waiting-reason save reconciles a lost response without changing work at ${width}px`, async ({ page }) => {
  const context = await setup(page, width, true);
  await page.getByRole("button", { name: "Edit waiting reason", exact: true }).click();
  await page.getByRole("textbox", { name: "Waiting reason", exact: true }).fill("Verified live; awaiting policy copy");
  await page.getByRole("button", { name: "Save waiting reason", exact: true }).click();
  await expect(page.getByRole("button", { name: "Retry same save", exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Waiting reason", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Retry same save", exact: true }).click();
  await expect(page.locator(".waiting-note")).toContainText("Verified live; awaiting policy copy");
  expect(context.requests).toHaveLength(2); expect(context.requests[1]).toEqual(context.requests[0]);
  expect(context.current().version).toBe(context.before.version + 1);
  expect(context.current().sessions).toEqual(context.before.sessions);
  expect(context.current().items).toEqual([{ ...context.before.items[0], blockedReason: "Verified live; awaiting policy copy", updatedAt: now }]);
});
test("a waiting-reason conflict keeps the draft and requires reloading the newer reason", async ({ page }) => {
  const context = await setup(page, 1440);
  await page.getByRole("button", { name: "Edit waiting reason", exact: true }).click();
  await page.getByRole("textbox", { name: "Waiting reason", exact: true }).fill("Stale draft"); context.concurrent();
  await page.getByRole("button", { name: "Save waiting reason", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Calendar changed");
  await expect(page.getByRole("textbox", { name: "Waiting reason", exact: true })).toHaveValue("Stale draft");
  await page.getByRole("button", { name: "Reload saved reason", exact: true }).click();
  await expect(page.locator(".waiting-note")).toContainText("Newer saved dependency");
  expect(context.current().sessions).toEqual(context.before.sessions);
});
