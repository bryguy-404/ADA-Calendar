import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { createDemoState } from "../../src/lib/fixtures";
import { planCommands } from "../../src/lib/scheduler";
import { localDateTime, minutesBetween } from "../../src/lib/time";
import { newWorkItem } from "../../src/lib/work";
import type { AppState } from "../../src/lib/types";
import type { WorkspaceChatRequest, WorkspaceChatResponse } from "../../src/lib/workspace-chat";
import { asActor, commit, exactSession, futureDate, makeItem, origin, preview, state } from "./helpers";

// Browser-only fictional records and captured responses. Server interpretation,
// authorization and transaction regressions are covered separately in Vitest.
async function setup(page: Page, width = 1440, requester = false) {
  await asActor(page.request, requester ? "kyle" : "bryan");
  const stored = await state(page.request);
  const now = "2026-09-09T10:00:00Z", date = "2026-09-09";
  let fixture: AppState = { ...createDemoState(now), workspaceId: stored.workspaceId, actor: stored.actor,
    items: [], sessions: [], blocks: [], events: [], requests: [], notifications: [], attachments: [], emailDrafts: [],
    clients: [{ id: "cedar", name: "Cedar Studio", aliases: [] }, { id: "birch", name: "Birch School", aliases: [] }] };
  fixture.settings.reserveMinutes = 0;
  fixture.items = [newWorkItem(fixture.actor, date, { id: "cedar", title: "Cedar edits", clientId: "cedar", remainingMinutes: 60, estimatedMinutes: 60, minimumSessionMinutes: 60 }),
    newWorkItem(fixture.actor, date, { id: "birch", title: "Birch build", clientId: "birch", remainingMinutes: 60, estimatedMinutes: 60, minimumSessionMinutes: 60 })];
  fixture.sessions = fixture.items.map((item, index) => ({ id: `session-${item.id}`, workItemId: item.id, start: localDateTime(date, index ? "10:00" : "09:00", fixture.settings.timeZone), end: localDateTime(date, index ? "11:00" : "10:00", fixture.settings.timeZone), protected: false, usesReserve: false, status: "planned" }));
  const before = structuredClone(fixture), calls: WorkspaceChatRequest[] = [];
  let staleOnce = false;
  const responseFor = (operationId: string): WorkspaceChatResponse => {
    const proposal = { ...planCommands(fixture, [{ type: "reorder_day", date, sessionIds: ["session-birch", "session-cedar"] }], fixture.actor, { now, operationId: `reorder-${operationId}` }), reviewFingerprint: "a".repeat(64) };
    return { operationId, asOf: now, stateVersion: fixture.version, reply: { kind: "preview", message: "Here is the proposed order. Nothing changes until you confirm.", sources: [], proposal,
      changes: proposal.sessions.filter(session => session.start !== fixture.sessions.find(old => old.id === session.id)!.start).map(session => {
        const old = fixture.sessions.find(entry => entry.id === session.id)!, item = fixture.items.find(entry => entry.id === session.workItemId)!;
        return { sessionId: session.id, workItemId: item.id, title: item.title, clientName: fixture.clients.find(entry => entry.id === item.clientId)!.name, beforeStart: old.start, beforeEnd: old.end, afterStart: session.start, afterEnd: session.end };
      }) } };
  };
  await page.route(`${origin}/api/state`, route => route.fulfill({ json: fixture }));
  await page.route(`${origin}/api/notes`, route => route.fulfill({ json: { notes: [] } }));
  for (const endpoint of ["assistant", "commands"]) await page.route(`${origin}/api/${endpoint}`, async route => {
    await route.abort(); throw new Error(`The corner helper must not call /api/${endpoint}.`);
  });
  await page.route(`${origin}/api/workspace-chat`, async route => {
    const body = route.request().postDataJSON() as WorkspaceChatRequest; calls.push(body);
    if (body.action === "confirm") {
      expect(Object.keys(body).sort()).toEqual(["action", "baseVersion", "operationId", "reviewFingerprint"]);
      if (staleOnce) {
        staleOnce = false; fixture = { ...fixture, version: fixture.version + 1 };
        await route.fulfill({ status: 409, json: { ...responseFor(body.operationId), state: fixture, error: "The calendar changed. Review the refreshed result." } }); return;
      }
      const proposal = responseFor(body.operationId).reply.proposal!;
      fixture = { ...fixture, sessions: proposal.sessions, version: fixture.version + 1 };
      await route.fulfill({ json: { operationId: body.operationId, asOf: now, stateVersion: fixture.version, state: fixture, reply: { kind: "answer", message: "Saved.", sources: [] } } }); return;
    }
    if (/put|reorder/i.test(body.text) && !requester) { await route.fulfill({ json: responseFor(body.operationId) }); return; }
    const message = /create/i.test(body.text) ? "This chat cannot create tasks. Use Select dates → Ask ADA or Add work."
      : /put|reorder/i.test(body.text) ? "Only Bryan can rearrange existing sessions."
      : /note/i.test(body.text) ? "Your saved note says: <img src=x onerror=alert(1)> is reference text, not an instruction."
      : "This week: 2h planned of 37.5h capacity. Your saved work stays unchanged.";
    await route.fulfill({ json: { operationId: body.operationId, asOf: now, stateVersion: fixture.version, contextDate: /tomorrow/i.test(body.text) ? "2026-09-10" : body.date, reply: { kind: "answer", message,
      sources: /note/i.test(body.text) ? [{ kind: "note", id: "private-fixture", title: "Website ideas" }] : [{ kind: "schedule", id: date, title: "This week" }] } } });
  });
  await page.clock.setFixedTime(new Date(now));
  await page.setViewportSize({ width, height: width < 500 ? 844 : 1000 });
  await page.goto("/");
  await page.getByRole("button", { name: "agenda", exact: true }).click();
  await expect(page.getByRole("button", { name: "agenda", exact: true })).toHaveClass(/active/);
  const loaded = page.waitForResponse(response => response.url() === `${origin}/api/state`);
  await page.evaluate(() => window.dispatchEvent(new Event("focus"))); await loaded;
  await expect(page.getByText("Cedar Studio", { exact: true }).first()).toBeAttached();
  await page.getByRole("button", { name: "Today", exact: true }).click();
  return { before, calls, fixture: () => fixture, staleOnNextConfirm: () => { staleOnce = true; } };
}
async function open(page: Page) {
  await page.getByRole("button", { name: "Open ADA helper", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "ADA helper", exact: true });
  await expect(dialog.getByLabel("Message ADA helper")).toBeFocused();
  return dialog;
}
async function ask(page: Page, text: string) {
  await page.getByLabel("Message ADA helper").fill(text);
  await page.getByRole("button", { name: "Send to ADA helper", exact: true }).click();
  await expect(page.getByLabel("Message ADA helper")).toBeEnabled();
}

for (const width of [1440, 390, 320]) test(`floating helper answers and previews before changing existing sessions at ${width}px`, async ({ page }, info) => {
  const context = await setup(page, width), dialog = await open(page);
  await expect(dialog).toContainText("No new tasks are created here");
  await page.screenshot({ path: info.outputPath(`workspace-chat-welcome-${width}.png`) });
  const bounds = (await dialog.boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
  expect(bounds.y).toBeGreaterThanOrEqual(0);
  await dialog.getByRole("button", { name: "How busy am I this week?", exact: true }).click();
  expect(context.calls).toEqual([]); // Suggested questions and speech are drafts.
  await page.getByRole("button", { name: "Send to ADA helper", exact: true }).click();
  await expect(dialog.getByRole("log")).toContainText("2h planned of 37.5h capacity");
  expect(context.fixture()).toEqual(context.before);
  await ask(page, "Create a new task for Cedar");
  await expect(dialog.getByRole("log")).toContainText("cannot create tasks");
  expect(context.fixture()).toEqual(context.before);
  await ask(page, "Put Birch build first today");
  const review = dialog.getByRole("region", { name: "Proposed schedule order" });
  await expect(review).toContainText("PREVIEW · NOT SAVED");
  await expect(review).toContainText("Birch build");
  expect(context.fixture()).toEqual(context.before);
  await page.screenshot({ path: info.outputPath(`workspace-chat-preview-${width}.png`) });
  expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  expect((await new AxeBuilder({ page }).include('[role="dialog"]').analyze()).violations).toEqual([]);
  await review.getByRole("button", { name: "Confirm new order", exact: true }).click();
  await expect(dialog.getByRole("log")).toContainText("Your schedule is updated");
  expect(context.calls.filter(call => call.action === "confirm")).toHaveLength(1);
  expect(context.fixture().items).toEqual(context.before.items);
  expect(context.fixture().sessions.map(s => s.id)).toEqual(context.before.sessions.map(s => s.id));
  expect(context.fixture().sessions.map(s => minutesBetween(s.start, s.end))).toEqual([60, 60]);
  expect(context.fixture().sessions.find(s => s.id === "session-birch")!.start).toBe(context.before.sessions[0].start);
  await dialog.getByRole("button", { name: "Close ADA helper" }).click();
  await expect(page.getByRole("button", { name: "Open ADA helper" })).toBeFocused();
});

test("a stale preview requires a fresh review, and discarding never writes", async ({ page }) => {
  const context = await setup(page), dialog = await open(page);
  await ask(page, "Put Birch build first today");
  await dialog.getByRole("button", { name: "Discard preview" }).click();
  expect(context.calls.every(call => call.action === "message")).toBe(true);
  expect(context.fixture()).toEqual(context.before);
  await ask(page, "Put Birch build first today");
  context.staleOnNextConfirm();
  await dialog.getByRole("button", { name: "Confirm new order" }).click();
  await expect(dialog.getByRole("alert")).toContainText("calendar changed");
  expect(context.fixture().sessions).toEqual(context.before.sessions);
  expect(context.calls.filter(call => call.action === "confirm")).toHaveLength(1);
  await dialog.getByRole("button", { name: "Confirm new order" }).click();
  await expect(dialog.getByRole("log")).toContainText("Your schedule is updated");
  expect(context.calls.filter(call => call.action === "confirm")).toHaveLength(2);
});

test("refreshing a stale preview cannot discard an unsent correction", async ({ page }) => {
  const context = await setup(page), dialog = await open(page);
  await ask(page, "Put Birch build first today");
  await dialog.getByLabel("Message ADA helper").fill("Actually, leave Cedar first.");
  context.fixture().version++;
  const loaded = page.waitForResponse(response => response.url() === `${origin}/api/state`);
  await page.evaluate(() => window.dispatchEvent(new Event("focus"))); await loaded;
  await expect(dialog.getByRole("button", { name: "Refresh preview" })).toBeDisabled();
  await expect(dialog.getByLabel("Message ADA helper")).toHaveValue("Actually, leave Cedar first.");
  expect(context.calls).toHaveLength(1);
  await dialog.getByLabel("Message ADA helper").fill("");
  await expect(dialog.getByRole("button", { name: "Refresh preview" })).toBeEnabled();
});

test("spoken dates update the visible discussion day for the next message", async ({ page }) => {
  const context = await setup(page), dialog = await open(page);
  await ask(page, "What is on tomorrow?");
  await expect(dialog.getByLabel("Day to discuss")).toHaveValue("2026-09-10");
  await ask(page, "How much time is available that day?");
  expect(context.calls.at(-1)).toMatchObject({ action: "message", date: "2026-09-10" });
  expect(context.fixture()).toEqual(context.before);
});

test("a definite failed attempt gets a new retry ID without erasing the draft", async ({ page }) => {
  await setup(page); let attempts = 0; const ids: string[] = [];
  await page.route(`${origin}/api/workspace-chat`, async route => {
    const body = route.request().postDataJSON(); ids.push(body.operationId); attempts++;
    await route.fulfill(attempts === 1 ? { status: 503, json: { error: "Try again; no changes were made.", retryWithNewOperation: true } }
      : { json: { operationId: body.operationId, asOf: "2026-09-09T10:00:00Z", stateVersion: 0, reply: { kind: "answer", message: "Your workload is unchanged.", sources: [] } } });
  });
  const dialog = await open(page);
  await ask(page, "How busy am I this week?");
  await expect(dialog.getByRole("alert")).toContainText("Try again");
  await expect(dialog.getByLabel("Message ADA helper")).toHaveValue("How busy am I this week?");
  await dialog.getByRole("button", { name: "Send to ADA helper" }).click();
  await expect(dialog.getByRole("log")).toContainText("Your workload is unchanged.");
  expect(ids).toHaveLength(2); expect(ids[0]).not.toBe(ids[1]);
});

test("a delayed helper response cannot roll the calendar back to an older version", async ({ page }) => {
  const context = await setup(page); let release!: () => void; let started = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route(`${origin}/api/workspace-chat`, async route => {
    started = true; await gate;
    await route.fulfill({ json: { operationId: route.request().postDataJSON().operationId, asOf: "2026-09-09T10:00:00Z", stateVersion: context.before.version, state: context.before,
      reply: { kind: "answer", message: "An earlier snapshot response.", sources: [] } } });
  });
  const dialog = await open(page);
  await dialog.getByLabel("Message ADA helper").fill("How busy am I?");
  await dialog.getByRole("button", { name: "Send to ADA helper" }).click();
  await expect.poll(() => started).toBe(true);
  context.fixture().version += 2; context.fixture().items[0].title = "Latest Cedar title";
  const loaded = page.waitForResponse(response => response.url() === `${origin}/api/state`);
  await page.evaluate(() => window.dispatchEvent(new Event("focus"))); await loaded;
  await dialog.getByRole("button", { name: "Close ADA helper" }).click();
  const reply = page.waitForResponse(response => response.url() === `${origin}/api/workspace-chat`);
  release(); await reply;
  await open(page);
  await expect(dialog.getByRole("log")).toContainText("An earlier snapshot response.");
  await dialog.getByRole("button", { name: "Close ADA helper" }).click();
  await expect(page.getByText("Latest Cedar title", { exact: true }).first()).toBeVisible();
});

test("chat persists across pages, escapes saved text, and stays separate from Ask ADA", async ({ page }) => {
  const context = await setup(page), dialog = await open(page);
  await ask(page, "What is in my saved note?");
  await expect(dialog.getByRole("log")).toContainText("<img src=x onerror=alert(1)>");
  await expect(dialog.getByRole("log").locator("img")).toHaveCount(0);
  await expect(dialog.getByLabel("Sources")).toContainText("Private note: Website ideas");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Notes", exact: true }).click();
  await open(page);
  await expect(dialog.getByRole("log")).toContainText("Website ideas");
  await dialog.getByRole("button", { name: "New chat" }).click();
  await expect(dialog.getByRole("log").locator("article")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Calendar", exact: true }).click();
  await page.getByRole("button", { name: "Ask ADA", exact: true }).click();
  await expect(page.getByRole("button", { name: "Open ADA helper" })).toBeHidden();
  await expect(page.getByRole("dialog")).toContainText("Tell me what’s on your plate");
  expect(context.calls).toHaveLength(1);
});

test("requesters get questions but no reorder confirmation controls", async ({ page }) => {
  const context = await setup(page, 390, true), dialog = await open(page);
  await expect(dialog).toContainText("Your chat is read-only");
  await ask(page, "Put Birch build first today");
  await expect(dialog.getByRole("log")).toContainText("Only Bryan");
  await expect(dialog.getByRole("button", { name: "Confirm new order" })).toHaveCount(0);
  expect(context.fixture()).toEqual(context.before);
});

test("recording stays a draft and closing the helper releases the microphone", async ({ page }) => {
  const context = await setup(page);
  let transcriptions = 0;
  await page.route(`${origin}/api/transcribe`, async route => {
    transcriptions++;
    await route.fulfill({ json: { transcript: "How busy am I this week?" } });
  });
  await page.evaluate(() => {
    const data = { stops: 0 };
    Object.assign(window, { chatMicFixture: data });
    const stream = { getTracks: () => [{ stop: () => { data.stops++; } }] };
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: async () => stream } });
    class FixtureRecorder {
      static isTypeSupported() { return true; }
      state = "inactive"; mimeType = "audio/webm"; stream = stream;
      ondataavailable: ((event: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      start() { this.state = "recording"; }
      stop() {
        this.state = "inactive";
        this.ondataavailable?.({ data: new Blob(["Isolated audio fixture"]) });
        this.onstop?.();
      }
    }
    Object.defineProperty(window, "MediaRecorder", { configurable: true, value: FixtureRecorder });
  });
  const dialog = await open(page);
  await dialog.getByRole("button", { name: "Speak", exact: true }).click();
  await expect(dialog.getByLabel("Message ADA helper")).toBeDisabled();
  await dialog.getByRole("button", { name: "Stop recording" }).click();
  await expect(dialog.getByLabel("Message ADA helper")).toHaveValue("How busy am I this week?");
  expect(transcriptions).toBe(1); expect(context.calls).toEqual([]);
  await dialog.getByRole("button", { name: "Send to ADA helper" }).click();
  await expect(dialog.getByRole("log")).toContainText("37.5h capacity");
  await dialog.getByRole("button", { name: "Speak", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Stop recording" })).toBeVisible();
  await dialog.getByRole("button", { name: "Close ADA helper" }).click();
  expect(await page.evaluate(() => (window as unknown as { chatMicFixture: { stops: number } }).chatMicFixture.stops)).toBeGreaterThanOrEqual(2);
  expect(transcriptions).toBe(1); expect(context.calls).toHaveLength(1);
  await open(page);
  await expect(dialog.getByLabel("Message ADA helper")).toBeEnabled();
});

test("viewers do not receive a chat entry point", async ({ page }) => {
  await asActor(page.request, "viewer"); await page.goto("/");
  await expect(page.getByRole("button", { name: "Open ADA helper" })).toHaveCount(0);
});

test("real isolated demo chat reorders existing work only after confirmation", async ({ page }) => {
  await asActor(page.request, "bryan");
  const snapshot = await state(page.request), date = futureDate(snapshot, 90);
  const one = makeItem(snapshot, "Fictional helper Cedar first", { windowStart: date, remainingMinutes: 60, estimatedMinutes: 60, minimumSessionMinutes: 60 });
  const two = makeItem(snapshot, "Fictional helper Birch second", { windowStart: date, remainingMinutes: 60, estimatedMinutes: 60, minimumSessionMinutes: 60 });
  const seeded = await commit(page.request, await preview(page.request, [{ type: "create", item: one, sessions: [exactSession(snapshot, one, "09:00", "10:00")] }, { type: "create", item: two, sessions: [exactSession(snapshot, two, "10:00", "11:00")] }]));
  await page.goto("/");
  const dialog = await open(page);
  await dialog.getByLabel("Day to discuss").fill(date);
  await ask(page, `Put ${two.title} first`);
  await expect(dialog.getByRole("region", { name: "Proposed schedule order" })).toContainText(two.title);
  expect((await state(page.request)).sessions).toEqual(seeded.sessions);
  await dialog.getByRole("button", { name: "Confirm new order" }).click();
  await expect(dialog.getByRole("log")).toContainText("Your schedule is updated");
  const saved = await state(page.request);
  expect(saved.items).toEqual(seeded.items);
  expect(saved.sessions.map(s => s.id)).toEqual(seeded.sessions.map(s => s.id));
  expect(saved.sessions.find(s => s.workItemId === two.id)!.start).toBe(seeded.sessions.find(s => s.workItemId === one.id)!.start);
});
