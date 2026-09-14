import { z } from "zod";
import { dateSchema, idSchema } from "./schemas";
import { addDays, isDate } from "./time";

export const CRM_API_VERSION = "1" as const;
export const CRM_PREVIEW_TTL_MINUTES = 15;

/** External input is a task request, never a WorkCommand or a schedule snapshot. */
export const crmTaskInputSchema = z.object({
  externalTaskId: idSchema,
  externalClientId: idSchema,
  title: z.string().trim().min(1).max(200),
  description: z.string().max(30_000).default(""),
  category: z.enum(["web", "it", "landings", "software"]),
  webKind: z.enum(["edit", "build"]).nullable().default(null),
  estimatedMinutes: z.number().int().min(15).max(100_000).multipleOf(15),
  requestedPriorityId: idSchema.optional(),
  scheduling: z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("due_by"), date: dateSchema, flexible: z.boolean().default(false) }).strict(),
    z.object({ mode: z.literal("day"), date: dateSchema }).strict(),
    z.object({
      mode: z.literal("exact"), date: dateSchema,
      startTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)
        .refine(time => Number(time.slice(3)) % 15 === 0, "Choose a 15-minute increment."),
    }).strict(),
  ]),
}).strict().superRefine((input, ctx) => {
  if (input.category !== "web" && input.webKind !== null)
    ctx.addIssue({ code: "custom", path: ["webKind"], message: "Web kind applies only to web work." });
  if (input.scheduling.mode !== "due_by" && input.estimatedMinutes > 480)
    ctx.addIssue({ code: "custom", path: ["estimatedMinutes"], message: "One-day requests cannot exceed eight hours." });
});

export type CrmTaskInput = z.infer<typeof crmTaskInputSchema>;

/** SQL uses the same pinned hosted Auth URL restriction; never fetch a caller's URL. */
export const crmAuthUrlSchema = z.string().regex(/^https:\/\/[a-z0-9-]+\.supabase\.co$/);
export const crmOriginSchema = z.string().url().refine(value => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === value && !url.username && !url.password;
  } catch { return false; }
}, "Use a canonical HTTPS origin without a path.");
export const crmAgencyDomainSchema = z.string().regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/);

export interface CrmRequester {
  subject: string;
  email: string;
  /** Verified email is the safe fallback; user-editable profile metadata is not authority. */
  name: string;
}

/** Private server data. Never add this shape to browser AppState. */
export interface CrmConnection {
  id: string;
  workspaceId: string;
  principalUserId: string;
  crmOrigin: string;
  crmAuthUrl: string;
  crmPublicKey: string;
  agencyDomain: string;
  credentialHash: string;
  enabled: boolean;
}

export interface CrmAuthenticatedContext {
  connection: CrmConnection;
  requester: CrmRequester;
}

export interface CrmStatus {
  apiVersion: typeof CRM_API_VERSION;
  status: "authenticated";
  bookingEnabled: boolean;
  capabilities: readonly ("connection_check" | "availability" | "previews" | "bookings" | "requests" | "replies" | "operations" | "changes")[];
}

export const crmAvailabilityQuerySchema = z.object({ startDate: dateSchema, endDate: dateSchema }).strict()
  .refine(value => !isDate(value.startDate) || !isDate(value.endDate) || value.endDate >= value.startDate && value.endDate <= addDays(value.startDate, 30), "Choose a range of up to 31 days.");
export interface CrmTimeRange { start: string; end: string }
export interface CrmVisibleWork {
  workItemId: string; title: string; client: { id: string; name: string };
  sessions: CrmTimeRange[];
}
export interface CrmAvailability {
  apiVersion: "1"; bookingEnabled: boolean; timeZone: string; asOf: string; baseVersion: number;
  days: {
    date: string; capacityMinutes: number; plannedMinutes: number; availableMinutes: number;
    openings: CrmTimeRange[]; work: CrmVisibleWork[];
    unavailable: (CrmTimeRange & { title: "Unavailable" })[];
  }[];
}
export interface CrmPreview {
  apiVersion: "1"; previewId: string; bookingEnabled: boolean; timeZone: string;
  createdAt: string; expiresAt: string; baseVersion: number;
  status: "fits" | "needs_approval" | "cannot_fit";
  task: { externalTaskId: string; title: string; client: { id: string; name: string }; estimatedMinutes: number; scheduling: CrmTaskInput["scheduling"] };
  proposedSessions: CrmTimeRange[];
  changes: (Omit<CrmVisibleWork, "sessions"> & { before: CrmTimeRange[]; after: CrmTimeRange[] })[];
  conflicts: { code: string; message: string }[];
  alternatives: {
    scheduling: CrmTaskInput["scheduling"]; sessions: CrmTimeRange[];
    requiresDateChange: boolean; requiresDeadlineChange: boolean;
  }[];
}

export const crmSubmissionSchema = z.object({ operationId: z.uuid(), previewId: z.uuid(), note: z.string().trim().max(5000).default("") }).strict();
export const crmReplySchema = z.object({ operationId: z.uuid(), externalTaskId: idSchema, message: z.string().trim().min(1).max(5000) }).strict();
export type CrmSubmission = z.infer<typeof crmSubmissionSchema>;

/** Parse responses too: accidental extra private fields are never forwarded. */
export const crmPublicTaskSchema = z.object({
  externalTaskId: idSchema, workItemId: idSchema.nullable(), requestId: idSchema.nullable(),
  requestStatus: z.enum(["pending", "approved", "declined", "needs_information"]).nullable(),
  status: z.enum(["planned", "in_progress", "waiting", "completed", "cancelled", "pending", "declined", "needs_information", "unbooked"]),
  title: z.string(), client: z.object({ id: idSchema, name: z.string() }),
  estimatedMinutes: z.number().nullable(), remainingMinutes: z.number().nullable(), priorityId: idSchema.nullable(),
  targetDate: dateSchema.nullable(), deadline: dateSchema.nullable(), forecastDate: dateSchema.nullable(),
  timeZone: z.string(), version: z.number().int().nonnegative(), decisionNote: z.string().nullable(),
  sessions: z.array(z.object({ start: z.string(), end: z.string(), status: z.enum(["planned", "completed", "cancelled"]) })),
});
export const crmOperationResultSchema = z.object({ apiVersion: z.literal("1"), operationId: z.uuid(), status: z.literal("completed"), sequence: z.number().int().positive(), task: crmPublicTaskSchema });
export type CrmOperationResult = z.infer<typeof crmOperationResultSchema>;
