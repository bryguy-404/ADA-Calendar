import AxeBuilder from "@axe-core/playwright";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { addDays, localDate, minutesBetween, nextWorkDate } from "../../src/lib/time";
import { asActor, commit, exactSession, futureDate, makeItem, origin, post, preview, state } from "./helpers";

async function pendingDisplacement(request: APIRequestContext, title: string, days: number, multipleDays = false) {
  await asActor(request, "bryan");
  const before = await state(request);
  const date = futureDate(before, days);
  const dates = multipleDays ? [date, nextWorkDate(addDays(date, 1), before.settings)] : [date], endDate = dates.at(-1)!;
  const blocker = makeItem(before, `${title} existing commitment`, { windowStart: date, windowEnd: endDate, targetDate: endDate, estimatedMinutes: 390 * dates.length, remainingMinutes: 390 * dates.length });
  await commit(request, await preview(request, [{ type: "create", item: blocker, sessions: dates.flatMap(workDate => [exactSession(before, { ...blocker, windowStart: workDate }, "09:00", "12:00"), exactSession(before, { ...blocker, windowStart: workDate }, "12:30", "16:00")]) }]));
  await asActor(request, "william");
  const current = await state(request);
  const work = makeItem(current, title, { windowStart: date, windowEnd: endDate, targetDate: endDate, estimatedMinutes: 60, remainingMinutes: 60, requestedPriorityId: "high" });
  const proposal = await preview(request, [{ type: "create", item: work, bookingWindow: { startDate: date, endDate } }]);
  expect(proposal.status).toBe("approval_required");
  const submitted = await post(request, "commands", { commands: proposal.commands, operationId: proposal.operationId, baseVersion: proposal.baseVersion, reviewFingerprint: proposal.reviewFingerprint, action: "request" });
  expect(submitted.ok(), await submitted.text()).toBe(true);
  await asActor(request, "bryan");
  const pending = await state(request);
  const entry = pending.requests.find(entry => entry.proposal.commands.some(command => command.type === "create" && command.item.id === work.id))!;
  expect(entry.status).toBe("pending");
  return { blocker, work, entry, pending };
}

test("desktop opens the month view, explains spans, and supports keyboard dismissal", async ({ page }, testInfo) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Your plate, at a glance." })).toBeVisible();
  await expect(page.getByLabel("Month workload calendar")).toBeVisible();
  await expect(page.getByText("Project span · no time reserved", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Preview as")).toHaveValue("bryan");
  const add = page.getByRole("button", { name: "Add work", exact: true });
  await add.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect.soft(page.getByRole("dialog")).toHaveAccessibleName("Make room for new work", { timeout: 2000 });
  await expect(page.getByLabel("What needs doing?")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect.soft(add).toBeFocused({ timeout: 2000 });
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  await testInfo.attach("desktop-accessibility", { body: JSON.stringify(results.violations, null, 2), contentType: "application/json" });
  expect(results.violations).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("desktop-calendar.png"), fullPage: true });
});

test("manual owner entry previews before saving, then supports explicit project completion", async ({ page }) => {
  await page.goto("/");
  const before = await state(page.request);
  const date = futureDate(before, 35);
  await page.getByRole("button", { name: "Add work", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("combobox", { name: "Client", exact: true }).selectOption("higher-ground");
  await dialog.getByLabel("What needs doing?").fill("E2E manual thank-you edit");
  await dialog.getByLabel("Description", { exact: true }).fill("Verify manual effort, capacity preview, and completion.");
  await dialog.getByLabel("Hours to book", { exact: true }).fill("0.5");
  await dialog.getByLabel("Work day", { exact: true }).fill(date);
  await dialog.getByRole("button", { name: "Review changes" }).click();
  await expect(dialog.getByRole("heading", { name: "This fits your schedule" })).toBeVisible();
  expect((await state(page.request)).version).toBe(before.version);
  await dialog.getByRole("button", { name: "Confirm changes" }).click();
  await expect(dialog).toHaveCount(0);
  // Calendar move guidance has its own live status region; assert the save toast.
  await expect(page.locator(".toast")).toContainText("Saved locally");
  const saved = await state(page.request);
  const work = saved.items.find(item => item.title === "E2E manual thank-you edit")!;
  expect(work).toBeDefined();
  expect(work.remainingMinutes).toBe(30);
  await page.getByRole("button", { name: "All work", exact: true }).click();
  await page.getByLabel("Search work").fill(work.title);
  await page.getByRole("button", { name: /E2E manual thank-you edit/ }).click();
  const details = page.getByRole("dialog");
  await details.getByRole("button", { name: "Mark project complete" }).click();
  await expect(details.getByText("completed", { exact: true })).toBeVisible();
  expect((await state(page.request)).items.find(item => item.id === work.id)?.completedAt).not.toBeNull();
});

test("requester sees the shared plate with read-only details and can clean-fit book", async ({ page }) => {
  await page.goto("/");
  // Wait for a client-rendered section before changing the server-rendered,
  // controlled preview select; hydration can otherwise restore its old value.
  await page.getByRole("button", { name: "All work", exact: true }).click();
  await expect(page.getByLabel("Search work")).toBeVisible();
  await page.getByRole("button", { name: "Calendar", exact: true }).click();
  await page.getByLabel("Preview as").selectOption("william");
  await expect(page.getByRole("heading", { name: "Bryan’s plate, at a glance." })).toBeVisible();
  await page.goto("/?work=drive-software");
  const details = page.getByRole("dialog");
  await expect(details).toBeVisible();
  await expect(details.getByRole("button", { name: "Edit details" })).toHaveCount(0);
  await expect(details.getByRole("button", { name: "Mark project complete" })).toHaveCount(0);
  await details.getByRole("button", { name: "Close dialog" }).click();
  const before = await state(page.request);
  const date = futureDate(before, 42);
  await page.getByRole("button", { name: "Request work", exact: true }).click();
  const form = page.getByRole("dialog");
  await form.getByRole("combobox", { name: "Client", exact: true }).selectOption("higher-ground");
  await form.getByLabel("What needs doing?").fill("E2E William clean-fit request");
  await form.getByLabel("Hours to book", { exact: true }).fill("0.5");
  await form.getByLabel("Work day", { exact: true }).fill(date);
  await form.getByRole("combobox", { name: "Suggested priority", exact: true }).selectOption("high");
  await form.getByRole("button", { name: "Review changes" }).click();
  await form.getByRole("button", { name: "Book this work" }).click();
  await expect(form).toHaveCount(0);
  const after = await state(page.request);
  expect(after.items.find(item => item.title === "E2E William clean-fit request")).toMatchObject({ requesterId: "william", requestedPriorityId: "high", priorityId: "normal" });
});

test("protected work requires its explicit move checkbox", async ({ page }) => {
  await page.goto("/?work=drive-software");
  const before = await state(page.request);
  const dialog = page.getByRole("dialog");
  await dialog.locator("button.session-row").first().click();
  await expect(dialog.getByRole("button", { name: "Move session", exact: true })).toBeDisabled();
  await dialog.getByLabel("I authorize moving this protected session.", { exact: true }).check();
  await expect(dialog.getByRole("button", { name: "Move session", exact: true })).toBeEnabled();
  await dialog.getByLabel("I authorize moving this protected session.", { exact: true }).uncheck();
  await expect(dialog.getByRole("button", { name: "Move session", exact: true })).toBeDisabled();
  expect((await state(page.request)).version).toBe(before.version);
});

test("session completion remains distinct from project completion and reported effort", async ({ page }) => {
  await asActor(page.request, "bryan");
  const before = await state(page.request);
  const date = futureDate(before, 63);
  const work = makeItem(before, "E2E explicit session completion", { windowStart: date, windowEnd: date, estimatedMinutes: 120, remainingMinutes: 120 });
  const booked = await commit(page.request, await preview(page.request, [{ type: "create", item: work }]));
  const session = booked.sessions.find(session => session.workItemId === work.id && session.status === "planned")!;
  await page.goto(`/?work=${work.id}`);
  const dialog = page.getByRole("dialog");
  await dialog.locator("button.session-row").first().click();
  await dialog.getByRole("button", { name: "Mark session complete", exact: true }).click();
  await expect.poll(async () => (await state(page.request)).sessions.find(entry => entry.id === session.id)?.status).toBe("completed");
  const after = await state(page.request);
  expect(after.items.find(item => item.id === work.id)).toMatchObject({ status: "planned", remainingMinutes: 120, completedAt: null });
  expect(after.sessions.some(entry => entry.workItemId === work.id && entry.status === "planned")).toBe(true);
});

test("keyboard session controls move protected time only after the explicit owner override", async ({ page }) => {
  await asActor(page.request, "bryan");
  const before = await state(page.request);
  const date = futureDate(before, 91);
  const nextDate = futureDate(before, 94);
  const work = makeItem(before, "E2E protected keyboard move", { windowStart: date, windowEnd: date, estimatedMinutes: 120, remainingMinutes: 120 });
  const held = { ...exactSession(before, work, "09:00", "11:00"), protected: true };
  const booked = await commit(page.request, await preview(page.request, [{ type: "create", item: work, sessions: [held] }]));
  await page.goto(`/?work=${work.id}`);
  const dialog = page.getByRole("dialog");
  await dialog.locator("button.session-row").first().click();
  await dialog.getByLabel("Date", { exact: true }).fill(nextDate);
  await dialog.getByLabel("Start", { exact: true }).fill("14:00");
  await dialog.getByLabel("End", { exact: true }).fill("16:00");
  const move = dialog.getByRole("button", { name: "Move session", exact: true });
  await expect(move).toBeDisabled();
  expect((await state(page.request)).version).toBe(booked.version);
  await dialog.getByLabel("I authorize moving this protected session.", { exact: true }).check();
  await move.focus();
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await state(page.request)).version).toBe(booked.version + 1);
  const after = await state(page.request);
  const moved = after.sessions.find(session => session.id === held.id)!;
  expect(localDate(moved.start, after.settings.timeZone)).toBe(nextDate);
  expect(moved.protected).toBe(true);
  expect(after.items.find(item => item.id === work.id)?.remainingMinutes).toBe(120);
});

test("week and day views render exact working hours without client errors", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const snapshot = await state(page.request);
  const session = snapshot.sessions.find(session => session.workItemId === "laville-build" && session.status === "planned") ?? snapshot.sessions.find(session => session.status === "planned")!;
  await page.goto("/");
  const title = snapshot.items.find(item => item.id === session.workItemId)!.title;
  await page.getByRole("button", { name: "day", exact: true }).click();
  const date = localDate(session.start, snapshot.settings.timeZone);
  const today = localDate(new Date().toISOString(), snapshot.settings.timeZone);
  const direction = date < today ? -1 : 1;
  for (let current = today; current !== date; current = addDays(current, direction)) {
    await page.getByRole("button", { name: direction < 0 ? "Previous period" : "Next period", exact: true }).click();
  }
  await expect(page.locator(".timed-calendar").getByRole("grid")).toBeVisible();
  await expect(page.locator(".timed-calendar").getByText(new RegExp(title)).first()).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("day-calendar.png"), fullPage: true });
  await page.getByRole("button", { name: "week", exact: true }).click();
  await expect(page.locator(".timed-calendar")).toBeVisible();
  await expect(page.locator(".timed-calendar").getByRole("grid")).toBeVisible();
  await expect(page.locator(".timed-calendar").getByText("9am", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "day", exact: true }).click();
  await expect(page.locator(".timed-calendar")).toBeVisible();
  await expect(page.locator(".timed-calendar").getByRole("grid")).toBeVisible();
  expect(errors).toEqual([]);
});

test("owner reviews revised effort and priority before approving visible displacement", async ({ page }) => {
  const { blocker, work, entry, pending } = await pendingDisplacement(page.request, "E2E reviewed priority request", 70);
  await page.goto("/");
  await page.getByRole("navigation").getByRole("button", { name: /^Requests/ }).click();
  await page.locator("article.request-card").filter({ hasText: work.title }).getByRole("button", { name: "Review with current schedule" }).click();
  const dialog = page.getByRole("dialog", { name: "Review priority request" });
  const brief = "# Priority request brief\n\nPreserve this original when approved.\n";
  await dialog.getByLabel("Add supporting file").setInputFiles({ name: "priority-request.md", mimeType: "text/markdown", buffer: Buffer.from(brief) });
  await expect(dialog.getByText("priority-request.md", { exact: true })).toBeVisible();
  await dialog.getByLabel("Estimated work (hours)").fill("1.5");
  await dialog.getByRole("combobox", { name: "Approved priority", exact: true }).selectOption("normal");
  await dialog.getByRole("button", { name: "Preview revised plan" }).click();
  await expect(dialog.getByRole("heading", { name: "Review before approval" })).toBeVisible();
  await expect(dialog.locator("summary").filter({ hasText: blocker.title })).toBeVisible();
  await expect(dialog.getByText("Before", { exact: true }).first()).toBeVisible();
  await expect(dialog.getByText("After approval", { exact: true }).first()).toBeVisible();
  expect((await state(page.request)).version).toBe(pending.version);
  await dialog.getByRole("button", { name: "Approve this reviewed plan" }).click();
  await expect(dialog).toHaveCount(0);
  const after = await state(page.request);
  expect(after.requests.find(request => request.id === entry.id)?.status).toBe("approved");
  expect(after.items.find(item => item.id === work.id)).toMatchObject({ estimatedMinutes: 90, remainingMinutes: 90, requesterId: "william", priorityId: "normal", requestedPriorityId: "high" });
  const beforeBookings = pending.sessions.filter(session => session.workItemId === blocker.id && session.status === "planned");
  const afterBookings = after.sessions.filter(session => session.workItemId === blocker.id && session.status === "planned");
  expect(afterBookings.map(session => [session.start, session.end]).sort()).not.toEqual(beforeBookings.map(session => [session.start, session.end]).sort());
  expect(afterBookings.reduce((sum, session) => sum + minutesBetween(session.start, session.end), 0)).toBe(beforeBookings.reduce((sum, session) => sum + minutesBetween(session.start, session.end), 0));
  expect(after.items.find(item => item.id === blocker.id)).toMatchObject({ remainingMinutes: blocker.remainingMinutes, estimatedMinutes: blocker.estimatedMinutes });
  expect(after.version).toBe(pending.version + 1);
  const attachment = after.attachments.find(file => file.workItemId === work.id && file.name === "priority-request.md")!;
  expect(await (await page.request.get(`/api/attachments/${attachment.id}`)).text()).toBe(brief);
});

test("stale approval cannot move work and a fresh review recovers without losing edits", async ({ page, playwright }) => {
  const { work, entry } = await pendingDisplacement(page.request, "E2E stale priority request", 77);
  await page.goto("/");
  await page.getByRole("navigation").getByRole("button", { name: /^Requests/ }).click();
  await page.locator("article.request-card").filter({ hasText: work.title }).getByRole("button", { name: "Review with current schedule" }).click();
  const dialog = page.getByRole("dialog", { name: "Review priority request" });
  await dialog.getByLabel("Estimated work (hours)").fill("1.5");
  await dialog.getByRole("button", { name: "Preview revised plan" }).click();
  await expect(dialog.getByRole("heading", { name: "Review before approval" })).toBeVisible();
  const other = await playwright.request.newContext({ baseURL: origin });
  try {
    await asActor(other, "kyle");
    const latest = await state(other);
    const date = futureDate(latest, 84);
    const extra = makeItem(latest, "E2E unrelated concurrent booking", { windowStart: date, windowEnd: date });
    await commit(other, await preview(other, [{ type: "create", item: extra }]));
  } finally { await other.dispose(); }
  const beforeApproval = await state(page.request);
  await dialog.getByRole("button", { name: "Approve this reviewed plan" }).click();
  await expect(dialog.getByRole("alert")).toContainText("schedule changed");
  const rejected = await state(page.request);
  expect(rejected.version).toBe(beforeApproval.version);
  expect(rejected.requests.find(request => request.id === entry.id)?.status).toBe("pending");
  expect(rejected.items.some(item => item.id === work.id)).toBe(false);
  await expect(dialog.getByLabel("Estimated work (hours)")).toHaveValue("1.5");
  await dialog.getByRole("button", { name: "Preview revised plan" }).click();
  await expect(dialog.getByRole("heading", { name: "Review before approval" })).toBeVisible();
  await dialog.getByRole("button", { name: "Approve this reviewed plan" }).click();
  await expect(dialog).toHaveCount(0);
  expect((await state(page.request)).items.find(item => item.id === work.id)?.estimatedMinutes).toBe(90);
});

test("multi-day request approval keeps its original range flexible and leaves the submitted request unchanged", async ({ page }) => {
  const { work, entry, pending } = await pendingDisplacement(page.request, "E2E bounded multi-day request", 91, true);
  await page.goto("/");
  await page.getByRole("navigation").getByRole("button", { name: /^Requests/ }).click();
  await page.locator("article.request-card").filter({ hasText: work.title }).getByRole("button", { name: "Review with current schedule" }).click();
  const dialog = page.getByRole("dialog", { name: "Review priority request" });
  await dialog.getByLabel("Estimated work (hours)").fill("1.5");
  await dialog.getByRole("button", { name: "Preview revised plan" }).click();
  await expect(dialog.getByRole("heading", { name: "Review before approval" })).toBeVisible();
  const reviewed = await state(page.request);
  expect(reviewed.version).toBe(pending.version);
  expect(reviewed.requests.find(request => request.id === entry.id)!.proposal).toEqual(entry.proposal);
  await dialog.getByRole("button", { name: "Approve this reviewed plan" }).click();
  await expect(dialog).toHaveCount(0);
  const saved = await state(page.request), item = saved.items.find(item => item.id === work.id)!;
  expect(item).toMatchObject({ estimatedMinutes: 90, remainingMinutes: 90, dateConstraints: { earliestStart: null, allowedDates: [] } });
  expect(item.dailyPlan).toBeUndefined();
  expect(saved.sessions.filter(session => session.workItemId === item.id).every(session => {
    const date = localDate(session.start, saved.settings.timeZone); return date >= work.windowStart && date <= work.windowEnd!;
  })).toBe(true);
  expect(saved.requests.find(request => request.id === entry.id)!.proposal).toEqual(entry.proposal);
});

test("typed commands save clean work while future-tense update language remains a draft", async ({ page }) => {
  await page.goto("/");
  const before = await state(page.request);
  const date = futureDate(before, 56);
  await page.getByRole("button", { name: "Ask ADA", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Instruction for ADA").fill(`Add web work for Higher Ground Tree: E2E assistant page fix, 1 hour on ${date}`);
  await dialog.getByRole("button", { name: "Send instruction" }).click();
  await expect(dialog.getByLabel("Instruction for ADA")).toHaveValue("");
  const saved = await state(page.request);
  expect(saved.items.some(item => item.title.includes("E2E assistant page fix"))).toBe(true);
  expect(saved.version).toBe(before.version + 1);
  await dialog.getByLabel("Instruction for ADA").fill("I have to tell her about the completed landings");
  await dialog.getByRole("button", { name: "Send instruction" }).click();
  await expect(dialog.getByLabel("Instruction for ADA")).toHaveValue("");
  const drafted = await state(page.request);
  expect(drafted.version).toBe(saved.version);
  expect(drafted.notifications).toHaveLength(saved.notifications.length);
  await dialog.getByRole("button", { name: "Close dialog" }).click();
  await expect(page.getByText("DRAFT · NOT SENT", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Send update email" }).first()).toBeVisible();
});

test("a short clarification reply keeps the original task and does not replay it on the next instruction", async ({ page }) => {
  await asActor(page.request, "bryan");
  await page.goto("/");
  const before = await state(page.request);
  const date = futureDate(before, 105);
  const title = "E2E followup missing effort";
  await page.getByRole("button", { name: "Ask ADA", exact: true }).click();
  const dialog = page.getByRole("dialog");
  const input = dialog.getByLabel("Instruction for ADA");
  const send = dialog.getByRole("button", { name: "Send instruction" });
  const continuation = dialog.getByText("Your reply will continue the pending instruction above.", { exact: true });
  await input.fill(`Add IT work for Higher Ground Tree: ${title}, on ${date}`);
  await send.click();
  await expect(continuation).toBeVisible();
  await expect(input).toHaveValue("");
  const waiting = await state(page.request);
  expect(waiting.version).toBe(before.version);
  expect(waiting.items).toEqual(before.items);
  expect(waiting.events).toHaveLength(before.events.length);
  expect(waiting.notifications).toHaveLength(before.notifications.length);

  await input.fill("Two hours");
  await send.click();
  await expect(continuation).toHaveCount(0);
  await expect(input).toHaveValue("");
  const saved = await state(page.request);
  const matches = saved.items.filter(item => item.title === title);
  expect(matches).toHaveLength(1);
  const work = matches[0];
  expect(work).toMatchObject({ clientId: "higher-ground", category: "it", estimatedMinutes: 120, remainingMinutes: 120, windowStart: date, windowEnd: date });
  expect(saved.version).toBe(before.version + 1);
  expect(saved.events).toHaveLength(before.events.length + 1);
  const createdEvent = saved.events.find(event => event.itemIds.includes(work.id))!;
  expect(saved.notifications.filter(notification => notification.eventId === createdEvent.id).map(notification => notification.recipient).sort()).toEqual(["kyle@example.test", "william@example.test"]);
  expect(saved.notifications.every(notification => notification.status === "captured")).toBe(true);

  const nextTitle = "E2E fresh instruction after clarification";
  const nextDate = futureDate(saved, 112);
  await input.fill(`Add web work for Higher Ground Tree: ${nextTitle}, 1 hour on ${nextDate}`);
  await send.click();
  await expect(input).toHaveValue("");
  await expect(continuation).toHaveCount(0);
  const after = await state(page.request);
  expect(after.items.filter(item => item.title === title)).toHaveLength(1);
  expect(after.items.filter(item => item.title === nextTitle)).toHaveLength(1);
  expect(after.items.find(item => item.title === nextTitle)).toMatchObject({ category: "web", estimatedMinutes: 60, windowStart: nextDate });
  expect(after.events).toHaveLength(saved.events.length + 1);
});

test("starting a new instruction discards pending context and Never mind leaves work unchanged", async ({ page }) => {
  await asActor(page.request, "bryan");
  await page.goto("/");
  const before = await state(page.request);
  const date = futureDate(before, 119);
  const title = "E2E abandoned pending instruction";
  await page.getByRole("button", { name: "Ask ADA", exact: true }).click();
  const dialog = page.getByRole("dialog");
  const input = dialog.getByLabel("Instruction for ADA");
  const send = dialog.getByRole("button", { name: "Send instruction" });
  const continuation = dialog.getByText("Your reply will continue the pending instruction above.", { exact: true });
  await input.fill(`Add IT work for Higher Ground Tree: ${title}, on ${date}`);
  await send.click();
  await expect(continuation).toBeVisible();
  await dialog.getByRole("button", { name: "Start a new instruction", exact: true }).click();
  await expect(continuation).toHaveCount(0);
  await expect(dialog.locator(".chat-message")).toHaveCount(0);
  await expect(input).toHaveValue("");

  // A bare estimate after clearing the pending instruction must not revive it.
  await input.fill("Two hours");
  await send.click();
  await expect(continuation).toBeVisible();
  await expect(input).toHaveValue("");
  const unanswered = await state(page.request);
  expect(unanswered.items).toEqual(before.items);
  expect(unanswered.events).toHaveLength(before.events.length);
  expect(unanswered.notifications).toHaveLength(before.notifications.length);
  await input.fill("Never mind");
  await send.click();
  await expect(continuation).toHaveCount(0);
  await expect(input).toHaveValue("");
  await expect(dialog.getByText("Pending instruction dismissed. No calendar work was changed or email sent.", { exact: true })).toBeVisible();
  const cancelled = await state(page.request);
  expect(cancelled.version).toBe(before.version);
  expect(cancelled.items).toEqual(before.items);
  expect(cancelled.events).toHaveLength(before.events.length);
  expect(cancelled.notifications).toHaveLength(before.notifications.length);
});

test("Markdown briefs preserve the original while rendering without executable HTML", async ({ page }) => {
  await asActor(page.request, "bryan");
  const before = await state(page.request);
  const work = makeItem(before, "E2E attachment work");
  await commit(page.request, await preview(page.request, [{ type: "create", item: work }]));
  await page.goto(`/?work=${work.id}`);
  const dialog = page.getByRole("dialog");
  const markdown = "# Landing brief\n\nBuild the South Bend page.\n\n<script>window.adaUnsafeMarkdown = true</script>\n";
  await dialog.locator('input[type="file"]').setInputFiles({ name: "landing-brief.md", mimeType: "text/markdown", buffer: Buffer.from(markdown) });
  await dialog.getByRole("button", { name: /^landing-brief\.md/ }).click();
  await expect(dialog.getByRole("heading", { name: "Landing brief" })).toBeVisible();
  expect(await page.evaluate(() => "adaUnsafeMarkdown" in window)).toBe(false);
  const after = await state(page.request);
  const attachment = after.attachments.find(file => file.workItemId === work.id)!;
  expect(await (await page.request.get(`/api/attachments/${attachment.id}`)).text()).toBe(markdown);
});

test("mobile defaults to agenda without horizontal overflow and keeps viewer actions hidden", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await asActor(page.request, "viewer");
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Bryan’s plate, at a glance." })).toBeVisible();
  await expect(page.locator(".agenda")).toBeVisible();
  await expect(page.getByLabel("Month workload calendar")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Request work", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Ask ADA", exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  await testInfo.attach("mobile-accessibility", { body: JSON.stringify(results.violations, null, 2), contentType: "application/json" });
  expect(results.violations).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("mobile-agenda.png"), fullPage: true });
});
