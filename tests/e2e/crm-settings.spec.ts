import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { planCommands } from "../../src/lib/scheduler";
import { newWorkItem } from "../../src/lib/work";
import { createDemoState } from "../../src/lib/fixtures";
import { asActor, origin } from "./helpers";
import type { CrmOwnerSetup } from "../../src/lib/crm-setup";

// Browser-only setup fixtures; every setup request is intercepted. No real
// connection, credential, account, mapping or mail is created by these tests.
for (const width of [1440, 390]) test(`owner CRM setup and client confirmation at ${width}px`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 1000 });
  await asActor(page.request, "bryan");
  const fixture = createDemoState(); fixture.mode = "live";
  fixture.clients = [{ id: "fixture-client", name: "Fictional Client", aliases: ["CRM Fixture"] }];
  const setup: CrmOwnerSetup = { connections: [], mappings: [], integrationEnabled: false, bookingEnabled: false };
  const writes: Record<string, unknown>[] = [];
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.route(`${origin}/api/state`, route => route.fulfill({ json: fixture }));
  await page.route(`${origin}/api/admin/crm`, async route => {
    if (route.request().method() === "GET") return route.fulfill({ json: setup });
    const input = route.request().postDataJSON(); writes.push(input);
    if (input.type === "create") setup.connections.push({ id: "20000000-0000-4000-8000-000000000001", crmOrigin: input.crmOrigin, crmAuthUrl: input.crmAuthUrl, agencyDomain: input.agencyDomain, enabled: false });
    if (input.type === "map") setup.mappings.push({ connectionId: input.connectionId, externalClientId: input.externalClientId, calendarClientId: input.calendarClientId, revision: 1 });
    if (input.type === "set_enabled") setup.connections[0].enabled = input.enabled;
    return route.fulfill({ json: { ok: true, ...(["create", "rotate"].includes(input.type) ? { credential: "FICTIONAL_LOCAL_TEST_KEY" } : {}) } });
  });
  await page.goto("/");
  // Trigger the workspace's ordinary refresh to install the browser-only fixture.
  await page.getByRole("button", { name: "month", exact: true }).click();
  const refresh = page.waitForResponse(`${origin}/api/state`); await page.evaluate(() => window.dispatchEvent(new Event("focus"))); await refresh;
  if (width <= 760) await page.getByRole("button", { name: "Open navigation", exact: true }).click();
  await page.getByRole("button", { name: "Workspace settings", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "CRM", exact: true }).click();
  await expect(dialog.getByText("New CRM bookings are disabled on the Calendar server.", { exact: false })).toBeVisible();
  await dialog.getByText("Add a CRM connection", { exact: true }).click();
  await dialog.getByLabel("CRM website", { exact: true }).fill("https://crm.example.invalid");
  await dialog.getByLabel("CRM Supabase URL", { exact: true }).fill("https://fixture.supabase.co");
  await dialog.getByLabel("CRM public or publishable key", { exact: true }).fill("sb_publishable_fixture");
  await dialog.getByLabel("Agency email domain", { exact: true }).fill("example.invalid");
  await dialog.getByRole("button", { name: "Create disabled connection", exact: true }).click();
  await expect(dialog.getByLabel(/^New connection key/)).toHaveValue("FICTIONAL_LOCAL_TEST_KEY");
  await expect(dialog.getByRole("button", { name: "Replace connection key" })).toBeDisabled();
  await dialog.getByRole("button", { name: "I saved the key" }).click();
  await dialog.getByRole("combobox", { name: "CRM connection", exact: true }).selectOption(setup.connections[0].id);
  await dialog.getByLabel("CRM client ID", { exact: true }).fill("crm-fixture-client");
  await dialog.getByLabel("CRM client name (for suggestions)", { exact: true }).fill("CRM Fixture");
  await expect(dialog.getByText("Suggested: Fictional Client", { exact: true })).toBeVisible();
  expect(writes.filter(input => input.type === "map")).toHaveLength(0);
  await expect(dialog.getByRole("combobox", { name: "Calendar client", exact: true })).toHaveValue("");
  await dialog.getByRole("combobox", { name: "Calendar client", exact: true }).selectOption("fixture-client");
  await dialog.getByRole("button", { name: "Confirm client match" }).click();
  await expect(dialog.getByText("crm-fixture-client → Fictional Client")).toBeVisible();
  await dialog.getByRole("button", { name: "Enable connection", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Disable connection", exact: true })).toBeVisible();
  await expect(dialog.getByText("New CRM bookings are disabled on the Calendar server.", { exact: false })).toBeVisible();
  expect(writes.map(input => input.type)).toEqual(["create", "map", "set_enabled"]);
  expect(errors).toEqual([]);
  expect((await new AxeBuilder({ page }).include('[role="dialog"]').analyze()).violations).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath(`crm-settings-${width}.png`), fullPage: true });
});

test("demo CRM setup is clearly disabled and makes no administration requests", async ({ page }) => {
  await asActor(page.request, "bryan");
  let requests = 0; await page.route(`${origin}/api/admin/crm`, route => { requests++; return route.abort(); });
  await page.goto("/"); await page.getByRole("button", { name: "Workspace settings", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "CRM", exact: true }).click();
  await expect(page.getByText("This demo cannot create or enable a connection.", { exact: false })).toBeVisible();
  expect(requests).toBe(0);
});


test("owner sees the CRM request conversation before reviewing an approval", async ({ page }) => {
  await asActor(page.request, "bryan");
  const fixture = createDemoState("2026-09-15T12:00:00Z");
  fixture.items = []; fixture.sessions = []; fixture.blocks = [];
  const requester = { id: "20000000-0000-4000-8000-000000000009", name: "teammate@example.invalid", email: "teammate@example.invalid", role: "requester" as const };
  const item = newWorkItem(requester, "2026-09-16", { title: "Fictional CRM request", clientId: fixture.clients[0].id, estimatedMinutes: 60, remainingMinutes: 60 });
  const proposal = planCommands(fixture, [{ type: "create", item }], requester, { now: "2026-09-15T12:00:00Z", operationId: "fixture-request" });
  fixture.requests = [{ id: "fixture-request", requesterId: requester.id, requesterName: requester.name, status: "pending", proposal: { ...proposal, status: "approval_required", requiresApproval: true }, note: "Can this use Thursday?", createdAt: "2026-09-15T12:00:00Z", resolvedAt: null,
    conversation: [{ author: "owner", message: "Can this use Thursday?", createdAt: "2026-09-15T12:01:00Z" }, { author: "requester", message: "Thursday works for the client.", createdAt: "2026-09-15T12:02:00Z" }] }];
  await page.route(`${origin}/api/state`, route => route.fulfill({ json: fixture }));
  await page.goto("/"); await page.getByRole("button", { name: "month", exact: true }).click();
  const refresh = page.waitForResponse(`${origin}/api/state`); await page.evaluate(() => window.dispatchEvent(new Event("focus"))); await refresh;
  await page.getByRole("navigation").getByRole("button", { name: /^Requests/ }).click();
  await page.getByRole("button", { name: "Review with current schedule", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Thursday works for the client.", { exact: false })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Preview revised plan", exact: true })).toBeVisible();
});
