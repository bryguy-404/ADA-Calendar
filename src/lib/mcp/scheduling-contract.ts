import { z } from "zod";
import { dateSchema, idSchema, instantSchema, reviewFingerprintSchema, smartFitRequestSchema, workItemSchema } from "../schemas";
import { addDays } from "../time";

export const discoverySchema = z.object({
  kind: z.enum(["clients", "tasks"]), query: z.string().max(150).default(""), clientId: idSchema.optional(),
  status: z.enum(["active", "all", "waiting", "completed", "cancelled"]).default("active"),
  unscheduledOnly: z.boolean().default(false), limit: z.number().int().min(1).max(25).default(15),
  offset: z.number().int().min(0).max(100_000).default(0), baseVersion: z.number().int().nonnegative().optional(),
}).strict().refine(v => v.offset === 0 || v.baseVersion !== undefined, "Pagination requires the version from the first page.");
export const availabilitySchema = z.object({ startDate: dateSchema, endDate: dateSchema }).strict()
  .refine(v => v.endDate >= v.startDate && v.endDate <= addDays(v.startDate, 13), "Request at most 14 calendar days.");
const booking = smartFitRequestSchema.refine(v => v.endDate <= addDays(v.startDate, 30), "Book at most 31 calendar days per operation.");
const task = workItemSchema.pick({ clientId: true, title: true, description: true, category: true, webKind: true,
  estimatedMinutes: true, windowStart: true, windowEnd: true, targetDate: true, deadline: true,
  minimumSessionMinutes: true, references: true, workContext: true, dateConstraints: true })
  .extend({ priorityId: idSchema.optional(), requesterId: idSchema.nullable().optional() }).strict();
export const scheduleIntentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("create"), task, booking: booking.optional() }).strict(),
  z.object({ kind: z.literal("book"), workItemId: idSchema, booking }).strict(),
  z.object({ kind: z.literal("reschedule"), moves: z.array(z.object({ sessionId: idSchema,
    start: instantSchema, end: instantSchema, overrideProtected: z.boolean().default(false) }).strict()).min(1).max(20)
    .refine(v => new Set(v.map(m => m.sessionId)).size === v.length, "Identify each session once.") }).strict(),
  z.object({ kind: z.literal("ongoing"), workItemId: idSchema, unknownEffort: z.boolean().default(false) }).strict(),
]);
export const prepareScheduleSchema = z.object({ workspaceId: idSchema, baseVersion: z.number().int().nonnegative(),
  operationId: z.uuid(), change: scheduleIntentSchema }).strict();
export const commitScheduleSchema = z.object({ workspaceId: idSchema, baseVersion: z.number().int().nonnegative(),
  operationId: z.uuid(), reviewFingerprint: reviewFingerprintSchema }).strict();
export type PrepareScheduleInput = z.infer<typeof prepareScheduleSchema>;
export type ScheduleIntent = z.infer<typeof scheduleIntentSchema>;
export type CommitScheduleInput = z.infer<typeof commitScheduleSchema>;
