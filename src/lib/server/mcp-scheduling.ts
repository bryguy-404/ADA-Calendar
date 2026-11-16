import "server-only";
import { z } from "zod";
import type { Actor, AppState, WorkCommand } from "../types";
import { commandSchema } from "../schemas";
import { commitScheduleSchema, prepareScheduleSchema, type PrepareScheduleInput } from "../mcp/scheduling-contract";
import { assertScope, availableSlots, canonical, digest, discover, preparePlan, SchedulingError, source } from "../mcp/scheduling-plan";
import { planCommands } from "../scheduler";
import { withReviewFingerprint } from "./preview";
import { assertDemoNotesOwner, demoEnabled, demoTransaction } from "./demo-store";
import { getSupabaseServerClient } from "./supabase";
import { assertLiveActor } from "./auth";
import { store } from "./service";

export interface PreparedSchedule {
  input: PrepareScheduleInput;
  commands: WorkCommand[];
  fingerprint: string;
  diff: ReturnType<typeof assertScope>;
  preparedAt: string;
}
const notifications = "Existing Calendar scheduling notifications apply to opted-in recipients only. Saved opt-outs are preserved; prepare and replay queue no additional mail.";
const key = (actor: Actor, workspaceId: string, operationId: string) => `${workspaceId}:${actor.id}:${operationId}`;
async function record(actor: Actor, workspaceId: string, operationId: string, candidate?: PreparedSchedule): Promise<PreparedSchedule | null> {
  if (demoEnabled()) return demoTransaction(state => {
    assertDemoNotesOwner(state, actor);
    if (state.workspaceId !== workspaceId) throw new SchedulingError("workspace_mismatch", "Workspace changed.", 403);
    const id = key(actor, workspaceId, operationId);
    state.mcpScheduleOperations ??= {};
    if (!state.mcpScheduleOperations[id] && candidate) state.mcpScheduleOperations[id] = candidate;
    return state.mcpScheduleOperations[id] ?? null;
  }, !!candidate);
  await assertLiveActor(actor);
  const db = await getSupabaseServerClient();
  if (candidate) {
    const { data, error } = await db.rpc("prepare_mcp_schedule", { p_workspace_id: workspaceId, p_operation_id: operationId, p_payload: candidate });
    if (error) throw new SchedulingError("prepare_uncertain", "Could not confirm the prepared operation. Retry the same arguments and operation ID.", 503);
    return data as PreparedSchedule;
  }
  const { data, error } = await db.from("mcp_schedule_operations").select("payload").eq("workspace_id", workspaceId).eq("actor_id", actor.id).eq("operation_id", operationId).maybeSingle();
  if (error) throw new SchedulingError("save_uncertain", "Cannot reconcile this operation yet. Retry the exact same operation ID.", 503);
  return (data?.payload as PreparedSchedule) ?? null;
}
function owner(actor: Actor, state: AppState, workspaceId: string) {
  if (actor.role !== "owner" || state.actor.id !== actor.id || state.actor.role !== "owner") throw new SchedulingError("access_denied", "Only the workspace owner can use scheduling tools.", 403);
  if (workspaceId !== state.workspaceId) throw new SchedulingError("workspace_mismatch", "Use the current signed-in workspace.", 403);
}
function preview(saved: PreparedSchedule, state: AppState) {
  return { source: source(state), operationId: saved.input.operationId, baseVersion: saved.input.baseVersion,
    reviewFingerprint: saved.fingerprint, diff: saved.diff, notifications,
    note: "Prepared only. Commit this exact operation after reviewing its diff against the user's authorization. No second blanket confirmation is required for already-authorized clean-fit work." };
}
export async function prepareSchedule(actor: Actor, raw: unknown, state: AppState) {
  const input = prepareScheduleSchema.parse(raw);
  owner(actor, state, input.workspaceId);
  const prior = await record(actor, input.workspaceId, input.operationId);
  if (prior) {
    if (digest(prior.input) !== digest(input)) throw new SchedulingError("operation_conflict", "This operation ID already belongs to a different request.");
    return preview(prior, state);
  }
  if (input.baseVersion !== state.version) throw new SchedulingError("stale_version", "Calendar changed. Read again and prepare a new operation.");
  const { proposal, diff } = preparePlan(state, actor, input);
  const candidate: PreparedSchedule = { input, commands: proposal.commands, fingerprint: proposal.reviewFingerprint!, diff, preparedAt: proposal.createdAt };
  const saved = (await record(actor, input.workspaceId, input.operationId, candidate))!;
  if (digest(saved.input) !== digest(input)) throw new SchedulingError("operation_conflict", "This operation ID already belongs to another request.");
  return preview(saved, state);
}
export async function commitSchedule(actor: Actor, raw: unknown, state: AppState) {
  const input = commitScheduleSchema.parse(raw);
  owner(actor, state, input.workspaceId);
  const saved = await record(actor, input.workspaceId, input.operationId);
  if (!saved) throw new SchedulingError("prepare_required", "Prepare this operation before committing it.");
  // Parse persisted commands again; prepared records are private, immutable and actor scoped.
  const commands = z.array(commandSchema).min(1).max(30).parse(saved.commands);
  prepareScheduleSchema.parse(saved.input);
  if (input.baseVersion !== saved.input.baseVersion || input.reviewFingerprint !== saved.fingerprint)
    throw new SchedulingError("operation_conflict", "Use the exact prepared version and fingerprint.");
  let replayed: boolean;
  try { replayed = await store.hasCommittedOperation(actor, input.operationId, commands); }
  catch (error) {
    if (error instanceof Error && /does not match|already used|different/i.test(error.message)) throw new SchedulingError("operation_conflict", "Operation ID belongs to different saved commands.");
    throw new SchedulingError("save_uncertain", "Cannot reconcile the save. Retry the same commit arguments.", 503);
  }
  if (!replayed) {
    if (state.version !== input.baseVersion) throw new SchedulingError("stale_version", "Calendar changed. This operation was not applied; read again and prepare a new operation.");
    const proposal = withReviewFingerprint(planCommands(state, commands, actor, { operationId: input.operationId, approveDisplacement: false }));
    const diff = assertScope(state, proposal, saved.input);
    if (proposal.reviewFingerprint !== saved.fingerprint || canonical(diff) !== canonical(saved.diff)) throw new SchedulingError("preview_changed", "Time or calendar state changed the preview. Prepare a new operation.");
    try { await store.commit(actor, proposal, state); }
    catch (error) {
      if (error instanceof Error && /schedule changed|calendar changed|reviewed plan changed/i.test(error.message)) throw new SchedulingError("stale_version", "Calendar changed during save. Reconcile this operation before preparing another.");
      throw new SchedulingError("save_uncertain", "Save outcome is uncertain. Retry this exact commit to reconcile it; do not create a new operation.", 503);
    }
  }
  // A fresh server read verifies the committed IDs. On replay this is current state,
  // not restoration of an old preview after subsequent legitimate edits.
  state = await store.getState(actor.id);
  const matchesAppliedDiff = ([['items', state.items], ['sessions', state.sessions]] as const).every(([kind, rows]) =>
    saved.diff[kind].every(change => {
      const row = rows.find(value => value.id === change.id);
      return Object.entries(change.fields).every(([field, values]) => canonical(row?.[field as keyof typeof row] ?? null) === canonical(values.after));
    }));
  if (!matchesAppliedDiff && state.version === saved.input.baseVersion + 1)
    throw new SchedulingError("save_uncertain", "The committed result could not be verified. Reconcile this same operation before making another change.", 503);
  return { source: source(state), receipt: { operationId: input.operationId, outcome: replayed ? "replayed" : "committed", notifications },
    verification: { matchesAppliedDiff, laterCalendarChanges: state.version > saved.input.baseVersion + 1 },
    appliedDiff: saved.diff,
    current: { items: saved.diff.items.map(({ id }) => { const item = state.items.find(i => i.id === id); return item ? { id, status: item.status, timelineMode: item.timelineMode, windowEnd: item.windowEnd, estimatedMinutes: item.estimatedMinutes, remainingMinutes: item.remainingMinutes, targetDate: item.targetDate, deadline: item.deadline, createdAt: item.createdAt, updatedAt: item.updatedAt } : { id, missing: true }; }),
      sessions: saved.diff.sessions.map(({ id }) => state.sessions.find(s => s.id === id) ?? { id, missing: true }) } };
}
export async function handleMcpScheduling(actor: Actor, state: AppState, action: string, raw: unknown) {
  const envelope = z.object({ actorId: z.string(), workspaceId: z.string(), input: z.unknown() }).strict().parse(raw);
  owner(actor, state, envelope.workspaceId);
  if (envelope.actorId !== actor.id) throw new SchedulingError("access_denied", "The MCP session identity changed; sign in explicitly.", 403);
  if (action === "discover") return discover(state, envelope.input);
  if (action === "availability") return availableSlots(state, envelope.input);
  if (action === "prepare") return prepareSchedule(actor, envelope.input, state);
  if (action === "commit") return commitSchedule(actor, envelope.input, state);
  throw new SchedulingError("not_found", "Unknown scheduling action.", 404);
}
