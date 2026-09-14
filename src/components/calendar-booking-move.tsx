"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, LoaderCircle, RefreshCw, Undo2 } from "lucide-react";
import type { AppState, ScheduleProposal, WorkEvent } from "@/lib/types";
import { CALENDAR_MOVE_PREFIX, calendarBookingMovePreview, calendarBookingMoveSourceUnavailableReason, calendarBookingMoveTargetUnavailableReason, latestCalendarBookingMove, type CalendarBookingMoveSelection } from "@/lib/calendar-booking-move";
import { undoUnavailableReason } from "@/lib/undo";
import { localDate } from "@/lib/time";
import { useCalendarClock } from "./calendar-clock";
import { api, ApiError, dateLabel, Modal, timeLabel } from "./ui";

interface Props { state: AppState; selection: CalendarBookingMoveSelection | null; onClose: () => void; onState: (state: AppState) => void; onInteractionLockChange?: (locked: boolean) => void }
type Preview = { state: AppState; proposal: ScheduleProposal; selection: CalendarBookingMoveSelection; operationId: string };
type UnknownResult = { kind: "move"; operationId: string; preview: Preview } | { kind: "undo"; eventId: string };
const hours = (minutes: number) => `${Number((minutes / 60).toFixed(2))}h`;
const fullDate = (date: string) => dateLabel(date, { weekday: "short", month: "short", day: "numeric", year: "numeric" });
const sameIdentity = (a: AppState, b: AppState) => a.workspaceId === b.workspaceId && a.actor.id === b.actor.id && a.actor.role === b.actor.role;
const selectionKey = (selection: CalendarBookingMoveSelection | null) => selection ? JSON.stringify([selection.date, [...selection.sessionIds].sort()]) : "";

/** Identity changes unmount pending private previews and status checks. */
export function CalendarBookingMove(props: Props) {
  if (props.state.actor.role !== "owner") return null;
  return <CalendarBookingMoveController key={`${props.state.workspaceId}:${props.state.actor.id}:${props.state.actor.role}`} {...props} />;
}

function CalendarBookingMoveController({ state, selection, onClose, onState, onInteractionLockChange }: Props) {
  const now = useCalendarClock();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState<"preview" | "commit" | "undo" | "check" | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [unknown, setUnknown] = useState<UnknownResult | null>(null);
  const [, tick] = useState(0);
  const latest = useRef({ state, selection, onClose, onState });
  const alive = useRef(true), inFlight = useRef(false), generation = useRef(0);
  const writeInFlight = useRef(false);
  const unknownRef = useRef<UnknownResult | null>(null);
  const moveOperation = useRef<{ key: string; id: string } | null>(null);
  const key = selectionKey(selection);
  const invalidatePreview = useCallback(() => { generation.current++; }, []);
  useEffect(() => { latest.current = { state, selection, onClose, onState }; }, [state, selection, onClose, onState]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; invalidatePreview(); }; }, [invalidatePreview]);
  useEffect(() => { const timer = setInterval(() => tick(value => value + 1), 15_000); return () => clearInterval(timer); }, []);
  useEffect(() => {
    onInteractionLockChange?.(Boolean(busy || unknown));
    return () => onInteractionLockChange?.(false);
  }, [busy, unknown, onInteractionLockChange]);
  const publish = useCallback((next: AppState) => {
    if (!alive.current || !sameIdentity(latest.current.state, next)) throw new Error("The signed-in workspace changed. Refresh before continuing.");
    if (next.version >= latest.current.state.version) latest.current.onState(next);
  }, []);
  const setUncertain = useCallback((value: UnknownResult | null) => { unknownRef.current = value; setUnknown(value); }, []);

  const refreshPreview = useCallback(async () => {
    const selected = latest.current.selection;
    if (!selected || unknownRef.current || inFlight.current) return;
    const selectedKey = selectionKey(selected), run = ++generation.current;
    // Refreshing or retrying this same move retains its identity, including
    // after an uncertain response. Only a newly selected move gets a new ID.
    if (moveOperation.current?.key !== selectedKey) moveOperation.current = { key: selectedKey, id: `${CALENDAR_MOVE_PREFIX}${crypto.randomUUID()}` };
    const operationId = moveOperation.current.id;
    inFlight.current = true; setBusy("preview"); setPreview(null); setError(""); setNotice("");
    try {
      let current = await api<AppState>("state");
      if (!alive.current || run !== generation.current || selectedKey !== selectionKey(latest.current.selection)) return;
      publish(current);
      const now = new Date().toISOString();
      const sourceReason = calendarBookingMoveSourceUnavailableReason(current, selected.sessionIds, now);
      if (sourceReason) throw new Error(sourceReason);
      const source = current.sessions.find(session => session.id === selected.sessionIds[0])!;
      const targetReason = calendarBookingMoveTargetUnavailableReason(current, localDate(source.start, current.settings.timeZone), selected.date, now);
      if (targetReason) throw new Error(targetReason);
      const result = await api<{ proposal: ScheduleProposal }>("commands", { action: "preview", operationId, commands: [{ type: "move_bookings", sessionIds: selected.sessionIds, date: selected.date }] });
      if (!alive.current || run !== generation.current || selectedKey !== selectionKey(latest.current.selection)) return;
      if (result.proposal.operationId !== operationId || result.proposal.actorId !== current.actor.id) throw new Error("This preview could not be matched to your move. Refresh before continuing.");
      // The preview endpoint may see a newer snapshot than our first read.
      // Only show before-times from the exact version that produced its plan.
      if (result.proposal.baseVersion !== current.version) { current = await api<AppState>("state"); publish(current); }
      if (result.proposal.baseVersion !== current.version) throw new Error("The calendar changed while checking this move. Refresh the preview to review the latest times.");
      setPreview({ state: current, proposal: result.proposal, selection: selected, operationId });
    } catch (reason) { if (alive.current && run === generation.current) setError((reason as Error).message); }
    finally { if (alive.current && run === generation.current) { inFlight.current = false; setBusy(null); } }
  }, [publish]);
  useEffect(() => {
    // A new prop selection must not unlock a commit, undo or status check.
    // The parent also disables calendar moves while this controller is locked.
    if (writeInFlight.current) return;
    const run = ++generation.current;
    inFlight.current = false;
    void Promise.resolve().then(() => {
      if (alive.current && generation.current === run && key) void refreshPreview();
    });
    return invalidatePreview;
  }, [key, refreshPreview, invalidatePreview]);

  function moveSucceeded(next: AppState, message = "Booked hours moved. The same total hours are booked on the new day.") {
    publish(next); moveOperation.current = null; setUncertain(null); setPreview(null); setError(""); setNotice(message); latest.current.onClose();
  }
  function undoSucceeded(next: AppState) {
    publish(next); moveOperation.current = null; setUncertain(null); setPreview(null); setError(""); setNotice("The last calendar move was undone. The previous booked times are restored.");
    if (latest.current.selection) latest.current.onClose();
  }
  async function checkResult(pending: UnknownResult, originalError?: string) {
    const next = await api<AppState>("state"); publish(next);
    if (pending.kind === "move") {
      const event = next.events.find(event => event.operationId === pending.operationId && event.actorId === next.actor.id);
      if (event) { moveSucceeded(next, event.undoneBy ? "That move was saved, then undone. The latest calendar is shown." : undefined); return; }
      setUncertain(null);
      // With no matching event the original preview remains the only possible
      // retry, and the server repeats its fingerprint/version check atomically.
      if (selectionKey(latest.current.selection) === selectionKey(pending.preview.selection)) setPreview(pending.preview);
      setError(next.version !== pending.preview.proposal.baseVersion
        ? "The calendar changed. This move was not found in the recent saved history; refresh its preview before trying again."
        : originalError || "This move has not been saved. Review the same preview before trying again.");
    } else {
      const event = next.events.find(event => event.id === pending.eventId);
      if (event?.undoneBy) { undoSucceeded(next); return; }
      setUncertain(null);
      setError(event ? undoUnavailableReason(next, event, new Date().toISOString()) || originalError || "Undo has not been applied. You can try again while this move is still eligible." : "This move is no longer available in recent history. Check Activity & email before continuing.");
    }
  }
  async function confirmMove() {
    if (!preview || inFlight.current || unknownRef.current || preview.proposal.baseVersion !== latest.current.state.version || selectionKey(preview.selection) !== selectionKey(latest.current.selection)) return;
    if (preview.proposal.status !== "ready" || preview.proposal.requiresApproval || !preview.proposal.reviewFingerprint || !calendarBookingMovePreview(preview.state, preview.proposal, preview.selection)) return;
    inFlight.current = true; writeInFlight.current = true; setBusy("commit"); setError("");
    const pending: UnknownResult = { kind: "move", operationId: preview.operationId, preview };
    try {
      const result = await api<{ state: AppState; proposal: ScheduleProposal }>("commands", { action: "commit", operationId: preview.operationId, commands: preview.proposal.commands,
        baseVersion: preview.proposal.baseVersion, reviewFingerprint: preview.proposal.reviewFingerprint });
      if (alive.current) moveSucceeded(result.state);
    } catch (reason) {
      if (!alive.current) return;
      // Explicit refreshed previews are known not to have saved; show them only
      // when both the server snapshot and its proposed version agree.
      if (reason instanceof ApiError && reason.state && reason.proposal && reason.state.version === reason.proposal.baseVersion) {
        publish(reason.state); setPreview({ ...preview, state: reason.state, proposal: reason.proposal }); setError(reason.message);
      } else {
        try { await checkResult(pending, (reason as Error).message); }
        catch { setUncertain(pending); setError("The connection interrupted saving. Check move status before another change; checking only reads the schedule."); }
      }
    } finally { writeInFlight.current = false; if (alive.current) { inFlight.current = false; setBusy(null); } }
  }
  async function undoMove(event: WorkEvent) {
    if (inFlight.current || unknownRef.current || preview && selection || undoUnavailableReason(latest.current.state, event, new Date().toISOString())) return;
    inFlight.current = true; writeInFlight.current = true; setBusy("undo"); setError(""); setNotice("");
    const pending: UnknownResult = { kind: "undo", eventId: event.id };
    try { const result = await api("undo", { id: event.id }); if (alive.current) undoSucceeded(result.state); }
    catch (reason) {
      if (!alive.current) return;
      try { await checkResult(pending, (reason as Error).message); }
      catch { setUncertain(pending); setError("I could not confirm whether Undo finished. Check undo status before making another change."); }
    } finally { writeInFlight.current = false; if (alive.current) { inFlight.current = false; setBusy(null); } }
  }
  async function checkUnknown() {
    const pending = unknownRef.current;
    if (!pending || inFlight.current) return;
    inFlight.current = true; writeInFlight.current = true; setBusy("check"); setError("");
    try { await checkResult(pending); }
    catch { if (alive.current) setError("The schedule is still unreachable. Keep this status check open and try again before making another change."); }
    finally { writeInFlight.current = false; if (alive.current) { inFlight.current = false; setBusy(null); } }
  }
  function close() {
    if (busy === "commit" || busy === "undo" || busy === "check") return;
    generation.current++; inFlight.current = false; setBusy(null); setPreview(null);
    if (!unknownRef.current) { moveOperation.current = null; setError(""); }
    latest.current.onClose();
  }
  const matches = preview && selectionKey(preview.selection) === key;
  const reviewed = matches ? preview : null;
  const details = reviewed && calendarBookingMovePreview(reviewed.state, reviewed.proposal, reviewed.selection, now);
  const stale = reviewed && state.version !== reviewed.proposal.baseVersion;
  const lastMove = latestCalendarBookingMove(state);
  const undoReason = lastMove && undoUnavailableReason(state, lastMove, new Date().toISOString());
  const canConfirm = reviewed && details && !stale && !busy && !unknown && reviewed.proposal.status === "ready" && !reviewed.proposal.requiresApproval && reviewed.proposal.reviewFingerprint && reviewed.proposal.affectedItemIds.length;
  const checkButton = unknown && <button type="button" className="secondary" disabled={!!busy} onClick={checkUnknown}><RefreshCw size={15} />{unknown.kind === "move" ? "Check move status" : "Check undo status"}</button>;

  return <>
    <Modal open={!!selection} onClose={close} title="Move booked hours" description="ADA finds an opening on the new day. Nothing changes until you confirm.">
      <div className="calendar-booking-move-preview">
        <p className="eyebrow">PREVIEW · NOT SAVED</p>
        {busy === "preview" && <p role="status" className="calendar-booking-move-loading"><LoaderCircle size={17} />Finding a safe opening…</p>}
        {details && <>
          <div className="calendar-booking-move-total"><strong>{hours(details.minutes)} · same booked hours</strong><span>{details.after.length} work block{details.after.length === 1 ? "" : "s"} on the new day</span></div>
          <strong>{details.clientName} · {details.title}</strong>
          <div className="form-grid calendar-booking-move-changes">
            <section><h3>Before</h3>{details.before.map(session => <p key={session.id}>{fullDate(localDate(session.start, state.settings.timeZone))} · {timeLabel(session.start, state.settings.timeZone)}–{timeLabel(session.end, state.settings.timeZone)}</p>)}</section>
            <section><h3>After</h3>{details.after.map(session => <p key={session.id}>{fullDate(localDate(session.start, state.settings.timeZone))} · {timeLabel(session.start, state.settings.timeZone)}–{timeLabel(session.end, state.settings.timeZone)}</p>)}</section>
          </div>
          <div className="calendar-booking-move-capacity" aria-label="Daily capacity after this move">{details.days.map(day => <div key={day.date}><strong>{dateLabel(day.date)}</strong><span>{hours(day.before.availableMinutes)} → {hours(day.after.availableMinutes)} left</span><small>{hours(day.after.plannedMinutes)} planned · {hours(day.after.capacityMinutes)} capacity</small></div>)}</div>
        </>}
        {reviewed && <ul className="calendar-booking-move-summary">{reviewed.proposal.summary.map((line, index) => <li key={index}>{line}</li>)}</ul>}
        {!!reviewed?.proposal.conflicts.length && <div className="calendar-booking-move-warning" role="alert">{reviewed.proposal.conflicts.map((conflict, index) => <p key={index}>{conflict.message}</p>)}</div>}
        {stale && <p role="status" className="calendar-booking-move-warning">The calendar changed after this preview. Refresh it before confirming.</p>}
        {error && <p role="alert" className="calendar-booking-move-warning">{error}</p>}
        <p className="micro muted">These hours move to the chosen day. Other bookings stay in place. A regular task’s ribbon follows its booked days.</p>
        <div className="calendar-booking-move-actions"><button type="button" className="secondary" disabled={busy === "commit" || busy === "undo" || busy === "check"} onClick={close}>Cancel move</button>
          {unknown ? checkButton : canConfirm ? <button type="button" className="primary" onClick={confirmMove}><Check size={15} />Confirm move</button>
            : <button type="button" className="primary" disabled={!!busy} onClick={refreshPreview}>{busy === "commit" ? "Saving move…" : "Refresh preview"}</button>}</div>
      </div>
    </Modal>
    {(lastMove || unknown || notice) && <section className="calendar-booking-move-undo" aria-label="Last calendar move">
      <div><p className="eyebrow">{lastMove?.undoneBy ? "MOVE UNDONE" : "LAST CALENDAR MOVE"}</p><strong>{notice || (lastMove?.undoneBy ? "The previous booked times were restored." : "A way back for your last calendar move.")}</strong>
        {lastMove && <><p>{lastMove.summary.join(" ")}</p><small>{dateLabel(localDate(lastMove.createdAt, state.settings.timeZone))} at {timeLabel(lastMove.createdAt, state.settings.timeZone)}</small></>}
        {undoReason && !lastMove?.undoneBy && <p className="micro muted">{undoReason}</p>}
        {!selection && error && <p role="alert" className="calendar-booking-move-warning">{error}</p>}</div>
      {unknown ? !selection && checkButton : lastMove && !lastMove.undoneBy && <button type="button" className="secondary" disabled={!!busy || !!selection || !!undoReason} onClick={() => undoMove(lastMove)}><Undo2 size={16} />{busy === "undo" ? "Undoing…" : "Undo last move"}</button>}
    </section>}
  </>;
}
