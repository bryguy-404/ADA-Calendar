/** Fictional test data only. No real account or website credentials. */
import { createDemoState } from "../fixtures";
import { localDateTime } from "../time";
import { newWorkItem } from "../work";
import type { WorkSession } from "../types";

export const date = "2026-11-02", now = "2026-11-02T13:00:00Z", origin = "https://calendar.example.test";
export const at = (day: string, clock: string) => localDateTime(day, clock, "America/Indiana/Indianapolis");
export function booking(id: string, day = date, status: WorkSession["status"] = "planned"): WorkSession {
  return { id: `${id}-${day}`, workItemId: id, start: at(day, "09:00"), end: at(day, "10:00"), status, protected: false, usesReserve: false };
}
export function fixture() {
  const state = createDemoState(now);
  state.mode = "live"; state.workspaceId = "fictional-workspace"; state.version = 17;
  state.settings.reserveMinutes = 0; state.blocks = []; state.sessions = []; state.attachments = [];
  state.items = [newWorkItem(state.actor, date, { id: "website", clientId: "becht", title: "FICTIONAL indexing and Carmel edits", estimatedMinutes: 120, remainingMinutes: 120, createdAt: now, updatedAt: now })];
  return state;
}
