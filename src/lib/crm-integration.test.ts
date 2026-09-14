import { describe, expect, it } from "vitest";
import { crmTaskInputSchema } from "./crm-integration";

const input = {
  externalTaskId: "crm-task-1", externalClientId: "crm-client-1", title: "Website update",
  category: "web", webKind: "edit", estimatedMinutes: 90,
  scheduling: { mode: "due_by", date: "2026-10-01" },
};

describe("CRM task request contract", () => {
  it("requires an estimate and treats a due date as firm by default", () => {
    expect(crmTaskInputSchema.parse(input).scheduling).toEqual({ mode: "due_by", date: "2026-10-01", flexible: false });
    for (const estimatedMinutes of [undefined, null, 0, -15, 16, 1.5, "90"])
      expect(crmTaskInputSchema.safeParse({ ...input, estimatedMinutes }).success).toBe(false);
  });
  it("accepts each explicit scheduling mode and rejects impossible dates and times", () => {
    for (const scheduling of [
      { mode: "due_by", date: "2026-10-01", flexible: true },
      { mode: "day", date: "2026-10-01" },
      { mode: "exact", date: "2026-10-01", startTime: "09:15" },
    ]) expect(crmTaskInputSchema.safeParse({ ...input, scheduling }).success).toBe(true);
    for (const scheduling of [
      { mode: "day", date: "2026-02-30" },
      { mode: "exact", date: "2026-10-01", startTime: "25:00" },
      { mode: "exact", date: "2026-10-01", startTime: "09:07" },
      { mode: "day", date: "2026-10-01", flexible: true },
    ]) expect(crmTaskInputSchema.safeParse({ ...input, scheduling }).success).toBe(false);
  });
  it("rejects caller-supplied identity, override authority and schedule snapshots", () => {
    for (const field of ["requesterId", "actorId", "role", "overrideProtected", "overrideDeadline", "commands", "sessions", "workspaceId"])
      expect(crmTaskInputSchema.safeParse({ ...input, [field]: "forged" }).success).toBe(false);
    expect(crmTaskInputSchema.safeParse({ ...input, category: "it" }).success).toBe(false);
    expect(crmTaskInputSchema.safeParse({ ...input, estimatedMinutes: 600, scheduling: { mode: "day", date: "2026-10-01" } }).success).toBe(false);
  });
});
