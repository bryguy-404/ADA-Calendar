import { expect, test } from "@playwright/test";
import { conversationText, nextContinuation, type AssistantContinuation } from "../../src/lib/assistant-conversation";
import { createDemoState } from "../../src/lib/fixtures";
import { planCommands } from "../../src/lib/scheduler";
import { compileInterpretation, emptyAssistantAction } from "../../src/lib/server/assistant";
import type { AppState, Interpretation } from "../../src/lib/types";
import { asActor, origin, state } from "./helpers";

test("offline ongoing-project conversation corrects the date, clarifies lunch, and reserves only approved sessions", async ({ page, baseURL }, testInfo) => {
  expect(baseURL).toBe(origin);
  await asActor(page.request, "bryan");
  const storedBefore = await state(page.request);
  expect(storedBefore.mode).toBe("demo");
  const now = new Date("2026-09-08T17:00:00Z");
  await page.clock.setFixedTime(now);
  let fixture: AppState = { ...createDemoState(now.toISOString()), clients: [{ id: "fictional-studio", name: "Cedar Studio", aliases: [] }],
    items: [], sessions: [], blocks: [], events: [], notifications: [], requests: [], emailDrafts: [], attachments: [] };
  const original = "Cedar Studio needs a catalog rebuild. Show the project for the rest of this month. Start with 4 hours this Friday the 10th from 9am–1pm.";
  const correction = "Sorry, I meant September 11th. Total estimated effort is unknown; 4 hours is just this session. Show the project this month until the end of the year. For now Friday 4 hours from 9am–1pm.";
  const months = "Add it for months of September, October, November and December and for now 4 hours this Friday the 11th from 9am–1pm.";
  const split = "Split around lunch and extend the finish.";
  const title = "Catalog rebuild";
  const requests = [original, correction, months, split];
  const question = "September 10 is Thursday; did you mean Friday September 11? Are four hours the first session or the total?";
  let continuation: AssistantContinuation | undefined;
  let count = 0;
  const pendingId = "00000000-0000-4000-8000-000000000008";

  // Provider and HTTP responses are mocked; the real conversation compiler and
  // shared scheduler run on fictional browser-local state, with no saved data.
  await page.route(`${origin}/api/assistant`, async route => {
    const body = route.request().postDataJSON();
    expect(body.text).toBe(requests[count]);
    if (count > 0) expect(body.replyToOperationId).toBe(pendingId);
    const text = conversationText(body.text, continuation);
    let interpretation: Interpretation;
    if (count === 0) interpretation = { kind: "clarification", message: question, commands: [] };
    else interpretation = compileInterpretation({ kind: "commands", message: "Saved the ongoing project and four hours of work. The total remains unknown.", draft: null, actions: [{
      ...emptyAssistantAction("create", text), clientName: "Cedar Studio", title, category: "web", webKind: "build", estimatedMinutes: null,
      sessions: count < 3
        ? [{ start: "2026-09-11T09:00:00-04:00", end: "2026-09-11T13:00:00-04:00", protected: false, usesReserve: false }]
        : [{ start: "2026-09-11T09:00:00-04:00", end: "2026-09-11T12:00:00-04:00", protected: false, usesReserve: false },
          { start: "2026-09-11T12:30:00-04:00", end: "2026-09-11T13:30:00-04:00", protected: false, usesReserve: false }],
    }] }, text, fixture, fixture.actor, now, body.text, continuation?.turns.slice(1).map(turn => turn.userText));
    count++;
    if (interpretation.kind === "clarification") {
      if (count > 1) expect(interpretation.message).toContain("lunch");
      continuation = nextContinuation(body.text, interpretation, now, continuation)!;
      return route.fulfill({ json: { interpretation, state: fixture, replyToOperationId: pendingId } });
    }
    expect(count).toBe(4);
    const proposal = planCommands(fixture, interpretation.commands, fixture.actor, { now: now.toISOString() });
    expect(proposal.status, JSON.stringify(proposal.conflicts)).toBe("ready");
    fixture = { ...fixture, items: proposal.items, sessions: proposal.sessions };
    expect(fixture.items[0]).toMatchObject({ estimatedMinutes: null, remainingMinutes: null, windowEnd: "2026-12-31", forecastDate: null });
    await route.fulfill({ json: { interpretation, proposal, state: fixture, replyToOperationId: null } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Ask ADA", exact: true }).click();
  const dialog = page.getByRole("dialog");
  for (const [index, text] of requests.entries()) {
    await dialog.getByLabel("Instruction for ADA", { exact: true }).fill(text);
    await dialog.getByRole("button", { name: "Send instruction", exact: true }).click();
    if (index === 0) await expect(dialog.getByText(question, { exact: true })).toBeVisible();
    else if (index < 3) await expect(dialog.getByText(/That session crosses your/)).toHaveCount(index);
    else await expect(dialog.getByText("Saved the ongoing project and four hours of work. The total remains unknown.", { exact: true })).toBeVisible();
    expect(count).toBe(index + 1);
  }
  expect(fixture.items).toHaveLength(1);
  expect(fixture.sessions).toHaveLength(2);
  await dialog.getByRole("button", { name: "Close dialog", exact: true }).click();
  await page.getByRole("button", { name: "Today", exact: true }).click();
  const calendar = page.getByLabel("Month workload calendar", { exact: true });
  await calendar.getByTitle(`Cedar Studio · ${title}`, { exact: true }).first().click();
  await expect(dialog.getByText("Hours added as needed", { exact: true }).first()).toBeVisible();
  await expect(dialog.getByText("4h", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Hours added as needed", { exact: true })).toHaveCount(2);
  await expect(dialog.getByText("Use Add hours or ask ADA. The project total can stay unknown.", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Schedule remaining work" })).toHaveCount(0);
  await dialog.screenshot({ path: testInfo.outputPath("ongoing-project-unknown-total-four-booked-hours.png") });
  await dialog.getByRole("button", { name: "Edit details", exact: true }).click();
  await expect(dialog.getByLabel("Project starts", { exact: true })).toHaveValue("2026-09-01");
  await expect(dialog.getByLabel(/^Remaining effort \(hours\)/)).toHaveCount(0);
  expect(await state(page.request)).toEqual(storedBefore);
});
