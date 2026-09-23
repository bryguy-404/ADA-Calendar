import { expect, test } from "@playwright/test";
import { createDemoState } from "../../src/lib/fixtures";
import { planCommands } from "../../src/lib/scheduler";
import { withReviewFingerprint } from "../../src/lib/server/preview";
import { localDateTime } from "../../src/lib/time";
import { newWorkItem } from "../../src/lib/work";
import type { AppState } from "../../src/lib/types";
import { asActor, origin, state } from "./helpers";

// Isolated browser records with real shared scheduling; no external providers.
const day = "2026-09-14", tomorrow = "2026-09-15", title = "Fictional afternoon edits";
const at = (clock: string, date = day) => localDateTime(date, clock, "America/Indiana/Indianapolis");

for (const width of [1440, 390]) {
  test(`finishing work frees only future time and hours keep shrinking without reload at ${width}px`, async ({ page }, info) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await asActor(page.request, "bryan");
    const stored = await state(page.request); expect(stored.mode).toBe("demo");
    let fixture: AppState = { ...createDemoState(at("16:00")), workspaceId: stored.workspaceId, actor: stored.actor,
      clients: [{ id: "fictional", name: "Fictional Client", aliases: [] }], items: [], sessions: [], blocks: [], events: [], requests: [], notifications: [], attachments: [], emailDrafts: [] };
    fixture.settings.reserveMinutes = 0;
    fixture.items = [newWorkItem(fixture.actor, day, { id: "afternoon", clientId: "fictional", title, timelineMode: "bookings", estimatedMinutes: 180, remainingMinutes: 180 })];
    fixture.sessions = [
      { id: "today", workItemId: "afternoon", start: at("14:30"), end: at("16:30"), status: "planned", protected: false, usesReserve: false },
      { id: "tomorrow", workItemId: "afternoon", start: at("09:00", tomorrow), end: at("10:00", tomorrow), status: "planned", protected: false, usesReserve: false },
    ];
    const original = structuredClone(fixture);
    await page.route(`${origin}/api/state`, route => route.fulfill({ json: fixture }));
    await page.route(`${origin}/api/commands`, async route => {
      const body = route.request().postDataJSON();
      const now = await page.evaluate(() => new Date().toISOString());
      const proposal = withReviewFingerprint(planCommands(fixture, body.commands, fixture.actor, { now, operationId: body.operationId }));
      expect(proposal.status, JSON.stringify(proposal.conflicts)).toBe("ready");
      if (body.action === "commit") {
        expect(body.reviewFingerprint).toBe(proposal.reviewFingerprint);
        fixture = { ...fixture, version: fixture.version + 1, items: proposal.items, sessions: proposal.sessions, blocks: proposal.blocks };
      }
      await route.fulfill({ json: { proposal, state: fixture } });
    });
    await page.clock.install({ time: new Date(at("15:59")) });
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/");
    if (width <= 760) await expect(page.getByRole("button", { name: "agenda", exact: true })).toHaveClass(/active/);
    await page.getByRole("button", { name: "month", exact: true }).click();
    // Let hydration and the mobile animation frame finish before freezing time.
    await page.clock.pauseAt(new Date(at("16:00")));
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    // Hydration starts on the server's date; select the simulated browser day
    // before checking views that show only sessions from the selected date.
    await page.getByRole("button", { name: "Today", exact: true }).click();
    const calendar = page.getByLabel("Month workload calendar", { exact: true });
    const today = calendar.getByRole("button", { name: /^Monday, September 14,/ });
    await expect(today).toHaveAttribute("aria-label", "Monday, September 14, 0.5h available, 2h planned");
    await expect(calendar.getByRole("button", { name: /^Friday, September 11,/ })).toHaveAttribute("aria-label", "Friday, September 11, 0h available, 0h planned");
    await expect(calendar.getByRole("button", { name: /^Tuesday, September 15,/ })).toHaveAttribute("aria-label", "Tuesday, September 15, 6.5h available, 1h planned");
    await calendar.getByTitle(`Fictional Client · ${title}`, { exact: true }).first().focus(); await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: title, exact: true });
    const row = dialog.locator(`[data-work-date="${day}"]`);
    await row.getByRole("button", { name: "Finish this day", exact: true }).click();
    await row.getByRole("button", { name: "Confirm day finished", exact: true }).click();
    await expect(row).toContainText("2h done");
    await dialog.getByRole("button", { name: "Close dialog", exact: true }).click();
    await expect(today).toHaveAttribute("aria-label", "Monday, September 14, 1h available, 0h planned");
    expect(fixture.items[0].remainingMinutes).toBe(60);
    expect(fixture.sessions[1]).toEqual(original.sessions[1]);
    await today.scrollIntoViewIfNeeded();
    await today.locator("..").screenshot({ path: info.outputPath(`four-pm-after-completion-${width}.png`) });
    const saved = structuredClone(fixture);
    await page.clock.fastForward(30 * 60_000);
    await expect(today).toHaveAttribute("aria-label", "Monday, September 14, 0.5h available, 0h planned");
    await page.getByRole("button", { name: "agenda", exact: true }).click();
    await expect(page.locator(".agenda h3").first()).toContainText("0h work planned · 0.5h left");
    await page.clock.fastForward(30 * 60_000);
    await expect(page.locator(".agenda h3").first()).toContainText("0h work planned · 0h left");
    await page.getByRole("button", { name: "month", exact: true }).click();
    await expect(today).toHaveAttribute("aria-label", "Monday, September 14, 0h available, 0h planned");
    await expect(calendar.getByRole("button", { name: /^Tuesday, September 15,/ })).toHaveAttribute("aria-label", "Tuesday, September 15, 6.5h available, 1h planned");
    expect(fixture).toEqual(saved);
    expect(errors).toEqual([]);
    expect(await state(page.request)).toEqual(stored);
  });
}
