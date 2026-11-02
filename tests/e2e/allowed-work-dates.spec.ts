import { expect, test, type Page } from "@playwright/test";
import { createDemoState } from "../../src/lib/fixtures";
import { planCommands } from "../../src/lib/scheduler";
import { localDate, localDateTime, minutesBetween } from "../../src/lib/time";
import type { AppState, WorkCommand } from "../../src/lib/types";
import { newWorkItem } from "../../src/lib/work";
import { asActor, origin, state } from "./helpers";

// Fictional browser-local work only. Every preview and commit uses the shared
// scheduler with a fixed clock; intercepted writes never reach storage or mail.
const now = "2026-09-09T13:00:00Z";
const sourceDate = "2026-09-10";
const targetDate = "2026-09-11";
const title = "Fictional first wave of website edits";
const itemId = "allowed-dates-website-edits";

async function setup(page: Page, width = 1440, actor: "bryan" | "kyle" = "bryan", waiting = false, limited = false, twoDays = false) {
  await asActor(page.request, actor);
  const stored = await state(page.request);
  expect(stored.mode).toBe("demo");
  let fixture: AppState = {
    ...createDemoState(now), workspaceId: stored.workspaceId, actor: stored.actor,
    clients: [{ id: "cedar", name: "Cedar Studio", aliases: [] }],
    items: [], sessions: [], blocks: [], events: [], requests: [],
    notifications: [], attachments: [], emailDrafts: [],
  };
  fixture.settings.reserveMinutes = 0;
  const item = newWorkItem(fixture.actor, sourceDate, {
    id: itemId, clientId: "cedar", title, category: "web", webKind: "edit",
    windowEnd: sourceDate, allowedDates: [sourceDate], estimatedMinutes: 120,
    remainingMinutes: 120, minimumSessionMinutes: 60, targetDate: null, deadline: null,
    ...(waiting ? { status: "waiting", estimatedMinutes: null, remainingMinutes: null } : {}),
  });
  delete item.dateConstraints; delete item.timelineMode;
  if (limited) item.dateConstraints = { earliestStart: null, allowedDates: [sourceDate] };
  if (waiting) { item.timelineMode = "span"; item.windowEnd = null; }
  if (twoDays) { item.estimatedMinutes = 240; item.remainingMinutes = 240; }
  const neighbor = newWorkItem(fixture.actor, targetDate, {
    id: "allowed-dates-neighbor", clientId: "cedar", title: "Fictional protected neighbor",
    estimatedMinutes: 60, remainingMinutes: 60,
  });
  const at = (date: string, time: string) => localDateTime(date, time, fixture.settings.timeZone);
  fixture.items = [item, neighbor];
  fixture.sessions = [
    { id: "allowed-dates-booking", workItemId: item.id, start: at(sourceDate, "10:00"), end: at(sourceDate, "12:00"), protected: false, status: "planned", usesReserve: false },
    { id: "allowed-dates-protected-neighbor", workItemId: neighbor.id, start: at(targetDate, "09:00"), end: at(targetDate, "10:00"), protected: true, status: "planned", usesReserve: false },
  ];
  if (twoDays) fixture.sessions.push({ id: "second-day", workItemId: itemId, start: at(targetDate, "14:00"), end: at(targetDate, "16:00"), protected: false, status: "planned", usesReserve: false });
  if (waiting) fixture.sessions = fixture.sessions.filter(session => session.workItemId !== itemId);
  const before = structuredClone(fixture);
  const requests: { action: string; commands: WorkCommand[] }[] = [];
  await page.route(`${origin}/api/state`, route => route.fulfill({ json: fixture }));
  for (const name of ["assistant", "workspace-chat", "transcribe"]) {
    await page.route(`${origin}/api/${name}`, () => {
      throw new Error(`Manual hours must not call /api/${name}.`);
    });
  }
  await page.route(`${origin}/api/commands`, async route => {
    const body = route.request().postDataJSON();
    requests.push(body);
    const proposal = planCommands(fixture, body.commands, fixture.actor, { now, operationId: body.operationId });
    if (body.action === "commit") {
      expect(proposal.status, JSON.stringify(proposal.conflicts)).toBe("ready");
      expect(body.baseVersion).toBe(fixture.version);
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
  await expect(page.getByTitle("Cedar Studio", { exact: true })).toBeVisible();
  // SSR seeds the real server date; select the browser fixture's frozen day.
  await page.getByRole("button", { name: "Today", exact: true }).click();
  await page.getByRole("button", { name: "month", exact: true }).click();
  return { before, requests, fixture: () => fixture };
}

const calendar = (page: Page) => page.getByLabel("Month workload calendar", { exact: true });
const details = (page: Page) => page.getByRole("dialog", { name: title, exact: true });
const editor = (page: Page) => page.getByRole("dialog", { name: "Edit details", exact: true });
const moveDialog = (page: Page) => page.getByRole("dialog", { name: "Move booked hours", exact: true });
const moveHandle = (page: Page) => calendar(page).getByRole("button", { name: `Move Cedar Studio · ${title} on Sep 10`, exact: true });

async function openDetails(page: Page) {
  // The separate move handle can cover the center of a narrow day ribbon.
  // Activate its accessible details button directly with the keyboard.
  await calendar(page).getByTitle(`Cedar Studio · ${title}`, { exact: true }).first().focus();
  await page.keyboard.press("Enter");
  await expect(details(page)).toBeVisible();
  return details(page);
}


async function previewMove(page: Page) {
  await moveHandle(page).focus(); await page.keyboard.press("Enter");
  const picker = page.getByRole("region", { name: "Choose a day for booked hours", exact: true });
  await picker.getByLabel("Move booking to date", { exact: true }).fill(targetDate);
  await picker.getByRole("button", { name: "Preview move", exact: true }).click();
  return moveDialog(page);
}
for (const width of [1440, 390]) {
  test(`legacy task moves freely and its ribbon follows at ${width}px`, async ({ page }, info) => {
    const context = await setup(page, width);
    const move = await previewMove(page);
    await expect(move.getByRole("button", { name: "Confirm move", exact: true })).toBeEnabled();
    expect(context.fixture()).toEqual(context.before);
    await move.screenshot({ path: info.outputPath(`simple-move-${width}.png`) });
    await move.getByRole("button", { name: "Confirm move", exact: true }).click();
    await expect(move).toHaveCount(0);
    const moved = context.fixture().sessions.find(session => session.id === "allowed-dates-booking")!;
    expect(localDate(moved.start, context.fixture().settings.timeZone)).toBe(targetDate);
    expect(minutesBetween(moved.start, moved.end)).toBe(120);
    expect(context.fixture().sessions.filter(session => session.workItemId !== itemId)).toEqual(context.before.sessions.filter(session => session.workItemId !== itemId));
    expect(context.fixture().items.find(item => item.id === itemId)?.remainingMinutes).toBe(120);
    await expect(calendar(page).locator(`[data-work-item-id="${itemId}"][data-booking-date="${sourceDate}"]`)).toHaveCount(0);
  });
  test(`daily hours update the regular total and preserve other days at ${width}px`, async ({ page }, info) => {
    const context = await setup(page, width, "bryan", false, false, true);
    const dialog = await openDetails(page);
    await dialog.getByRole("button", { name: "Edit hours", exact: true }).click();
    await dialog.getByLabel("Hours on day 2", { exact: true }).fill("1");
    await dialog.getByRole("button", { name: "Review changes", exact: true }).click();
    await expect(dialog.getByRole("button", { name: "Confirm changes", exact: true })).toBeVisible();
    expect(context.fixture()).toEqual(context.before);
    await dialog.screenshot({ path: info.outputPath(`simple-day-hours-${width}.png`) });
    await dialog.getByRole("button", { name: "Confirm changes", exact: true }).click();
    expect(context.fixture().items.find(item => item.id === itemId)?.remainingMinutes).toBe(180);
    expect(context.fixture().sessions.find(session => session.id === "allowed-dates-booking")).toEqual(context.before.sessions.find(session => session.id === "allowed-dates-booking"));
    expect(context.requests.at(-1)?.commands).toEqual([{ type: "set_day_hours", itemId, days: [{ date: targetDate, minutes: 60 }] }]);
  });
}
test("explicit optional date limits still apply and can be removed without moving bookings", async ({ page }) => {
  const context = await setup(page, 1440, "bryan", false, true);
  const move = await previewMove(page);
  await expect(move.getByRole("alert")).toContainText(/allowed work date/i);
  await move.getByRole("button", { name: "Cancel move", exact: true }).click();
  const dialog = await openDetails(page);
  await dialog.getByRole("button", { name: "Edit details", exact: true }).click();
  const form = editor(page);
  await form.getByText("Scheduling limits (optional)", { exact: true }).click();
  await form.getByLabel("Limit work to selected dates", { exact: true }).uncheck();
  await expect(form.getByLabel("Minimum focus session", { exact: true })).toHaveCount(0);
  await form.getByRole("button", { name: "Review changes", exact: true }).click();
  await form.getByRole("button", { name: "Confirm changes", exact: true }).click();
  expect(context.fixture().sessions).toEqual(context.before.sessions);
  expect(context.fixture().items.find(item => item.id === itemId)?.dateConstraints?.allowedDates).toEqual([]);
});
test("cancelling an hours edit makes no changes", async ({ page }) => {
  const context = await setup(page);
  const dialog = await openDetails(page);
  await dialog.getByRole("button", { name: "Edit hours", exact: true }).click();
  await dialog.getByRole("button", { name: "Remove day 1", exact: true }).click();
  await dialog.getByRole("button", { name: "Review changes", exact: true }).click();
  await dialog.getByRole("button", { name: "Cancel edits", exact: true }).click();
  expect(context.fixture()).toEqual(context.before);
});
test("requesters cannot edit or drag existing work", async ({ page }) => {
  await setup(page, 390, "kyle");
  const dialog = await openDetails(page);
  await expect(dialog.getByRole("button", { name: "Edit details", exact: true })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Edit hours", exact: true })).toHaveCount(0);
  await expect(moveHandle(page)).toHaveCount(0);
});

for (const width of [1440, 390]) {
  test(`create unequal dated hours and ongoing work at ${width}px`, async ({ page }, info) => {
    const context = await setup(page, width);
    await page.getByRole("button", { name: "Add work", exact: true }).click();
    const form = page.getByRole("dialog", { name: "Make room for new work", exact: true });
    await form.getByLabel("What needs doing?", { exact: true }).fill("Fictional simple dates");
    await form.getByRole("button", { name: /^Days and hours/ }).click();
    await form.getByLabel("Work day 1", { exact: true }).fill("2026-09-14");
    await form.getByLabel("Hours on day 1", { exact: true }).fill("2");
    await form.getByRole("button", { name: "Add day", exact: true }).click();
    await form.getByLabel("Work day 2", { exact: true }).fill("2026-09-16");
    await form.getByLabel("Hours on day 2", { exact: true }).fill("1");
    await expect(form.getByLabel("Minimum focus session", { exact: true })).toHaveCount(0);
    await form.getByRole("button", { name: "Review changes", exact: true }).click();
    await form.getByRole("button", { name: "Confirm changes", exact: true }).click();
    await expect(form).toHaveCount(0);
    const task = context.fixture().items.find(item => item.title === "Fictional simple dates")!;
    expect(task).toMatchObject({ remainingMinutes: 180, timelineMode: "bookings", dateConstraints: { earliestStart: null, allowedDates: [] } });
    expect(task.dailyPlan).toEqual([{ date: "2026-09-14", minutes: 120 }, { date: "2026-09-16", minutes: 60 }]);
    await page.getByRole("button", { name: "Add work", exact: true }).click();
    await form.getByLabel("What needs doing?", { exact: true }).fill("Fictional ongoing updates");
    await form.getByRole("button", { name: /^Ongoing/ }).click();
    await expect(form.getByLabel(/No end date/)).toBeChecked();
    await form.screenshot({ path: info.outputPath(`ongoing-create-${width}.png`) });
    expect(await form.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await form.getByRole("button", { name: "Review changes", exact: true }).click();
    await form.getByRole("button", { name: "Confirm changes", exact: true }).click();
    const ongoing = context.fixture().items.find(item => item.title === "Fictional ongoing updates")!;
    expect(ongoing).toMatchObject({ timelineMode: "span", windowEnd: null, estimatedMinutes: null, remainingMinutes: null, status: "waiting" });
    expect(context.fixture().sessions.filter(session => session.workItemId === ongoing.id)).toHaveLength(0);
    await calendar(page).getByTitle("Cedar Studio · Fictional ongoing updates", { exact: true }).first().focus();
    await page.keyboard.press("Enter");
    const ongoingDialog = page.getByRole("dialog", { name: "Fictional ongoing updates", exact: true });
    await ongoingDialog.getByRole("button", { name: "Add hours", exact: true }).click();
    await ongoingDialog.getByLabel("Work day 1", { exact: true }).fill(targetDate);
    await ongoingDialog.getByLabel("Hours on day 1", { exact: true }).fill("3");
    await ongoingDialog.getByRole("button", { name: "Review changes", exact: true }).click();
    await ongoingDialog.getByRole("button", { name: "Confirm changes", exact: true }).click();
    expect(context.fixture().items.find(item => item.id === ongoing.id)).toMatchObject({ remainingMinutes: null, estimatedMinutes: null, status: "planned", windowEnd: null });
    expect(context.fixture().sessions.filter(session => session.workItemId === ongoing.id).reduce((total, session) => total + minutesBetween(session.start, session.end), 0)).toBe(180);
  });
}
