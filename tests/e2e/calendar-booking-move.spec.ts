import { expect, test, type Locator, type Page } from "@playwright/test";
import type { AppState, WorkCommand } from "../../src/lib/types";
import { addDays, localDate, localDateTime, minutesBetween, nextWorkDate } from "../../src/lib/time";
import { asActor, commit, exactSession, futureDate, makeItem, origin, preview, state } from "./helpers";

// Real isolated demo commands and captured transactions. The month interaction
// never invokes an assistant, provider, transcription, or outgoing mail.
test.beforeEach(async ({ page, baseURL }) => {
  expect(baseURL).toBe(origin);
  await asActor(page.request, "bryan");
  expect((await state(page.request)).mode).toBe("demo");
  for (const routeName of ["assistant", "workspace-chat", "transcribe"]) {
    await page.route(`${origin}/api/${routeName}`, async route => {
      await route.abort();
      throw new Error(`Moving an existing month booking must not call /api/${routeName}.`);
    });
  }
});

const calendar = (page: Page) => page.getByLabel("Month workload calendar", { exact: true });
const moveDialog = (page: Page) => page.getByRole("dialog", { name: "Move booked hours", exact: true });
const moveCard = (page: Page) => page.getByLabel("Last calendar move", { exact: true });
const schedule = ({ items, sessions, blocks }: AppState) => ({ items, sessions, blocks });
const shortDate = (date: string) => new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`));

async function seed(page: Page, offset: number, options: { fullTarget?: boolean; protectedSource?: boolean; nextMonthTarget?: boolean } = {}) {
  const snapshot = await state(page.request), source = futureDate(snapshot, offset);
  const target = nextWorkDate(options.nextMonthTarget
    ? new Date(Date.UTC(Number(source.slice(0, 4)), Number(source.slice(5, 7)), 1)).toISOString().slice(0, 10)
    : addDays(source, 1), snapshot.settings);
  const end = addDays(target, 9), title = `Fictional month booking ${offset}`;
  const item = makeItem(snapshot, title, {
    windowStart: source, windowEnd: end, estimatedMinutes: 120, remainingMinutes: 120,
    minimumSessionMinutes: 60, category: "web", webKind: "build",
  });
  const sessions = [exactSession(snapshot, item, "09:00", "10:00"), exactSession(snapshot, item, "12:30", "13:30")];
  if (options.protectedSource) sessions[0].protected = true;
  const other = makeItem(snapshot, `Fictional unchanged neighbor ${offset}`, {
    windowStart: source, windowEnd: source, estimatedMinutes: 60, remainingMinutes: 60, minimumSessionMinutes: 60,
  });
  const commands: WorkCommand[] = [
    { type: "create", item, sessions },
    { type: "create", item: other, sessions: [exactSession(snapshot, other, "10:00", "11:00")] },
    { type: "block", block: {
      id: crypto.randomUUID(), title: `Fictional destination meeting ${offset}`, kind: "meeting",
      start: localDateTime(target, "09:00", snapshot.settings.timeZone),
      end: localDateTime(target, options.fullTarget ? "17:00" : "11:00", snapshot.settings.timeZone),
    } },
  ];
  const proposal = await preview(page.request, commands);
  expect(proposal.status, JSON.stringify(proposal.conflicts)).toBe("ready");
  const saved = await commit(page.request, proposal);
  const client = saved.clients.find(client => client.id === item.clientId)!.name;
  return { saved, source, target, item, sessions, title, client };
}
type Fixture = Awaited<ReturnType<typeof seed>>;

async function showMonth(page: Page, fixture: Fixture) {
  await page.goto("/");
  if ((page.viewportSize()?.width ?? 1440) <= 760)
    await expect(page.getByRole("button", { name: "agenda", exact: true })).toHaveClass(/active/);
  await page.getByRole("button", { name: "month", exact: true }).click();
  const today = localDate(new Date().toISOString(), fixture.saved.settings.timeZone);
  const months = (Number(fixture.source.slice(0, 4)) - Number(today.slice(0, 4))) * 12
    + Number(fixture.source.slice(5, 7)) - Number(today.slice(5, 7));
  for (let index = 0; index < months; index++)
    await page.getByRole("button", { name: "Next period", exact: true }).click();
  await expect(day(page, fixture.source)).toBeVisible();
}

const day = (page: Page, date: string) => calendar(page).locator(`.day-cell[data-date="${date}"]`);
const ribbon = (page: Page, fixture: Fixture) => calendar(page).getByTitle(`${fixture.client} · ${fixture.title}`, { exact: true });
const booked = (page: Page, fixture: Fixture) => calendar(page).locator(`.ribbon-reserved[data-work-item-id="${fixture.item.id}"][data-booking-date="${fixture.source}"]`);
const handle = (page: Page, fixture: Fixture) => calendar(page).getByRole("button", {
  name: `Move ${fixture.client} · ${fixture.title} on ${shortDate(fixture.source)}`, exact: true,
});

async function drag(page: Page, fixture: Fixture) {
  await expect(booked(page, fixture)).toHaveAttribute("draggable", "true");
  await day(page, fixture.target).scrollIntoViewIfNeeded();
  const destination = await day(page, fixture.target).boundingBox();
  expect(destination).not.toBeNull();
  await booked(page, fixture).hover();
  await page.mouse.down();
  // Cross-week drops need actual movement through dragenter and dragover before
  // releasing. A single jump can enter the new week without accepting the drop.
  await page.mouse.move(destination!.x + 12, destination!.y + 12, { steps: 12 });
  await page.mouse.move(destination!.x + 14, destination!.y + 14);
  await page.mouse.up();
  const dialog = moveDialog(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Confirm move", exact: true })).toBeEnabled();
  return dialog;
}

async function confirm(page: Page, dialog: Locator) {
  const response = page.waitForResponse(response => response.url() === `${origin}/api/commands` && response.request().postDataJSON()?.action === "commit");
  await dialog.getByRole("button", { name: "Confirm move", exact: true }).click();
  const committed = await response;
  expect(committed.ok(), await committed.text()).toBe(true);
  await expect(dialog).toHaveCount(0);
  await expect(moveCard(page).getByRole("button", { name: "Undo last move", exact: true })).toBeEnabled();
  return state(page.request);
}

function expectMoved(fixture: Fixture, saved: AppState) {
  expect(saved.sessions.map(session => session.id).sort()).toEqual(fixture.saved.sessions.map(session => session.id).sort());
  const moved = saved.sessions.filter(session => fixture.sessions.some(original => original.id === session.id));
  expect(moved).toHaveLength(2);
  expect(moved.map(session => localDate(session.start, saved.settings.timeZone))).toEqual([fixture.target, fixture.target]);
  expect(moved.map(session => minutesBetween(session.start, session.end))).toEqual([60, 60]);
  expect(moved.map(session => session.start)).toEqual([
    localDateTime(fixture.target, "11:00", saved.settings.timeZone),
    localDateTime(fixture.target, "12:30", saved.settings.timeZone),
  ]);
  expect(saved.sessions.filter(session => session.workItemId !== fixture.item.id)).toEqual(fixture.saved.sessions.filter(session => session.workItemId !== fixture.item.id));
  expect(saved.items.find(item => item.id === fixture.item.id)).toMatchObject({
    estimatedMinutes: 120, remainingMinutes: 120, minimumSessionMinutes: 60,
    windowStart: fixture.item.windowStart, windowEnd: fixture.item.windowEnd,
  });
  expect(saved.blocks).toEqual(fixture.saved.blocks);
}

test("desktop drag previews the whole booked day, cancel is read-only, confirm smart-fits and undo restores it", async ({ page }, info) => {
  const fixture = await seed(page, 340);
  await showMonth(page, fixture);
  await booked(page, fixture).scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath("desktop-booking-move-calendar.png") });
  // Faded timeline segments carry no drag authority, and ordinary clicks still
  // open the existing work details rather than initiating a booking move.
  await expect(ribbon(page, fixture).locator('.ribbon-span[draggable="true"]')).toHaveCount(0);
  await ribbon(page, fixture).first().click();
  const details = page.getByRole("dialog", { name: fixture.title, exact: true });
  await expect(details).toBeVisible();
  await details.getByRole("button", { name: "Close dialog", exact: true }).click();
  let dialog = await drag(page, fixture);
  expect(await state(page.request)).toEqual(fixture.saved);
  await dialog.screenshot({ path: info.outputPath("desktop-booking-move-preview.png") });
  await dialog.getByRole("button", { name: "Cancel move", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(await state(page.request)).toEqual(fixture.saved);
  dialog = await drag(page, fixture);
  const saved = await confirm(page, dialog);
  expectMoved(fixture, saved);
  const event = saved.events[0];
  expect(event.operationId).toMatch(/^calendar-move-/);
  expect(event.before).toEqual(schedule(fixture.saved));
  const request = page.waitForRequest(request => request.url() === `${origin}/api/undo` && request.method() === "POST");
  await moveCard(page).getByRole("button", { name: "Undo last move", exact: true }).click();
  expect((await request).postDataJSON()).toEqual({ id: event.id });
  await expect(moveCard(page)).toContainText("MOVE UNDONE");
  await expect(moveCard(page).getByRole("button", { name: "Undo last move", exact: true }).and(page.locator(":enabled"))).toHaveCount(0);
  const restored = await state(page.request);
  expect(schedule(restored)).toEqual(schedule(fixture.saved));
  expect(restored.events.find(entry => entry.id === event.id)?.undoneBy).toBeTruthy();
  // Repeating the same deliberate action after Undo is a new transaction, not
  // an idempotent replay of the first successful move.
  const repeated = await confirm(page, await drag(page, fixture));
  expectMoved(fixture, repeated);
  expect(repeated.version).toBe(restored.version + 1);
  expect(repeated.events[0].operationId).toMatch(/^calendar-move-/);
  expect(repeated.events[0].operationId).not.toBe(event.operationId);
  expect(repeated.events[0].id).not.toBe(event.id);
});

test("keyboard handles coexist with Select dates and move to a selected day only after preview", async ({ page }) => {
  const fixture = await seed(page, 352);
  await showMonth(page, fixture);
  await page.getByRole("button", { name: "Select dates", exact: true }).click();
  await expect(handle(page, fixture).and(page.locator(":enabled"))).toHaveCount(0);
  await expect(booked(page, fixture)).not.toHaveAttribute("draggable", "true");
  await day(page, fixture.source).click();
  await expect(day(page, fixture.source)).toHaveAttribute("aria-pressed", "true");
  await expect(moveDialog(page)).toHaveCount(0);
  expect(await state(page.request)).toEqual(fixture.saved);
  await page.getByRole("button", { name: "Cancel selection", exact: true }).click();
  await handle(page, fixture).focus();
  await page.keyboard.press("Enter");
  await day(page, fixture.target).focus();
  await page.keyboard.press("Enter");
  const dialog = moveDialog(page);
  await expect(dialog.getByRole("button", { name: "Confirm move", exact: true })).toBeEnabled();
  expect(await state(page.request)).toEqual(fixture.saved);
  expectMoved(fixture, await confirm(page, dialog));
});

test.describe("touch month booking controls", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  test("touch selects a booked day and destination without a drag gesture", async ({ page }, info) => {
    const fixture = await seed(page, 364);
    await showMonth(page, fixture);
    await booked(page, fixture).scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath("mobile-booking-move-calendar.png") });
    await handle(page, fixture).tap();
    await day(page, fixture.target).tap();
    const dialog = moveDialog(page);
    await expect(dialog.getByRole("button", { name: "Confirm move", exact: true })).toBeEnabled();
    expect(await state(page.request)).toEqual(fixture.saved);
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await page.screenshot({ path: info.outputPath("mobile-booking-move-preview.png") });
    await dialog.getByRole("button", { name: "Confirm move", exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath("mobile-booking-move-preview-controls.png") });
    expectMoved(fixture, await confirm(page, dialog));
  });
});

test("an unavailable destination cannot partially move either source session", async ({ page }) => {
  const fixture = await seed(page, 376, { fullTarget: true });
  await showMonth(page, fixture);
  await handle(page, fixture).click();
  // Destination-picking mode lets the whole day receive this click, even when
  // a faded project ribbon occupies its center.
  await day(page, fixture.target).click();
  const dialog = moveDialog(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("alert")).toContainText(/cannot|can't|available|fit|opening/i);
  await expect(dialog.getByRole("button", { name: "Confirm move", exact: true }).and(page.locator(":enabled"))).toHaveCount(0);
  expect(await state(page.request)).toEqual(fixture.saved);
  await dialog.getByRole("button", { name: "Cancel move", exact: true }).click();
  expect(await state(page.request)).toEqual(fixture.saved);
});

test("one protected session prevents dragging or picking a destination for its whole booked day", async ({ page }) => {
  const fixture = await seed(page, 388, { protectedSource: true });
  await showMonth(page, fixture);
  await expect(booked(page, fixture)).not.toHaveAttribute("draggable", "true");
  await expect(handle(page, fixture).and(page.locator(":enabled"))).toHaveCount(0);
  // A nonmovable block must still open details across its full clickable area.
  await booked(page, fixture).click();
  await expect(page.getByRole("dialog", { name: fixture.title, exact: true })).toBeVisible();
  expect(await state(page.request)).toEqual(fixture.saved);
});

test("unfinished planned bookings keep their move controls after the scheduled day ends", async ({ page }) => {
  const fixture = await seed(page, 400);
  await showMonth(page, fixture);
  // Advance only the browser clock after hydration. The real server fixture is
  // still upcoming; fixed-clock missed-booking tests also exercise the planner.
  await page.clock.setFixedTime(new Date(localDateTime(fixture.source, "18:38", fixture.saved.settings.timeZone)));
  await page.getByRole("button", { name: "agenda", exact: true }).click();
  await page.getByRole("button", { name: "month", exact: true }).click();
  await expect(booked(page, fixture)).toBeVisible();
  await expect(booked(page, fixture)).toHaveAttribute("draggable", "true");
  await expect(handle(page, fixture)).toBeEnabled();
  expect(await state(page.request)).toEqual(fixture.saved);
});

test("requesters can open details but receive no month booking move controls", async ({ page }) => {
  const fixture = await seed(page, 412);
  await asActor(page.request, "kyle");
  await showMonth(page, fixture);
  await expect(booked(page, fixture)).not.toHaveAttribute("draggable", "true");
  await expect(handle(page, fixture)).toHaveCount(0);
  await ribbon(page, fixture).first().click();
  await expect(page.getByRole("dialog", { name: fixture.title, exact: true })).toBeVisible();
  expect(schedule(await state(page.request))).toEqual(schedule(fixture.saved));
});

test("a stale move preview cannot overwrite a newer unrelated booking", async ({ page }) => {
  const fixture = await seed(page, 424);
  await showMonth(page, fixture);
  const dialog = await drag(page, fixture);
  const unrelatedDate = nextWorkDate(addDays(fixture.target, 3), fixture.saved.settings);
  const unrelated = makeItem(fixture.saved, "Fictional newer month booking", {
    windowStart: unrelatedDate, windowEnd: unrelatedDate, estimatedMinutes: 60, remainingMinutes: 60,
  });
  const newer = await commit(page.request, await preview(page.request, [{ type: "create", item: unrelated, sessions: [exactSession(fixture.saved, unrelated, "14:00", "15:00")] }]));
  const rejected = page.waitForResponse(response => response.url() === `${origin}/api/commands` && response.request().postDataJSON()?.action === "commit");
  await dialog.getByRole("button", { name: "Confirm move", exact: true }).click();
  const response = await rejected;
  expect(response.status()).toBe(409);
  expect((await response.json()).proposal.baseVersion).toBe(newer.version);
  await expect(dialog.getByRole("alert")).toContainText(/changed|review/i);
  // The server returns a fresh preview for renewed review, never auto-commits it.
  await expect(dialog.getByRole("button", { name: "Confirm move", exact: true })).toBeEnabled();
  expect(await state(page.request)).toEqual(newer);
  await dialog.getByRole("button", { name: "Cancel move", exact: true }).click();
  expect(await state(page.request)).toEqual(newer);
});

test("a lost successful commit is found by operation ID without sending another move", async ({ page }) => {
  const fixture = await seed(page, 436);
  await showMonth(page, fixture);
  const dialog = await drag(page, fixture);
  const operations: string[] = [];
  await page.route(`${origin}/api/commands`, async route => {
    const body = route.request().postDataJSON();
    if (body.action !== "commit") return route.continue();
    expect(body.commands).toEqual([{ type: "move_bookings", sessionIds: fixture.sessions.map(session => session.id), date: fixture.target }]);
    operations.push(body.operationId);
    const response = await route.fetch({ maxRetries: 0 });
    expect(response.ok(), await response.text()).toBe(true);
    await route.abort("failed");
  });
  const refreshed = page.waitForResponse(response => response.url() === `${origin}/api/state` && response.request().method() === "GET");
  await dialog.getByRole("button", { name: "Confirm move", exact: true }).click();
  await refreshed;
  await expect(dialog).toHaveCount(0);
  await expect(moveCard(page).getByRole("button", { name: "Undo last move", exact: true })).toBeEnabled();
  const saved = await state(page.request);
  expectMoved(fixture, saved);
  expect(operations).toHaveLength(1);
  expect(saved.events.filter(event => event.operationId === operations[0])).toHaveLength(1);
  expect(saved.version).toBe(fixture.saved.version + 1);
  await page.reload();
  await expect(moveCard(page).getByRole("button", { name: "Undo last move", exact: true })).toBeEnabled();
  expect(operations).toHaveLength(1);
});

test("the date-input fallback rejects the same day, cancels with Escape, and previews a move into next month", async ({ page }) => {
  const fixture = await seed(page, 448, { nextMonthTarget: true });
  expect(fixture.target.slice(0, 7)).not.toBe(fixture.source.slice(0, 7));
  await showMonth(page, fixture);
  const requests: unknown[] = [];
  page.on("request", request => {
    if (request.url() === `${origin}/api/commands` && request.method() === "POST") requests.push(request.postDataJSON());
  });
  const picker = page.getByRole("region", { name: "Choose a day for booked hours", exact: true });
  await handle(page, fixture).click();
  await expect(picker).toBeFocused();
  await picker.getByLabel("Move booking to date", { exact: true }).fill(fixture.source);
  await picker.getByRole("button", { name: "Preview move", exact: true }).click();
  await expect(page.locator(".calendar-booking-drag-status")).toContainText("already on that day");
  await expect(moveDialog(page)).toHaveCount(0);
  expect(requests).toHaveLength(0);
  expect(await state(page.request)).toEqual(fixture.saved);
  await page.keyboard.press("Escape");
  await expect(picker).toHaveCount(0);
  await expect(page.locator(".calendar-booking-drag-status")).toContainText("Move cancelled");
  expect(requests).toHaveLength(0);
  expect(await state(page.request)).toEqual(fixture.saved);

  await handle(page, fixture).click();
  await picker.getByLabel("Move booking to date", { exact: true }).fill(fixture.target);
  await picker.getByRole("button", { name: "Preview move", exact: true }).click();
  const dialog = moveDialog(page);
  await expect(dialog.getByRole("button", { name: "Confirm move", exact: true })).toBeEnabled();
  expect(requests).toHaveLength(1);
  expect(await state(page.request)).toEqual(fixture.saved);
  expectMoved(fixture, await confirm(page, dialog));
});

test("an uncertain saved move blocks new moves after closing until a read-only status check recovers it", async ({ page }) => {
  const fixture = await seed(page, 460);
  await showMonth(page, fixture);
  const dialog = await drag(page, fixture);
  const operations: string[] = [];
  let unavailable = false, unavailableReads = 0;
  await page.route(`${origin}/api/state`, async route => {
    if (!unavailable) return route.continue();
    unavailableReads++;
    await route.abort("failed");
  });
  await page.route(`${origin}/api/commands`, async route => {
    const body = route.request().postDataJSON();
    if (body.action !== "commit") return route.continue();
    expect(body.commands).toEqual([{ type: "move_bookings", sessionIds: fixture.sessions.map(session => session.id), date: fixture.target }]);
    operations.push(body.operationId);
    const response = await route.fetch({ maxRetries: 0 });
    expect(response.ok(), await response.text()).toBe(true);
    unavailable = true;
    await route.abort("failed");
  });
  await dialog.getByRole("button", { name: "Confirm move", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("connection interrupted saving");
  await expect(dialog.getByRole("button", { name: "Check move status", exact: true })).toBeEnabled();
  await expect(dialog.getByRole("button", { name: "Confirm move", exact: true })).toHaveCount(0);
  expect(unavailableReads).toBe(1);
  expect(operations).toHaveLength(1);
  await dialog.getByRole("button", { name: "Cancel move", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const check = moveCard(page).getByRole("button", { name: "Check move status", exact: true });
  await expect(check).toBeEnabled();
  await expect(booked(page, fixture)).not.toHaveAttribute("draggable", "true");
  await expect(handle(page, fixture)).toHaveCount(0);
  // Another failed check stays read-only and does not release the interaction lock.
  await check.click();
  await expect(moveCard(page).getByRole("alert")).toContainText("schedule is still unreachable");
  expect(unavailableReads).toBe(2);
  expect(operations).toHaveLength(1);
  await expect(handle(page, fixture)).toHaveCount(0);

  unavailable = false;
  await check.click();
  await expect(check).toHaveCount(0);
  await expect(moveCard(page).getByRole("button", { name: "Undo last move", exact: true })).toBeEnabled();
  const saved = await state(page.request);
  expectMoved(fixture, saved);
  expect(operations).toHaveLength(1);
  expect(saved.events.filter(event => event.operationId === operations[0])).toHaveLength(1);
  expect(saved.version).toBe(fixture.saved.version + 1);
  await expect(booked(page, { ...fixture, source: fixture.target })).toHaveAttribute("draggable", "true");
});
