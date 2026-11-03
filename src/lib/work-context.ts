import { z } from "zod";
import type { WebsiteWorkContext } from "./types";

const referenceUrl = z.string().max(2000).refine(value => {
  if (!value) return true;
  try { const url = new URL(value); return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password; }
  catch { return false; }
}, "Use a website URL without embedded credentials, or leave it blank.");

/** Optional descriptive metadata, never scheduling or execution authority. */
export const workContextSchema = z.object({
  websiteUrl: referenceUrl, projectUrl: referenceUrl,
  requestedResult: z.string().max(4000),
  requirementsStatus: z.enum(["tentative", "confirmed"]),
  requirementsNote: z.string().max(4000).optional(),
  progressNote: z.string().max(4000),
  materialsStatus: z.enum(["not_checked", "ready", "missing", "inaccessible"]),
  materialsNote: z.string().max(2000),
  manualOnly: z.boolean(),
}).strict();

export const taskContextPatchSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(30_000).optional(),
  references: z.array(z.string().max(2000)).max(20).optional(),
  blockedReason: z.string().max(2000).nullable().optional(),
  workContext: workContextSchema.partial().refine(value => Object.keys(value).length > 0, "Choose a context field to update.").optional(),
}).strict().refine(value => Object.keys(value).length > 0, "Choose a field to update.");

export function emptyWorkContext(): WebsiteWorkContext {
  return { websiteUrl: "", projectUrl: "", requestedResult: "", requirementsStatus: "tentative", progressNote: "", materialsStatus: "not_checked", materialsNote: "", manualOnly: false };
}
