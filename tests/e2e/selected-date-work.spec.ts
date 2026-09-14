import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { createDemoState } from "../../src/lib/fixtures";
import { planCommands } from "../../src/lib/scheduler";
import { localDate, minutesBetween } from "../../src/lib/time";
import type { AppState, WorkCommand } from "../../src/lib/types";
import { asActor, origin, state } from "./helpers";

// Fictional browser-local state only. All commands are intercepted and checked
// by the shared scheduler; no production writes, model calls, or email sends.
const now = "2026-09-09T13:00:00Z";
async function prepare(page: Page, width = 1440, role: "bryan" | "kyle" | "viewer" = "bryan") {
  await asActor(page.request, role);
  const stored = await state(page.request);
  expect(stored.mode).toBe("demo");
  let fixture: AppState = { ...createDemoState(now), workspaceId: stored.workspaceId, actor: stored.actor,
    clients: [{ id: "cedar", name: "Cedar Studio", aliases: [] }], items: [], sessions: [], blocks: [], events: [], requests: [], notifications: [], attachments: [], emailDrafts: [] };
  const requests: { action: string; commands: WorkCommand[] }[] = [];
  await page.route(`${origin}/api/state`, route => route.fulfill({ json: fixture }));
  await page.route(`${origin}/api/assistant`, () => { throw new Error("Manual work must not call Ask ADA."); });
  await page.route(`${origin}/api/commands`, async route => {
    const body = route.request().postDataJSON();
    requests.push(body);
    const proposal = planCommands(fixture, body.commands, fixture.actor, { now, operationId: body.operationId });
    if (body.action === "commit") {
      expect(proposal.status, JSON.stringify(proposal.conflicts)).toBe("ready");
      fixture = { ...fixture, version: fixture.version + 1, items: proposal.items, sessions: proposal.sessions, blocks: proposal.blocks };
    }
    await route.fulfill({ json: { proposal: { ...proposal, reviewFingerprint: "a".repeat(64) }, state: fixture } });
  });
  await page.clock.setFixedTime(new Date(now));
  await page.setViewportSize({ width, height: 1000 });
  await page.goto("/");
  await page.getByRole("button", { name: "agenda", exact: true }).click();
  await expect(page.getByRole("button", { name: "agenda", exact: true })).toHaveClass(/active/);
  const refreshed = page.waitForResponse(`${origin}/api/state`);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await refreshed;
  await expect(page.getByTitle("Cedar Studio", { exact: true })).toHaveCount(1);
  // The initial calendar date was hydrated from the real server clock; select
  // the browser fixture's Today before checking ordinary Add work defaults.
  await page.getByRole("button", { name: "Today", exact: true }).click();
  return { requests, stored, fixture: () => fixture };
}
const day = (page: Page, name: string) => page.getByLabel("Month workload calendar", { exact: true }).getByRole("button", { name: new RegExp(`^${name},`) }).locator(".day-number");
const add = (page: Page) => page.getByRole("button", { name: "Add work on these dates", exact: true });

for (const width of [1440, 390]) test(`selected day opens manual work, previews and saves only that day at ${width}px`, async ({ page }, info) => {
  const context = await prepare(page, width);
  if (width === 1440) {
    await page.getByRole("button", { name: "month", exact: true }).click();
    await day(page, "Thursday, September 10").dblclick();
  } else {
    await page.getByRole("button", { name: "Select dates", exact: true }).click();
    await expect(add(page)).toBeDisabled();
    await day(page, "Thursday, September 10").click();
  }
  await expect(add(page)).toBeEnabled();
  await page.screenshot({ path: info.outputPath(`selected-date-actions-${width}.png`) });
  await add(page).click();
  const form = page.getByRole("dialog", { name: "Make room for new work", exact: true });
  if (width === 1440) {
    await expect(page.getByRole("dialog")).toHaveCount(1);
    await form.getByRole("button", { name: "Close dialog", exact: true }).click();
    const selectionModal = page.getByRole("dialog", { name: "Selected dates", exact: true });
    await expect(selectionModal.locator("strong")).toHaveText("Sep 10, 2026");
    expect(context.requests).toHaveLength(0);
    await selectionModal.getByRole("button", { name: "Add work on these dates", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(1);
  }
  await expect(form.getByLabel("Work day", { exact: true })).toHaveValue("2026-09-10");
  await expect(form.getByRole("button", { name: /^Total hours ADA fits/ })).toHaveAttribute("aria-pressed", "true");
  await form.getByLabel("What needs doing?", { exact: true }).fill("Cedar page edits");
  await form.getByLabel("Hours to book", { exact: true }).fill("2");
  await form.getByRole("button", { name: "Review changes", exact: true }).click();
  await expect(form.getByRole("heading", { name: "This fits your schedule" })).toBeVisible();
  expect(context.fixture().items).toHaveLength(0);
  expect(context.requests.map(r => r.action)).toEqual(["preview"]);
  expect(context.requests[0].commands[0]).toMatchObject({ type: "create", item: { windowStart: "2026-09-10", windowEnd: "2026-09-10" }, smartFit: { startDate: "2026-09-10", endDate: "2026-09-10", minutes: 120, distribution: "total" } });
  expect((await new AxeBuilder({ page }).include('[role="dialog"]').analyze()).violations).toEqual([]);
  expect(await form.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await form.getByRole("button", { name: "Confirm changes", exact: true }).click();
  await expect(form).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: "Selected dates", exact: true })).toHaveCount(0);
  await expect(page.locator(".date-selection-toolbar")).toHaveCount(0);
  expect(context.fixture().items).toHaveLength(1);
  expect(context.fixture().sessions.map(s => localDate(s.start, context.fixture().settings.timeZone))).toEqual(["2026-09-10"]);
  expect(context.fixture().sessions.reduce((sum, s) => sum + minutesBetween(s.start, s.end), 0)).toBe(120);
  expect((await state(page.request)).notifications).toEqual(context.stored.notifications);
  await page.getByRole("button", { name: "Add work", exact: true }).click();
  await expect(form.getByLabel("Work day", { exact: true })).toHaveValue("2026-09-09");
});

test("cross-month range is prefilled, cancel keeps selection, and hours may be spread each day", async ({ page }) => {
  const context = await prepare(page);
  await page.getByRole("button", { name: "Select dates", exact: true }).click();
  await day(page, "Tuesday, September 29").click();
  await page.getByRole("button", { name: "Next period", exact: true }).click();
  await day(page, "Friday, October 2").click();
  await add(page).click();
  const form = page.getByRole("dialog");
  await expect(form.getByLabel("First day", { exact: true })).toHaveValue("2026-09-29");
  await expect(form.getByLabel("Last day", { exact: true })).toHaveValue("2026-10-02");
  await expect(form.getByRole("combobox", { name: "Spread the hours", exact: true })).toHaveCount(0);
  await form.getByText("Advanced", { exact: true }).click();
  await form.getByLabel("Set exact times", { exact: true }).check();
  await expect(form.getByLabel("Session dates (YYYY-MM-DD, comma-separated)", { exact: true })).toHaveValue("2026-09-29");
  await form.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.locator(".date-selection-toolbar strong")).toHaveText("Sep 29, 2026 – Oct 2, 2026");
  expect(context.requests).toHaveLength(0);
  await add(page).click();
  await form.getByLabel("What needs doing?", { exact: true }).fill("Cedar daily page edits");
  await form.getByRole("button", { name: /^Days and hours Choose/ }).click();
  for (let index = 1; index <= 4; index++) {
    if (index > 1) await form.getByRole("button", { name: "Add day", exact: true }).click();
    await form.getByLabel(`Hours on day ${index}`, { exact: true }).fill("2");
  }
  await form.getByRole("button", { name: "Review changes", exact: true }).click();
  await expect(form.getByRole("heading", { name: "This fits your schedule" })).toBeVisible();
  expect(context.requests[0].commands[0]).toMatchObject({ type: "create", item: { estimatedMinutes: 480, timelineMode: "bookings", dailyPlan: ["2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02"].map(date => ({ date, minutes: 120 })) } });
  await form.getByRole("button", { name: "Confirm changes", exact: true }).click();
  expect(context.fixture().sessions.map(s => localDate(s.start, context.fixture().settings.timeZone))).toEqual(["2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02"]);
});

test("cancel, project timeline, and weekend selections never silently book work", async ({ page }) => {
  const context = await prepare(page);
  await page.getByRole("button", { name: "Select dates", exact: true }).click();
  await day(page, "Saturday, September 26").click();
  await page.getByLabel("Use selected dates as", { exact: true }).selectOption("project_span");
  await expect(add(page)).toBeDisabled();
  await expect(page.locator(".date-selection-toolbar")).toContainText("choose Work window to book hours manually");
  await page.getByLabel("Use selected dates as", { exact: true }).selectOption("work_window");
  await add(page).click();
  const form = page.getByRole("dialog");
  await expect(form.getByLabel("Work day", { exact: true })).toHaveValue("2026-09-26");
  await expect(form.locator(".smart-fit-summary")).toContainText("no working days");
  await form.getByLabel("What needs doing?", { exact: true }).fill("Weekend edits");
  await form.getByRole("button", { name: "Review changes", exact: true }).click();
  await expect(form.getByRole("heading", { name: "This needs a decision" })).toBeVisible();
  await expect(form.getByRole("button", { name: "Confirm changes", exact: true })).toHaveCount(0);
  expect(context.fixture().items).toHaveLength(0);
  await form.getByRole("button", { name: "Close dialog", exact: true }).click();
  await page.getByRole("button", { name: "Cancel selection", exact: true }).click();
  await page.getByRole("button", { name: "Select dates", exact: true }).click();
  await expect(add(page)).toBeDisabled();
});

test("requesters can manually book selected dates; viewers cannot create work", async ({ page }) => {
  const context = await prepare(page, 1440, "kyle");
  await page.getByRole("button", { name: "Select dates", exact: true }).click();
  await day(page, "Thursday, September 10").click();
  await page.getByRole("button", { name: "Request work on these dates", exact: true }).click();
  const form = page.getByRole("dialog", { name: "Find an opening", exact: true });
  await expect(form.getByLabel("Work day", { exact: true })).toHaveValue("2026-09-10");
  await form.getByLabel("What needs doing?", { exact: true }).fill("Cedar requested edits");
  await form.getByRole("button", { name: "Review changes", exact: true }).click();
  await expect(form.getByRole("button", { name: "Book this work", exact: true })).toBeVisible();
  await form.getByRole("button", { name: "Book this work", exact: true }).click();
  expect(context.fixture().items).toHaveLength(1);
  await page.unrouteAll();
  await prepare(page, 1440, "viewer");
  await expect(page.getByRole("button", { name: "Select dates", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^(Add|Request) work/ })).toHaveCount(0);
});
