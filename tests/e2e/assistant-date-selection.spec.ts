import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { createDemoState } from "../../src/lib/fixtures";
import type { AppState } from "../../src/lib/types";
import { asActor, origin, state } from "./helpers";

// Browser-only fictional data. All assistant replies are intercepted, with no
// provider calls, workload mutations, or emails. Real storage is checked below.
async function prepare(page: Page, width = 1440, role: "bryan" | "kyle" | "viewer" = "bryan") {
  await asActor(page.request, role);
  const stored = await state(page.request);
  expect(stored.mode).toBe("demo");
  const fixture: AppState = { ...createDemoState("2026-09-08T13:00:00Z"), workspaceId: stored.workspaceId, actor: stored.actor,
    clients: [{ id: "cedar", name: "Cedar Studio", aliases: [] }], items: [], sessions: [], blocks: [], events: [], requests: [], notifications: [], attachments: [], emailDrafts: [] };
  await page.setViewportSize({ width, height: 1000 });
  await page.clock.setFixedTime(new Date("2026-09-08T13:00:00Z"));
  await page.route(`${origin}/api/state`, route => route.fulfill({ json: fixture }));
  await page.goto("/");
  if (width <= 760) await expect(page.getByRole("button", { name: "agenda", exact: true })).toHaveClass(/active/);
  // Wait for hydration before dispatching the synthetic focus refresh.
  await page.getByRole("button", { name: "agenda", exact: true }).click();
  await expect(page.getByRole("button", { name: "agenda", exact: true })).toHaveClass(/active/);
  await page.getByRole("button", { name: "month", exact: true }).click();
  await expect(page.getByRole("button", { name: "month", exact: true })).toHaveClass(/active/);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByTitle("Cedar Studio", { exact: true })).toHaveCount(1);
  return { fixture, stored };
}
const day = (page: Page, name: string) => page.getByLabel("Month workload calendar", { exact: true }).getByRole("button", { name: new RegExp(`^${name},`), includeHidden: true });
const dialog = (page: Page) => page.getByRole("dialog", { name: "Ask ADA", exact: true });
const selectionDialog = (page: Page) => page.getByRole("dialog", { name: "Selected dates", exact: true });

for (const width of [1440, 390]) test(`selects a cross-month range and retains it through a follow-up at ${width}px`, async ({ page }, info) => {
  const { fixture, stored } = await prepare(page, width);
  const requests: Record<string, unknown>[] = [];
  await page.route(`${origin}/api/assistant`, async route => {
    const input = route.request().postDataJSON(); requests.push(input);
    await route.fulfill({ json: { state: fixture,
      interpretation: requests.length === 1 ? { kind: "clarification", message: "How many hours for the page edits?", commands: [] } : { kind: "answer", message: "Test complete; no work saved.", commands: [] },
      replyToOperationId: requests.length === 1 ? input.operationId : null,
      dateSelection: requests.length === 1 ? input.dateSelection : null } });
  });
  if (width === 1440) {
    await day(page, "Tuesday, September 29").dblclick();
    await selectionDialog(page).getByRole("button", { name: "Change dates on calendar", exact: true }).click();
  } else {
    await page.getByRole("button", { name: "Select dates", exact: true }).click();
    await day(page, "Tuesday, September 29").click();
  }
  await expect(day(page, "Tuesday, September 29")).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Next period", exact: true }).click();
  await day(page, "Friday, October 2").click();
  await expect(page.locator(".date-selection-toolbar strong")).toHaveText("Sep 29, 2026 – Oct 2, 2026");
  await expect(day(page, "Thursday, October 1")).toHaveAttribute("aria-pressed", "true");
  expect(requests).toHaveLength(0);
  expect((await state(page.request)).items).toEqual(stored.items);
  await page.screenshot({ path: info.outputPath(`selected-range-${width}.png`), fullPage: true });
  const calendarAudit = await new AxeBuilder({ page }).include(".primary-column").analyze();
  expect(calendarAudit.violations).toEqual([]);
  await page.getByRole("button", { name: "Ask ADA about these dates", exact: true }).click();
  await expect(dialog(page).locator(".assistant-date-context")).toContainText("Sep 29, 2026 – Oct 2, 2026");
  await dialog(page).getByLabel("Instruction for ADA", { exact: true }).fill("Add web work for Cedar Studio: Page edits.");
  await dialog(page).getByRole("button", { name: "Send instruction", exact: true }).click();
  await expect(dialog(page).getByText("How many hours for the page edits?", { exact: true })).toBeVisible();
  await dialog(page).getByLabel("Instruction for ADA", { exact: true }).fill("Two hours");
  await dialog(page).getByRole("button", { name: "Close dialog", exact: true }).click();
  await page.getByRole("button", { name: "Ask ADA", exact: true }).click();
  await expect(dialog(page).getByLabel("Instruction for ADA", { exact: true })).toHaveValue("Two hours");
  await expect(dialog(page).locator(".assistant-date-context")).toContainText("Sep 29, 2026 – Oct 2, 2026");
  expect((await new AxeBuilder({ page }).include('[role="dialog"]').analyze()).violations).toEqual([]);
  await dialog(page).screenshot({ path: info.outputPath(`selected-conversation-${width}.png`) });
  await dialog(page).getByRole("button", { name: "Send instruction", exact: true }).click();
  await expect(dialog(page).getByText("Test complete; no work saved.", { exact: true })).toBeVisible();
  expect(requests[0].dateSelection).toEqual({ start: "2026-09-29", end: "2026-10-02", kind: "work_window" });
  expect(requests[1].dateSelection).toEqual(requests[0].dateSelection);
  expect(requests[1].replyToOperationId).toBe(requests[0].operationId);
  await expect(dialog(page).locator(".assistant-date-context")).toContainText("Dates from your instruction");
  expect((await state(page.request)).notifications).toEqual(stored.notifications);
});

test("single-day keyboard selection, reverse ranges, reset, and Day button navigation", async ({ page }) => {
  const { stored } = await prepare(page);
  await day(page, "Friday, September 11").focus();
  await page.keyboard.press("Enter");
  await expect(selectionDialog(page).locator("strong")).toHaveText("Sep 11, 2026");
  await selectionDialog(page).getByRole("button", { name: "Change dates on calendar", exact: true }).click();
  await day(page, "Wednesday, September 9").locator(".day-number").click();
  await expect(page.locator(".date-selection-toolbar strong")).toHaveText("Sep 9, 2026 – Sep 11, 2026");
  await day(page, "Monday, September 14").click();
  await expect(page.locator(".date-selection-toolbar strong")).toHaveText("Sep 14, 2026");
  await expect(page.getByRole("button", { name: "Clear selection", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Cancel selection", exact: true }).click();
  await expect(page.locator(".date-selection-toolbar")).toHaveCount(0);
  await page.getByRole("button", { name: "Select dates", exact: true }).click();
  await expect(page.getByRole("button", { name: "Ask ADA about these dates", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Cancel selection", exact: true }).click();
  await day(page, "Wednesday, September 9").locator(".day-number").click();
  await expect(page.getByRole("button", { name: "month", exact: true })).toHaveClass(/active/);
  await expect(page.locator(".date-selection-toolbar")).toHaveCount(0);
  await page.getByRole("button", { name: "Next period", exact: true }).click();
  await expect(page.locator(".date-navigation h2")).toHaveText("October 2026");
  await page.getByRole("button", { name: "day", exact: true }).click();
  await expect(page.getByRole("button", { name: "day", exact: true })).toHaveClass(/active/);
  await expect(page.locator(".date-navigation h2")).toHaveText("September 8, 2026");
  await expect(page.locator(".timed-calendar").getByRole("grid")).toBeVisible();
  await page.getByRole("button", { name: "Next period", exact: true }).click();
  await expect(page.locator(".date-navigation h2")).toHaveText("September 9, 2026");
  await page.getByRole("button", { name: "Previous period", exact: true }).click();
  await expect(page.locator(".date-navigation h2")).toHaveText("September 8, 2026");
  await page.getByRole("button", { name: "Previous period", exact: true }).click();
  await expect(page.locator(".date-navigation h2")).toHaveText("September 7, 2026");
  await page.getByRole("button", { name: "Today", exact: true }).click();
  await expect(page.locator(".date-navigation h2")).toHaveText("September 8, 2026");
  expect(await state(page.request)).toEqual(stored);
});

for (const width of [1440, 390]) test(`double-click opens a centered date modal with keyboard dismissal and range selection at ${width}px`, async ({ page }, info) => {
  const { stored } = await prepare(page, width);
  const selected = day(page, "Wednesday, September 9");
  const position = { x: 20, y: 130 };
  await selected.click({ position });
  await expect(page.locator(".date-selection-toolbar")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "month", exact: true })).toHaveClass(/active/);
  await selected.dblclick({ position });
  const modal = selectionDialog(page);
  await expect(modal.locator("strong")).toHaveText("Sep 9, 2026");
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await expect(page.locator(".date-selection-toolbar")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Open ADA helper", exact: true })).toHaveCount(0);
  await expect(selected).toHaveAttribute("aria-pressed", "true");
  const bounds = (await modal.boundingBox())!;
  expect(bounds.x + bounds.width / 2).toBeCloseTo(width / 2, 0);
  expect(bounds.y + bounds.height / 2).toBeCloseTo(500, 0);
  expect(await modal.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  expect((await new AxeBuilder({ page }).include('[role="dialog"]').analyze()).violations).toEqual([]);
  await page.screenshot({ path: info.outputPath(`date-selection-modal-${width}.png`) });
  await page.keyboard.press("Shift+Tab");
  expect(await modal.evaluate(el => el.contains(document.activeElement))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(modal).toHaveCount(0);
  await expect(selected).toBeFocused();
  await expect(selected).not.toHaveClass(/date-selected/);
  await page.keyboard.press("Space");
  await expect(modal.locator("strong")).toHaveText("Sep 9, 2026");
  await expect(page.getByRole("button", { name: "Add work on these dates", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Ask ADA about these dates", exact: true })).toBeEnabled();
  await modal.getByRole("button", { name: "Change dates on calendar", exact: true }).click();
  await expect(modal).toHaveCount(0);
  await day(page, "Friday, September 11").dblclick();
  await expect(page.locator(".date-selection-toolbar strong")).toHaveText("Sep 9, 2026 – Sep 11, 2026");
  await page.screenshot({ path: info.outputPath("double-click-date-selection.png") });
  await page.getByRole("button", { name: "Cancel selection", exact: true }).click();
  await expect(page.locator(".date-selection-toolbar")).toHaveCount(0);
  await expect(selected).not.toHaveClass(/date-selected/);
  await selected.focus();
  await page.keyboard.press("Space");
  await expect(modal.locator("strong")).toHaveText("Sep 9, 2026");
  await modal.getByRole("button", { name: "Cancel selection", exact: true }).click();
  await expect(modal).toHaveCount(0);
  await selected.dblclick({ position });
  await modal.getByRole("button", { name: "Close dialog", exact: true }).click();
  await expect(modal).toHaveCount(0);
  expect(await state(page.request)).toEqual(stored);
});

test("change and clear dates, preserve errors, and require a deliberate new instruction", async ({ page }) => {
  await prepare(page);
  await page.route(`${origin}/api/assistant`, route => route.fulfill({ status: 400, json: { error: "Offline test: retry later." } }));
  await page.getByRole("button", { name: "Select dates", exact: true }).click();
  await day(page, "Wednesday, September 9").click();
  await page.getByRole("button", { name: "Ask ADA about these dates", exact: true }).click();
  await dialog(page).getByRole("button", { name: "Change dates", exact: true }).click();
  await dialog(page).getByLabel("End date", { exact: true }).fill("2026-09-11");
  await dialog(page).getByRole("button", { name: "Use these dates", exact: true }).click();
  await dialog(page).getByLabel("Instruction for ADA", { exact: true }).fill("Add web work for Cedar Studio: Page edits, two hours.");
  await dialog(page).getByRole("button", { name: "Send instruction", exact: true }).click();
  await expect(dialog(page).getByText("Offline test: retry later.", { exact: true })).toBeVisible();
  await expect(dialog(page).locator(".assistant-date-context")).toContainText("Sep 9, 2026 – Sep 11, 2026");
  await dialog(page).getByRole("button", { name: "Clear dates", exact: true }).click();
  await expect(dialog(page).locator(".assistant-date-context")).toContainText("Dates from your instruction");
  await dialog(page).getByRole("button", { name: "Close dialog", exact: true }).click();
  await day(page, "Thursday, September 10").dblclick();
  await expect(page.getByRole("dialog", { name: "Start a new instruction?", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Keep current instruction", exact: true }).click();
  await expect(dialog(page).getByLabel("Instruction for ADA", { exact: true })).toHaveValue(/Cedar Studio/);
  await dialog(page).getByRole("button", { name: "Close dialog", exact: true }).click();
  await day(page, "Thursday, September 10").dblclick();
  await page.getByRole("button", { name: "Start a new instruction", exact: true }).click();
  await expect(selectionDialog(page).locator("strong")).toHaveText("Sep 10, 2026");
  await page.getByLabel("Use selected dates as", { exact: true }).selectOption("project_span");
  await page.getByRole("button", { name: "Ask ADA about these dates", exact: true }).click();
  await expect(selectionDialog(page)).toHaveCount(0);
  await expect(dialog(page).getByLabel("Instruction for ADA", { exact: true })).toHaveValue("");
  await expect(dialog(page).locator(".assistant-date-context")).toContainText("Selected project timeline");
});

test("requesters get work windows, while viewers get no date-selection command", async ({ page }) => {
  await prepare(page, 1440, "kyle");
  await day(page, "Wednesday, September 9").dblclick();
  await expect(page.getByLabel("Use selected dates as", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Ask ADA about these dates", exact: true }).click();
  await expect(dialog(page).locator(".assistant-date-context")).toContainText("Selected work dates");
  await page.unroute(`${origin}/api/state`);
  await prepare(page, 1440, "viewer");
  await expect(page.getByRole("button", { name: "Select dates", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Ask ADA", exact: true })).toHaveCount(0);
  await day(page, "Wednesday, September 9").dblclick();
  await expect(page.locator(".date-selection-toolbar")).toHaveCount(0);
  await expect(selectionDialog(page)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "month", exact: true })).toHaveClass(/active/);
  await page.getByRole("button", { name: "day", exact: true }).click();
  await expect(page.locator(".timed-calendar").getByRole("grid")).toBeVisible();
});

for (const width of [1440, 390]) test(`selected-date actions stay below the sticky header while scrolling at ${width}px`, async ({ page }, info) => {
  await prepare(page, width);
  await page.getByRole("button", { name: "Select dates", exact: true }).click();
  await day(page, "Tuesday, September 29").locator(".day-number").click();
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  const header = page.locator(".calendar-sticky-header");
  const toolbar = page.locator(".date-selection-toolbar");
  const headerBounds = (await header.boundingBox())!;
  const monthBounds = (await page.locator(".calendar-toolbar-sticky").boundingBox())!;
  const toolbarBounds = (await toolbar.boundingBox())!;
  expect(headerBounds.y).toBe(0);
  expect(monthBounds.y).toBeCloseTo(headerBounds.height, 0);
  expect(toolbarBounds.y).toBeCloseTo(monthBounds.y + monthBounds.height, 0);
  const ask = page.getByRole("button", { name: "Ask ADA about these dates", exact: true });
  await expect(ask).toBeInViewport({ ratio: 1 });
  await page.screenshot({ path: info.outputPath(`sticky-date-actions-${width}.png`) });
  await ask.click();
  await expect(dialog(page).locator(".assistant-date-context")).toContainText("Sep 29, 2026");
});

for (const width of [1440, 390]) test(`month controls and weekday labels stick below the header and follow selection height at ${width}px`, async ({ page }, info) => {
  const { stored } = await prepare(page, width);
  const header = page.locator(".calendar-sticky-header");
  const month = page.locator(".calendar-toolbar-sticky");
  const weekdays = page.locator(".weekday-head");
  await page.evaluate(() => window.scrollTo(0, 0));
  const initialHeader = (await header.boundingBox())!;
  const initialMonth = (await month.boundingBox())!;
  const initialWeekdays = (await weekdays.boundingBox())!;
  expect(initialMonth.y).toBeGreaterThanOrEqual(initialHeader.y + initialHeader.height);
  expect(initialWeekdays.y).toBeGreaterThan(initialHeader.y + initialHeader.height);

  // The header and month controls pin before the weekday row reaches them.
  const firstScroll = initialHeader.y + 5;
  await page.evaluate(y => window.scrollTo(0, y), firstScroll);
  await expect.poll(async () => (await header.boundingBox())!.y).toBeCloseTo(0, 0);
  expect((await weekdays.boundingBox())!.y).toBeCloseTo(initialWeekdays.y - firstScroll, 0);
  expect((await weekdays.boundingBox())!.y).toBeGreaterThan((await header.boundingBox())!.height);

  const stickyScroll = initialWeekdays.y - initialHeader.height + 80;
  for (const y of [stickyScroll, stickyScroll + 100]) {
    await page.evaluate(y => window.scrollTo(0, y), y);
    await expect.poll(async () => (await month.boundingBox())!.y - (await header.boundingBox())!.height).toBeCloseTo(0, 0);
    await expect.poll(async () => {
      const controls = (await month.boundingBox())!;
      return (await weekdays.boundingBox())!.y - controls.y - controls.height;
    }).toBeCloseTo(0, 0);
    expect(await weekdays.evaluate(el => {
      const box = el.getBoundingClientRect();
      return el.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
    })).toBe(true);
    await expect(month.getByRole("heading", { name: "September 2026", exact: true })).toBeInViewport({ ratio: 1 });
    await expect(month.getByRole("button", { name: "Today", exact: true })).toBeInViewport({ ratio: 1 });
  }
  await month.getByRole("button", { name: "Next period", exact: true }).click();
  await expect(month.getByRole("heading", { name: "October 2026", exact: true })).toBeVisible();
  await month.getByRole("button", { name: "Previous period", exact: true }).click();
  await expect(month.getByRole("heading", { name: "September 2026", exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath(`sticky-weekdays-${width}.png`) });
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect.poll(async () => (await month.boundingBox())!.y).toBeCloseTo(initialMonth.y, 0);
  await expect.poll(async () => (await weekdays.boundingBox())!.y).toBeCloseTo(initialWeekdays.y, 0);

  await page.getByRole("button", { name: "Select dates", exact: true }).click();
  await day(page, "Tuesday, September 29").locator(".day-number").click();
  const toolbar = page.locator(".date-selection-toolbar");
  for (const currentWidth of [width, width === 1440 ? 1100 : 520]) {
    await page.setViewportSize({ width: currentWidth, height: 1000 });
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await expect.poll(async () => (await month.boundingBox())!.y - (await header.boundingBox())!.height).toBeCloseTo(0, 0);
    await expect.poll(async () => {
      const controls = (await month.boundingBox())!;
      return (await toolbar.boundingBox())!.y - controls.y - controls.height;
    }).toBeCloseTo(0, 0);
    await expect.poll(async () => {
      const top = (await weekdays.boundingBox())!.y;
      const panel = (await toolbar.boundingBox())!;
      return top - (panel.y + panel.height);
    }).toBeCloseTo(0, 0);
  }
  await page.screenshot({ path: info.outputPath(`sticky-weekdays-with-selection-${width}.png`) });
  await page.getByRole("button", { name: "Cancel selection", exact: true }).click();
  await expect.poll(async () => {
    const controls = (await month.boundingBox())!;
    return (await weekdays.boundingBox())!.y - controls.y - controls.height;
  }).toBeCloseTo(0, 0);
  expect(await state(page.request)).toEqual(stored);
});
