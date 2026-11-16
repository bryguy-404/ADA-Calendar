import { createHash } from "node:crypto";
import type { Actor, AppState, ScheduleProposal, WorkCommand, WorkItem } from "../types";
import { dayOpenings, planCommands } from "../scheduler";
import { addDays, minutesBetween } from "../time";
import { defaultWorkPriority, newWorkItem } from "../work";
import { withReviewFingerprint } from "../server/preview";
import { availabilitySchema, discoverySchema, type PrepareScheduleInput } from "./scheduling-contract";

export class SchedulingError extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) { super(message); }
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
export const digest = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
export const source = (s: AppState) => ({ workspaceId: s.workspaceId, scheduleVersion: s.version, actorId: s.actor.id, mode: s.mode, timeZone: s.settings.timeZone });
export function discover(state: AppState, raw: unknown) {
  const input = discoverySchema.parse(raw), query = input.query.toLocaleLowerCase();
  const plannedCounts = new Map<string, number>();
  for (const session of state.sessions) if (session.status === "planned") plannedCounts.set(session.workItemId, (plannedCounts.get(session.workItemId) ?? 0) + 1);
  if (input.baseVersion !== undefined && input.baseVersion !== state.version) throw new SchedulingError("stale_version", "Calendar changed; restart discovery at offset zero.");
  const rows = input.kind === "clients" ? state.clients.filter(c => [c.name, ...c.aliases].some(n => n.toLocaleLowerCase().includes(query)))
    .map(c => ({ id: c.id, name: c.name, aliases: c.aliases })) : state.items.filter(i =>
      (!input.clientId || i.clientId === input.clientId) && i.title.toLocaleLowerCase().includes(query) &&
      (input.status === "all" || (input.status === "active" && !["completed", "cancelled"].includes(i.status)) || i.status === input.status) &&
      (!input.unscheduledOnly || !plannedCounts.has(i.id)))
      .map(i => ({ id: i.id, clientId: i.clientId, title: i.title, status: i.status, ongoing: i.timelineMode === "span" && i.windowEnd === null,
        remainingMinutes: i.remainingMinutes, plannedSessions: plannedCounts.get(i.id) ?? 0 }));
  rows.sort((a, b) => a.id.localeCompare(b.id));
  return { source: source(state), results: rows.slice(input.offset, input.offset + input.limit),
    nextOffset: input.offset + input.limit < rows.length ? input.offset + input.limit : null };
}
export function availableSlots(state: AppState, raw: unknown, now = new Date().toISOString()) {
  const input = availabilitySchema.parse(raw), days = [];
  for (let date = input.startDate; date <= input.endDate; date = addDays(date, 1)) days.push({ date, openings: dayOpenings(state, date, now) });
  return { source: source(state), days, note: "Open capacity only; task limits and saved version are checked again during prepare and commit." };
}
function semanticItem(item: WorkItem) { const { updatedAt: _, ...rest } = item; void _; return rest; }
export function exactDiff(state: AppState, proposal: ScheduleProposal) {
  const changes = <T extends { id: string }>(before: T[], after: T[]) => {
    const oldRows = new Map(before.map(v => [v.id, v])), newRows = new Map(after.map(v => [v.id, v]));
    return [...new Set([...oldRows.keys(), ...newRows.keys()])].sort().flatMap(id => {
    const a = oldRows.get(id), b = newRows.get(id);
    if (canonical(a) === canonical(b)) return [];
    const fields = Object.fromEntries([...new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])].filter(k =>
      canonical(a?.[k as keyof T]) !== canonical(b?.[k as keyof T])).map(k => [k, { before: a?.[k as keyof T] ?? null, after: b?.[k as keyof T] ?? null }]));
    return [{ id, fields }];
    });
  };
  const originalIds = new Set(state.items.map(i => i.id));
  const forDiff = (item: WorkItem) => { const { createdAt, ...rest } = semanticItem(item); return originalIds.has(item.id) ? { ...rest, createdAt } : rest; };
  // Creation time is assigned at commit, not an instruction to reserve capacity.
  return { items: changes(state.items.map(forDiff), proposal.items.map(forDiff)), sessions: changes(state.sessions, proposal.sessions) };
}
export function assertScope(state: AppState, proposal: ScheduleProposal, input: PrepareScheduleInput) {
  if (proposal.status !== "ready" || proposal.requiresApproval) throw new SchedulingError("schedule_conflict", proposal.conflicts.map(c => c.message).join(" ") || "This change cannot fit safely.");
  const change = input.change;
  const ids = new Set(change.kind === "create" ? [input.operationId] : change.kind === "reschedule" ? change.moves.map(m => state.sessions.find(s => s.id === m.sessionId)?.workItemId) : [change.workItemId]);
  const afterItems = new Map(proposal.items.map(i => [i.id, i])), afterSessions = new Map(proposal.sessions.map(s => [s.id, s]));
  const expectedIds = new Set(state.items.map(i => i.id));
  if (change.kind === "create") expectedIds.add(input.operationId);
  if (proposal.items.length !== expectedIds.size || proposal.items.some(i => !expectedIds.has(i.id))) throw new SchedulingError("scope_violation", "This would add or remove unrequested tasks.");
  if (canonical(state.blocks) !== canonical(proposal.blocks)) throw new SchedulingError("scope_violation", "Unavailable time must remain unchanged.");
  for (const item of state.items) if (!afterItems.has(item.id) || !ids.has(item.id) && canonical(semanticItem(item)) !== canonical(semanticItem(afterItems.get(item.id)!)))
    throw new SchedulingError("scope_violation", "This would change unrelated work.");
  const moved = new Set(change.kind === "reschedule" ? change.moves.map(m => m.sessionId) : []);
  for (const session of state.sessions) {
    const after = afterSessions.get(session.id);
    if (!moved.has(session.id) && canonical(after) !== canonical(session)) throw new SchedulingError("scope_violation", "This would move or remove an unrequested booking or history.");
  }
  if (change.kind === "reschedule" || change.kind === "ongoing") {
    if (proposal.sessions.length !== state.sessions.length) throw new SchedulingError("scope_violation", "This would add or remove bookings outside the request.");
  }
  if (change.kind === "ongoing") {
    const before = state.items.find(i => i.id === change.workItemId)!, after = proposal.items.find(i => i.id === change.workItemId)!;
    const allowed = new Set(["timelineMode", "windowEnd", "updatedAt", ...(change.unknownEffort ? ["estimatedMinutes", "remainingMinutes", "forecastDate"] : [])]);
    for (const key of Object.keys(before) as (keyof WorkItem)[]) if (!allowed.has(key) && canonical(before[key]) !== canonical(after[key]))
      throw new SchedulingError("scope_violation", `Ongoing visibility must preserve ${key}.`);
  }
  const diff = exactDiff(state, proposal);
  if (diff.sessions.length > 60 || Buffer.byteLength(JSON.stringify(diff)) > 60_000) throw new SchedulingError("preview_too_large", "Split this into smaller scheduling operations.");
  return diff;
}
export function preparePlan(state: AppState, actor: Actor, input: PrepareScheduleInput, now = new Date().toISOString()) {
  const change = input.change;
  const getItem = (id: string) => { const item = state.items.find(i => i.id === id); if (!item || ["completed", "cancelled"].includes(item.status)) throw new SchedulingError("invalid_task", "Choose an existing active task."); return item; };
  let commands: WorkCommand[];
  if (change.kind === "create") {
    if (!state.clients.some(c => c.id === change.task.clientId)) throw new SchedulingError("invalid_client", "Discover and use an exact existing client ID.");
    const requester = change.task.requesterId === null ? null : state.members.find(m => m.id === (change.task.requesterId ?? actor.id));
    if (change.task.requesterId !== null && !requester) throw new SchedulingError("invalid_requester", "Requester must be an active workspace member.");
    const item = newWorkItem(actor, change.task.windowStart, { ...change.task, id: input.operationId, createdAt: now, updatedAt: now,
      requesterId: requester?.id ?? null, requestedBy: requester?.name ?? actor.name,
      priorityId: change.task.priorityId ?? defaultWorkPriority(change.task.category, state.priorities),
      remainingMinutes: change.task.estimatedMinutes, status: change.booking ? "planned" : "waiting" });
    commands = [{ type: "create", item, ...(change.booking ? { smartFit: change.booking } : { sessions: [] }) }];
  } else if (change.kind === "book") {
    getItem(change.workItemId); commands = [{ type: "fit", itemId: change.workItemId, request: change.booking }];
  } else if (change.kind === "reschedule") {
    commands = change.moves.map(move => {
      const original = state.sessions.find(s => s.id === move.sessionId);
      if (!original || original.status !== "planned" || Date.parse(original.start) < Date.parse(now)) throw new SchedulingError("invalid_session", "Move only exact future planned sessions; recorded history is immutable.");
      getItem(original.workItemId);
      if (minutesBetween(original.start, original.end) !== minutesBetween(move.start, move.end)) throw new SchedulingError("invalid_duration", "Rescheduling must preserve the booked duration.");
      if (original.protected && !move.overrideProtected) throw new SchedulingError("protected_session", "Moving this protected session needs explicit owner override.");
      return { type: "move", ...move };
    });
  } else {
    const item = getItem(change.workItemId);
    commands = [{ type: "update", itemId: item.id, patch: { timelineMode: "span", windowEnd: null,
      ...(change.unknownEffort ? { estimatedMinutes: null, remainingMinutes: null } : {}) } }];
    if (item.status !== "waiting") commands.push({ type: "schedule", itemId: item.id, sessions: state.sessions.filter(s => s.workItemId === item.id && s.status === "planned") });
  }
  const plan = (cmds: WorkCommand[]) => withReviewFingerprint(planCommands(state, cmds, actor, { operationId: input.operationId, now, approveDisplacement: false }));
  let proposal = plan(commands);
  assertScope(state, proposal, input);
  // Freeze smart-fit placements into explicit shared-scheduler commands. IDs and exact
  // placements then survive a restarted adapter, server process, or lost response.
  if (change.kind === "book" || change.kind === "create" && change.booking) {
    const id = change.kind === "book" ? change.workItemId : input.operationId;
    const after = proposal.items.find(i => i.id === id)!;
    const sessions = proposal.sessions.filter(s => s.workItemId === id && s.status === "planned");
    commands = change.kind === "create" ? [{ type: "create", item: after, sessions }] : [
      { type: "update", itemId: id, patch: { status: after.status, blockedReason: after.blockedReason, ...(after.dailyPlan ? { dailyPlan: after.dailyPlan } : {}) } },
      { type: "schedule", itemId: id, sessions },
    ];
    const frozen = plan(commands);
    if (canonical(exactDiff(state, frozen)) !== canonical(exactDiff(state, proposal))) throw new SchedulingError("plan_changed", "The exact booking could not be preserved; review a smaller request.");
    proposal = frozen;
  }
  return { proposal, diff: assertScope(state, proposal, input) };
}
