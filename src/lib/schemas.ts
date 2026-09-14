import { z } from "zod";
import { addDays, isDate, isInstant } from "./time";

export const idSchema = z.string().min(1).max(150).regex(/^[\w-]+$/);
export const reviewFingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/, "Check a fresh schedule preview.");
export const dateSchema = z.string().refine(isDate, "Use a valid calendar date.");
export const instantSchema = z.string().refine(isInstant, "Use a date and time with a timezone.");
const minutes = z.number().int().min(0).max(100_000);
const nullableDate = dateSchema.nullable();
const statusSchema = z.enum(["planned", "in_progress", "waiting", "completed", "cancelled"]);
const checklistSchema = z.array(z.object({ id: idSchema, title: z.string().min(1).max(500), done: z.boolean() }).strict()).max(500);
export const dailyPlanSchema = z.array(z.object({ date: dateSchema, minutes: z.number().int().min(15).max(480).multipleOf(15) }).strict()).max(366)
  .refine(rows => new Set(rows.map(row => row.date)).size === rows.length, "Use each daily-plan date only once.")
  .refine(rows => rows.reduce((sum, row) => sum + row.minutes, 0) <= 100_000, "Daily hours exceed the supported total.");
export const workItemSchema = z.object({
  id: idSchema, clientId: idSchema, title: z.string().trim().min(1).max(200), description: z.string().max(30_000),
  category: z.enum(["web", "it", "landings", "software"]), webKind: z.enum(["edit", "build"]).nullable(),
  requesterId: idSchema.nullable(), requestedBy: z.string().max(120), priorityId: idSchema, requestedPriorityId: idSchema.nullable(),
  status: statusSchema, estimatedMinutes: minutes.nullable(), remainingMinutes: minutes.nullable(),
  windowStart: dateSchema, windowEnd: nullableDate, targetDate: nullableDate, deadline: nullableDate,
  dateConstraints: z.object({ earliestStart: nullableDate, allowedDates: z.array(dateSchema).max(366) }).strict().optional(),
  timelineMode: z.enum(["bookings", "span"]).optional(),
  forecastDate: nullableDate, completedAt: instantSchema.nullable(), blockedReason: z.string().max(2000).nullable(),
  minimumSessionMinutes: z.number().int().min(15).max(480).multipleOf(15), allowedDates: z.array(dateSchema).max(366),
  dailyPlan: dailyPlanSchema.optional(),
  checklist: checklistSchema, progressTotal: z.number().int().positive().max(10_000).nullable(),
  progressCompleted: z.number().int().min(0).max(10_000), updateDate: nullableDate,
  references: z.array(z.string().max(2000)).max(20), createdAt: instantSchema, updatedAt: instantSchema,
}).strict();
export const sessionSchema = z.object({
  id: idSchema, workItemId: idSchema, start: instantSchema, end: instantSchema, protected: z.boolean(),
  status: z.enum(["planned", "completed", "cancelled"]), usesReserve: z.boolean(),
  focusOverrideMinutes: z.number().int().min(15).max(480).multipleOf(15).optional(),
}).strict();
const override = { overrideProtected: z.boolean().optional(), overrideDeadline: z.boolean().optional() };
export const blockSchema = z.object({ id: idSchema, title: z.string().trim().min(1).max(200), start: instantSchema, end: instantSchema, kind: z.enum(["meeting", "time_off"]) }).strict()
  .refine(block => !isInstant(block.start) || !isInstant(block.end) || Date.parse(block.end) > Date.parse(block.start), "Unavailable time must end after it starts.");
export const bookingWindowSchema = z.object({
  startDate: dateSchema, endDate: dateSchema,
  dates: z.array(dateSchema).min(1).max(366).refine(dates => new Set(dates).size === dates.length, "Choose each booking date only once.").optional(),
}).strict().refine(value => !isDate(value.startDate) || !isDate(value.endDate) ||
  (value.endDate >= value.startDate && value.endDate <= addDays(value.startDate, 365)), "Choose an inclusive range of at most 366 days.")
  .refine(value => !value.dates || value.dates.every(date => date >= value.startDate && date <= value.endDate), "Booking dates must fall inside the requested range.");
export const smartFitRequestSchema = z.object({
  startDate: dateSchema, endDate: dateSchema,
  dates: z.array(dateSchema).min(1).max(366).refine(dates => new Set(dates).size === dates.length, "Choose each booking date only once.").optional(),
  minutes: z.number().int().min(15).max(100_000).multipleOf(15),
  distribution: z.enum(["total", "per_day"]), resumeWaiting: z.boolean().optional(),
}).strict().refine(value => !isDate(value.startDate) || !isDate(value.endDate) ||
  (value.endDate >= value.startDate && value.endDate <= addDays(value.startDate, 365)), "Choose an inclusive range of at most 366 days.")
  .refine(value => !value.dates || value.dates.every(date => date >= value.startDate && date <= value.endDate), "Booking dates must fall inside the requested range.")
  .refine(value => value.distribution !== "per_day" || value.minutes <= 480, "Daily hours cannot exceed eight hours.");
export const commandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("create"), item: workItemSchema, sessions: z.array(sessionSchema).max(1000).optional(), smartFit: smartFitRequestSchema.optional(), bookingWindow: bookingWindowSchema.optional(), urgent: z.boolean().optional(), ...override }).strict(),
  z.object({ type: z.literal("fit"), itemId: idSchema, request: smartFitRequestSchema }).strict(),
  z.object({ type: z.literal("reorder_day"), date: dateSchema,
    sessionIds: z.array(idSchema).min(1).max(100).refine(ids => new Set(ids).size === ids.length, "Choose each existing session only once."),
    overrideProtected: z.boolean().optional(),
  }).strict(),
  z.object({ type: z.literal("resize_booking"), sessionId: idSchema, minutes: z.number().int().min(15).max(480).multipleOf(15), overrideProtected: z.boolean().optional() }).strict(),
  z.object({ type: z.literal("move_booking"), sessionId: idSchema, date: dateSchema, minutes: z.number().int().min(15).max(480).multipleOf(15).optional(),
    startTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(), overrideProtected: z.boolean().optional() }).strict(),
  z.object({ type: z.literal("move_bookings"), date: dateSchema,
    sessionIds: z.array(idSchema).min(1).max(100).refine(ids => new Set(ids).size === ids.length, "Choose each existing session only once."),
  }).strict(),
  z.object({ type: z.literal("add_booking"), itemId: idSchema, request: smartFitRequestSchema }).strict(),
  z.object({ type: z.literal("set_day_hours"), itemId: idSchema, days: z.array(z.object({ date: dateSchema, minutes: z.number().int().min(0).max(480).multipleOf(15) }).strict()).min(1).max(366)
    .refine(days => new Set(days.map(day => day.date)).size === days.length, "Use each work day only once.")
    .refine(days => days.reduce((total, day) => total + day.minutes, 0) <= 100_000, "Daily hours exceed the supported total."), overrideProtected: z.boolean().optional() }).strict(),
  z.object({ type: z.literal("update"), itemId: idSchema, patch: workItemSchema.partial(), ...override }).strict(),
  z.object({ type: z.literal("schedule"), itemId: idSchema, sessions: z.array(sessionSchema).max(1000).optional(), urgent: z.boolean().optional(), ...override }).strict(),
  z.object({ type: z.literal("move"), sessionId: idSchema, start: instantSchema, end: instantSchema, ...override }).strict(),
  z.object({ type: z.literal("progress"), itemId: idSchema, remainingMinutes: minutes.optional(), progressCompleted: minutes.optional(), checklist: checklistSchema.optional() }).strict(),
  z.object({ type: z.literal("complete_session"), sessionId: idSchema, remainingMinutes: minutes.optional() }).strict(),
  z.object({ type: z.literal("complete_day"), itemId: idSchema, date: dateSchema }).strict(),
  z.object({ type: z.literal("status"), itemId: idSchema, status: statusSchema, reason: z.string().max(2000).optional(), remainingMinutes: minutes.optional(), overrideProtected: z.boolean().optional() }).strict(),
  z.object({ type: z.literal("client_update"), itemId: idSchema, message: z.string().min(1).max(10_000) }).strict(),
  z.object({ type: z.literal("block"), block: blockSchema, remove: z.boolean().optional(), ...override }).strict(),
]);
export const commandRequestSchema = z.object({
  commands: z.array(commandSchema).min(1).max(30), operationId: idSchema, baseVersion: z.number().int().min(0).optional(),
  reviewFingerprint: reviewFingerprintSchema.optional(),
  action: z.enum(["preview", "commit", "request"]).default("preview"), note: z.string().max(5000).optional(),
}).strict();
const clockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const settingsSchema = z.object({
  name: z.string().min(1).max(100), timeZone: z.string().refine(v => { try { new Intl.DateTimeFormat("en", { timeZone: v }); return true; } catch { return false; } }),
  weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7), dayStart: clockTime, dayEnd: clockTime,
  lunchStart: clockTime, lunchEnd: clockTime, reserveStart: clockTime, reserveMinutes: z.number().int().min(0).max(240).multipleOf(15),
  slotMinutes: z.literal(15), weeklyDay: z.number().int().min(1).max(7), weeklyTime: clockTime,
  aiWarningUsd: z.number().min(0).max(1000), aiLimitUsd: z.number().min(0).max(1000),
}).strict().refine(s => s.dayStart < s.lunchStart && s.lunchStart < s.lunchEnd && s.lunchEnd <= s.reserveStart && s.reserveStart <= s.dayEnd && s.aiWarningUsd <= s.aiLimitUsd,
  "Lunch, reserve, and working hours must be in order; the AI warning cannot exceed the limit.");
export const clientSchema = z.object({ id: idSchema, name: z.string().trim().min(1).max(150), aliases: z.array(z.string().trim().min(1).max(150)).max(30), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional() }).strict();
export const prioritySchema = z.object({ id: idSchema, label: z.string().trim().min(1).max(50), rank: z.number().int().min(0).max(100) }).strict();
