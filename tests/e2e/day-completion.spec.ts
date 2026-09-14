import { expect, test, type Page } from "@playwright/test";
import { createDemoState } from "../../src/lib/fixtures";
import { planCommands } from "../../src/lib/scheduler";
import { withReviewFingerprint } from "../../src/lib/server/preview";
import { localDateTime } from "../../src/lib/time";
import type { AppState, WorkCommand } from "../../src/lib/types";
import { newWorkItem } from "../../src/lib/work";
import { asActor, origin, state } from "./helpers";

// Browser-local fictional records; the shared planner handles preview and save.
// Authenticated persistence/authorization are covered by day-completion-server.
const now = "2026-09-09T22:38:00Z", dates = ["2026-09-09", "2026-09-10", "2026-09-11"];
const title = "Fictional three-day edits", itemId = "three-day-completion";
async function setup(page: Page, width: number, mixedUnknown = false) {
  await asActor(page.request, "bryan");
  const stored = await state(page.request); expect(stored.mode).toBe("demo");
  let fixture: AppState = { ...createDemoState(now), workspaceId: stored.workspaceId, actor: stored.actor,
    clients: [{ id: "cedar", name: "Cedar Studio", aliases: [] }], items: [], sessions: [], blocks: [], events: [], requests: [], notifications: [], attachments: [], emailDrafts: [] };
  fixture.settings.reserveMinutes = 0;
  fixture.items = [newWorkItem(fixture.actor, dates[0], { id: itemId, clientId: "cedar", title,
    estimatedMinutes: mixedUnknown ? null : 180, remainingMinutes: mixedUnknown ? null : 180,
    timelineMode: mixedUnknown ? "span" : "bookings", windowEnd: mixedUnknown ? null : dates[2],
    dailyPlan: dates.map(date => ({ date, minutes: 60 })),
  })];
  const at = (date: string, clock: string) => localDateTime(date, clock, fixture.settings.timeZone);
  fixture.sessions = dates.map((date, index) => ({ id: `day-${index}`, workItemId: itemId, start: at(date, "09:00"), end: at(date, "10:00"), status: "planned", protected: false, usesReserve: false }));
  if (mixedUnknown) {
    fixture.sessions[0].end = at(dates[0], "09:15");
    fixture.sessions[0].protected = true;
    fixture.sessions.push({ ...fixture.sessions[0], id: "second-fragment", start: at(dates[0], "10:00"), end: at(dates[0], "10:45"), protected: false },
      { ...fixture.sessions[0], id: "recorded-history", start: at(dates[0], "11:00"), end: at(dates[0], "11:30"), status: "completed", protected: false });
  }
  const before = structuredClone(fixture), actions: string[] = [], commands: WorkCommand[][] = [];
  await page.route(`${origin}/api/state`, route => route.fulfill({ json: fixture }));
  await page.route(`${origin}/api/commands`, async route => {
    const body = route.request().postDataJSON(); actions.push(body.action); commands.push(body.commands);
    const proposal = withReviewFingerprint(planCommands(fixture, body.commands, fixture.actor, { now, operationId: body.operationId }));
    if (body.action === "commit") {
      expect(proposal.status, JSON.stringify(proposal.conflicts)).toBe("ready");
      expect(body.baseVersion).toBe(proposal.baseVersion); expect(body.reviewFingerprint).toBe(proposal.reviewFingerprint);
      fixture = { ...fixture, version: fixture.version + 1, items: proposal.items, sessions: proposal.sessions, blocks: proposal.blocks };
    }
    await route.fulfill({ json: { proposal, state: fixture } });
  });
  await page.clock.setFixedTime(new Date(now)); await page.setViewportSize({ width, height: 1000 });
  await page.goto("/");
  await page.getByRole("button", { name: "agenda", exact: true }).click();
  const refreshed = page.waitForResponse(`${origin}/api/state`); await page.evaluate(() => window.dispatchEvent(new Event("focus"))); await refreshed;
  // The page now hydrates with the server's date. Select the browser fixture's
  // simulated today explicitly before verifying agenda and timed views.
  await page.getByRole("button", { name: "Today", exact: true }).click();
  await page.getByRole("button", { name: "month", exact: true }).click();
  return { before, actions, commands, current: () => fixture, changeFromAnotherTab: () => {
    fixture = structuredClone(fixture); fixture.version++;
    fixture.sessions[0].end = at(dates[0], "11:00"); fixture.items[0].remainingMinutes = 240; fixture.items[0].dailyPlan![0].minutes = 120;
  } };
}
const calendar = (page: Page) => page.getByLabel("Month workload calendar", { exact: true });
async function captureCompletedWeek(page: Page, filename: string) {
  const completed = calendar(page).locator(`[data-work-item-id="${itemId}"][data-completed-date="${dates[0]}"]`).first();
  await completed.evaluate(element => element.scrollIntoView({ block: "center", inline: "nearest" }));
  await calendar(page).locator(".calendar-week").filter({ has: page.locator(`[data-work-item-id="${itemId}"][data-completed-date="${dates[0]}"]`) }).screenshot({ path: filename });
}
async function openDetails(page: Page) {
  await calendar(page).getByTitle(`Cedar Studio · ${title}`, { exact: true }).first().focus(); await page.keyboard.press("Enter");
  return page.getByRole("dialog", { name: title, exact: true });
}

for (const width of [1440, 390]) {
  test(`finishes one of three booked days and leaves the others active at ${width}px`, async ({ page }, info) => {
    const context = await setup(page, width), dialog = await openDetails(page);
    await expect(dialog.locator(".completion-day")).toHaveCount(3);
    await expect(dialog.getByRole("button", { name: "Finish this day", exact: true })).toHaveCount(3);
    const first = dialog.locator(`[data-work-date="${dates[0]}"]`);
    await expect(first).toContainText("1h booked");
    await first.getByRole("button", { name: "Finish this day", exact: true }).click();
    const review = first.getByRole("region", { name: "Finish work on Wed, Sep 9", exact: true });
    await expect(review).toContainText("Remaining effort: 3h → 2h");
    await expect(review).toContainText("9:00 AM–10:00 AM");
    await expect(review).toContainText("The project stays open");
    expect(context.current()).toEqual(context.before);
    await review.screenshot({ path: info.outputPath(`day-completion-review-${width}.png`) });
    await review.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(context.current()).toEqual(context.before);
    await first.getByRole("button", { name: "Finish this day", exact: true }).click();
    await review.getByRole("button", { name: "Confirm day finished", exact: true }).click();
    await expect(review).toHaveCount(0);
    await expect(first).toContainText("Day finished"); await expect(first).toContainText("1h done");
    await expect(first.getByRole("button", { name: "Finish this day", exact: true })).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "Finish this day", exact: true })).toHaveCount(2);
    await expect(dialog.getByLabel("Remaining hours", { exact: true })).toHaveValue("2");
    const saved = context.current();
    expect(saved.items[0]).toMatchObject({ remainingMinutes: 120, estimatedMinutes: 180, status: "planned", completedAt: null });
    expect(saved.sessions).toEqual(context.before.sessions.map((session, index) => index === 0 ? { ...session, status: "completed" } : session));
    expect(context.commands.at(-1)).toEqual([{ type: "complete_day", itemId, date: dates[0] }]);
    expect(context.actions.filter(action => action === "commit")).toEqual(["commit"]);
    expect(context.actions.slice(0, -1).every(action => action === "preview")).toBe(true);
    await dialog.getByRole("button", { name: "Close dialog", exact: true }).click();
    await expect(calendar(page).locator(`.completed-day-segment[data-work-item-id="${itemId}"][data-completed-date="${dates[0]}"]`)).toContainText("1h done");
    await expect(calendar(page).getByRole("button", { name: `Move Cedar Studio · ${title} on Sep 10`, exact: true })).toBeEnabled();
    await expect(calendar(page).getByRole("button", { name: `Move Cedar Studio · ${title} on Sep 9`, exact: true })).toHaveCount(0);
    await captureCompletedWeek(page, info.outputPath(`completed-day-calendar-${width}.png`));
    await page.getByRole("button", { name: "agenda", exact: true }).click();
    await expect(page.locator('.completed-agenda-session[data-session-id="day-0"]')).toBeVisible();
    for (const view of ["week", "day"]) {
      await page.getByRole("button", { name: view, exact: true }).click();
      await expect(page.locator('.completed-time-session[data-session-id="day-0"]')).toBeVisible();
    }
  });
}

for (const width of [1440, 390]) test(`finishes a mixed split day and keeps ongoing effort unknown at ${width}px`, async ({ page }, info) => {
  const context = await setup(page, width, true);
  await expect(calendar(page).locator(`.completed-day-segment[data-work-item-id="${itemId}"][data-completed-date="${dates[0]}"]`)).toContainText("0.5h done");
  await expect(calendar(page).locator(`[data-booking-date="${dates[0]}"] .planned-day-amount`)).toContainText("1h");
  await captureCompletedWeek(page, info.outputPath(`mixed-day-calendar-${width}.png`));
  const dialog = await openDetails(page);
  const day = dialog.locator(`[data-work-date="${dates[0]}"]`);
  await expect(day).toContainText("1h booked"); await expect(day).toContainText("0.5h done");
  await day.getByRole("button", { name: "Finish this day", exact: true }).click();
  const review = day.getByRole("region", { name: "Finish work on Wed, Sep 9", exact: true });
  await expect(review).toContainText("Remaining effort stays unknown");
  await expect(review.locator("li")).toHaveCount(2);
  await day.screenshot({ path: info.outputPath(`mixed-day-review-${width}.png`) });
  await review.getByRole("button", { name: "Confirm day finished", exact: true }).click();
  await expect(day).toContainText("1.5h done");
  expect(context.current().items[0]).toMatchObject({ estimatedMinutes: null, remainingMinutes: null, status: "planned", completedAt: null });
  expect(context.current().sessions).toEqual(context.before.sessions.map(session => ["day-0", "second-fragment"].includes(session.id) ? { ...session, status: "completed" } : session));
  await expect(dialog.getByRole("button", { name: "Finish this day", exact: true })).toHaveCount(2);
});

test("reviews authoritative hours when another tab changes the day before completion is opened", async ({ page }) => {
  const context = await setup(page, 390), dialog = await openDetails(page);
  const day = dialog.locator(`[data-work-date="${dates[0]}"]`);
  await expect(day).toContainText("1h booked");
  context.changeFromAnotherTab();
  const changed = structuredClone(context.current());
  await day.getByRole("button", { name: "Finish this day", exact: true }).click();
  const review = day.getByRole("region", { name: "Finish work on Wed, Sep 9", exact: true });
  await expect(review).toContainText("The calendar changed since you opened this task");
  await expect(review).toContainText("Mark 2h of booked work");
  await expect(review).toContainText("9:00 AM–11:00 AM");
  await expect(review).toContainText("Remaining effort: 4h → 2h");
  expect(context.current()).toEqual(changed); expect(context.actions.every(action => action === "preview")).toBe(true);
  await review.getByRole("button", { name: "Confirm day finished", exact: true }).click();
  await expect(day).toContainText("2h done");
  expect(context.current().items[0]).toMatchObject({ estimatedMinutes: 180, remainingMinutes: 120, status: "planned" });
  expect(context.current().sessions).toEqual(changed.sessions.map((session, index) => index === 0 ? { ...session, status: "completed" } : session));
});
