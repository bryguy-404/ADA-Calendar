import { describe, expect, it } from "vitest";
import { dayAgenda, workBundle } from "./projection";
import { at, booking, date, fixture, now, origin } from "./test-fixtures";
import { emptyWorkContext } from "../work-context";
import { minutesBetween } from "../time";

describe("read-only coordination projections", () => {
  it("selects local dates, clips overnight bookings and never turns spans or elapsed time into work", () => {
    const state = fixture(), before = structuredClone(state);
    state.items.push({ ...state.items[0], id: "span-only", windowEnd: "2026-11-30", timelineMode: "span" });
    state.sessions = [booking("website"), { ...booking("website", "2026-11-01"), start: at("2026-11-01", "23:30"), end: at(date, "00:30") }, booking("website", "2026-11-03")];
    const snapshot = structuredClone(state), result = dayAgenda(state, date, origin, now);
    expect(result.websiteWork).toHaveLength(1);
    expect(result.websiteWork[0]).toMatchObject({ workItemId: "website", plannedMinutes: 90, status: "planned" });
    expect(result.websiteWork[0].sessions).toHaveLength(2);
    expect(result.source).toMatchObject({ retrievedAt: now, scheduleVersion: 17, timeZone: "America/Indiana/Indianapolis" });
    expect(state).toEqual(snapshot); expect(state.settings).toEqual(before.settings);
  });
  it.each([["2026-03-08", 23], ["2026-11-01", 25]])("uses real local midnight bounds across DST on %s", (day, hours) => {
    const { range } = dayAgenda(fixture(), String(day), origin, now);
    expect(minutesBetween(range.start, range.endExclusive)).toBe(Number(hours) * 60);
  });
  it("keeps IT indexing/domain tasks visible for classification while software and explicit manual flags stay manual", () => {
    const state = fixture(); state.items[0].category = "it";
    state.items.push({ ...state.items[0], id: "software", category: "software", title: "FICTIONAL Drive & Shine surveys" },
      { ...state.items[0], id: "manual", category: "web", workContext: { ...emptyWorkContext(), manualOnly: true } });
    state.sessions = state.items.map(item => booking(item.id));
    const before = structuredClone(state), agenda = dayAgenda(state, date, origin, now);
    expect(agenda.needsClassification).toHaveLength(1);
    expect(agenda.needsClassification[0]).toMatchObject({ category: "it", workItemId: "website", coordination: { handling: "needs_classification", automaticExecutionAllowed: false } });
    expect(agenda.manualWork.map(item => item.workItemId)).toEqual(["manual", "software"]);
    expect(agenda.websiteWork).toEqual([]); expect(state).toEqual(before);
  });
  it("retains explicitly completed sessions and zero-hour markers, hides cancellations, and never verifies an external result", () => {
    const state = fixture(); state.items[0].status = "completed"; state.items[0].completedAt = at(date, "10:00");
    state.items.push({ ...state.items[0], id: "no-hours" });
    state.sessions = [booking("website", date, "completed"), booking("website", "2026-11-03", "cancelled")];
    const agenda = dayAgenda(state, date, origin, now);
    expect(agenda.websiteWork).toHaveLength(2);
    expect(agenda.websiteWork.find(item => item.workItemId === "website")).toMatchObject({ plannedMinutes: 0, completionMarker: false });
    expect(agenda.websiteWork.find(item => item.workItemId === "no-hours")).toMatchObject({ plannedMinutes: 0, completionMarker: true });
    const bundle = workBundle(state, "website", origin, now);
    expect(bundle.sessions).toHaveLength(2); expect(bundle.completion.independentlyVerified).toBe(false);
    expect(dayAgenda(state, "2026-11-03", origin, now).websiteWork).toEqual([]);
  });
  it("preserves original references and stable IDs across reordering, with explicit provenance and no assumed access", () => {
    const state = fixture(); state.items[0].references = ["https://docs.google.com/document/d/fictional", "Original email: clarification pending"];
    state.items[0].workContext = { ...emptyWorkContext(), materialsStatus: "missing", materialsNote: "Copy not received" };
    const first = workBundle(state, "website", origin, now);
    state.items[0].references.reverse();
    const second = workBundle(state, "website", origin, now);
    expect(second.references).toEqual([...first.references].reverse());
    expect(first.references[0]).toMatchObject({ original: state.items[0].references[1], access: "not_checked", contentRetrieved: false, source: { workItemId: "website", field: "references" } });
    expect(first.coordination.context).toMatchObject({ requirementsStatus: "tentative", materialsStatus: "missing" });
    expect(first).not.toHaveProperty("events"); expect(first).not.toHaveProperty("emailDrafts");
  });
  it("lists only associated active attachments and refuses unknown work", () => {
    const state = fixture(); const file = { id: "asset", workItemId: "website", name: "original.md", contentType: "text/markdown", size: 42, path: "private/path", uploadedBy: "bryan", createdAt: now, removedAt: null };
    state.attachments = [file, { ...file, id: "other", workItemId: "other-item" }, { ...file, id: "removed", removedAt: now }];
    const bundle = workBundle(state, "website", origin, now);
    expect(bundle.materials).toHaveLength(1); expect(bundle.materials[0]).not.toHaveProperty("path");
    expect(bundle.materials[0].availability).toBe("listed_not_yet_retrieved");
    expect(() => workBundle(state, "unknown", origin, now)).toThrow("unavailable");
  });
});
