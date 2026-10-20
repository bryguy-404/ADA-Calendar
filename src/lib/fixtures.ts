import type { Actor, AppState, WorkEvent, WorkItem, WorkSession } from "./types";
import { DEFAULT_PRIORITIES, DEFAULT_SETTINGS } from "./defaults";
import { addDays, localDate, localDateTime, nextWorkDate } from "./time";
import { newWorkItem } from "./work";

export const DEMO_MEMBERS: Actor[] = [
  { id: "bryan", name: "Bryan", email: "bryan@example.test", role: "owner" },
  { id: "kyle", name: "Kyle", email: "kyle@example.test", role: "requester" },
  { id: "william", name: "William", email: "william@example.test", role: "requester" },
  { id: "viewer", name: "Teammate", email: "viewer@example.test", role: "viewer" },
];

/** Fictional example work, isolated from real memberships and outgoing delivery. */
export function createDemoState(now = new Date().toISOString()): AppState & { events: WorkEvent[] } {
  const today = localDate(now, DEFAULT_SETTINGS.timeZone);
  const start = nextWorkDate(addDays(today, 1), DEFAULT_SETTINGS);
  const yearMonth = start.slice(0, 7);
  const monthEnd = addDays(`${Number(start.slice(0, 4)) + (start.slice(5, 7) === "12" ? 1 : 0)}-${String(Number(start.slice(5, 7)) % 12 + 1).padStart(2, "0")}-01`, -1);
  // Count distinct working days. Adding calendar days and then clamping each
  // weekend date to Monday would stack several fictional sessions together.
  const next = (offset: number) => {
    let date = start;
    for (let day = 0; day < offset; day++) date = nextWorkDate(addDays(date, 1), DEFAULT_SETTINGS);
    return date;
  };
  const mk = (id: string, patch: Partial<WorkItem>) => newWorkItem(DEMO_MEMBERS[0], start, { id, ...patch });
  const items: WorkItem[] = [
    mk("drive-software", { clientId: "drive-shine", title: "Oil change survey software", category: "software", webKind: null,
      description: "Example project: connect the oil-change survey workflow, test API responses, and verify the customer experience. Protected focus sessions are separate from this month-long project span.",
      windowStart: `${yearMonth}-01`, windowEnd: monthEnd, targetDate: monthEnd, priorityId: "high", minimumSessionMinutes: 120, estimatedMinutes: 2400, remainingMinutes: 1800, status: "in_progress" }),
    mk("laville-build", { clientId: "laville", title: "New website build", webKind: "build", priorityId: "high", estimatedMinutes: 1800, remainingMinutes: 1200, minimumSessionMinutes: 120, windowEnd: addDays(start, 18), targetDate: addDays(start, 18), status: "in_progress", description: "Example work: design and build the new client website. Content review is a separate checkpoint." }),
    mk("higher-ground-edit", { clientId: "higher-ground", title: "Thank-you page & email forwarding", estimatedMinutes: 120, remainingMinutes: 120, windowEnd: next(1), description: "Example request: update the thank-you page and forward the retired mailbox to the replacement address." }),
    ...["tech-tyler", "becht", "z-roofing", "oral-surgery", "pura-vida", "kc-orthodontics"].map((clientId, i) => mk(`landings-${i}`, {
      clientId, title: ["South Bend service landings", "Neighborhood landing batch", "Location landing batch", "New service pages", "Neighborhood pages", "Service landing batch"][i],
      category: "landings", webKind: null, requestedBy: "William", requesterId: "william",
      estimatedMinutes: 360, remainingMinutes: 240, windowStart: start, windowEnd: next(8), targetDate: next(8), updateDate: next(4),
      progressTotal: 8, progressCompleted: 2, minimumSessionMinutes: 60, description: "Example batch. The weekly update checkpoint is not a deadline for every page.",
      checklist: [{ id: `page-${i}-1`, title: "Draft first service page", done: true }, { id: `page-${i}-2`, title: "Build location variants", done: false }, { id: `page-${i}-3`, title: "QA forms and links", done: false }],
    })),
    mk("waiting-software", { clientId: "agency", title: "Internal reporting integration", category: "software", webKind: null,
      status: "waiting", blockedReason: "Waiting for API credentials from the client", estimatedMinutes: 480, remainingMinutes: 360, minimumSessionMinutes: 120, windowEnd: monthEnd }),
  ];
  const session = (id: string, workItemId: string, date: string, startTime: string, endTime: string, protect = false): WorkSession => ({
    id, workItemId, start: localDateTime(date, startTime, DEFAULT_SETTINGS.timeZone), end: localDateTime(date, endTime, DEFAULT_SETTINGS.timeZone),
    protected: protect, status: "planned", usesReserve: false,
  });
  const sessions = [
    session("demo-1", "laville-build", start, "09:00", "12:00", true),
    session("demo-2", "landings-0", start, "12:30", "14:30"),
    session("demo-3", "higher-ground-edit", next(1), "09:00", "11:00"),
    session("demo-4", "landings-1", next(1), "12:30", "14:30"),
    session("demo-5", "drive-software", next(2), "09:00", "12:00", true),
    session("demo-6", "drive-software", next(2), "12:30", "16:00", true),
    session("demo-7", "landings-2", next(3), "09:00", "11:00"),
    session("demo-8", "landings-3", next(3), "12:30", "14:30"),
    session("demo-9", "drive-software", next(4), "09:00", "12:00", true),
    session("demo-10", "landings-4", next(7), "09:00", "11:00"),
    session("demo-11", "landings-5", next(7), "12:30", "14:30"),
  ];
  return {
    workspaceId: "demo-workspace", version: 0, settings: structuredClone(DEFAULT_SETTINGS), clients: [
      { id: "drive-shine", name: "Drive & Shine", aliases: ["Drive and Shine", "car wash"] },
      { id: "higher-ground", name: "Higher Ground Tree", aliases: ["Higher Ground"] },
      { id: "laville", name: "Laville", aliases: [] },
      { id: "tech-tyler", name: "Tech Tyler", aliases: ["Tyler"] },
      { id: "becht", name: "Becht", aliases: [] }, { id: "z-roofing", name: "Z Roofing", aliases: [] },
      { id: "oral-surgery", name: "Oral Surgery", aliases: [] }, { id: "pura-vida", name: "Pura Vida", aliases: [] },
      { id: "kc-orthodontics", name: "KC Orthodontics", aliases: [] }, { id: "agency", name: "Agency · internal", aliases: ["internal"] },
    ], priorities: structuredClone(DEFAULT_PRIORITIES), items, sessions, blocks: [], actor: DEMO_MEMBERS[0], members: DEMO_MEMBERS,
    requests: [], events: [], notifications: [], attachments: [], emailDrafts: [], aiUsageUsd: 0, mode: "demo",
  };
}
