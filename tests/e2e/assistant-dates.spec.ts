import { expect, test } from "@playwright/test";
import { createDemoState } from "../../src/lib/fixtures";
import { planCommands } from "../../src/lib/scheduler";
import { compileInterpretation, emptyAssistantAction } from "../../src/lib/server/assistant";
import { localDate, minutesBetween } from "../../src/lib/time";
import type { AppState } from "../../src/lib/types";
import { asActor, origin, state } from "./helpers";

test("mocked-provider UI regression: tomorrow-only work has no timeline ribbon today", async ({ page, baseURL }, testInfo) => {
  // The provider response is mocked, but both compilation and scheduling below
  // use production code. No model call, calendar write, or outgoing email occurs.
  expect(baseURL).toBe(origin);
  await asActor(page.request, "bryan");
  expect((await state(page.request)).mode).toBe("demo");
  const now = new Date("2026-09-08T14:20:00.000Z");
  await page.clock.setFixedTime(now);
  const empty: AppState = {
    ...createDemoState(now.toISOString()),
    clients: [{ id: "cidwp", name: "CIDWP", aliases: [] }],
    items: [], sessions: [], blocks: [], requests: [], events: [], notifications: [],
    attachments: [], emailDrafts: [],
  };
  const instruction = "CIDWP needs a new website build. Will work on a home page demo for them to approve before moving on to the rest of the site. Will get started on the home page demo from start to finish on September, 9th and should take me about 3 hours from start to finish.";
  const interpretation = compileInterpretation({
    kind: "commands",
    message: "Mocked provider: homepage demo prepared for scheduling.",
    actions: [{
      ...emptyAssistantAction("create", instruction),
      clientName: "CIDWP", title: "Homepage demo", category: "web", webKind: "build",
      estimatedMinutes: 180, allowedDates: ["2026-09-09"],
      targetDate: "2026-09-09", deadline: "2026-09-09",
      // Deliberately leave windowStart null, matching the reported extraction.
    }],
    draft: null,
  }, instruction, empty, empty.actor, now);
  expect(interpretation.kind, interpretation.message).toBe("commands");
  const proposal = planCommands(empty, interpretation.commands, empty.actor, { now: now.toISOString() });
  expect(proposal.status, JSON.stringify(proposal.conflicts)).toBe("ready");
  expect(proposal.items).toHaveLength(1);
  expect(proposal.items[0].windowStart).toBe("2026-09-09");
  expect(proposal.sessions.length).toBeGreaterThan(0);
  expect(proposal.sessions.every(session => localDate(session.start, empty.settings.timeZone) === "2026-09-09")).toBe(true);
  expect(proposal.sessions.reduce((total, session) => total + minutesBetween(session.start, session.end), 0)).toBe(180);
  const scheduled: AppState = { ...empty, items: proposal.items, sessions: proposal.sessions, blocks: proposal.blocks };
  let intercepted = 0;
  await page.route(`${origin}/api/assistant`, async route => {
    expect(route.request().method()).toBe("POST");
    expect(route.request().postDataJSON().text).toBe(instruction);
    intercepted += 1;
    await route.fulfill({ json: { interpretation, proposal, state: scheduled, replyToOperationId: null } });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Ask ADA", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Instruction for ADA", { exact: true }).fill(instruction);
  await dialog.getByRole("button", { name: "Send instruction", exact: true }).click();
  await expect(dialog.getByText(interpretation.message, { exact: true })).toBeVisible();
  expect(intercepted).toBe(1);
  await dialog.getByRole("button", { name: "Close dialog", exact: true }).click();
  await page.getByRole("button", { name: "Today", exact: true }).click();
  await page.getByRole("button", { name: "month", exact: true }).click();

  const calendar = page.getByLabel("Month workload calendar", { exact: true });
  // At 10:20 AM, elapsed time and the next 15-minute start boundary leave 5h.
  await expect(calendar.getByRole("button", { name: "Tuesday, September 8, 5h available, 0h planned", exact: true })).toBeVisible();
  await expect(calendar.getByRole("button", { name: "Wednesday, September 9, 3.5h available, 3h planned", exact: true })).toBeVisible();
  const ribbon = calendar.getByTitle("CIDWP · Homepage demo", { exact: true });
  await expect(ribbon).toHaveCount(1);
  // Sunday is column 1: Wednesday-only must occupy 4 / 5, not Tuesday 3 / 5.
  // The lane now owns grid placement so the move handle can remain a sibling
  // of the details button, without nesting interactive controls.
  const lane = ribbon.locator("..");
  await expect(lane).toHaveClass(/project-ribbon-lane/);
  await expect(lane).toHaveCSS("grid-column-start", "4");
  await expect(lane).toHaveCSS("grid-column-end", "5");
  await expect(ribbon.locator(".ribbon-reserved")).toHaveCount(1);
  await expect(ribbon.locator(".ribbon-reserved")).toHaveText("3h");
  await expect(ribbon.locator(".ribbon-span, .ribbon-gap")).toHaveCount(0);
  await calendar.screenshot({ path: testInfo.outputPath("tomorrow-only-cidwp-calendar.png") });
});
