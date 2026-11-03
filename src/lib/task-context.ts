import { z } from "zod";
import { idSchema } from "./schemas";
import { emptyWorkContext, taskContextPatchSchema } from "./work-context";
import type { TaskContextPatch, WorkItem } from "./types";

export const taskContextRequestSchema = z.object({
  workspaceId: idSchema,
  workItemId: idSchema,
  baseVersion: z.number().int().nonnegative(),
  operationId: z.uuid(),
  patch: taskContextPatchSchema,
}).strict();
export type TaskContextRequest = z.infer<typeof taskContextRequestSchema>;

export function applyTaskContext(item: WorkItem, patch: TaskContextPatch, now: string): WorkItem {
  const parsed = taskContextPatchSchema.parse(patch);
  if (parsed.blockedReason !== undefined && item.status !== "waiting")
    throw new Error("A waiting reason can only be edited on an already-waiting task. Change status separately.");
  const { workContext, ...metadata } = parsed;
  return { ...item, ...metadata,
    ...(workContext ? { workContext: { ...emptyWorkContext(), ...item.workContext, ...workContext } } : {}),
    updatedAt: now };
}
