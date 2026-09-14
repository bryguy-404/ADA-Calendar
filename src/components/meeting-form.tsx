"use client";

import { useRef, useState } from "react";
import { CalendarClock, LockKeyhole } from "lucide-react";
import type { AppState, ScheduleProposal, UnavailableBlock, WorkSession } from "@/lib/types";
import { addDays, instantMs, localDate, localDateTime, minutesBetween } from "@/lib/time";
import { dayCapacity } from "@/lib/scheduler";
import { formatHours } from "@/lib/work";
import { useCalendarClock } from "./calendar-clock";
import { api, ApiError, dateLabel, Field, Modal, timeLabel } from "./ui";

type Draft = { title: string; kind: UnavailableBlock["kind"]; date: string; endDate: string; start: string; end: string };
type Review = { before: AppState; proposal: ScheduleProposal; block: UnavailableBlock; remove: boolean };

function clockTime(instant: string, timeZone: string) {
  return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone }).format(new Date(instant));
}
function describeTime(block: { start: string; end: string }, timeZone: string) {
  const first = localDate(block.start, timeZone), last = localDate(block.end, timeZone);
  return `${dateLabel(first, { month: "short", day: "numeric", year: "numeric" })} · ${timeLabel(block.start, timeZone)}–${first === last ? "" : `${dateLabel(last)} · `}${timeLabel(block.end, timeZone)}`;
}
function sameSession(a: WorkSession, b: WorkSession) {
  return a.workItemId === b.workItemId && a.start === b.start && a.end === b.end && a.status === b.status && a.protected === b.protected && a.usesReserve === b.usesReserve;
}

/** Fixed commitments use the same reviewed, authorized transaction as work. */
export function MeetingForm({ state, date, existing, onSaved, onCommitted, onClose }: {
  state: AppState; date: string; existing?: UnavailableBlock;
  onSaved: (state: AppState) => void; onCommitted: (state: AppState, date: string) => void; onClose: () => void;
}) {
  const [zone] = useState(state.settings.timeZone);
  const now = useCalendarClock();
  const owner = state.actor.role === "owner";
  const [id] = useState(() => existing?.id ?? crypto.randomUUID());
  const [draft, setDraft] = useState<Draft>(() => ({
    title: existing?.title ?? "", kind: existing?.kind ?? "meeting",
    date: existing ? localDate(existing.start, zone) : date,
    endDate: existing ? localDate(existing.end, zone) : date,
    start: existing ? clockTime(existing.start, zone) : "09:00",
    end: existing ? clockTime(existing.end, zone) : "10:00",
  }));
  const [overrideProtected, setOverrideProtected] = useState(false);
  const [showOverride, setShowOverride] = useState(false);
  const [review, setReview] = useState<Review | null>(null);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  const operationId = useRef(crypto.randomUUID());
  const kindLabel = draft.kind === "meeting" ? "meeting" : "time off";
  const stale = review && state.version !== review.proposal.baseVersion;

  function change(patch: Partial<Draft>) {
    setDraft(current => ({ ...current, ...patch }));
    setOverrideProtected(false); setShowOverride(false);
    setReview(null); setError(""); operationId.current = crypto.randomUUID();
  }
  async function preview(remove = false) {
    if (!owner || inFlight.current || uncertain) return;
    inFlight.current = true; setBusy(true); setError(""); setReview(null);
    try {
      if (!draft.title.trim()) throw new Error("Add a title so you can recognize this time on your calendar.");
      const block: UnavailableBlock = remove && existing ? existing : {
        id, title: draft.title.trim(), kind: draft.kind,
        start: localDateTime(draft.date, draft.start, zone),
        end: localDateTime(draft.endDate, draft.end, zone),
      };
      if (minutesBetween(block.start, block.end) <= 0) throw new Error("End time must be after start time.");
      let before = await api<AppState>("state");
      if (before.workspaceId !== state.workspaceId || before.actor.id !== state.actor.id || before.actor.role !== "owner") throw new Error("Your access changed. Refresh the calendar before continuing.");
      if (before.settings.timeZone !== zone) {
        onSaved(before);
        throw new Error("The workspace timezone changed. Close and reopen this form to enter times in the current timezone.");
      }
      if (existing) {
        const current = before.blocks.find(block => block.id === existing.id);
        if (!current || current.title !== existing.title || current.kind !== existing.kind || current.start !== existing.start || current.end !== existing.end) {
          onSaved(before);
          throw new Error("This meeting was changed or removed elsewhere. Close this form and open the latest calendar entry before editing.");
        }
      }
      const result = await api<{ proposal: ScheduleProposal }>("commands", {
        action: "preview", operationId: operationId.current,
        commands: [{ type: "block", block, ...(remove ? { remove: true } : {}), ...(overrideProtected ? { overrideProtected: true } : {}) }],
      });
      if (before.version !== result.proposal.baseVersion) before = await api<AppState>("state");
      if (before.version !== result.proposal.baseVersion) throw new Error("The calendar changed while checking this time. Preview again.");
      // Publish the current snapshot so a stale form cannot confirm against old data.
      onSaved(before);
      setReview({ before, proposal: result.proposal, block, remove });
      if (result.proposal.conflicts.some(conflict => conflict.code === "protected_session")) setShowOverride(true);
    } catch (reason) { setError((reason as Error).message); }
    finally { inFlight.current = false; setBusy(false); }
  }
  async function reconcile(message: string) {
    const next = await api<AppState>("state");
    if (next.workspaceId !== state.workspaceId || next.actor.id !== state.actor.id || next.actor.role !== "owner") throw new Error("Your access changed. Refresh the calendar before continuing.");
    onSaved(next);
    if (next.events.some(event => event.operationId === operationId.current && event.actorId === state.actor.id)) {
      setUncertain(false); onCommitted(next, draft.date); onClose(); return;
    }
    setUncertain(false); setError(message);
  }
  async function confirm() {
    if (!owner || !review || stale || inFlight.current || uncertain || review.proposal.status !== "ready" || review.proposal.requiresApproval) return;
    inFlight.current = true; setBusy(true); setError("");
    try {
      const result = await api("commands", { action: "commit", operationId: review.proposal.operationId,
        commands: review.proposal.commands, baseVersion: review.proposal.baseVersion, reviewFingerprint: review.proposal.reviewFingerprint });
      onCommitted(result.state, draft.date); onClose();
    } catch (reason) {
      if (reason instanceof ApiError && reason.state && reason.proposal) {
        onSaved(reason.state); setReview(null); setError(reason.message);
      } else {
        try { await reconcile((reason as Error).message); }
        catch { setUncertain(true); setError("The connection interrupted saving. Check save status before making another change."); }
      }
    } finally { inFlight.current = false; setBusy(false); }
  }
  async function checkSave() {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true);
    try { await reconcile("No saved change was found. You can retry the same preview."); }
    catch { setError("The calendar is still unreachable. Try checking save status again."); }
    finally { inFlight.current = false; setBusy(false); }
  }

  const changedItems = review ? review.proposal.affectedItemIds.map(itemId => {
    const before = review.before.sessions.filter(s => s.workItemId === itemId && s.status === "planned");
    const after = review.proposal.sessions.filter(s => s.workItemId === itemId && s.status === "planned");
    return { id: itemId, title: review.proposal.items.find(item => item.id === itemId)?.title,
      before: before.filter(s => !after.some(other => sameSession(s, other))), after: after.filter(s => !before.some(other => sameSession(s, other))) };
  }).filter(item => item.before.length || item.after.length) : [];
  const impactedDays = new Set<string>();
  if (review) {
    for (const block of [review.block, review.before.blocks.find(block => block.id === id)].filter((block): block is UnavailableBlock => !!block)) {
      const last = localDate(block.end, zone);
      // Long time-off ranges show the first 31 days; work changes are all listed below.
      for (let day = localDate(block.start, zone), count = 0; day <= last && count < 31; day = addDays(day, 1), count++) impactedDays.add(day);
    }
    for (const item of changedItems) for (const session of [...item.before, ...item.after]) impactedDays.add(localDate(session.start, zone));
  }

  return <Modal open onClose={() => { if (!busy && !uncertain) onClose(); }} title={existing ? "Meeting details" : "Add meeting"}
    description="Reserve a fixed time. ADA schedules work around your meetings and time off.">
    {owner ? <form className="meeting-form" onSubmit={event => { event.preventDefault(); void preview(); }}>
      <fieldset disabled={busy || uncertain}>
        <Field label="Meeting title" hint="Include the client or purpose, e.g. Higher Ground · project check-in.">
          <input required maxLength={200} value={draft.title} onChange={event => change({ title: event.target.value })} placeholder="Client · meeting name" />
        </Field>
        <Field label="Type"><select value={draft.kind} onChange={event => change({ kind: event.target.value as Draft["kind"] })}>
          <option value="meeting">Meeting</option><option value="time_off">Time off</option>
        </select></Field>
        <Field label="Date"><input required type="date" value={draft.date} onChange={event => change({ date: event.target.value, endDate: event.target.value })} /></Field>
        {(draft.kind === "time_off" || draft.endDate !== draft.date) && <Field label="End date"><input required type="date" min={draft.date} value={draft.endDate} onChange={event => change({ endDate: event.target.value })} /></Field>}
        <div className="form-grid">
          <Field label="Start time"><input required type="time" step={900} value={draft.start} onChange={event => change({ start: event.target.value })} /></Field>
          <Field label="End time"><input required type="time" step={900} value={draft.end} onChange={event => change({ end: event.target.value })} /></Field>
        </div>
        <p className="micro muted">Times use {zone}. Only time inside your working hours reduces work capacity. Meetings don’t count toward a project’s effort.</p>
        {showOverride && <label className="check"><input type="checkbox" checked={overrideProtected} onChange={event => { setOverrideProtected(event.target.checked); setReview(null); operationId.current = crypto.randomUUID(); }} /><LockKeyhole size={14} />Allow this meeting to move overlapping protected work. Preview again to review the changes.</label>}
        <div className="form-actions">
          {existing && <button type="button" className="text-button" onClick={() => { operationId.current = crypto.randomUUID(); void preview(true); }}>Remove meeting</button>}
          <button className="primary" type="submit"><CalendarClock size={16} />{busy ? "Checking…" : existing ? "Preview changes" : "Preview meeting"}</button>
        </div>
      </fieldset>
    </form> : existing && <div className="meeting-readonly"><h3>{existing.title}</h3><p>{describeTime(existing, zone)}</p><p>{existing.kind === "meeting" ? "Meeting" : "Time off"} · {formatHours(minutesBetween(existing.start, existing.end))}</p><p className="muted">This time is reserved. Bryan manages meetings and time off.</p></div>}

    {review && <section className={`proposal ${review.proposal.status === "ready" ? "proposal-ready" : "proposal-conflict"}`} aria-label="Meeting preview">
      <p className="eyebrow">PREVIEW · NOT SAVED</p>
      <h3>{review.remove ? "Remove this reserved time" : `Reserve ${formatHours(minutesBetween(review.block.start, review.block.end))} for ${kindLabel}`}</h3>
      <p><strong>{review.block.title}</strong><br />{describeTime(review.block, zone)}</p>
      {!review.remove && review.before.blocks.filter(block => block.id !== id && instantMs(block.start) < instantMs(review.block.end) && instantMs(block.end) > instantMs(review.block.start))
        .map(block => <p key={block.id}>Overlaps reserved time: <strong>{block.title}</strong> · {describeTime(block, zone)}. Shared minutes count once.</p>)}
      {existing && !review.remove && <p className="micro muted">Previously: {describeTime(review.before.blocks.find(block => block.id === id) ?? existing, zone)}</p>}
      {!!review.proposal.conflicts.length && <div role="alert">{review.proposal.conflicts.map((conflict, index) => <p key={index}>{conflict.message}</p>)}</div>}
      {changedItems.length ? <div className="meeting-work-changes"><h4>Work that would move</h4>{changedItems.map(item => <div key={item.id}>
        <strong>{item.title}</strong>
        <p>Before: {item.before.length ? item.before.map(session => describeTime(session, zone)).join("; ") : "No booked hours"}</p>
        <p>After: {item.after.length ? item.after.map(session => describeTime(session, zone)).join("; ") : "No booked hours"}</p>
      </div>)}</div> : review.proposal.status === "ready" && <p>Existing work stays at its saved times.</p>}
      {review.proposal.status === "ready" && <div className="meeting-capacity" aria-label="Work capacity after meeting">
        {[...impactedDays].sort().map(day => {
          const before = dayCapacity(review.before, day, now);
          const after = dayCapacity({ ...review.before, ...review.proposal }, day, now);
          return <p key={day}><strong>{dateLabel(day)}</strong><span>{formatHours(before.availableMinutes)} → {formatHours(after.availableMinutes)} left for work</span></p>;
        })}
        {minutesBetween(review.block.start, review.block.end) > 31 * 24 * 60 && <p className="micro muted">Capacity shown for the first 31 days and any days with moved work.</p>}
      </div>}
      {stale && <p role="status">The calendar changed. Preview again before confirming.</p>}
      {!uncertain && review.proposal.status === "ready" && !review.proposal.requiresApproval && <button type="button" className="primary" disabled={busy || !!stale} onClick={confirm}>{busy ? "Saving…" : review.remove ? "Confirm removal" : existing ? "Confirm changes" : "Confirm meeting"}</button>}
    </section>}
    {error && <p className="error" role="alert">{error}</p>}
    {uncertain && <button className="secondary" disabled={busy} onClick={checkSave}>Check save status</button>}
  </Modal>;
}
