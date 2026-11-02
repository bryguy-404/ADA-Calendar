import { describe, expect, it } from "vitest";
import { emptyWorkContext, workContextSchema } from "./work-context";
import { workItemSchema } from "./schemas";
import { planCommands } from "./scheduler";
import { booking, date, fixture, now } from "./mcp/test-fixtures";

describe("optional website work context", () => {
  it("accepts legacy items and validates bounded descriptive fields without embedded URL credentials", () => {
    const state = fixture(); expect(workItemSchema.parse(state.items[0])).not.toHaveProperty("workContext");
    expect(workContextSchema.parse(emptyWorkContext()).requirementsStatus).toBe("tentative");
    for (const websiteUrl of ["javascript:alert(1)", "https://user:secret@example.test", "not a URL"])
      expect(workContextSchema.safeParse({ ...emptyWorkContext(), websiteUrl }).success).toBe(false);
    expect(workContextSchema.safeParse({ ...emptyWorkContext(), requestedResult: "x".repeat(4001) }).success).toBe(false);
    expect(workContextSchema.safeParse({ ...emptyWorkContext(), execute: true }).success).toBe(false);
  });
  it("updates context through the owner scheduler without moving bookings or changing completed history/settings", () => {
    const state = fixture(); state.sessions = [booking("website"), booking("website", "2026-10-30", "completed")];
    const before = structuredClone(state), workContext = { ...emptyWorkContext(), websiteUrl: "https://fictional.example", requestedResult: "Fix indexing", progressNote: "Audit reported; publish still pending" };
    const result = planCommands(state, [{ type: "update", itemId: "website", patch: { workContext } }], state.actor, { now });
    expect(result.status).toBe("ready"); expect(result.items[0].workContext).toEqual(workContext);
    expect(result.sessions).toEqual(state.sessions); expect(state).toEqual(before);
    const updated = { ...state, items: result.items, sessions: result.sessions };
    const day = planCommands(updated, [{ type: "complete_day", itemId: "website", date }], state.actor, { now });
    expect(day.status).toBe("ready"); expect(day.items[0]).toMatchObject({ status: "planned", workContext, remainingMinutes: 60 });
    const complete = planCommands({ ...updated, items: day.items, sessions: day.sessions }, [{ type: "status", itemId: "website", status: "completed" }], state.actor, { now });
    expect(complete.status).toBe("ready"); expect(complete.items[0]).toMatchObject({ status: "completed", workContext });
    expect(complete.sessions.filter(s => s.status === "completed")).toHaveLength(2);
  });
  it.each(["requester", "viewer"] as const)("does not let a %s edit existing context", role => {
    const state = fixture(), result = planCommands(state, [{ type: "update", itemId: "website", patch: { workContext: emptyWorkContext() } }], { ...state.actor, role }, { now });
    expect(result.status).not.toBe("ready"); expect(result.items).toEqual(state.items);
  });
});
