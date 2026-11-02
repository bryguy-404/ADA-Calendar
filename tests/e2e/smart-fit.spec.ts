import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { createDemoState } from "../../src/lib/fixtures";
import { newWorkItem } from "../../src/lib/work";
import { planCommands } from "../../src/lib/scheduler";
import { localDate, localDateTime, minutesBetween } from "../../src/lib/time";
import type { AppState } from "../../src/lib/types";
import { asActor, commit, futureDate, makeItem, origin, preview, state } from "./helpers";

// Browser-local fixture only. Intercepts writes before storage; no production
// workload, external providers, or real email delivery.
async function setup(page: Page, width: number, withFridayBooking = false) {
  await asActor(page.request, "bryan");
  const stored = await state(page.request);
  expect(stored.mode).toBe("demo");
  const now = "2026-09-09T13:00:00Z";
  let fixture: AppState = { ...createDemoState(now), workspaceId: stored.workspaceId, actor: stored.actor,
    clients: [{ id: "cedar", name: "Cedar Studio", aliases: [] }], items: [], sessions: [], blocks: [], events: [], requests: [], notifications: [], attachments: [], emailDrafts: [] };
  fixture.settings.reserveMinutes = 0;
  const ongoing = newWorkItem(fixture.actor, "2026-09-08", { id: "cedar-survey", clientId: "cedar", title: "Cedar survey", category: "software", webKind: null,
    status: "waiting", estimatedMinutes: null, remainingMinutes: null, timelineMode: "span", windowEnd: "2026-10-31", minimumSessionMinutes: 120, blockedReason: "Waiting for client details" });
  const other = newWorkItem(fixture.actor, "2026-09-09", { id: "existing-work", clientId: "cedar", title: "Existing protected work", estimatedMinutes: 60, remainingMinutes: 60 });
  fixture.items = [ongoing, other];
  const at = (day: string, time: string) => localDateTime(day, time, fixture.settings.timeZone);
  fixture.sessions = [{ id: "protected-booking", workItemId: other.id, start: at("2026-09-09", "09:00"), end: at("2026-09-09", "10:00"), protected: true, status: "planned", usesReserve: false }];
  if (withFridayBooking) {
    const friday = newWorkItem(fixture.actor, "2026-09-11", { id: "friday-work", clientId: "cedar", title: "Existing Friday work", estimatedMinutes: 240, remainingMinutes: 240 });
    fixture.items.push(friday);
    fixture.sessions.push({ id: "friday-booking", workItemId: friday.id, start: at("2026-09-11", "12:30"), end: at("2026-09-11", "16:30"), protected: false, status: "planned", usesReserve: false });
  }
  fixture.blocks = [{ id: "tomorrow-full", title: "Time off", kind: "time_off", start: at("2026-09-10", "09:00"), end: at("2026-09-10", "17:00") }];
  const before = structuredClone(fixture);
  const actions: string[] = [];
  await page.route(`${origin}/api/state`, route => route.fulfill({ json: fixture }));
  await page.route(`${origin}/api/commands`, async route => {
    const body = route.request().postDataJSON(); actions.push(body.action);
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
  await expect(page.getByRole("heading", { name: "Your plate, at a glance." })).toBeVisible();
  // A real interaction waits for hydration before firing the refresh listener.
  await page.getByRole("button", { name: "agenda", exact: true }).click();
  await expect(page.getByRole("button", { name: "agenda", exact: true })).toHaveClass(/active/);
  const loaded = page.waitForResponse(response => response.url() === `${origin}/api/state`);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await loaded;
  await expect(page.getByText("Cedar Studio", { exact: true }).first()).toBeAttached();
  await page.getByRole("button", { name: "Today", exact: true }).click();
  return { before, actions, fixture: () => fixture };
}

async function openOngoingProject(page: Page) {
  const menu = page.getByRole("button", { name: "Open navigation", exact: true });
  if (await menu.isVisible()) await menu.click();
  await page.getByRole("button", { name: "All work", exact: true }).click();
  await page.getByLabel("Search work").fill("Cedar survey");
  await page.getByRole("button", { name: /Cedar survey Cedar Studio/ }).click();
  return page.getByRole("dialog", { name: "Cedar survey", exact: true });
}

for (const width of [1440, 390]) test(`finds two hours today on an existing unknown-total project at ${width}px`, async ({ page }, info) => {
  const context = await setup(page, width);
  const dialog = await openOngoingProject(page);
  await dialog.getByRole("button", { name: "Add hours", exact: true }).click();
  await expect(dialog.getByLabel("Hours on day 1", { exact: true })).toHaveValue("");
  await dialog.getByLabel("Hours on day 1", { exact: true }).fill("2");
  await dialog.getByLabel("Work day 1", { exact: true }).fill("2026-09-10");
  await dialog.getByRole("button", { name: "Review changes", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "This needs a decision" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Confirm changes", exact: true })).toHaveCount(0);
  expect(context.fixture()).toEqual(context.before);
  await dialog.getByLabel("Work day 1", { exact: true }).fill("2026-09-09");
  await expect(dialog.getByRole("heading", { name: "This needs a decision" })).toHaveCount(0);
  await dialog.getByLabel("Work day 1", { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath(`smart-fit-controls-${width}.png`) });
  await dialog.getByRole("button", { name: "Review changes", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "This fits your schedule" })).toBeVisible();
  await expect(dialog.locator(".proposal-sessions")).toContainText("10:00 AM–12:00 PM");
  await expect(dialog.locator(".proposal-sessions")).not.toContainText("Existing protected work");
  expect(context.fixture()).toEqual(context.before);
  expect((await new AxeBuilder({ page }).include('[role="dialog"]').analyze()).violations).toEqual([]);
  await dialog.locator(".session-manager").screenshot({ path: info.outputPath(`smart-fit-${width}.png`) });
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await dialog.getByRole("button", { name: "Confirm changes", exact: true }).click();
  await expect(dialog.locator(".session-manager")).toHaveCount(0);
  const saved = context.fixture();
  expect(saved.sessions.find(session => session.id === "protected-booking")).toEqual(context.before.sessions[0]);
  expect(saved.items.find(item => item.id === "cedar-survey")).toMatchObject({ status: "planned", estimatedMinutes: null, remainingMinutes: null, windowStart: "2026-09-08", windowEnd: "2026-10-31", timelineMode: "span" });
  expect(saved.sessions.filter(session => session.workItemId === "cedar-survey").map(session => minutesBetween(session.start, session.end))).toEqual([120]);
  expect(context.actions).toEqual(["preview", "preview", "commit"]);
});

for (const width of [1440, 390]) for (const entry of ["Add hours", "Edit hours"]) test(`books three Friday hours after ${entry} on waiting unknown-total work at ${width}px`, async ({ page }, info) => {
  const context = await setup(page, width, true);
  const dialog = await openOngoingProject(page);
  async function fillFriday() {
    await dialog.getByRole("button", { name: entry, exact: true }).click();
    if (entry === "Edit hours") await dialog.getByRole("button", { name: /^Add hours Book additional/ }).click();
    await dialog.getByLabel("Work day 1", { exact: true }).fill("2026-09-11");
    await dialog.getByLabel("Hours on day 1", { exact: true }).fill("3");
    await expect(dialog.locator(".session-manager-budget")).toContainText("Project total stays unknown");
  }
  await fillFriday();
  expect(context.actions).toEqual([]);
  expect(context.fixture()).toEqual(context.before);
  await dialog.getByRole("button", { name: "Review changes", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "This fits your schedule" })).toBeVisible();
  await expect(dialog.locator(".proposal-status-changes")).toContainText("Waiting → Planned");
  await expect(dialog.locator(".proposal-sessions")).toContainText("9:00 AM–12:00 PM");
  expect(context.actions).toEqual(["preview"]);
  expect(context.fixture()).toEqual(context.before);
  await dialog.getByRole("button", { name: "Cancel edits", exact: true }).click();
  await expect(dialog.locator(".session-manager")).toHaveCount(0);
  expect(context.fixture()).toEqual(context.before);
  await fillFriday();
  await dialog.getByRole("button", { name: "Review changes", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "This fits your schedule" })).toBeVisible();
  expect(context.fixture()).toEqual(context.before);
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  if (entry === "Edit hours") {
    expect((await new AxeBuilder({ page }).include('[role="dialog"]').analyze()).violations).toEqual([]);
    await dialog.locator(".session-manager").screenshot({ path: info.outputPath(`waiting-friday-preview-${width}.png`) });
  }
  await dialog.getByRole("button", { name: "Confirm changes", exact: true }).click();
  await expect(dialog.locator(".session-manager")).toHaveCount(0);
  const saved = context.fixture();
  expect(saved.items.find(item => item.id === "cedar-survey")).toMatchObject({ status: "planned", blockedReason: null, estimatedMinutes: null, remainingMinutes: null, forecastDate: null, windowStart: "2026-09-08", windowEnd: "2026-10-31", completedAt: null });
  const booked = saved.sessions.filter(session => session.workItemId === "cedar-survey");
  expect(booked.reduce((sum, session) => sum + minutesBetween(session.start, session.end), 0)).toBe(180);
  expect(booked.every(session => localDate(session.start, saved.settings.timeZone) === "2026-09-11")).toBe(true);
  expect(saved.sessions.filter(session => session.workItemId !== "cedar-survey")).toEqual(context.before.sessions);
});

for (const width of [1440, 390]) test(`switching booking editors preserves drafts without resuming waiting work at ${width}px`, async ({ page }) => {
  const context = await setup(page, width);
  const dialog = await openOngoingProject(page);
  await dialog.getByRole("button", { name: "Add hours", exact: true }).click();
  await dialog.getByLabel("Hours on day 1", { exact: true }).fill("2");
  await dialog.getByRole("button", { name: /^Edit hours Change or remove/ }).click();
  await expect(dialog.getByLabel("Hours on day 1", { exact: true })).toHaveCount(0);
  await dialog.getByRole("button", { name: /^Add hours Book additional/ }).click();
  await expect(dialog.getByLabel("Hours on day 1", { exact: true })).toHaveValue("2");
  await dialog.getByRole("button", { name: "Review changes", exact: true }).click();
  await expect(dialog.locator(".proposal-status-changes")).toContainText("Waiting → Planned");
  expect(context.fixture()).toEqual(context.before);
  await dialog.getByRole("button", { name: "Cancel edits", exact: true }).click();
  expect(context.fixture().items.find(item => item.id === "cedar-survey")?.status).toBe("waiting");
});

test("new work distinguishes a total from independently chosen daily hours", async ({ page }, info) => {
  const context = await setup(page, 390);
  await page.getByRole("button", { name: "Add work", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("What needs doing?").fill("Cedar school website");
  await dialog.getByRole("combobox", { name: "Work category", exact: true }).selectOption("web-build");
  await expect(dialog.getByRole("button", { name: /^Total hours ADA fits/ })).toHaveAttribute("aria-pressed", "true");
  await dialog.getByLabel("Choose multiple days", { exact: true }).check();
  await dialog.getByLabel("First day", { exact: true }).fill("2026-09-14");
  await dialog.getByLabel("Last day", { exact: true }).fill("2026-09-18");
  await dialog.getByLabel("Hours to book", { exact: true }).fill("2");
  await expect(dialog.locator(".smart-fit-summary")).toContainText("2h to book total across these days");
  await dialog.getByRole("button", { name: /^Days and hours Choose/ }).click();
  await dialog.getByLabel("Work day 1", { exact: true }).fill("2026-09-14");
  for (let index = 1; index <= 5; index++) {
    if (index > 1) await dialog.getByRole("button", { name: "Add day", exact: true }).click();
    await dialog.getByLabel(`Hours on day ${index}`, { exact: true }).fill("2");
  }
  await expect(dialog.locator(".day-hours-footer")).toContainText("10h across 5 days");
  await expect(dialog.getByLabel("Minimum focus session", { exact: true })).toHaveCount(0);
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  await page.route(`${origin}/api/commands`, async route => { await hold; await route.fallback(); });
  await dialog.getByRole("button", { name: "Review changes", exact: true }).click();
  await expect(dialog.getByLabel("What needs doing?")).toBeDisabled();
  await expect(dialog.getByLabel("Hours on day 5", { exact: true })).toBeDisabled();
  release();
  await expect(dialog.getByRole("heading", { name: "This fits your schedule" })).toBeVisible();
  await expect(dialog.locator(".proposal-sessions > div")).toHaveCount(5);
  await dialog.locator(".work-form").screenshot({ path: info.outputPath("smart-fit-new-mobile.png") });
  expect((await new AxeBuilder({ page }).include('[role="dialog"]').analyze()).violations).toEqual([]);
  await dialog.getByRole("button", { name: "Confirm changes", exact: true }).click();
  const saved = context.fixture(), item = saved.items.find(item => item.title === "Cedar school website")!;
  expect(item.remainingMinutes).toBe(600);
  const sessions = saved.sessions.filter(session => session.workItemId === item.id);
  expect(sessions.map(session => localDate(session.start, saved.settings.timeZone))).toEqual(["2026-09-14", "2026-09-15", "2026-09-16", "2026-09-17", "2026-09-18"]);
  expect(sessions.map(session => minutesBetween(session.start, session.end))).toEqual([120, 120, 120, 120, 120]);
});

test("editing project details offers the same add-hours shortcut without saving metadata", async ({ page }) => {
  const context = await setup(page, 1440);
  const details = await openOngoingProject(page);
  await details.getByRole("button", { name: "Edit details", exact: true }).click();
  await page.getByRole("dialog", { name: "Edit details", exact: true }).getByRole("button", { name: "Add hours", exact: true }).click();
  const form = page.getByRole("dialog", { name: "Add hours · Cedar survey", exact: true });
  await expect(form.getByLabel("Hours on day 1", { exact: true })).toHaveValue("");
  await form.getByLabel("Hours on day 1", { exact: true }).fill("2");
  await form.getByText("Advanced", { exact: true }).click();
  await form.getByLabel("Set exact times", { exact: true }).check();
  await expect(form.getByRole("button", { name: "Add session", exact: true })).toBeVisible();
  await form.getByLabel("Set exact times", { exact: true }).uncheck();
  await expect(form.getByLabel("Hours on day 1", { exact: true })).toHaveValue("2");
  await form.getByRole("button", { name: "Cancel edits", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Cedar survey", exact: true })).toBeVisible();
  expect(context.actions).toEqual([]);
  expect(context.fixture()).toEqual(context.before);
});

test("Ask ADA fits hours on an existing project after a short capacity follow-up", async ({ page }) => {
  await asActor(page.request, "bryan");
  const initial = await state(page.request);
  expect(initial.mode).toBe("demo");
  const date = futureDate(initial, 175);
  const item = makeItem(initial, "E2E ongoing smart survey", { windowStart: date, windowEnd: date, targetDate: null, status: "waiting", estimatedMinutes: null, remainingMinutes: null, timelineMode: "span", minimumSessionMinutes: 120 });
  await commit(page.request, await preview(page.request, [{ type: "create", item }]));
  const before = await state(page.request);
  await page.goto("/");
  await page.getByRole("button", { name: "Ask ADA", exact: true }).click();
  const dialog = page.getByRole("dialog");
  const input = dialog.getByLabel("Instruction for ADA", { exact: true });
  const send = dialog.getByRole("button", { name: "Send instruction", exact: true });
  await input.fill(`Find time for 8 hours on ${date} for ${item.title}.`);
  await send.click();
  await expect(dialog.getByText("Your reply will continue the pending instruction above.", { exact: true })).toBeVisible();
  const rejected = await state(page.request);
  expect(rejected.version).toBe(before.version);
  expect(rejected.sessions).toEqual(before.sessions);
  await input.fill("2 hours instead");
  await send.click();
  await expect(dialog.getByText("Your reply will continue the pending instruction above.", { exact: true })).toHaveCount(0);
  await expect(input).toHaveValue("");
  const saved = await state(page.request);
  expect(saved.version).toBe(before.version + 1);
  expect(saved.items.find(candidate => candidate.id === item.id)).toMatchObject({ estimatedMinutes: null, remainingMinutes: null, status: "planned" });
  expect(saved.sessions.filter(s => s.workItemId !== item.id)).toEqual(before.sessions);
  const booked = saved.sessions.filter(s => s.workItemId === item.id && s.status === "planned");
  expect(booked.reduce((sum, s) => sum + minutesBetween(s.start, s.end), 0)).toBe(120);
  expect(booked.every(s => localDate(s.start, saved.settings.timeZone) === date)).toBe(true);
  expect(saved.notifications.filter(n => !before.notifications.some(old => old.id === n.id)).every(n => n.status === "captured")).toBe(true);
});
