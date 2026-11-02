import { expect, test, type Page } from "@playwright/test";
import { createDemoState } from "../../src/lib/fixtures";
import { planCommands } from "../../src/lib/scheduler";
import { localDate, localDateTime, minutesBetween } from "../../src/lib/time";
import type { AppState, WorkCommand } from "../../src/lib/types";
import { newWorkItem } from "../../src/lib/work";
import { asActor, origin, state } from "./helpers";

// Fictional browser-local fixture at 6:38 PM. Preview and confirmation use
// the real shared scheduler at the same clock, without storage or provider sends.
const now = "2026-09-09T22:38:00Z";
const sourceDate = "2026-09-09", targetDate = "2026-09-10";
const title = "Fictional unfinished website edits", itemId = "missed-website-edits";

async function setup(page: Page, width: number) {
  await asActor(page.request, "bryan");
  const stored = await state(page.request);
  expect(stored.mode).toBe("demo");
  let fixture: AppState = {
    ...createDemoState(now), workspaceId: stored.workspaceId, actor: stored.actor,
    clients: [{ id: "cedar", name: "Cedar Studio", aliases: [] }],
    items: [], sessions: [], blocks: [], events: [], requests: [],
    notifications: [], attachments: [], emailDrafts: [],
  };
  fixture.settings.reserveMinutes = 0;
  fixture.items = [newWorkItem(fixture.actor, sourceDate, {
    id: itemId, clientId: "cedar", title, estimatedMinutes: 120, remainingMinutes: 120,
    windowEnd: sourceDate, dailyPlan: [{ date: sourceDate, minutes: 120 }],
  }), newWorkItem(fixture.actor, targetDate, {
    id: "neighbor", clientId: "cedar", title: "Fictional protected neighbor", estimatedMinutes: 60, remainingMinutes: 60,
  })];
  const at = (date: string, clock: string) => localDateTime(date, clock, fixture.settings.timeZone);
  fixture.sessions = [
    { id: "missed-booking", workItemId: itemId, start: at(sourceDate, "14:00"), end: at(sourceDate, "16:00"), status: "planned", protected: false, usesReserve: false },
    { id: "completed-history", workItemId: itemId, start: at("2026-09-08", "09:00"), end: at("2026-09-08", "10:00"), status: "completed", protected: false, usesReserve: false },
    { id: "cancelled-history", workItemId: itemId, start: at(sourceDate, "09:00"), end: at(sourceDate, "10:00"), status: "cancelled", protected: false, usesReserve: false },
    { id: "protected-neighbor", workItemId: "neighbor", start: at(targetDate, "09:00"), end: at(targetDate, "10:00"), status: "planned", protected: true, usesReserve: false },
  ];
  const before = structuredClone(fixture), actions: string[] = [];
  const commands: WorkCommand[][] = [];
  await page.route(`${origin}/api/state`, route => route.fulfill({ json: fixture }));
  await page.route(`${origin}/api/commands`, async route => {
    const body = route.request().postDataJSON();
    actions.push(body.action); commands.push(body.commands);
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
  const refreshed = page.waitForResponse(`${origin}/api/state`);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await refreshed;
  await page.getByRole("button", { name: "Today", exact: true }).click();
  await page.getByRole("button", { name: "month", exact: true }).click();
  return { before, actions, commands, current: () => fixture };
}

const calendar = (page: Page) => page.getByLabel("Month workload calendar", { exact: true });
async function openDetails(page: Page) {
  await calendar(page).getByTitle(`Cedar Studio · ${title}`, { exact: true }).first().focus();
  await page.keyboard.press("Enter");
  return page.getByRole("dialog", { name: title, exact: true });
}
function verifyMove(context: Awaited<ReturnType<typeof setup>>) {
  const current = context.current(), item = current.items.find(item => item.id === itemId)!;
  expect(item).toMatchObject({ remainingMinutes: 120, estimatedMinutes: 120, status: "planned", completedAt: null, dailyPlan: [{ date: targetDate, minutes: 120 }] });
  const planned = current.sessions.filter(session => session.workItemId === itemId && session.status === "planned");
  expect(planned.reduce((total, session) => total + minutesBetween(session.start, session.end), 0)).toBe(120);
  expect(planned.every(session => localDate(session.start, current.settings.timeZone) === targetDate)).toBe(true);
  expect(current.sessions.filter(session => session.id !== "missed-booking" && !planned.some(booking => booking.id === session.id))).toEqual(context.before.sessions.filter(session => session.id !== "missed-booking"));
  expect(current.blocks).toEqual(context.before.blocks);
  expect(current.notifications).toEqual(context.before.notifications);
}

for (const width of [1440, 390]) {
  test(`moves missed planned hours from the month after 5 PM at ${width}px`, async ({ page }) => {
    const context = await setup(page, width);
    const handle = calendar(page).getByRole("button", { name: `Move Cedar Studio · ${title} on Sep 9`, exact: true });
    await expect(handle).toBeEnabled();
    await handle.focus(); await page.keyboard.press("Enter");
    const picker = page.getByRole("region", { name: "Choose a day for booked hours", exact: true });
    await picker.getByLabel("Move booking to date", { exact: true }).fill(targetDate);
    await picker.getByRole("button", { name: "Preview move", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Move booked hours", exact: true });
    await expect(dialog.getByRole("button", { name: "Confirm move", exact: true })).toBeEnabled();
    expect(context.current()).toEqual(context.before);
    await dialog.getByRole("button", { name: "Confirm move", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    verifyMove(context);
    expect(context.actions).toEqual(["preview", "commit"]);
    await expect(calendar(page).locator(`[data-work-item-id="${itemId}"][data-booking-date="${sourceDate}"]`)).toHaveCount(0);
  });

  test(`edits a missed planned day after 5 PM without adding effort at ${width}px`, async ({ page }, info) => {
    const context = await setup(page, width), dialog = await openDetails(page);
    await dialog.getByRole("button", { name: "Edit hours", exact: true }).click();
    await expect(dialog.getByLabel("Work day 1", { exact: true })).toHaveValue(sourceDate);
    await expect(dialog.getByLabel("Hours on day 1", { exact: true })).toHaveValue("2");
    await expect(dialog.getByLabel("Work day 2", { exact: true })).toHaveCount(0);
    await dialog.getByLabel("Work day 1", { exact: true }).fill(targetDate);
    await expect(dialog.locator(".session-manager-budget")).toContainText("2h remaining after this edit");
    await dialog.getByRole("button", { name: "Review changes", exact: true }).click();
    await expect(dialog.getByRole("button", { name: "Confirm changes", exact: true })).toBeVisible();
    expect(context.current()).toEqual(context.before);
    await dialog.screenshot({ path: info.outputPath(`missed-day-preview-${width}.png`) });
    await dialog.getByRole("button", { name: "Cancel edits", exact: true }).click();
    expect(context.current()).toEqual(context.before);
    await dialog.getByRole("button", { name: "Edit hours", exact: true }).click();
    await expect(dialog.getByLabel("Work day 1", { exact: true })).toHaveValue(sourceDate);
    await dialog.getByLabel("Work day 1", { exact: true }).fill(targetDate);
    await dialog.getByRole("button", { name: "Review changes", exact: true }).click();
    await dialog.getByRole("button", { name: "Confirm changes", exact: true }).click();
    await expect(dialog.locator(".session-manager")).toHaveCount(0);
    verifyMove(context);
    expect(context.commands.at(-1)).toEqual([{ type: "set_day_hours", itemId, days: [{ date: sourceDate, minutes: 0 }, { date: targetDate, minutes: 120 }] }]);
  });
}

test("advanced exact editing moves missed planned work after 5 PM while preserving recorded history", async ({ page }) => {
  const context = await setup(page, 1440), dialog = await openDetails(page);
  await dialog.getByRole("button", { name: "Edit hours", exact: true }).click();
  await dialog.getByText("Advanced", { exact: true }).click();
  await dialog.getByLabel("Set exact times", { exact: true }).check();
  await expect(dialog.getByLabel("Session 1 date", { exact: true })).toBeEnabled();
  await expect(dialog.getByLabel("Session 2 date", { exact: true })).toHaveCount(0);
  await dialog.getByLabel("Session 1 date", { exact: true }).fill(targetDate);
  await dialog.getByRole("button", { name: "Review changes", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Confirm changes", exact: true })).toBeVisible();
  expect(context.current()).toEqual(context.before);
  await dialog.getByRole("button", { name: "Confirm changes", exact: true }).click();
  await expect(dialog.locator(".session-manager")).toHaveCount(0);
  verifyMove(context);
  expect(context.current().sessions.find(session => session.id === "missed-booking")?.start).toBe(localDateTime(targetDate, "14:00", context.current().settings.timeZone));
});
