"use client";
import { useState } from "react";
import type { AppState, WorkItem } from "@/lib/types";
import type { TaskContextRequest } from "@/lib/task-context";
import { Field } from "./ui";

export function WaitingReasonEditor({ item, state, onState }: { item: WorkItem; state: AppState; onState: (state: AppState) => void }) {
  const [draft, setDraft] = useState<{ reason: string; baseVersion: number } | null>(null);
  const [pending, setPending] = useState<TaskContextRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [conflicted, setConflicted] = useState(false);
  function edit() {
    setDraft({ reason: item.blockedReason ?? "", baseVersion: state.version });
    setError(""); setConflicted(false);
  }
  async function save() {
    if (!draft) return;
    const input = pending ?? { workspaceId: state.workspaceId, workItemId: item.id, baseVersion: draft.baseVersion,
      operationId: crypto.randomUUID(), patch: { blockedReason: draft.reason || null } };
    setPending(input); setBusy(true); setError("");
    try {
      const response = await fetch("/api/task-context", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
      const result = await response.json();
      if (!response.ok) {
        if (response.status < 500 && result.code !== "save_uncertain") { setPending(null); setConflicted(true); }
        throw new Error(result.error || "The save could not be confirmed. Retry this same save to check its result.");
      }
      onState(result.state); setPending(null); setDraft(null);
    } catch (error) {
      setError(error instanceof Error ? error.message : "The save could not be confirmed. Retry this same save to check its result.");
    } finally { setBusy(false); }
  }
  async function reload() {
    setBusy(true);
    try {
      const response = await fetch("/api/state", { cache: "no-store" });
      if (!response.ok) throw new Error("Unable to reload the saved reason.");
      onState(await response.json()); setDraft(null); setConflicted(false); setError("");
    } catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  }
  if (!draft) return <button className="secondary" onClick={edit}>Edit waiting reason</button>;
  return <div className="inset">
    <Field label="Waiting reason"><textarea aria-label="Waiting reason" value={draft.reason} maxLength={2000} rows={4}
      disabled={busy || !!pending || conflicted} onChange={event => setDraft({ ...draft, reason: event.target.value })} /></Field>
    <p className="micro muted">Updates this reason only. Waiting status, booked hours and completed history stay unchanged. No email is sent.</p>
    {error && <p role="alert" className="error">{error}</p>}
    <div className="detail-actions">
      {conflicted ? <button className="secondary" disabled={busy} onClick={reload}>Reload saved reason</button>
        : <button className="primary" disabled={busy} onClick={save}>{busy ? "Saving…" : pending ? "Retry same save" : "Save waiting reason"}</button>}
      <button className="secondary" disabled={busy || !!pending} onClick={() => { setDraft(null); setError(""); }}>Cancel</button>
    </div>
  </div>;
}
