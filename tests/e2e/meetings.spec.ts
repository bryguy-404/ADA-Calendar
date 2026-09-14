import { expect, test, type Locator, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { dayCapacity, validateSchedule } from "../../src/lib/scheduler";
import { addDays, localDate, localDateTime, minutesBetween, nextWorkDate } from "../../src/lib/time";
import type { AppState, UnavailableBlock, WorkCommand } from "../../src/lib/types";
import { formatHours } from "../../src/lib/work";
import { asActor, commit, exactSession, futureDate, makeItem, origin, post, preview, state } from "./helpers";

// These flows use the dedicated .data-e2e demo workspace and its actual reviewed
// command API. Provider credentials are empty and all notification mail is captured.
test.beforeEach(async ({ page, baseURL }) => {
  expect(baseURL).toBe(origin);
  await asActor(page.request, "bryan");
  expect((await state(page.request)).mode).toBe("demo");
  for (const routeName of ["assistant", "workspace-chat", "transcribe"]) {
    await page.route(`${origin}/api/${routeName}`, async route => {
      await route.abort();
      throw new Error(`Manual meeting entry must not call /api/${routeName}.`);
    });
  }
});

const month = (page: Page) => page.getByLabel("Month workload calendar", { exact: true });
const day = (page: Page, date: string) => month(page).locator(`.day-cell[data-date="${date}"]`);
const details = (page: Page) => page.getByRole("dialog", { name: "Meeting details", exact: true });
const schedule = ({ version, settings, items, sessions, blocks, events, notifications }: AppState) => ({ version, settings, items, sessions, blocks, events, notifications });

function emptyFutureDay(snapshot: AppState, offset = 280) {
  let date = futureDate(snapshot, offset);
  for (let attempt = 0; attempt < 366; attempt++) {
    const occupied = snapshot.sessions.some(session => session.status === "planned" && localDate(session.start, snapshot.settings.timeZone) === date)
      || snapshot.blocks.some(block => localDate(block.start, snapshot.settings.timeZone) <= date && localDate(block.end, snapshot.settings.timeZone) >= date);
    if (!occupied) return date;
    date = nextWorkDate(addDays(date, 1), snapshot.settings);
  }
  throw new Error("The isolated demo has no empty future workday for the meeting scenario.");
}

async function showDate(page: Page, snapshot: AppState, date: string, width = 1440) {
  await page.setViewportSize({ width, height: 1000 });
  // Make this fixture's date today in the browser; Day always opens today.
  await page.clock.setFixedTime(new Date(localDateTime(date, "09:00", snapshot.settings.timeZone)));
  await page.goto("/");
  if (width <= 760) await expect(page.getByRole("button", { name: "agenda", exact: true })).toHaveClass(/active/);
  // Initial rendering uses the server date; navigate to the simulated date.
  await page.getByRole("button", { name: "Today", exact: true }).click();
  await page.getByRole("button", { name: "month", exact: true }).click();
  await expect(day(page, date)).toBeVisible();
  await page.getByRole("button", { name: "day", exact: true }).click();
  await expect(page.getByRole("button", { name: "day", exact: true })).toHaveClass(/active/);
}

async function fillMeeting(form: Locator, date: string, title: string, kind: "meeting" | "time_off" = "meeting") {
  await form.getByLabel(/^Meeting title/).fill(title);
  await form.getByRole("combobox", { name: "Type", exact: true }).selectOption(kind);
  await form.getByLabel("Date", { exact: true }).fill(date);
  await form.getByLabel("Start time", { exact: true }).fill("09:00");
  await form.getByLabel("End time", { exact: true }).fill("10:00");
}

async function savedBlock(page: Page, title: string) {
  const saved = await state(page.request);
  const block = saved.blocks.find(candidate => candidate.title === title);
  expect(block).toBeDefined();
  return { saved, block: block! };
}

async function seedMeeting(page: Page, offset: number, title: string) {
  const before = await state(page.request), date = emptyFutureDay(before, offset);
  const block: UnavailableBlock = {
    id: crypto.randomUUID(), title, kind: "meeting",
    start: localDateTime(date, "09:00", before.settings.timeZone),
    end: localDateTime(date, "10:00", before.settings.timeZone),
  };
  const proposal = await preview(page.request, [{ type: "block", block }]);
  expect(proposal.status, JSON.stringify(proposal.conflicts)).toBe("ready");
  return { before, date, block, saved: await commit(page.request, proposal) };
}

function blockInView(page: Page, view: "month" | "agenda" | "week" | "day", blockId: string) {
  const container = view === "month" ? month(page) : page.locator(view === "agenda" ? ".agenda" : ".timed-calendar");
  return container.locator(`[data-block-id="${blockId}"]`);
}

async function closeDetails(page: Page) {
  await details(page).getByRole("button", { name: "Close dialog", exact: true }).click();
  await expect(details(page)).toHaveCount(0);
}

test("a reviewed client meeting reduces capacity and new smart-fit work uses the remaining hours", async ({ page }, info) => {
  const before = await state(page.request), date = emptyFutureDay(before);
  const title = "Fictional Cedar client planning meeting";
  await showDate(page, before, date);
  await page.getByRole("button", { name: "Add meeting", exact: true }).click();
  const form = page.getByRole("dialog", { name: "Add meeting", exact: true });
  await expect(form.getByLabel("Date", { exact: true })).toHaveValue(date);
  await fillMeeting(form, date, title);
  await form.getByRole("button", { name: "Preview meeting", exact: true }).click();
  await expect(form.getByRole("button", { name: "Confirm meeting", exact: true })).toBeVisible();
  expect(schedule(await state(page.request))).toEqual(schedule(before));
  await form.screenshot({ path: info.outputPath("meeting-preview-desktop.png") });
  await form.getByRole("button", { name: "Confirm meeting", exact: true }).click();
  await expect(form).toHaveCount(0);
  const { saved, block } = await savedBlock(page, title);
  expect(block).toMatchObject({ kind: "meeting", start: localDateTime(date, "09:00", before.settings.timeZone), end: localDateTime(date, "10:00", before.settings.timeZone) });
  expect(saved.settings).toEqual(before.settings);
  expect(saved.items).toEqual(before.items);
  expect(saved.sessions).toEqual(before.sessions);
  expect(dayCapacity(saved, date).availableMinutes).toBe(dayCapacity(before, date).availableMinutes - 60);
  await page.getByRole("button", { name: "month", exact: true }).click();
  await expect(day(page, date).locator(".day-capacity strong")).toHaveText(formatHours(dayCapacity(saved, date).availableMinutes));
  await expect(blockInView(page, "month", block.id)).toContainText(title);
  await month(page).screenshot({ path: info.outputPath("meeting-capacity-desktop.png") });

  await page.getByRole("button", { name: "Add work", exact: true }).click();
  const work = page.getByRole("dialog", { name: "Make room for new work", exact: true });
  await work.getByRole("combobox", { name: "Client", exact: true }).selectOption("higher-ground");
  await work.getByLabel("What needs doing?", { exact: true }).fill("Fictional work around the client meeting");
  await work.getByLabel("Work day", { exact: true }).fill(date);
  await work.getByLabel("Hours to book", { exact: true }).fill("2");
  await work.getByRole("button", { name: "Review changes", exact: true }).click();
  await expect(work.getByRole("heading", { name: "This fits your schedule", exact: true })).toBeVisible();
  expect(schedule(await state(page.request))).toEqual(schedule(saved));
  await work.getByRole("button", { name: "Confirm changes", exact: true }).click();
  await expect(work).toHaveCount(0);
  const booked = await state(page.request);
  const item = booked.items.find(candidate => candidate.title === "Fictional work around the client meeting")!;
  expect(item).toBeDefined();
  const sessions = booked.sessions.filter(session => session.workItemId === item.id && session.status === "planned");
  expect(sessions.reduce((sum, session) => sum + minutesBetween(session.start, session.end), 0)).toBe(120);
  expect(sessions.every(session => localDate(session.start, booked.settings.timeZone) === date)).toBe(true);
  expect(sessions.every(session => session.start >= block.end || session.end <= block.start)).toBe(true);
  expect(sessions[0].start).toBe(localDateTime(date, "10:00", booked.settings.timeZone));
  expect(booked.blocks).toEqual(saved.blocks);
  expect(booked.sessions.filter(session => session.workItemId !== item.id)).toEqual(saved.sessions);
  expect(dayCapacity(booked, date).availableMinutes).toBe(dayCapacity(saved, date).availableMinutes - 120);
  expect(validateSchedule(booked)).toEqual([]);
  expect(booked.notifications.filter(notification => !before.notifications.some(old => old.id === notification.id)).every(notification => notification.status === "captured")).toBe(true);
});

test("meetings open from every calendar view and editing or removing them requires review", async ({ page }, info) => {
  const fixture = await seedMeeting(page, 294, "Fictional Maple client review");
  await showDate(page, fixture.saved, fixture.date);
  for (const view of ["month", "agenda", "week", "day"] as const) {
    await page.getByRole("button", { name: view, exact: true }).click();
    const meeting = blockInView(page, view, fixture.block.id);
    await expect(meeting).toBeVisible();
    await expect(meeting).toContainText(fixture.block.title);
    await expect(meeting).toHaveAccessibleName(/^Meeting:/);
    await meeting.click();
    await expect(details(page)).toBeVisible();
    await expect(details(page).getByLabel(/^Meeting title/)).toHaveValue(fixture.block.title);
    await closeDetails(page);
  }
  expect(schedule(await state(page.request))).toEqual(schedule(fixture.saved));
  await blockInView(page, "day", fixture.block.id).click();
  const form = details(page), title = "Fictional Maple revised client review";
  await form.getByLabel(/^Meeting title/).fill(title);
  await form.getByLabel("End time", { exact: true }).fill("09:30");
  await form.getByRole("button", { name: "Preview changes", exact: true }).click();
  await expect(form.getByRole("button", { name: "Confirm changes", exact: true })).toBeVisible();
  expect(schedule(await state(page.request))).toEqual(schedule(fixture.saved));
  await form.getByRole("button", { name: "Confirm changes", exact: true }).click();
  await expect(form).toHaveCount(0);
  const { saved, block } = await savedBlock(page, title);
  expect(block).toMatchObject({ id: fixture.block.id, end: localDateTime(fixture.date, "09:30", saved.settings.timeZone) });
  expect(dayCapacity(saved, fixture.date).availableMinutes).toBe(dayCapacity(fixture.saved, fixture.date).availableMinutes + 30);
  await page.getByRole("button", { name: "agenda", exact: true }).click();
  await expect(blockInView(page, "agenda", block.id)).toContainText(title);
  await blockInView(page, "agenda", block.id).click();
  await form.getByRole("button", { name: "Remove meeting", exact: true }).click();
  await expect(form.getByRole("button", { name: "Confirm removal", exact: true })).toBeVisible();
  expect(schedule(await state(page.request))).toEqual(schedule(saved));
  await form.screenshot({ path: info.outputPath("meeting-removal-review.png") });
  await form.getByRole("button", { name: "Confirm removal", exact: true }).click();
  await expect(form).toHaveCount(0);
  const removed = await state(page.request);
  expect(removed.blocks).toEqual(fixture.before.blocks);
  expect(removed.items).toEqual(fixture.before.items);
  expect(removed.sessions).toEqual(fixture.before.sessions);
  expect(removed.settings).toEqual(fixture.before.settings);
  expect(dayCapacity(removed, fixture.date)).toEqual(dayCapacity(fixture.before, fixture.date));
  await expect(blockInView(page, "agenda", block.id)).toHaveCount(0);
});

test("meeting controls and time-off reservations work at 390px without horizontal overflow", async ({ page }, info) => {
  const before = await state(page.request), date = emptyFutureDay(before, 308);
  await showDate(page, before, date, 390);
  const add = page.getByRole("button", { name: "Add meeting", exact: true });
  await expect(add).toBeVisible();
  await add.click();
  const form = page.getByRole("dialog", { name: "Add meeting", exact: true });
  await fillMeeting(form, date, "Fictional personal appointment", "time_off");
  await form.getByRole("button", { name: "Preview meeting", exact: true }).click();
  await expect(form.getByRole("button", { name: "Confirm meeting", exact: true })).toBeVisible();
  expect(schedule(await state(page.request))).toEqual(schedule(before));
  expect(await form.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  expect((await new AxeBuilder({ page }).include('[role="dialog"]').withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze()).violations).toEqual([]);
  await form.screenshot({ path: info.outputPath("meeting-time-off-preview-mobile.png") });
  await form.getByRole("button", { name: "Confirm meeting", exact: true }).click();
  await expect(form).toHaveCount(0);
  const { saved, block } = await savedBlock(page, "Fictional personal appointment");
  expect(block.kind).toBe("time_off");
  expect(saved.settings).toEqual(before.settings);
  expect(dayCapacity(saved, date).availableMinutes).toBe(dayCapacity(before, date).availableMinutes - 60);
  await page.getByRole("button", { name: "agenda", exact: true }).click();
  await expect(blockInView(page, "agenda", block.id)).toBeVisible();
  await expect(blockInView(page, "agenda", block.id)).toContainText("Time off");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("meeting-agenda-mobile.png"), fullPage: true });
  await page.getByRole("button", { name: "month", exact: true }).click();
  await expect(blockInView(page, "month", block.id)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await month(page).screenshot({ path: info.outputPath("meeting-month-mobile.png") });
});

test("editing a preview or cancelling saves nothing, and a stale editor cannot recreate a deleted meeting", async ({ page }) => {
  const fixture = await seedMeeting(page, 350, "Fictional meeting cancellation and stale edit");
  await showDate(page, fixture.saved, fixture.date);
  await blockInView(page, "day", fixture.block.id).click();
  const form = details(page);
  await form.getByLabel("End time", { exact: true }).fill("09:30");
  await form.getByRole("button", { name: "Preview changes", exact: true }).click();
  await expect(form.getByRole("button", { name: "Confirm changes", exact: true })).toBeVisible();
  await form.getByLabel("End time", { exact: true }).fill("09:45");
  await expect(form.getByRole("button", { name: "Confirm changes", exact: true })).toHaveCount(0);
  await expect(form.getByLabel("Meeting preview", { exact: true })).toHaveCount(0);
  expect(schedule(await state(page.request))).toEqual(schedule(fixture.saved));
  await form.getByRole("button", { name: "Preview changes", exact: true }).click();
  await expect(form.getByRole("button", { name: "Confirm changes", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(form).toHaveCount(0);
  expect(schedule(await state(page.request))).toEqual(schedule(fixture.saved));

  await blockInView(page, "day", fixture.block.id).click();
  await expect(form.getByLabel("End time", { exact: true })).toHaveValue("10:00");
  await form.getByLabel(/^Meeting title/).fill("Fictional stale meeting edit");
  await form.getByRole("button", { name: "Preview changes", exact: true }).click();
  await expect(form.getByRole("button", { name: "Confirm changes", exact: true })).toBeVisible();
  // Another owner session removes the record while this reviewed form stays open.
  const removed = await commit(page.request, await preview(page.request, [{ type: "block", block: fixture.block, remove: true }]));
  await form.getByRole("button", { name: "Confirm changes", exact: true }).click();
  await expect(form.getByRole("button", { name: "Confirm changes", exact: true })).toHaveCount(0);
  expect(schedule(await state(page.request))).toEqual(schedule(removed));
  await form.getByRole("button", { name: "Preview changes", exact: true }).click();
  await expect(form.getByRole("alert")).toContainText(/no longer exists|removed/i);
  await expect(form.getByRole("button", { name: "Confirm changes", exact: true })).toHaveCount(0);
  expect(schedule(await state(page.request))).toEqual(schedule(removed));
  expect(removed.blocks.some(block => block.id === fixture.block.id)).toBe(false);
});

test("moving protected work for a meeting requires an explicit override and a reviewed before-and-after plan", async ({ page }, info) => {
  const before = await state(page.request), date = emptyFutureDay(before, 357);
  const protectedWork = makeItem(before, "Fictional protected client delivery", {
    windowStart: date, windowEnd: date, estimatedMinutes: 120, remainingMinutes: 120,
    // This delivery is explicitly unavailable before this day; display dates
    // alone no longer impose that restriction during an approved replan.
    dateConstraints: { earliestStart: date, allowedDates: [] },
  });
  const protectedSession = { ...exactSession(before, protectedWork, "09:00", "11:00"), protected: true };
  const otherWork = makeItem(before, "Fictional unchanged afternoon work", {
    windowStart: date, windowEnd: date, estimatedMinutes: 60, remainingMinutes: 60,
  });
  const otherSession = exactSession(before, otherWork, "14:00", "15:00");
  const seeded = await commit(page.request, await preview(page.request, [
    { type: "create", item: protectedWork, sessions: [protectedSession] },
    { type: "create", item: otherWork, sessions: [otherSession] },
  ]));
  await showDate(page, seeded, date);
  await page.getByRole("button", { name: "Add meeting", exact: true }).click();
  const form = page.getByRole("dialog", { name: "Add meeting", exact: true });
  await fillMeeting(form, date, "Fictional client meeting with protected conflict");
  await form.getByRole("button", { name: "Preview meeting", exact: true }).click();
  await expect(form.getByRole("alert")).toContainText(/protected session/i);
  await expect(form.getByRole("button", { name: "Confirm meeting", exact: true })).toHaveCount(0);
  expect(schedule(await state(page.request))).toEqual(schedule(seeded));
  await form.getByLabel(/^Allow this meeting to move overlapping protected work/).check();
  await expect(form.getByRole("button", { name: "Confirm meeting", exact: true })).toHaveCount(0);
  await form.getByRole("button", { name: "Preview meeting", exact: true }).click();
  await expect(form.getByRole("button", { name: "Confirm meeting", exact: true })).toBeVisible();
  const changes = form.locator(".meeting-work-changes");
  await expect(changes).toContainText(protectedWork.title);
  await expect(changes).toContainText("Before:");
  await expect(changes).toContainText("9:00 AM–11:00 AM");
  await expect(changes).toContainText("After:");
  await expect(changes).toContainText("10:00 AM–12:00 PM");
  await expect(changes).not.toContainText(otherWork.title);
  expect(schedule(await state(page.request))).toEqual(schedule(seeded));
  await form.screenshot({ path: info.outputPath("meeting-protected-work-review.png") });
  await form.getByRole("button", { name: "Confirm meeting", exact: true }).click();
  await expect(form).toHaveCount(0);
  const saved = await state(page.request);
  const moved = saved.sessions.filter(session => session.workItemId === protectedWork.id && session.status === "planned");
  expect(moved).toHaveLength(1);
  expect(moved[0]).toMatchObject({ protected: true, start: localDateTime(date, "10:00", saved.settings.timeZone), end: localDateTime(date, "12:00", saved.settings.timeZone) });
  expect(saved.sessions.filter(session => session.workItemId !== protectedWork.id)).toEqual(seeded.sessions.filter(session => session.workItemId !== protectedWork.id));
  expect(saved.items.find(item => item.id === protectedWork.id)).toMatchObject({ estimatedMinutes: 120, remainingMinutes: 120 });
  expect(saved.settings).toEqual(seeded.settings);
  expect(validateSchedule(saved)).toEqual([]);
});

for (const actor of ["kyle", "viewer"] as const) test(`${actor} can see meetings but cannot add, edit, or remove them`, async ({ page }) => {
  const fixture = await seedMeeting(page, actor === "kyle" ? 322 : 336, `Fictional ${actor} read-only meeting`);
  await asActor(page.request, actor);
  await showDate(page, await state(page.request), fixture.date);
  await expect(page.getByRole("button", { name: "Add meeting", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "agenda", exact: true }).click();
  await blockInView(page, "agenda", fixture.block.id).click();
  await expect(details(page)).toBeVisible();
  await expect(details(page).getByRole("button", { name: "Preview changes", exact: true })).toHaveCount(0);
  await expect(details(page).getByRole("button", { name: "Remove meeting", exact: true })).toHaveCount(0);
  const commands: WorkCommand[] = [
    { type: "block", block: { ...fixture.block, id: crypto.randomUUID(), title: "Unauthorized meeting creation" } },
    { type: "block", block: { ...fixture.block, title: "Unauthorized meeting edit" } },
    { type: "block", block: fixture.block, remove: true },
  ];
  for (const command of commands) {
    const operationId = crypto.randomUUID();
    const response = await post(page.request, "commands", { commands: [command], operationId, action: "preview" });
    if (actor === "viewer") {
      expect(response.status()).toBe(403);
      const denied = await post(page.request, "commands", { commands: [command], operationId, action: "commit" });
      expect(denied.status()).toBe(403);
    } else {
      expect(response.ok(), await response.text()).toBe(true);
      const { proposal } = await response.json();
      expect(proposal.status).toBe("infeasible");
      expect(proposal.conflicts).toEqual(expect.arrayContaining([expect.objectContaining({ code: "forbidden" })]));
      const denied = await post(page.request, "commands", { commands: proposal.commands, operationId: proposal.operationId, baseVersion: proposal.baseVersion, reviewFingerprint: proposal.reviewFingerprint, action: "commit" });
      expect(denied.ok()).toBe(false);
    }
  }
  await asActor(page.request, "bryan");
  expect(schedule(await state(page.request))).toEqual(schedule(fixture.saved));
});
