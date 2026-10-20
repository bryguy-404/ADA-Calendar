import type { WorkActivity, WorkEvent } from "./types";

export function hasEventSnapshots(event: WorkActivity): event is WorkEvent {
  return !!event.before && !!event.after;
}

/** Project only the visible activity fields. Never change the stored event. */
export function activitySummary(event: WorkActivity): WorkActivity {
  return {
    id: event.id, operationId: event.operationId, actorId: event.actorId, actorName: event.actorName,
    type: event.type, summary: event.summary, itemIds: event.itemIds, createdAt: event.createdAt,
    version: event.version, undoneBy: event.undoneBy, completedDay: event.completedDay,
  };
}

export function compactActivity(events: WorkEvent[]): WorkActivity[] {
  const latestVersion = events.reduce((latest, event) => Math.max(latest, event.version), -1);
  return events.map(event => event.version === latestVersion ? event : activitySummary(event));
}
