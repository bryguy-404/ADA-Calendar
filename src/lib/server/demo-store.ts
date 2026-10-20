import "server-only";
import { mkdir, readFile, rename, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createDemoState, DEMO_MEMBERS } from "../fixtures";
import type { Actor, AppState, ScheduleProposal, WorkEvent } from "../types";
import type { LiveAdminAction } from "./live-store";
import { planCommands, validateSchedule } from "../scheduler";
import { buildCommitNotifications, buildDraftNotifications, buildRequestNotifications } from "./email";
import { attachmentPath, canAccessAttachmentWork, validateUpload } from "./uploads";
import { assertReviewedProposal } from "./preview";
import type { PersonalNote } from "../notes";
import { completedDayFromCommands, undoUnavailableReason } from "../undo";
import { compactActivity } from "../work-activity";

export type AIOperationInput = { id: string; kind: "assistant" | "transcribe"; inputHash: string; reserveUsd: number; parentId?: string };
export type AIOperationResult = { status: "claimed" | "processing" | "completed" | "failed"; result: unknown | null };
export type PrivateAIOperation = { kind: string; status: "processing" | "completed" | "failed"; result: unknown };
type Reservation = { actorId: string; amountUsd: number; settled: boolean };
type StoredAIOperation = PrivateAIOperation & { actorId: string; workspaceId: string; inputHash: string; parentId?: string };
type StoredState = Omit<AppState, "events"> & { events: WorkEvent[]; aiReservations?: Record<string, Reservation>; aiMonth?: string; aiOperations?: Record<string, StoredAIOperation>; operationHashes?: Record<string, string>; pendingAttachmentIds?: string[];
  personalNotes?: { workspaceId: string; authorId: string; note: PersonalNote }[] };
const globalStore = globalThis as unknown as { adaWriteQueue?: Promise<unknown> };
export function demoEnabled() { return process.env.NODE_ENV !== "production" && process.env.ADA_DEMO_MODE === "true"; }
export function demoDirectory() { return process.env.ADA_DATA_DIR || path.join(process.cwd(), ".data"); }
function assertDemo() { if (!demoEnabled()) throw new Error("Demo access is disabled."); }

export async function demoTransaction<T>(fn: (state: StoredState) => Promise<T> | T, write = true): Promise<T> {
  assertDemo();
  const task = (globalStore.adaWriteQueue ?? Promise.resolve()).then(async () => {
    const directory = demoDirectory();
    await mkdir(directory, { recursive: true });
    const filename = path.join(directory, "ada-demo.json");
    let state: StoredState;
    try { state = JSON.parse(await readFile(filename, "utf8")) as StoredState; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      state = createDemoState();
    }
    const month = new Date().toISOString().slice(0, 7);
    if (state.aiMonth !== month) { state.aiMonth = month; state.aiUsageUsd = 0; state.aiReservations = {}; }
    const result = await fn(state);
    if (write) {
      const temp = `${filename}.${randomUUID()}.tmp`;
      await writeFile(temp, JSON.stringify(state), { mode: 0o600 });
      await rename(temp, filename);
    }
    return structuredClone(result);
  });
  globalStore.adaWriteQueue = task.catch(() => {});
  return task;
}

export function demoActor(id: string | undefined): Actor {
  assertDemo();
  if (!id) return DEMO_MEMBERS[0];
  const actor = DEMO_MEMBERS.find(m => m.id === id);
  if (!actor) throw new Error("Unknown demo account.");
  return actor;
}
function trustedActor(state: StoredState, actor: Actor) {
  const trusted = state.members.find(member => member.id === actor.id);
  if (!trusted || trusted.role !== actor.role || trusted.email !== actor.email || trusted.name !== actor.name) throw new Error("The actor does not match workspace membership.");
  return trusted;
}
export function assertDemoNotesOwner(state: StoredState, actor: Actor) {
  const trusted = trustedActor(state, actor);
  if (trusted.role !== "owner") throw new Error("Only the workspace owner can access personal notes.");
  return trusted;
}
const commandHash = (commands: ScheduleProposal["commands"]) => createHash("sha256").update(JSON.stringify(commands)).digest("hex");
function visible(state: StoredState, actor: Actor): AppState {
  trustedActor(state, actor);
  const { aiReservations: _reservations, aiMonth: _month, aiOperations: _operations, operationHashes: _hashes, pendingAttachmentIds: _pending, personalNotes: _notes, ...publicState } = state;
  void _reservations; void _month; void _operations; void _hashes; void _notes;
  return { ...publicState, actor,
    events: compactActivity(state.events),
    requests: state.requests.filter(r => actor.role === "owner" || r.requesterId === actor.id),
    notifications: state.notifications.filter(n => actor.role === "owner" || n.recipient === actor.email),
    emailDrafts: state.emailDrafts.filter(d => d.authorId === actor.id),
    attachments: state.attachments.filter(a => !a.removedAt && !_pending?.includes(a.id) && canAccessAttachmentWork(a.workItemId, state, actor)),
  };
}
export function getDemoState(actor: Actor) { return demoTransaction(state => visible(state, actor)); }

/** Consult the complete ledger, independently of any event page shown in the UI. */
export function hasCommittedDemoOperation(actor: Actor, operationId: string, commands: ScheduleProposal["commands"]): Promise<boolean> {
  return demoTransaction(state => {
    trustedActor(state, actor);
    const prior = state.events.find(event => event.operationId === operationId);
    if (!prior) return false;
    if (prior.actorId !== actor.id || state.operationHashes?.[operationId] !== commandHash(commands))
      throw new Error("That operation id does not match this account and its saved commands. Its saved work was not repeated.");
    return true;
  }, false);
}

function saveProposal(state: StoredState, actor: Actor, proposal: ScheduleProposal, type = "schedule_changed"): WorkEvent {
  trustedActor(state, actor);
  if (proposal.status !== "ready" || proposal.requiresApproval) throw new Error("This change needs approval or different scheduling dates.");
  if (actor.role === "viewer") throw new Error("Viewers cannot change the schedule.");
  const event: WorkEvent = {
    id: randomUUID(), operationId: proposal.operationId, actorId: actor.id, actorName: actor.name, type,
    summary: proposal.summary, itemIds: proposal.affectedItemIds, createdAt: new Date().toISOString(), version: state.version + 1,
    before: structuredClone({ items: state.items, sessions: state.sessions, blocks: state.blocks }),
    after: structuredClone({ items: proposal.items, sessions: proposal.sessions, blocks: proposal.blocks }), undoneBy: null,
    completedDay: completedDayFromCommands(proposal.commands),
  };
  state.items = proposal.items; state.sessions = proposal.sessions; state.blocks = proposal.blocks; state.version++;
  state.events.unshift(event);
  state.operationHashes ??= {};
  state.operationHashes[proposal.operationId] = commandHash(proposal.commands);
  state.notifications.unshift(...buildCommitNotifications(event, { ...state, actor }).map(n => ({ ...n, status: "captured" as const })));
  return event;
}
export function commitDemoProposal(actor: Actor, proposal: ScheduleProposal) {
  return demoTransaction(state => {
    trustedActor(state, actor);
    const prior = state.events.find(e => e.operationId === proposal.operationId);
    if (prior) {
      if (prior.actorId !== actor.id) throw new Error("Operation identifier already used by another account.");
      if (state.operationHashes?.[proposal.operationId] && state.operationHashes[proposal.operationId] !== commandHash(proposal.commands)) throw new Error("Operation identifier was already used for a different change.");
      return visible(state, actor);
    }
    if (state.version !== proposal.baseVersion) throw new Error("The schedule changed. Check a fresh preview before saving.");
    const fresh = planCommands(state, proposal.commands, actor, { operationId: proposal.operationId, approveDisplacement: actor.role === "owner" });
    assertReviewedProposal(proposal, fresh);
    saveProposal(state, actor, fresh);
    return visible(state, actor);
  });
}
export function submitDemoRequest(actor: Actor, proposal: ScheduleProposal, note = "") {
  return demoTransaction(state => {
    trustedActor(state, actor);
    if (actor.role !== "requester") throw new Error("Only requesters submit priority requests.");
    const prior = state.events.find(event => event.operationId === proposal.operationId);
    if (prior) {
      if (prior.actorId !== actor.id || (state.operationHashes?.[proposal.operationId] && state.operationHashes[proposal.operationId] !== commandHash(proposal.commands))) throw new Error("Operation identifier was already used for a different change.");
      return visible(state, actor);
    }
    const pending = state.requests.find(request => request.id === proposal.operationId);
    if (pending) {
      if (pending.requesterId !== actor.id || commandHash(pending.proposal.commands) !== commandHash(proposal.commands)) throw new Error("Operation identifier was already used for a different request.");
      return visible(state, actor);
    }
    if (state.version !== proposal.baseVersion) throw new Error("The schedule changed. Check a fresh preview.");
    const fresh = planCommands(state, proposal.commands, actor, { operationId: proposal.operationId });
    assertReviewedProposal(proposal, fresh);
    if (fresh.status === "ready" && !fresh.requiresApproval) saveProposal(state, actor, fresh);
    else {
      const request = { id: proposal.operationId, requesterId: actor.id, requesterName: actor.name, proposal: fresh, note, status: "pending" as const, createdAt: new Date().toISOString(), resolvedAt: null };
      state.requests.unshift(request);
      state.notifications.unshift(...buildRequestNotifications(request, state).map(n => ({ ...n, status: "captured" as const })));
    }
    return visible(state, actor);
  });
}
export function resolveDemoRequest(actor: Actor, id: string, decision: "approved" | "declined" | "needs_information", note = "", freshProposal?: ScheduleProposal) {
  return demoTransaction(state => {
    trustedActor(state, actor);
    if (actor.role !== "owner") throw new Error("Only Bryan can approve a displacement.");
    const request = state.requests.find(r => r.id === id && (r.status === "pending" || r.status === "needs_information"));
    if (!request) throw new Error("This request is no longer pending.");
    if (decision === "approved") {
      if (!freshProposal || freshProposal.baseVersion !== state.version) throw new Error("The schedule changed. Check a fresh preview before approving.");
      const commands = freshProposal.commands.map(command => command.type === "create" ? { ...command, item: { ...command.item, requesterId: request.requesterId, requestedBy: request.requesterName } } : command);
      const proposal = planCommands(state, commands, actor, { operationId: `approve-${id}`, approveDisplacement: true });
      assertReviewedProposal(freshProposal, proposal);
      saveProposal(state, actor, proposal, "request_approved");
    }
    request.status = decision; request.note = note || request.note; request.resolvedAt = new Date().toISOString();
    return visible(state, actor);
  });
}
export function undoDemoEvent(actor: Actor, id: string) {
  return demoTransaction(state => {
    trustedActor(state, actor);
    if (actor.role !== "owner") throw new Error("Only Bryan can undo work changes.");
    const event = state.events.find(e => e.id === id);
    if (!event) throw new Error("This schedule change is no longer available to undo.");
    const now = new Date().toISOString();
    const unavailable = undoUnavailableReason(state, event, now);
    if (unavailable) throw new Error(unavailable);
    const conflicts = validateSchedule({ ...state, ...event.before });
    if (conflicts.length) throw new Error(conflicts.map(c => c.message).join(" "));
    const corrective = saveProposal(state, actor, {
      id: randomUUID(), operationId: `undo-${id}`, baseVersion: state.version, actorId: actor.id, commands: [],
      status: "ready", requiresApproval: false, ...structuredClone(event.before), affectedItemIds: event.itemIds,
      summary: [`Undid: ${event.summary.join(" ")}`], conflicts: [], alternatives: [], createdAt: now,
    }, "schedule_undone");
    event.undoneBy = corrective.id;
    return visible(state, actor);
  });
}

export function mutateDemoAdmin(actor: Actor, action: LiveAdminAction) {
  return demoTransaction(async state => {
    trustedActor(state, actor);
    if (actor.role === "viewer") throw new Error("Viewers cannot change workspace data.");
    if (actor.role !== "owner" && !["attachment", "complete_attachment", "abort_attachment", "reserve_ai", "settle_ai"].includes(action.type)) throw new Error("Only Bryan can change existing work or settings.");
    if (action.type === "clients") {
      if (state.items.some(item => !action.clients.some(client => client.id === item.clientId))) throw new Error("Keep clients referenced by existing work.");
      if (new Set(action.clients.map(client => client.id)).size !== action.clients.length) throw new Error("Client IDs must be unique.");
      state.clients = action.clients; state.version++;
    }
    else if (action.type === "settings") {
      if (validateSchedule({ ...state, settings: action.settings }).length) throw new Error("These settings conflict with existing sessions. Reschedule them first.");
      state.settings = action.settings; state.version++;
    } else if (action.type === "priorities") {
      if (!action.priorities.some(priority => priority.id === "normal") || state.items.some(item => !action.priorities.some(priority => priority.id === item.priorityId))) throw new Error("Keep Normal and priorities used by existing work.");
      state.priorities = action.priorities; state.version++;
    }
    else if (action.type === "member") {
      if (action.member.role === "owner") throw new Error("There is one workspace owner.");
      if (state.members.some(m => m.email.toLowerCase() === action.member.email.toLowerCase())) throw new Error("This member already exists.");
      state.members.push(action.member);
    } else if (action.type === "attachment") {
      const existing = state.attachments.find(a => a.id === action.attachment.id);
      if (existing) {
        if (existing.uploadedBy !== actor.id || existing.path !== action.attachment.path || existing.size !== action.attachment.size) throw new Error("Attachment ID was already used.");
        return visible(state, actor);
      }
      validateUpload(action.attachment, state, actor);
      if (action.attachment.uploadedBy !== actor.id || action.attachment.path !== attachmentPath(state.workspaceId, action.attachment.workItemId, action.attachment.id, action.attachment.name)) throw new Error("Attachment path or author mismatch.");
      const current = state.attachments.filter(a => a.workItemId === action.attachment.workItemId && !a.removedAt);
      if (current.length >= 5 || current.reduce((n, a) => n + a.size, 0) + action.attachment.size > 20 * 1024 * 1024) throw new Error("Maximum five files and 20 MB per work item.");
      state.attachments.push(action.attachment);
      state.pendingAttachmentIds ??= [];
      state.pendingAttachmentIds.push(action.attachment.id);
    } else if (action.type === "complete_attachment") {
      const attachment = state.attachments.find(file => file.id === action.id && !file.removedAt);
      if (!attachment || (attachment.uploadedBy !== actor.id && actor.role !== "owner")) throw new Error("Upload reservation is unavailable.");
      const file = await stat(path.join(demoDirectory(), "files", attachment.id));
      if (!file.isFile() || file.size !== attachment.size) throw new Error("Upload is missing or has an unexpected size.");
      state.pendingAttachmentIds = (state.pendingAttachmentIds ?? []).filter(id => id !== attachment.id);
    } else if (action.type === "remove_attachment" || action.type === "abort_attachment") {
      const attachment = state.attachments.find(a => a.id === action.id);
      if (!attachment || (actor.role !== "owner" && attachment.uploadedBy !== actor.id)) throw new Error("Attachment is not available.");
      if (action.type === "abort_attachment" && !state.pendingAttachmentIds?.includes(attachment.id)) throw new Error("Only a pending upload can be aborted.");
      attachment.removedAt = new Date().toISOString();
    } else if (action.type === "draft") {
      if (action.draft.authorId !== actor.id) throw new Error("Draft author mismatch.");
      const existing = state.emailDrafts.find(draft => draft.id === action.draft.id);
      if (existing) {
        if (existing.authorId !== actor.id) throw new Error("Draft author mismatch.");
        if (existing.status !== "draft") return visible(state, actor);
        Object.assign(existing, action.draft);
      } else state.emailDrafts.push(action.draft);
    } else if (action.type === "edit_draft") {
      const draft = state.emailDrafts.find(d => d.id === action.id && d.authorId === actor.id && d.status === "draft");
      if (!draft) throw new Error("Draft is not editable.");
      if (!action.subject.trim() || !action.body.trim() || action.subject.length > 200 || action.body.length > 12_000 || /[\r\n]/.test(action.subject)) throw new Error("Use a single-line subject and a body of up to 12,000 characters.");
      draft.subject = action.subject; draft.body = action.body;
    } else if (action.type === "dismiss_draft" || action.type === "send_draft") {
      const draft = state.emailDrafts.find(d => d.id === action.id && d.authorId === actor.id);
      if (action.type === "send_draft" && draft && (draft.subject !== action.expectedSubject || draft.body !== action.expectedBody)) throw new Error("This draft changed. Reload and review the current text before sending.");
      if (draft && ((action.type === "send_draft" && draft.status === "sent") || (action.type === "dismiss_draft" && draft.status === "dismissed"))) return visible(state, actor);
      if (!draft || draft.status !== "draft") throw new Error("Draft is no longer available.");
      if (action.type === "send_draft") state.notifications.unshift(...buildDraftNotifications(draft, state, actor).map(n => ({ ...n, status: "captured" as const })));
      draft.status = action.type === "send_draft" ? "sent" : "dismissed";
    } else if (action.type === "reserve_ai") {
      state.aiReservations ??= {};
      reserveAI(state, actor, action.reservationId, action.amountUsd);
    } else if (action.type === "settle_ai") {
      settleAI(state, actor, action.reservationId, action.costUsd);
    }
    return visible(state, actor);
  });
}

function reserveAI(state: StoredState, actor: Actor, id: string, amountUsd: number) {
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) throw new Error("AI reservation must be a positive amount.");
  state.aiReservations ??= {};
  const prior = state.aiReservations[id];
  if (prior) {
    if (prior.actorId !== actor.id) throw new Error("AI reservation belongs to another account.");
    return;
  }
  if (state.aiUsageUsd + amountUsd > state.settings.aiLimitUsd) throw new Error("AI allowance reached. Manual scheduling is still available.");
  state.aiReservations[id] = { actorId: actor.id, amountUsd, settled: false };
  state.aiUsageUsd += amountUsd;
}
function settleAI(state: StoredState, actor: Actor, id: string, amountUsd: number) {
  if (!Number.isFinite(amountUsd) || amountUsd < 0) throw new Error("AI cost must be a known nonnegative amount.");
  const prior = state.aiReservations?.[id];
  if (!prior || prior.actorId !== actor.id) throw new Error("AI reservation is not available to this account.");
  if (prior.settled) return;
  state.aiUsageUsd = Math.max(0, state.aiUsageUsd - prior.amountUsd + amountUsd);
  prior.amountUsd = amountUsd; prior.settled = true;
}
export function beginDemoAIOperation(actor: Actor, input: AIOperationInput): Promise<AIOperationResult> {
  return demoTransaction(state => {
    trustedActor(state, actor);
    if (actor.role === "viewer") throw new Error("Viewers cannot use the writing assistant.");
    state.aiOperations ??= {};
    const prior = state.aiOperations[input.id];
    if (prior) {
      if (prior.actorId !== actor.id || prior.workspaceId !== state.workspaceId || prior.inputHash !== input.inputHash || prior.kind !== input.kind || prior.parentId !== input.parentId) throw new Error("Operation ID belongs to a different request.");
      return { status: prior.status, result: prior.result };
    }
    if (input.parentId !== undefined) {
      const parent = state.aiOperations[input.parentId];
      const result = parent?.result as { interpretation?: { kind?: unknown }; continuation?: unknown } | null;
      if (input.id === input.parentId || input.kind !== "assistant" || !parent || parent.actorId !== actor.id || parent.workspaceId !== state.workspaceId || parent.kind !== "assistant" || parent.status !== "completed" || result?.interpretation?.kind !== "clarification" || !result.continuation || typeof result.continuation !== "object" || Array.isArray(result.continuation)) {
        throw new Error("This clarification is not available to continue.");
      }
      if (Object.values(state.aiOperations).some(operation => operation.parentId === input.parentId)) throw new Error("This clarification already has a reply. Continue from the latest question or start a new request.");
    }
    // Demo calls have no provider cost; tests may exercise the real budget gate.
    if (input.reserveUsd > 0) reserveAI(state, actor, input.id, input.reserveUsd);
    else if (input.reserveUsd !== 0) throw new Error("Invalid AI reservation.");
    state.aiOperations[input.id] = { actorId: actor.id, workspaceId: state.workspaceId, kind: input.kind, inputHash: input.inputHash, parentId: input.parentId, status: "processing", result: null };
    return { status: "claimed", result: null };
  });
}
export function getDemoAIOperation(actor: Actor, id: string): Promise<PrivateAIOperation> {
  return demoTransaction(state => {
    trustedActor(state, actor);
    const operation = state.aiOperations?.[id];
    if (!operation || operation.actorId !== actor.id || operation.workspaceId !== state.workspaceId) throw new Error("AI operation is unavailable to this account.");
    return { kind: operation.kind, status: operation.status, result: operation.result };
  }, false);
}
export function finishDemoAIOperation(actor: Actor, id: string, result: unknown, costUsd?: number, error?: string) {
  return demoTransaction(state => {
    trustedActor(state, actor);
    const operation = state.aiOperations?.[id];
    if (!operation || operation.actorId !== actor.id) throw new Error("AI operation is unavailable to this account.");
    if (operation.status !== "processing") return;
    if (costUsd !== undefined) settleAI(state, actor, id, costUsd);
    operation.status = error ? "failed" : "completed";
    operation.result = error ? { error } : result;
  });
}
export function getDemoUploadReservation(actor: Actor, id: string) {
  return demoTransaction(state => {
    trustedActor(state, actor);
    const attachment = state.attachments.find(file => file.id === id && file.uploadedBy === actor.id && !file.removedAt && state.pendingAttachmentIds?.includes(file.id));
    if (!attachment) throw new Error("Upload reservation not found.");
    return attachment;
  }, false);
}
