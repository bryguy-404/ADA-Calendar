export type Role = "owner" | "requester" | "viewer";
export type Category = "web" | "it" | "landings" | "software";
export type WorkStatus = "planned" | "in_progress" | "waiting" | "completed" | "cancelled";
export interface Actor { id: string; name: string; email: string; role: Role }
export interface Client { id: string; name: string; aliases: string[]; color?: string }
export interface Priority { id: string; label: string; rank: number }
export interface WorkspaceSettings {
  name: string; timeZone: string; weekdays: number[]; dayStart: string; dayEnd: string;
  lunchStart: string; lunchEnd: string; reserveStart: string; reserveMinutes: number; slotMinutes: number;
  weeklyDay: number; weeklyTime: string; aiWarningUsd: number; aiLimitUsd: number;
}
export interface ChecklistItem { id: string; title: string; done: boolean }
export interface WorkItem {
  id: string; clientId: string; title: string; description: string; category: Category;
  webKind: "edit" | "build" | null; requesterId: string | null; requestedBy: string;
  priorityId: string; requestedPriorityId: string | null; status: WorkStatus;
  estimatedMinutes: number | null; remainingMinutes: number | null;
  windowStart: string; windowEnd: string | null; targetDate: string | null; deadline: string | null;
  /** Display dates do not constrain bookings. Only deliberately chosen limits do. */
  dateConstraints?: { earliestStart: string | null; allowedDates: string[] };
  timelineMode?: "bookings" | "span";
  forecastDate: string | null; completedAt: string | null; blockedReason: string | null;
  minimumSessionMinutes: number; allowedDates: string[]; checklist: ChecklistItem[];
  /** Exact remaining reservation budget on each date; omitted means flexible placement. */
  dailyPlan?: { date: string; minutes: number }[];
  progressTotal: number | null; progressCompleted: number; updateDate: string | null;
  references: string[]; createdAt: string; updatedAt: string;
}
export interface WorkSession {
  id: string; workItemId: string; start: string; end: string; protected: boolean;
  status: "planned" | "completed" | "cancelled"; usesReserve: boolean;
  /** Owner-authorized focus minimum for this explicit booking, not the project. */
  focusOverrideMinutes?: number;
}
export interface UnavailableBlock { id: string; title: string; start: string; end: string; kind: "meeting" | "time_off" }
export interface ScheduleSnapshot {
  workspaceId: string; version: number; settings: WorkspaceSettings; clients: Client[];
  priorities: Priority[]; items: WorkItem[]; sessions: WorkSession[]; blocks: UnavailableBlock[];
}
/** Dates for initial placement or owner review, never saved project restrictions. */
export interface BookingWindow {
  startDate: string; endDate: string; dates?: string[];
}
/** Additional reservations only; this is not an estimate of the whole project. */
export interface SmartFitRequest {
  startDate: string; endDate: string; minutes: number;
  /** Optional sparse dates for this booking operation only, never project limits. */
  dates?: string[];
  distribution: "total" | "per_day"; resumeWaiting?: boolean;
}
export type WorkCommand =
  | { type: "create"; item: WorkItem; sessions?: WorkSession[]; smartFit?: SmartFitRequest; bookingWindow?: BookingWindow; urgent?: boolean; overrideProtected?: boolean; overrideDeadline?: boolean }
  | { type: "fit"; itemId: string; request: SmartFitRequest }
  /** Existing sessions only, in their requested chronological order on one day. */
  | { type: "reorder_day"; date: string; sessionIds: string[]; overrideProtected?: boolean }
  | { type: "resize_booking"; sessionId: string; minutes: number; overrideProtected?: boolean }
  | { type: "move_booking"; sessionId: string; date: string; minutes?: number; startTime?: string; overrideProtected?: boolean }
  /** Move one project's booked day, splitting into openings while preserving its total. */
  | { type: "move_bookings"; sessionIds: string[]; date: string }
  | { type: "add_booking"; itemId: string; request: SmartFitRequest }
  | { type: "set_day_hours"; itemId: string; days: { date: string; minutes: number }[]; overrideProtected?: boolean }
  | { type: "update"; itemId: string; patch: Partial<WorkItem>; overrideProtected?: boolean; overrideDeadline?: boolean }
  | { type: "schedule"; itemId: string; sessions?: WorkSession[]; urgent?: boolean; overrideProtected?: boolean; overrideDeadline?: boolean }
  | { type: "move"; sessionId: string; start: string; end: string; overrideProtected?: boolean; overrideDeadline?: boolean }
  | { type: "progress"; itemId: string; remainingMinutes?: number; progressCompleted?: number; checklist?: ChecklistItem[] }
  | { type: "complete_session"; sessionId: string; remainingMinutes?: number }
  /** Record all still-planned hours for one work item/day as completed. */
  | { type: "complete_day"; itemId: string; date: string }
  | { type: "status"; itemId: string; status: WorkStatus; reason?: string; remainingMinutes?: number; overrideProtected?: boolean }
  | { type: "client_update"; itemId: string; message: string }
  | { type: "block"; block: UnavailableBlock; remove?: boolean; overrideProtected?: boolean; overrideDeadline?: boolean };
export interface ScheduleConflict { code: string; message: string; itemIds: string[] }
export interface ScheduleAlternative { start: string; end: string; label: string; sessions: WorkSession[] }
export interface ScheduleProposal {
  id: string; operationId: string; baseVersion: number; actorId: string; commands: WorkCommand[];
  reviewFingerprint?: string;
  status: "ready" | "approval_required" | "infeasible"; requiresApproval: boolean;
  items: WorkItem[]; sessions: WorkSession[]; blocks: UnavailableBlock[];
  affectedItemIds: string[]; summary: string[]; conflicts: ScheduleConflict[];
  alternatives: ScheduleAlternative[]; createdAt: string;
}
export interface WorkEvent {
  id: string; operationId: string; actorId: string; actorName: string; type: string;
  summary: string[]; itemIds: string[]; createdAt: string; version: number;
  before: { items: WorkItem[]; sessions: WorkSession[]; blocks: UnavailableBlock[] };
  after: { items: WorkItem[]; sessions: WorkSession[]; blocks: UnavailableBlock[] };
  undoneBy: string | null;
  /** Derived from the saved command; never inferred from an event's prose. */
  completedDay?: { itemId: string; date: string };
}
export interface PendingRequest {
  id: string; requesterId: string; requesterName: string; proposal: ScheduleProposal;
  status: "pending" | "approved" | "declined" | "needs_information";
  note: string; createdAt: string; resolvedAt: string | null;
  /** Explicit requester replies and owner decision messages, never private notes. */
  conversation?: { author: "owner" | "requester"; message: string; createdAt: string }[];
}
export interface Notification {
  id: string; eventId: string; recipient: string; recipientName: string; subject: string; body: string;
  status: "queued" | "captured" | "sent" | "delivered" | "failed" | "uncertain" | "bounced";
  attempts: number; providerId: string | null; createdAt: string; lastError: string | null;
}
export interface Attachment {
  id: string; workItemId: string; name: string; contentType: string; size: number; path: string;
  uploadedBy: string; createdAt: string; removedAt: string | null;
}
export interface EmailDraft { id: string; authorId: string; itemId: string | null; subject: string; body: string; status: "draft" | "sent" | "dismissed"; createdAt: string }
export interface AppState extends ScheduleSnapshot {
  actor: Actor; members: Actor[]; requests: PendingRequest[]; events: WorkEvent[];
  notifications: Notification[]; attachments: Attachment[]; emailDrafts: EmailDraft[];
  aiUsageUsd: number; mode: "demo" | "live";
}
export interface Interpretation {
  kind: "commands" | "clarification" | "email_draft" | "answer" | "undo";
  message: string; commands: WorkCommand[];
  emailDraft?: { itemId: string | null; subject: string; body: string };
  usage?: { inputTokens: number; outputTokens: number; costUsd: number };
}
