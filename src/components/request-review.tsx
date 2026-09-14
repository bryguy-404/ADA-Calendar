"use client";
import { pendingBookingCommands } from "@/lib/pending-bookings";
import { useState } from "react";
import { Download, Paperclip, TriangleAlert } from "lucide-react";
import type { AppState, Attachment, PendingRequest, ScheduleProposal, WorkCommand, WorkItem, WorkSession } from "@/lib/types";
import { localDate } from "@/lib/time";
import { formatHours } from "@/lib/work";
import { api, ApiError, dateLabel, Field, timeLabel } from "./ui";

type Props = { state: AppState; request: PendingRequest; onState: (state: AppState) => void };
const createdItems = (request: PendingRequest) => request.proposal.commands.flatMap(command => command.type === "create" ? [command.item] : []);
function sessionLabel(session: WorkSession, state: AppState) {
  return `${dateLabel(localDate(session.start, state.settings.timeZone))} · ${timeLabel(session.start, state.settings.timeZone)}–${timeLabel(session.end, state.settings.timeZone)}${session.protected ? " · protected" : ""}`;
}

/** Uploads remain private on the request; the same work IDs preserve them on approval. */
export function RequestAttachments({ state, request, onState }: Props) {
  const items = createdItems(request);
  const [itemId, setItemId] = useState(items[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const canUpload = (request.status === "pending" || request.status === "needs_information") &&
    (state.actor.role === "owner" || state.actor.role === "requester" && request.requesterId === state.actor.id);
  const files = state.attachments.filter(file => !file.removedAt && items.some(item => item.id === file.workItemId));
  async function upload(file: File) {
    setBusy(true); setError("");
    let uploadId: string | undefined;
    try {
      const contentType = /\.(md|markdown)$/i.test(file.name) ? "text/markdown" : file.type;
      const prepared = await api<{ attachment: Attachment; uploadUrl: string }>("attachments/prepare", { workItemId: itemId, name: file.name, contentType, size: file.size });
      uploadId = prepared.attachment.id;
      const response = await fetch(prepared.uploadUrl, { method: state.mode === "demo" ? "POST" : "PUT", headers: { "Content-Type": contentType }, body: file });
      if (!response.ok) throw new Error("The upload did not finish. Please try again.");
      const completed = await api("attachments/complete", { id: uploadId });
      onState(completed.state);
    } catch (cause) {
      if (uploadId) await api("attachments/abort", { id: uploadId }).catch(() => undefined);
      setError((cause as Error).message);
    } finally { setBusy(false); }
  }
  if (!items.length) return null;
  return <section className="inset">
    <h3><Paperclip size={17} /> Request files</h3>
    <p className="micro">Private to Bryan and the requester until the work is booked. Up to five original files and 20 MB total per task.</p>
    {files.map(file => <div className="list-row" key={file.id}>
      <div><strong>{file.name}</strong><p className="micro">{items.find(item => item.id === file.workItemId)?.title} · {(file.size / 1024).toFixed(1)} KB</p></div>
      <a className="secondary" href={`/api/attachments/${encodeURIComponent(file.id)}?download=1`}><Download size={14} /> Download original</a>
    </div>)}
    {!files.length && <p className="muted">No files attached yet.</p>}
    {canUpload && <div className="form-grid">
      {items.length > 1 && <Field label="Attach to task"><select value={itemId} onChange={event => setItemId(event.target.value)} disabled={busy}>{items.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></Field>}
      <Field label={busy ? "Uploading…" : "Add supporting file"}><input type="file" accept=".md,.markdown,.pdf,.png,.jpg,.jpeg,.webp" disabled={busy || !itemId} onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void upload(file); }} /></Field>
    </div>}
    {error && <p className="error" role="alert">{error}</p>}
  </section>;
}

export function RequestReview({ state, request, onState, onClose }: Props & { onClose: () => void }) {
  const [commands, setCommands] = useState<WorkCommand[]>(() => pendingBookingCommands(request, state.settings.timeZone, state.settings.weekdays).map(command => {
    // Request text never carries permission to override existing protected time or deadlines.
    return "overrideProtected" in command || "overrideDeadline" in command ? { ...command, overrideProtected: false, overrideDeadline: false } as WorkCommand : command;
  }));
  const [overrides, setOverrides] = useState<string[]>([]);
  const [deadlineEdits, setDeadlineEdits] = useState<Record<string, string>>( {} );
  const [note, setNote] = useState("");
  const [proposal, setProposal] = useState<ScheduleProposal | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = request.status === "pending" || request.status === "needs_information";
  const newItems = commands.flatMap(command => command.type === "create" ? [{ ...command.item,
    windowStart: command.bookingWindow?.startDate ?? command.item.windowStart,
    windowEnd: command.bookingWindow?.endDate ?? command.item.windowEnd }] : []);
  const protectedItems = state.items.filter(item => state.sessions.some(session => session.workItemId === item.id && session.protected && session.status === "planned"));
  const firmItems = state.items.filter(item => item.deadline && item.status !== "completed" && item.status !== "cancelled");
  function patchItem(id: string, patch: Partial<WorkItem>) {
    setCommands(current => current.map(command => {
      if (command.type !== "create" || command.item.id !== id) return command;
      const item = { ...command.item, ...patch };
      const bookingChanged = patch.windowStart !== undefined || patch.windowEnd !== undefined || patch.remainingMinutes !== undefined;
      const startDate = patch.windowStart ?? command.bookingWindow?.startDate ?? item.windowStart;
      const endDate = patch.windowEnd !== undefined ? patch.windowEnd ?? startDate : command.bookingWindow?.endDate ?? item.windowEnd ?? startDate;
      const dates = patch.windowStart === undefined && patch.windowEnd === undefined ? command.bookingWindow?.dates : undefined;
      return bookingChanged ? { ...command, item: { ...item, dailyPlan: undefined }, sessions: undefined,
        smartFit: undefined, bookingWindow: { startDate, endDate, ...(dates ? { dates } : {}) } } : { ...command, item };
    }));
    setProposal(null);
  }
  function revisedCommands(): WorkCommand[] {
    return [
      ...Object.entries(deadlineEdits).filter(([id, date]) => (date || null) !== state.items.find(item => item.id === id)?.deadline).map(([itemId, deadline]): WorkCommand => ({ type: "update", itemId, patch: { deadline: deadline || null }, overrideDeadline: true })),
      ...overrides.map((itemId): WorkCommand => ({ type: "update", itemId, patch: {}, overrideProtected: true })),
      ...commands,
    ];
  }
  async function preview() {
    setBusy(true); setError(""); setProposal(null);
    try {
      const result = await api<{ state: AppState; proposal: ScheduleProposal }>("requests/resolve", { id: request.id, decision: "approved", commands: revisedCommands(), preview: true });
      setProposal(result.proposal);
      // Refresh the exact “Before” snapshot used for this preview without resetting local edits.
      onState(result.state);
    }
    catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }
  async function resolve(decision: "approved" | "declined" | "needs_information") {
    if (decision === "needs_information" && !note.trim()) { setError("Add a note explaining what information you need."); return; }
    if (decision === "approved" && (!proposal || proposal.baseVersion !== state.version)) { setProposal(null); setError("The schedule changed. Preview again before approving."); return; }
    setBusy(true); setError("");
    try {
      const response = await api("requests/resolve", { id: request.id, decision, note,
        ...(decision === "approved" && proposal ? { commands: proposal.commands, baseVersion: proposal.baseVersion, reviewFingerprint: proposal.reviewFingerprint } : {}) });
      onState(response.state); onClose();
    } catch (cause) {
      setError((cause as Error).message);
      setProposal(cause instanceof ApiError ? cause.proposal ?? null : null);
      if (cause instanceof ApiError && cause.state) onState(cause.state);
    }
    finally { setBusy(false); }
  }
  const ready = proposal?.status === "ready" && !proposal.requiresApproval && proposal.baseVersion === state.version;
  return <div className="work-form">
    <p className="muted">Requested by {request.requesterName}. Revise the plan, review every affected commitment, then approve. Nothing moves during preview.</p>
    {request.note && <p className="inset">Latest note: {request.note}</p>}
    {!!request.conversation?.length && <details className="inset" open><summary>Request conversation</summary>{request.conversation.map((entry, index) => <p key={`${entry.createdAt}/${index}`}><strong>{entry.author === "owner" ? "Bryan" : request.requesterName}:</strong> {entry.message}</p>)}</details>}
    {state.actor.role === "owner" && pending && <>
      {newItems.map(item => <section className="inset" key={item.id}>
        <h3>{item.title}</h3>
        <p className="micro">{state.clients.find(client => client.id === item.clientId)?.name}</p>
        <div className="form-grid">
          <Field label="First work day"><input type="date" required value={item.windowStart} disabled={busy} onChange={event => patchItem(item.id, { windowStart: event.target.value, allowedDates: [] })} /></Field>
          <Field label="Last work day"><input type="date" value={item.windowEnd ?? ""} disabled={busy} onChange={event => patchItem(item.id, { windowEnd: event.target.value || null, allowedDates: [] })} /></Field>
          <Field label="Estimated work (hours)"><input type="number" min="0.25" step="0.25" value={item.estimatedMinutes === null ? "" : item.estimatedMinutes / 60} disabled={busy} onChange={event => { const minutes = event.target.value ? Math.round(Number(event.target.value) * 60) : null; patchItem(item.id, { estimatedMinutes: minutes, remainingMinutes: minutes }); }} /></Field>
          <Field label="Approved priority"><select value={item.priorityId} disabled={busy} onChange={event => patchItem(item.id, { priorityId: event.target.value })}>{state.priorities.map(priority => <option key={priority.id} value={priority.id}>{priority.label}</option>)}</select></Field>
          <Field label="Target date (flexible)"><input type="date" value={item.targetDate ?? ""} disabled={busy} onChange={event => patchItem(item.id, { targetDate: event.target.value || null })} /></Field>
          <Field label="Firm deadline" hint="Clearing or changing this field explicitly revises the requested deadline."><input type="date" value={item.deadline ?? ""} disabled={busy} onChange={event => patchItem(item.id, { deadline: event.target.value || null })} /></Field>
        </div>
        {commands.some(command => command.type === "create" && command.item.id === item.id && command.sessions?.length) && <p className="micro">The request includes exact sessions. Editing these fields switches this task to automatic placement within its revised dates.</p>}
      </section>)}
      {(protectedItems.length > 0 || firmItems.length > 0) && <details className="inset">
        <summary>Explicit exceptions for existing commitments</summary>
        <p className="micro">These are optional. Checking one project authorizes moving its protected sessions only; protection remains on its replacement sessions. A firm deadline changes only when you edit its date below.</p>
        {protectedItems.map(item => <label className="check" key={item.id}><input type="checkbox" checked={overrides.includes(item.id)} disabled={busy} onChange={event => { setOverrides(current => event.target.checked ? [...current, item.id] : current.filter(id => id !== item.id)); setProposal(null); }} />I authorize moving protected time for “{item.title}”.</label>)}
        {firmItems.map(item => <Field key={item.id} label={`Firm deadline: ${item.title}`} hint={`Currently ${dateLabel(item.deadline!)}. Edit or clear only with an explicit decision.`}><input type="date" value={deadlineEdits[item.id] ?? item.deadline!} disabled={busy} onChange={event => { setDeadlineEdits(current => ({ ...current, [item.id]: event.target.value })); setProposal(null); }} /></Field>)}
      </details>}
      <Field label="Decision note"><textarea value={note} maxLength={5000} disabled={busy} onChange={event => setNote(event.target.value)} placeholder="Explain the revised plan or ask for missing details." /></Field>
      <button className="secondary" type="button" disabled={busy} onClick={preview}>{busy ? "Working…" : "Preview revised plan"}</button>
      {proposal && <section className={`proposal ${ready ? "proposal-ready" : "proposal-conflict"}`}>
        <h3>{ready ? "Review before approval" : <><TriangleAlert size={18} /> This plan still needs changes</>}</h3>
        <ul>{proposal.summary.map((summary, index) => <li key={`s${index}`}>{summary}</li>)}{proposal.conflicts.map((conflict, index) => <li key={`c${index}`}>{conflict.message}</li>)}</ul>
        {proposal.affectedItemIds.map(id => {
          const before = state.items.find(item => item.id === id); const after = proposal.items.find(item => item.id === id);
          if (!after) return null;
          const prior = state.sessions.filter(session => session.workItemId === id && session.status === "planned");
          const next = proposal.sessions.filter(session => session.workItemId === id && session.status === "planned");
          return <details key={id} open className="inset"><summary>{after.title} · {after.remainingMinutes === null ? "Hours added as needed" : formatHours(after.remainingMinutes)} remaining</summary>
            <p className="micro">Priority: {before ? state.priorities.find(priority => priority.id === before.priorityId)?.label : "New"} → {state.priorities.find(priority => priority.id === after.priorityId)?.label}. Firm deadline: {before?.deadline ?? "None"} → {after.deadline ?? "None"}.</p>
            <div className="form-grid"><div><strong>Before</strong>{prior.length ? prior.map(session => <p className="micro" key={session.id}>{sessionLabel(session, state)}</p>) : <p className="micro">No sessions</p>}</div><div><strong>After approval</strong>{next.length ? next.map(session => <p className="micro" key={session.id}>{sessionLabel(session, state)}</p>) : <p className="micro">No sessions</p>}</div></div>
          </details>;
        })}
        {proposal.baseVersion !== state.version && <p className="error">The schedule changed. Preview again.</p>}
        <button type="button" className="primary" disabled={busy || !ready} onClick={() => resolve("approved")}>Approve this reviewed plan</button>
      </section>}
      <div className="button-row"><button className="secondary" type="button" disabled={busy} onClick={() => resolve("needs_information")}>Ask for information</button><button className="secondary danger" type="button" disabled={busy} onClick={() => resolve("declined")}>Decline request</button></div>
    </>}
    <RequestAttachments state={state} request={request} onState={onState} />
    {error && <p className="error" role="alert">{error}</p>}
  </div>;
}
