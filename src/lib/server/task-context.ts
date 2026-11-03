import "server-only";
import type { Actor, AppState, WorkCommand } from "../types";
import { taskContextRequestSchema, type TaskContextRequest } from "../task-context";
import { planCommands } from "../scheduler";
import { store } from "./service";
import { withReviewFingerprint } from "./preview";

export class TaskContextError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) { super(message); }
}

/** A scoped explicit patch is the user's requested change; no second confirmation is needed. */
export async function saveTaskContext(actor: Actor, raw: TaskContextRequest, state: AppState) {
  const input = taskContextRequestSchema.parse(raw);
  if (actor.role !== "owner" || state.actor.id !== actor.id)
    throw new TaskContextError("access_denied", "Only the workspace owner can update task context.", 403);
  if (state.workspaceId !== input.workspaceId)
    throw new TaskContextError("workspace_mismatch", "The requested workspace does not match this session.", 403);
  const commands: WorkCommand[] = [{ type: "context_update", itemId: input.workItemId, patch: input.patch }];
  let replayed: boolean;
  try { replayed = await store.hasCommittedOperation(actor, input.operationId, commands); }
  catch (error) {
    if (error instanceof Error && /does not match|different command|different.*account|different.*actor|already used/i.test(error.message))
      throw new TaskContextError("operation_conflict", "This operation ID belongs to a different patch or account. Reuse the exact original arguments to reconcile that save.", 409);
    throw new TaskContextError("save_uncertain", "Could not reconcile this operation yet. Retry the exact same patch, version and operation ID.", 503);
  }
  if (replayed) state = await store.getState(actor.id);
  else {
    if (input.baseVersion !== state.version)
      throw new TaskContextError("stale_version", "Calendar changed since your read. Read the task again and review the patch before using a new operation ID.", 409);
    const proposal = withReviewFingerprint(planCommands(state, commands, actor, { operationId: input.operationId }));
    if (proposal.status !== "ready")
      throw new TaskContextError("invalid_context", proposal.conflicts.map(conflict => conflict.message).join(" "), 400);
    try { state = await store.commit(actor, proposal, state); }
    catch (error) {
      if (error instanceof Error && /schedule changed|calendar changed|reviewed plan changed/i.test(error.message))
        throw new TaskContextError("stale_version", "Calendar changed while saving. Read the task again and reconcile this operation before making another change.", 409);
      throw new TaskContextError("save_uncertain", "The save result could not be confirmed. Retry the exact same patch, version and operation ID to reconcile it safely.", 503);
    }
  }
  return { state, receipt: { operationId: input.operationId, workItemId: input.workItemId,
    outcome: replayed ? "replayed" : "committed", notifications: "none" } };
}
