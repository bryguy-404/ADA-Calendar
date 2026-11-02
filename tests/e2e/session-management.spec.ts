import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { createDemoState } from "../../src/lib/fixtures";
import { newWorkItem } from "../../src/lib/work";
import { planCommands } from "../../src/lib/scheduler";
import { localDateTime, minutesBetween } from "../../src/lib/time";
import type { AppState, WorkItem } from "../../src/lib/types";
import { asActor, origin, state } from "./helpers";

// Local browser-only fixture; command requests run the pure scheduler and are
// intercepted before storage. No provider, production workload, or sends.
for (const width of [1440, 390]) test(`redistributes three bookings into five days at ${width}px`, async ({ page }, info) => {
  await asActor(page.request, "bryan");
  const stored = await state(page.request);
  expect(stored.mode).toBe("demo");
  const now = "2026-09-08T13:00:00Z";
  let fixture: AppState = { ...createDemoState(now), workspaceId: stored.workspaceId, actor: stored.actor,
    clients: [{ id: "cedar", name: "Cedar Studio", aliases: [] }], items: [], sessions: [], blocks: [], events: [], requests: [], notifications: [], attachments: [], emailDrafts: [] };
  const item = newWorkItem(fixture.actor, "2026-09-14", { id: "cedar-build", clientId: "cedar", title: "Cedar website", estimatedMinutes: 600, remainingMinutes: 600, windowEnd: "2026-09-18", minimumSessionMinutes: 120 });
  fixture.items = [item];
  const at = (date: string, clock: string) => localDateTime(date, clock, fixture.settings.timeZone);
  fixture.sessions = [
    { id: "one", workItemId: item.id, start: at("2026-09-14","12:30"), end: at("2026-09-14","17:00"), status: "planned", protected: false, usesReserve: false },
    { id: "two", workItemId: item.id, start: at("2026-09-15","09:00"), end: at("2026-09-15","12:00"), status: "planned", protected: false, usesReserve: false },
    { id: "three", workItemId: item.id, start: at("2026-09-16","12:30"), end: at("2026-09-16","15:00"), status: "planned", protected: false, usesReserve: false },
  ];
  fixture.settings.reserveMinutes = 0;
  const actions: string[] = [];
  await page.route(`${origin}/api/state`, route => route.fulfill({ json: fixture }));
  await page.route(`${origin}/api/commands`, async route => {
    const body = route.request().postDataJSON(); actions.push(body.action);
    const proposal = planCommands(fixture, body.commands, fixture.actor, { now, operationId: body.operationId });
    expect(proposal.status, JSON.stringify(proposal.conflicts)).toBe("ready");
    if (body.action === "commit") fixture = { ...fixture, version: fixture.version + 1, items: proposal.items, sessions: proposal.sessions, blocks: proposal.blocks };
    await route.fulfill({ json: { proposal: { ...proposal, reviewFingerprint: "a".repeat(64) }, state: fixture } });
  });
  await page.clock.setFixedTime(new Date(now));
  await page.setViewportSize({ width, height: 1000 });
  await page.goto("/");
  await page.getByRole("button", { name: "agenda", exact: true }).click();
  await expect(page.getByRole("button", { name: "agenda", exact: true })).toHaveClass(/active/);
  await page.getByRole("button", { name: "month", exact: true }).click();
  await expect(page.getByRole("button", { name: "month", exact: true })).toHaveClass(/active/);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.getByRole("button", { name: "Today", exact: true }).click();
  await page.getByTitle("Cedar Studio · Cedar website", { exact: true }).first().focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: item.title, exact: true });
  await dialog.getByRole("button", { name: "Edit hours", exact: true }).click();
  await dialog.getByText("Advanced", { exact: true }).click();
  await dialog.getByLabel("Set exact times", { exact: true }).check();
  for (let i = 1; i <= 3; i++) {
    await dialog.getByLabel(`Session ${i} start`, { exact: true }).fill("09:00");
    await dialog.getByLabel(`Session ${i} end`, { exact: true }).fill("11:00");
  }
  await dialog.getByRole("button", { name: "Review changes", exact: true }).click();
  await expect(dialog.getByText("This fits your schedule", { exact: true })).toBeVisible();
  expect(actions).toEqual(["preview"]);
  expect(fixture.sessions.map(s => minutesBetween(s.start, s.end))).toEqual([270, 180, 150]);
  await dialog.getByRole("button", { name: "Add session", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Confirm changes", exact: true })).toHaveCount(0);
  await expect(dialog.getByLabel("Session 4 date", { exact: true })).toHaveValue("2026-09-17");
  await dialog.getByLabel("Session 4 end", { exact: true }).fill("11:00");
  await dialog.getByRole("button", { name: "Add session", exact: true }).click();
  await expect(dialog.getByLabel("Session 5 date", { exact: true })).toHaveValue("2026-09-18");
  await dialog.getByLabel("Session 5 end", { exact: true }).fill("11:00");
  await expect(dialog.locator(".session-manager-budget")).toContainText("10h planned hours after this edit");
  await dialog.locator(".session-manager").screenshot({ path: info.outputPath(`session-manager-${width}.png`) });
  expect((await new AxeBuilder({ page }).include('[role="dialog"]').analyze()).violations).toEqual([]);
  await dialog.getByRole("button", { name: "Review changes", exact: true }).click();
  await expect(dialog.getByText("This fits your schedule", { exact: true })).toBeVisible();
  expect(actions).toEqual(["preview", "preview"]);
  await dialog.getByRole("button", { name: "Confirm changes", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Edit hours", exact: true })).toBeVisible();
  expect(actions).toEqual(["preview", "preview", "commit"]);
  expect(fixture.sessions.map(s => minutesBetween(s.start,s.end))).toEqual([120,120,120,120,120]);
  expect(fixture.items[0].remainingMinutes).toBe(600);
  expect((await state(page.request)).items).toEqual(stored.items);
  expect((await state(page.request)).notifications).toEqual(stored.notifications);
});

async function openSessionFixture(page: Page, width: number, dailyPlan = true, patch: Partial<WorkItem> = {}) {
  await asActor(page.request, "bryan");
  const stored = await state(page.request);
  expect(stored.mode).toBe("demo");
  const now = "2026-09-08T13:00:00Z";
  const dates = ["2026-09-14", "2026-09-15", "2026-09-16", "2026-09-17", "2026-09-18"];
  let fixture: AppState = {
    ...createDemoState(now), workspaceId: stored.workspaceId, actor: stored.actor,
    clients: [{ id: "cedar", name: "Cedar Studio", aliases: [] }], items: [], sessions: [],
    blocks: [], events: [], requests: [], notifications: [], attachments: [], emailDrafts: [],
  };
  fixture.settings.reserveMinutes = 0;
  const item = newWorkItem(fixture.actor, dates[0], {
    id: "cedar-daily-build", clientId: "cedar", title: "Cedar daily website build", webKind: "build",
    description: "Fictional browser fixture: two hours on each selected weekday.",
    estimatedMinutes: 600, remainingMinutes: 600, windowEnd: dates[4], forecastDate: dates[4],
    minimumSessionMinutes: 120, allowedDates: dates,
    ...(dailyPlan ? { dailyPlan: dates.map(date => ({ date, minutes: 120 })) } : {}),
    ...patch,
  });
  fixture.items = [item];
  fixture.sessions = dates.map((date, index) => ({
    id: `daily-${index + 1}`, workItemId: item.id,
    start: localDateTime(date, "09:00", fixture.settings.timeZone),
    end: localDateTime(date, "11:00", fixture.settings.timeZone),
    status: "planned", protected: false, usesReserve: false,
  }));
  const original = structuredClone(fixture);
  const actions: string[] = [];
  await page.route(`${origin}/api/state`, route => route.fulfill({ json: fixture }));
  await page.route(`${origin}/api/commands`, async route => {
    const body = route.request().postDataJSON();
    actions.push(body.action);
    const proposal = planCommands(fixture, body.commands, fixture.actor, { now, operationId: body.operationId });
    expect(proposal.status, JSON.stringify(proposal.conflicts)).toBe("ready");
    if (body.action === "commit") fixture = {
      ...fixture, version: fixture.version + 1, items: proposal.items, sessions: proposal.sessions, blocks: proposal.blocks,
    };
    await route.fulfill({ json: { proposal: { ...proposal, reviewFingerprint: "a".repeat(64) }, state: fixture } });
  });
  await page.clock.setFixedTime(new Date(now));
  await page.setViewportSize({ width, height: width < 500 ? 844 : 1000 });
  await page.goto("/");
  await page.getByRole("button", { name: "agenda", exact: true }).click();
  await expect(page.getByRole("button", { name: "agenda", exact: true })).toHaveClass(/active/);
  await page.getByRole("button", { name: "month", exact: true }).click();
  await expect(page.getByRole("button", { name: "month", exact: true })).toHaveClass(/active/);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.getByRole("button", { name: "Today", exact: true }).click();
  await page.getByTitle("Cedar Studio · Cedar daily website build", { exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: item.title, exact: true });
  return { dialog, dates, original, actions, current: () => fixture, stored };
}

for (const width of [1440, 390]) test(`edits daily hours and remaining effort together at ${width}px`, async ({ page }, info) => {
  const context = await openSessionFixture(page, width);
  const { dialog } = context;
  await dialog.getByRole("button", { name: "Edit hours", exact: true }).click();
  await expect(dialog.getByLabel("Hours on day 1", { exact: true })).toHaveValue("2");
  for (let index = 2; index <= 5; index++) {
    await dialog.getByLabel(`Hours on day ${index}`, { exact: true }).fill("1");
    await expect(dialog.getByLabel(`Session ${index} end`, { exact: true })).toHaveCount(0);
  }
  await expect(dialog.locator(".session-manager-budget")).toContainText("6h remaining after this edit");
  expect(context.actions).toEqual([]);
  expect(context.current()).toEqual(context.original);
  await dialog.getByRole("button", { name: "Review changes", exact: true }).click();
  await expect(dialog.getByText("This fits your schedule", { exact: true })).toBeVisible();
  expect(context.actions).toEqual(["preview"]);
  expect(context.current()).toEqual(context.original);
  expect((await new AxeBuilder({ page }).include('[role="dialog"]').analyze()).violations).toEqual([]);
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await dialog.getByRole("heading", { name: "Edit hours", exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath(`daily-hours-edit-${width}.png`) });
  await dialog.getByRole("heading", { name: "Hours and days to save", exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath(`daily-hours-preview-${width}.png`) });
  await dialog.getByRole("button", { name: "Confirm changes", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Edit hours", exact: true })).toBeVisible();
  expect(context.actions).toEqual(["preview", "commit"]);
  const saved = context.current();
  expect(saved.sessions.map(session => minutesBetween(session.start, session.end))).toEqual([120, 60, 60, 60, 60]);
  expect(saved.items[0]).toMatchObject({
    remainingMinutes: 360, estimatedMinutes: 600, minimumSessionMinutes: 120, forecastDate: context.dates[4],
    dailyPlan: context.dates.map((date, index) => ({ date, minutes: index === 0 ? 120 : 60 })),
  });
  expect(saved.sessions.slice(1).map(session => session.focusOverrideMinutes)).toEqual([undefined, undefined, undefined, undefined]);
  expect(saved.settings).toEqual(context.original.settings);
  expect((await state(page.request)).items).toEqual(context.stored.items);
  expect((await state(page.request)).notifications).toEqual(context.stored.notifications);
});

for (const width of [1440, 390]) test(`removes a daily booking without reporting progress and can cancel at ${width}px`, async ({ page }, info) => {
  const context = await openSessionFixture(page, width);
  const { dialog } = context;
  await dialog.getByRole("button", { name: "Edit hours", exact: true }).click();
  await expect(dialog.getByLabel("Hours on day 5", { exact: true })).toHaveValue("2");
  await expect(dialog.getByRole("checkbox", { name: "Update remaining effort too", exact: true })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Remove day 5", exact: true }).click();
  await dialog.getByRole("button", { name: "Review changes", exact: true }).click();
  await expect(dialog.getByText("This fits your schedule", { exact: true })).toBeVisible();
  expect(context.current()).toEqual(context.original);
  await dialog.getByRole("button", { name: "Cancel edits", exact: true }).click();
  await expect(dialog.locator(".session-row")).toHaveCount(5);
  expect(context.actions).toEqual(["preview"]);
  expect(context.current()).toEqual(context.original);
  await dialog.getByRole("button", { name: "Edit hours", exact: true }).click();
  await expect(dialog.getByLabel("Hours on day 5", { exact: true })).toHaveValue("2");
  await dialog.getByRole("button", { name: "Remove day 5", exact: true }).click();
  await dialog.getByRole("button", { name: "Review changes", exact: true }).click();
  await expect(dialog.getByText("This fits your schedule", { exact: true })).toBeVisible();
  expect((await new AxeBuilder({ page }).include('[role="dialog"]').analyze()).violations).toEqual([]);
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await dialog.getByRole("heading", { name: "Hours and days to save", exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath(`daily-day-removal-${width}.png`) });
  await dialog.getByRole("button", { name: "Confirm changes", exact: true }).click();
  await expect(dialog.locator(".session-row")).toHaveCount(4);
  expect(context.actions).toEqual(["preview", "preview", "commit"]);
  expect(context.current().sessions).toEqual(context.original.sessions.slice(0, 4));
  expect(context.current().items[0]).toMatchObject({
    remainingMinutes: 480, estimatedMinutes: 600, forecastDate: context.dates[3],
    dailyPlan: context.dates.slice(0, 4).map(date => ({ date, minutes: 120 })),
  });
  expect((await state(page.request)).items).toEqual(context.stored.items);
  expect((await state(page.request)).notifications).toEqual(context.stored.notifications);
});

test("reducing reported effort opens a daily-plan edit before any write", async ({ page }) => {
  const context = await openSessionFixture(page, 1440);
  const { dialog } = context;
  await dialog.getByLabel("Remaining hours", { exact: true }).fill("6");
  await dialog.getByRole("button", { name: "Save progress", exact: true }).click();
  await expect(dialog.getByText("You entered 6h remaining.", { exact: false })).toBeVisible();
  await expect(dialog.getByLabel("Set exact times", { exact: true })).toBeChecked();
  await expect(dialog.getByLabel("Session 1 end", { exact: true })).toHaveValue("11:00");
  expect(context.actions).toEqual([]);
  expect(context.current()).toEqual(context.original);
  for (let index = 2; index <= 5; index++) await dialog.getByLabel(`Session ${index} end`, { exact: true }).fill("10:00");
  await dialog.getByRole("button", { name: "Review changes", exact: true }).click();
  await expect(dialog.getByText("This fits your schedule", { exact: true })).toBeVisible();
  expect(context.current()).toEqual(context.original);
  await dialog.getByRole("button", { name: "Confirm changes", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Edit hours", exact: true })).toBeVisible();
  expect(context.actions).toEqual(["preview", "commit"]);
  expect(context.current().items[0].remainingMinutes).toBe(360);
  expect(context.current().sessions.map(session => minutesBetween(session.start, session.end))).toEqual([120, 60, 60, 60, 60]);
  expect((await state(page.request)).items).toEqual(context.stored.items);
  expect((await state(page.request)).notifications).toEqual(context.stored.notifications);
});

test("zero remaining effort can remove every daily booking without completing the project", async ({ page }) => {
  const context = await openSessionFixture(page, 1440);
  const { dialog } = context;
  await dialog.getByLabel("Remaining hours", { exact: true }).fill("0");
  await dialog.getByRole("button", { name: "Save progress", exact: true }).click();
  await expect(dialog.getByText("You entered 0h remaining.", { exact: false })).toBeVisible();
  expect(context.actions).toEqual([]);
  for (let index = 5; index >= 1; index--) await dialog.getByRole("button", { name: `Remove session ${index}`, exact: true }).click();
  await dialog.getByRole("button", { name: "Review changes", exact: true }).click();
  await expect(dialog.getByText("This fits your schedule", { exact: true })).toBeVisible();
  expect(context.current()).toEqual(context.original);
  await dialog.getByRole("button", { name: "Confirm changes", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Edit hours", exact: true })).toBeVisible();
  expect(context.actions).toEqual(["preview", "commit"]);
  expect(context.current().sessions).toEqual([]);
  expect(context.current().items[0]).toMatchObject({
    remainingMinutes: 0, estimatedMinutes: 600, status: "planned", completedAt: null, forecastDate: null, dailyPlan: [],
  });
  expect((await state(page.request)).items).toEqual(context.stored.items);
  expect((await state(page.request)).notifications).toEqual(context.stored.notifications);
});

test("resizing from the exact session editor preserves the requested clock times and keeps the total in sync", async ({ page }) => {
  const context = await openSessionFixture(page, 1440, false);
  const { dialog } = context;
  await dialog.locator(".session-row").last().click();
  await dialog.getByLabel("Start", { exact: true }).fill("14:00");
  await dialog.getByLabel("End", { exact: true }).fill("15:00");
  await dialog.getByRole("button", { name: "Move session", exact: true }).click();
  await expect(dialog.getByLabel("Set exact times", { exact: true })).toBeChecked();
  await expect(dialog.getByLabel("Session 5 start", { exact: true })).toHaveValue("14:00");
  await expect(dialog.getByLabel("Session 5 end", { exact: true })).toHaveValue("15:00");
  await expect(dialog.getByRole("checkbox", { name: "Update remaining effort too", exact: true })).toHaveCount(0);
  expect(context.actions).toEqual([]);
  expect(context.current()).toEqual(context.original);
  await dialog.getByRole("button", { name: "Review changes", exact: true }).click();
  await expect(dialog.getByText("This fits your schedule", { exact: true })).toBeVisible();
  expect(context.current()).toEqual(context.original);
  await dialog.getByRole("button", { name: "Confirm changes", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Edit hours", exact: true })).toBeVisible();
  expect(context.actions).toEqual(["preview", "commit"]);
  expect(context.current().sessions.slice(0, 4)).toEqual(context.original.sessions.slice(0, 4));
  expect(context.current().sessions[4].start).toBe(localDateTime(context.dates[4], "14:00", context.current().settings.timeZone));
  expect(context.current().sessions[4].end).toBe(localDateTime(context.dates[4], "15:00", context.current().settings.timeZone));
  expect(minutesBetween(context.current().sessions[4].start, context.current().sessions[4].end)).toBe(60);
  expect(context.current().sessions[4].focusOverrideMinutes).toBeUndefined();
  expect(context.current().items[0]).toMatchObject({ remainingMinutes: 540, estimatedMinutes: 600, forecastDate: context.dates[4] });
  expect(context.current().items[0].dailyPlan).toBeUndefined();
  expect((await state(page.request)).items).toEqual(context.stored.items);
  expect((await state(page.request)).notifications).toEqual(context.stored.notifications);
});


test("an explicit first estimate and page progress stay atomic with reconciled bookings", async ({ page }) => {
  const context = await openSessionFixture(page, 390, true, { category: "landings", webKind: null, estimatedMinutes: null, remainingMinutes: null, timelineMode: "span", progressTotal: 10, progressCompleted: 2 });
  const { dialog } = context;
  await dialog.getByRole("spinbutton", { name: /^Remaining hours/ }).fill("6");
  await dialog.getByLabel("Pages complete / 10", { exact: true }).fill("4");
  await dialog.getByRole("button", { name: "Save progress", exact: true }).click();
  await expect(dialog.getByLabel("Set exact times", { exact: true })).toBeChecked();
  await expect(dialog.getByLabel("Set exact times", { exact: true })).toBeDisabled();
  await expect(dialog.locator(".session-manager-budget")).toContainText("6h remaining after this edit");
  for (let index = 2; index <= 5; index++) await dialog.getByLabel(`Session ${index} end`, { exact: true }).fill("10:00");
  await dialog.getByRole("button", { name: "Review changes", exact: true }).click();
  await expect(dialog.getByText("This fits your schedule", { exact: true })).toBeVisible();
  expect(context.current()).toEqual(context.original);
  await dialog.getByRole("button", { name: "Confirm changes", exact: true }).click();
  await expect(dialog.locator(".session-manager")).toHaveCount(0);
  expect(context.current().items[0]).toMatchObject({ estimatedMinutes: 360, remainingMinutes: 360, progressCompleted: 4, timelineMode: "span", windowEnd: context.dates[4] });
  expect(context.current().sessions.map(session => minutesBetween(session.start, session.end))).toEqual([120, 60, 60, 60, 60]);
  expect(context.actions).toEqual(["preview", "commit"]);
});
