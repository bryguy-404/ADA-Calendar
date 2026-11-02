import { expect, test } from "@playwright/test";
import { conversationText, nextContinuation } from "../../src/lib/assistant-conversation";
import { createDemoState } from "../../src/lib/fixtures";
import { planCommands } from "../../src/lib/scheduler";
import { compileInterpretation, emptyAssistantAction } from "../../src/lib/server/assistant";
import type { AppState } from "../../src/lib/types";
import { newWorkItem } from "../../src/lib/work";
import { asActor, origin, state } from "./helpers";

test("offline waiting-project clarification preserves a separate project and two-month display span", async ({ page, baseURL }, testInfo) => {
  expect(baseURL).toBe(origin);
  await asActor(page.request, "bryan");
  const storedBefore = await state(page.request);
  expect(storedBefore.mode).toBe("demo");
  const now = new Date("2026-09-08T16:00:00Z");
  await page.clock.setFixedTime(now);
  const client = { id: "fictional-birch", name: "Birch Meadow Labs", aliases: [] };
  const title = "Guest Follow-up Connector";
  const demo = createDemoState(now.toISOString());
  const existing = newWorkItem(demo.actor, "2026-09-08", {
    id: "fictional-existing", clientId: client.id, title: "Fleet Health Dashboard", category: "software", webKind: null,
    status: "waiting", estimatedMinutes: null, remainingMinutes: null, windowEnd: "2026-10-31",
  });
  let fixture: AppState = { ...demo, clients: [client], items: [existing], sessions: [], blocks: [], events: [], notifications: [], requests: [], emailDrafts: [], attachments: [] };
  const original = "Software project Guest Follow-up Connector integrates a sample service. Expected project context is the rest of September and October 2026, but specific work dates and hours are awaiting client details. This is a separate task from Fleet Health Dashboard.";
  const reply = `${client.name} ${title}`;
  const question = "Which client and task title?";
  const clarification = { kind: "clarification" as const, message: question, commands: [] };
  const continuation = nextContinuation(original, clarification, now)!;
  const pendingId = "00000000-0000-4000-8000-000000000002";
  let assistantRequests = 0;

  // Fictional, browser-local state. Provider and HTTP are mocked; the actual
  // conversation compiler and scheduler run without persistence or email sends.
  await page.route(`${origin}/api/assistant`, async route => {
    const body = route.request().postDataJSON();
    assistantRequests++;
    if (assistantRequests === 1) {
      expect(body.text).toBe(original);
      return route.fulfill({ json: { interpretation: clarification, state: fixture, replyToOperationId: pendingId } });
    }
    expect(body.text).toBe(reply);
    expect(body.replyToOperationId).toBe(pendingId);
    const evidence = conversationText(reply, continuation);
    const interpretation = compileInterpretation({ kind: "commands", message: "Saved the separate waiting project. No hours booked.", actions: [{
      ...emptyAssistantAction("create", reply), clientName: client.name, title, category: "software",
    }], draft: null }, evidence, fixture, fixture.actor, now, reply);
    expect(interpretation.kind).toBe("commands");
    const proposal = planCommands(fixture, interpretation.commands, fixture.actor, { now: now.toISOString() });
    expect(proposal.status, JSON.stringify(proposal.conflicts)).toBe("ready");
    expect(proposal.items).toHaveLength(2);
    expect(proposal.items[0]).toEqual(existing);
    expect(proposal.items[1]).toMatchObject({ title, status: "waiting", estimatedMinutes: null, remainingMinutes: null, windowStart: "2026-09-08", windowEnd: "2026-10-31", targetDate: null, deadline: null });
    expect(proposal.sessions).toEqual([]);
    fixture = { ...fixture, items: proposal.items, sessions: proposal.sessions, blocks: proposal.blocks };
    await route.fulfill({ json: { interpretation, proposal, state: fixture, replyToOperationId: null } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Ask ADA", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Instruction for ADA", { exact: true }).fill(original);
  await dialog.getByRole("button", { name: "Send instruction", exact: true }).click();
  await expect(dialog.getByText(question, { exact: true })).toBeVisible();
  await dialog.getByLabel("Instruction for ADA", { exact: true }).fill(reply);
  await dialog.getByRole("button", { name: "Send instruction", exact: true }).click();
  await expect(dialog.getByText("Saved the separate waiting project. No hours booked.", { exact: true })).toBeVisible();
  expect(assistantRequests).toBe(2);
  await dialog.getByRole("button", { name: "Close dialog", exact: true }).click();
  await page.getByRole("button", { name: "Today", exact: true }).click();
  const calendar = page.getByLabel("Month workload calendar", { exact: true });
  // The six-week grid includes the beginning of the following month.
  await expect(calendar.getByTitle(`${client.name} · ${title}`, { exact: true })).toHaveCount(5);
  await expect(calendar.getByTitle(`${client.name} · ${existing.title}`, { exact: true })).toHaveCount(5);
  await expect(calendar.locator(".ribbon-reserved")).toHaveCount(0);
  await calendar.screenshot({ path: testInfo.outputPath("separate-waiting-projects-september.png") });
  await page.getByRole("button", { name: "Next period", exact: true }).click();
  await expect(page.getByText("October 2026", { exact: true })).toBeVisible();
  await expect(calendar.getByTitle(`${client.name} · ${title}`, { exact: true })).toHaveCount(5);
  await expect(calendar.locator(".ribbon-reserved")).toHaveCount(0);
  await calendar.screenshot({ path: testInfo.outputPath("waiting-projects-october.png") });
  expect(await state(page.request)).toEqual(storedBefore);
});
