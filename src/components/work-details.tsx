"use client";
import { workTimeline } from "@/lib/work-timeline";
import { useEffect, useState } from "react";
import {
  Check,
  CheckCircle2,
  Clock3,
  Download,
  FileText,
  LockKeyhole,
  Paperclip,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import Markdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import type {
  AppState,
  Attachment,
  WorkCommand,
  WorkItem,
  WorkSession,
} from "@/lib/types";
import { CATEGORY_LABELS } from "@/lib/defaults";
import { localDate, localDateTime, minutesBetween } from "@/lib/time";
import { formatHours } from "@/lib/work";
import { api, dateLabel, Field, timeLabel } from "./ui";
import { SessionManager } from "./session-manager";
import { DayCompletion } from "./day-completion";

function SessionEditor({
  session,
  state,
  command,
  onResize,
}: {
  session: WorkSession;
  state: AppState;
  command: (c: WorkCommand) => Promise<void>;
  onResize: (session: WorkSession) => void;
}) {
  const zone = state.settings.timeZone;
  const fmt = (iso: string) =>
    new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: zone,
    }).format(new Date(iso));
  const [date, setDate] = useState(localDate(session.start, zone));
  const [start, setStart] = useState(fmt(session.start));
  const [end, setEnd] = useState(fmt(session.end));
  const [override, setOverride] = useState(false);
  return (
    <div className="inset session-editor">
      <div className="form-grid three">
        <Field label="Date">
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </Field>
        <Field label="Start">
          <input
            type="time"
            value={start}
            step="900"
            onChange={(e) => setStart(e.target.value)}
          />
        </Field>
        <Field label="End">
          <input
            type="time"
            value={end}
            step="900"
            onChange={(e) => setEnd(e.target.value)}
          />
        </Field>
      </div>
      <p className="micro muted">
        Change the times to move this session. A shorter or longer duration opens the hours editor so you can review the schedule and remaining effort together.
      </p>
      {session.protected && (
        <label className="check">
          <input
            type="checkbox"
            checked={override}
            onChange={(e) => setOverride(e.target.checked)}
          />
          I authorize moving this protected session.
        </label>
      )}
      <button
        className="secondary"
        disabled={session.protected && !override}
        onClick={() => {
          const nextStart = localDateTime(date, start, zone);
          const nextEnd = localDateTime(date, end, zone);
          if (minutesBetween(nextStart, nextEnd) !== minutesBetween(session.start, session.end)) {
            onResize({ ...session, start: nextStart, end: nextEnd });
            return;
          }
          return command({
            type: "move",
            sessionId: session.id,
            start: nextStart,
            end: nextEnd,
            overrideProtected: override,
          });
        }}
      >
        Move session
      </button>
    </div>
  );
}
function AttachmentPreview({ attachment }: { attachment: Attachment }) {
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let stopped = false;
    if (/\.(md|markdown)$/i.test(attachment.name))
      fetch(`/api/attachments/${attachment.id}`)
        .then((r) => {
          if (!r.ok) throw new Error("Preview unavailable.");
          return r.text();
        })
        .then((s) => {
          if (!stopped) setText(s);
        })
        .catch((e) => {
          if (!stopped) setError(e.message);
        });
    return () => {
      stopped = true;
    };
  }, [attachment]);
  if (/\.(md|markdown)$/i.test(attachment.name))
    return (
      <div className="markdown-preview">
        {error || (
          <Markdown
            skipHtml
            rehypePlugins={[rehypeSanitize]}
            components={{
              a: (p) => <a {...p} target="_blank" rel="noopener noreferrer" />,
            }}
          >
            {text || "Loading preview…"}
          </Markdown>
        )}
      </div>
    );
  if (attachment.contentType.startsWith("image/"))
    return (
      <div className="image-preview">
        {/* Authenticated local image; next/image cannot forward cookie auth to this endpoint. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={`/api/attachments/${attachment.id}`} alt={attachment.name} />
      </div>
    );
  return (
    <p className="muted">
      Open the original PDF using the download link above.
    </p>
  );
}
export function WorkDetails({
  item,
  state,
  onEdit,
  onCommand,
  onState,
}: {
  item: WorkItem;
  state: AppState;
  onEdit: () => void;
  onCommand: (c: WorkCommand) => Promise<void>;
  onState: (s: AppState) => void;
}) {
  const owner = state.actor.role === "owner";
  const [remaining, setRemaining] = useState(
    item.remainingMinutes === null ? "" : String(item.remainingMinutes / 60),
  );
  const [completed, setCompleted] = useState(item.progressCompleted);
  const [reason, setReason] = useState("");
  const [clientUpdate, setClientUpdate] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [managingSessions, setManagingSessions] = useState(false);
  const [sessionMode, setSessionMode] = useState<"smart" | "exact">("smart");
  const [sessionRemaining, setSessionRemaining] = useState<number | undefined>();
  const [sessionDrafts, setSessionDrafts] = useState<WorkSession[] | undefined>();
  const [preview, setPreview] = useState<string | null>(null);
  const [checklistTitle, setChecklistTitle] = useState("");
  const [override, setOverride] = useState(false);
  const [completionDate, setCompletionDate] = useState<string | null>(null);
  const sessions = state.sessions
    .filter((s) => s.workItemId === item.id && s.status === "planned")
    .sort((a, b) => a.start.localeCompare(b.start));
  const visibleSessions = state.sessions.filter(session => session.workItemId === item.id && session.status !== "cancelled")
    .sort((a, b) => a.start.localeCompare(b.start));
  const timeline = workTimeline(item, visibleSessions, state.settings.timeZone);
  const sessionDays = [...new Set(visibleSessions.map(session => localDate(session.start, state.settings.timeZone)))];
  const attachments = state.attachments.filter(
    (a) => a.workItemId === item.id && !a.removedAt,
  );
  const planned = sessions.reduce(
    (n, s) => n + minutesBetween(s.start, s.end),
    0,
  );
  const remainingMinutes = remaining.trim() === "" ? undefined : Number(remaining) * 60;
  const validRemaining = remainingMinutes === undefined || (
    Number.isInteger(remainingMinutes) && remainingMinutes >= 0 && remainingMinutes <= 100_000
  );
  const canResume = validRemaining && (item.estimatedMinutes === null
    ? remainingMinutes !== undefined && remainingMinutes > 0
    : remainingMinutes !== undefined || item.remainingMinutes !== null);
  function manage(mode: "smart" | "exact", nextRemaining?: number, resized?: WorkSession) {
    setEditing(null);
    setCompletionDate(null);
    setSessionMode(mode);
    setSessionRemaining(nextRemaining);
    setSessionDrafts(resized ? sessions.map(session => session.id === resized.id ? resized : session) : undefined);
    setManagingSessions(true);
  }
  async function command(c: WorkCommand) {
    setBusy(true);
    setError("");
    try {
      await onCommand(c);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function upload(files: FileList | null) {
    if (!files) return;
    setBusy(true);
    setError("");
    try {
      for (const file of Array.from(files)) {
        const contentType = /\.(md|markdown)$/i.test(file.name)
          ? "text/markdown"
          : file.type;
        const prepared = await api<{
          attachment: Attachment;
          uploadUrl: string;
        }>("attachments/prepare", {
          workItemId: item.id,
          name: file.name,
          contentType,
          size: file.size,
        });
        try {
          const response = await fetch(prepared.uploadUrl, {
            method: state.mode === "demo" ? "POST" : "PUT",
            headers: { "Content-Type": contentType },
            body: file,
          });
          if (!response.ok) throw new Error("Upload failed. Please try again.");
          onState(
            (await api("attachments/complete", { id: prepared.attachment.id }))
              .state,
          );
        } catch (error) {
          await api("attachments/abort", { id: prepared.attachment.id });
          throw error;
        }
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="work-details">
      <div className="detail-tags">
        <span className={`category-pill category-${item.category}`}>
          {CATEGORY_LABELS[item.category]}
          {item.category === "web" && ` · ${item.webKind}`}
        </span>
        <span className={`priority-pill priority-${item.priorityId}`}>
          {state.priorities.find((p) => p.id === item.priorityId)?.label}
        </span>
        <span className="status-pill">{item.status.replace("_", " ")}</span>
      </div>
      <div className="detail-client">
        <span>{state.clients.find((c) => c.id === item.clientId)?.name}</span>
        <small>Requested by {item.requestedBy || "Bryan"}</small>
      </div>
      <p className="detail-description">
        {item.description || "No additional description."}
      </p>
      <div className="detail-stats">
        <div>
          <span>Remaining effort</span>
          <strong>
            {item.remainingMinutes === null
              ? "Hours added as needed"
              : formatHours(item.remainingMinutes)}
          </strong>
        </div>
        <div>
          <span>Booked hours</span>
          <strong>{formatHours(planned)}</strong>
        </div>
        <div>
          <span>Target finish</span>
          <strong>
            {item.targetDate ? dateLabel(item.targetDate) : "Flexible"}
          </strong>
        </div>
      </div>
      <dl className="detail-dates">
        <div>
          <dt>{item.status === "completed" ? visibleSessions.some(session => session.status === "completed") ? "Recorded work days" : "Completion date" : timeline?.mode === "span" ? "Project span" : "Booked days"}</dt>
          <dd>{timeline ? timeline.start === timeline.end ? dateLabel(timeline.start) : `${dateLabel(timeline.start)} → ${timeline.end ? dateLabel(timeline.end) : "Until completed or cancelled"}` : "No hours booked"}</dd>
        </div>
        <div>
          <dt>Predicted finish</dt>
          <dd>
            {item.forecastDate
              ? dateLabel(item.forecastDate)
              : item.remainingMinutes === null ? "Hours added as needed" : "Not fully scheduled"}
          </dd>
        </div>
        <div>
          <dt>Firm deadline</dt>
          <dd>{item.deadline ? dateLabel(item.deadline) : "None"}</dd>
        </div>
        {item.dateConstraints?.earliestStart && <div><dt>Cannot start before</dt><dd>{dateLabel(item.dateConstraints.earliestStart)}</dd></div>}
        {(item.dateConstraints?.allowedDates.length ?? 0) > 0 && <div>
          <dt>Allowed work dates</dt>
          <dd>{[...(item.dateConstraints?.allowedDates ?? [])].sort().map(date => dateLabel(date)).join(", ")}</dd>
        </div>}
        {item.updateDate && (
          <div>
            <dt>Client update checkpoint</dt>
            <dd>{dateLabel(item.updateDate)}</dd>
          </div>
        )}
        {item.completedAt && (
          <div>
            <dt>Actually completed</dt>
            <dd>
              {dateLabel(localDate(item.completedAt, state.settings.timeZone))}
            </dd>
          </div>
        )}
      </dl>
      {item.status === "waiting" && (
        <div className="waiting-note">
          <Clock3 size={18} />
          <span>Waiting · {item.blockedReason || "Awaiting client input"}</span>
        </div>
      )}
      {owner && (
        <div className="detail-actions">
          <button className="secondary" onClick={onEdit}>
            <Pencil size={14} />
            Edit details
          </button>
          {item.status !== "completed" && item.status !== "cancelled" && <button className="secondary" onClick={() => manage("smart")}><Clock3 size={14} /> Add hours</button>}
          {item.status !== "completed" && item.status !== "cancelled" && <button className="secondary" onClick={() => manage("exact")}>
            <Clock3 size={14} /> Edit hours
          </button>}
          {item.status !== "completed" && item.status !== "cancelled" && (
            <button
              className="primary"
              disabled={busy}
              onClick={() =>
                command({
                  type: "status",
                  itemId: item.id,
                  status: "completed",
                  overrideProtected: override,
                })
              }
            >
              <CheckCircle2 size={16} />
              Mark project complete
            </button>
          )}
        </div>
      )}
      <section className="detail-section">
        <h3>
          <Clock3 size={16} />
          Work sessions <span>{visibleSessions.length}</span>
        </h3>
        {managingSessions ? (
          <SessionManager key={`${sessionMode}-${sessionRemaining}`} item={item} state={state} initialMode={sessionMode} initialSessions={sessionDrafts} initialRemainingMinutes={sessionRemaining} initialProgressCompleted={sessionRemaining === undefined ? undefined : completed} onSaved={onState} onClose={() => setManagingSessions(false)} />
        ) : sessionDays.length ? (
          sessionDays.map(day => {
            const daySessions = visibleSessions.filter(session => localDate(session.start, state.settings.timeZone) === day);
            const plannedMinutes = daySessions.filter(session => session.status === "planned").reduce((sum, session) => sum + minutesBetween(session.start, session.end), 0);
            const completedMinutes = daySessions.filter(session => session.status === "completed").reduce((sum, session) => sum + minutesBetween(session.start, session.end), 0);
            const label = dateLabel(day, { weekday: "short", month: "short", day: "numeric" });
            return <section key={day} className={`completion-day${plannedMinutes ? "" : " completion-day-done"}`} aria-label={`Work on ${label}`} data-work-date={day}>
              <div className="completion-day-heading">
                <div><h4>{label}</h4><p>{plannedMinutes > 0 && <span>{formatHours(plannedMinutes)} booked</span>}{completedMinutes > 0 && <span className="completion-done"><Check size={13} />{formatHours(completedMinutes)} done</span>}</p></div>
                {owner && plannedMinutes > 0 && item.status !== "completed" && item.status !== "cancelled" && <button className="secondary completion-finish" disabled={busy} onClick={() => { setEditing(null); setCompletionDate(completionDate === day ? null : day); }}><CheckCircle2 size={15} />Finish this day</button>}
                {!plannedMinutes && <span className="completion-done"><CheckCircle2 size={16} />Day finished</span>}
              </div>
              {daySessions.map(s => s.status === "completed" ? <div className="completion-session-done" key={s.id} data-session-id={s.id}><Check size={14} /><span>{timeLabel(s.start, state.settings.timeZone)}–{timeLabel(s.end, state.settings.timeZone)}</span><span>Done</span></div> : (
            <div key={s.id}>
              <button
                className="session-row"
                disabled={!owner}
                onClick={() => { setCompletionDate(null); setEditing(editing === s.id ? null : s.id); }}
                aria-label={`Edit booking on ${label}, ${timeLabel(s.start, state.settings.timeZone)}–${timeLabel(s.end, state.settings.timeZone)}`}
              >
                <span>
                  {s.protected ? (
                    <LockKeyhole size={15} />
                  ) : (
                    <span className="category-dot" />
                  )}
                  {formatHours(minutesBetween(s.start, s.end))}
                </span>
                <strong>
                  {timeLabel(s.start, state.settings.timeZone)}–
                  {timeLabel(s.end, state.settings.timeZone)}
                </strong>
                {owner && <Pencil size={13} />}
              </button>
              {editing === s.id && (
                <>
                  {item.dailyPlan?.length ? (
                    <button className="secondary" onClick={() => manage("exact")}>
                      <Pencil size={14} /> Edit hours
                    </button>
                  ) : (
                    <SessionEditor session={s} state={state} command={command} onResize={resized => manage("exact", undefined, resized)} />
                  )}
                  <div className="form-actions">
                    <button
                      className="text-button"
                      onClick={() =>
                        command({
                          type: "schedule",
                          itemId: item.id,
                          sessions: sessions.map((x) =>
                            x.id === s.id
                              ? { ...x, protected: !x.protected }
                              : x,
                          ),
                          overrideProtected: s.protected,
                        })
                      }
                    >
                      {s.protected
                        ? "Explicitly unprotect this session"
                        : "Protect this session"}
                    </button>
                    <button
                      className="text-button"
                      onClick={() =>
                        command({
                          type: "complete_session",
                          sessionId: s.id,
                        })
                      }
                    >
                      Mark session complete
                    </button>
                  </div>
                  <p className="micro muted">
                    This individual session control keeps reported effort unchanged. Use Finish this day to finish all of this day’s booked hours and update remaining effort together.
                  </p>
                </>
              )}
            </div>
              ))}
              {completionDate === day && <DayCompletion key={`${item.id}-${day}-${state.version}`} item={item} date={day} state={state} onSaved={onState} onClose={() => setCompletionDate(null)} />}
            </section>;
          })
        ) : (
          <p className="muted">
            No hours booked. Add hours when you are ready to work on this project.
          </p>
        )}
        {owner && !managingSessions && item.remainingMinutes === null && item.status !== "completed" && item.status !== "cancelled" && (
          <p className="micro muted">Use Add hours or ask ADA. The project total can stay unknown.</p>
        )}
      </section>
      {owner && (
        <section className="detail-section">
          <h3>
            <Check size={16} />
            Progress & status
          </h3>
          <div className="form-grid">
            <Field
              label="Remaining hours"
              hint={item.remainingMinutes === null ? "Leave blank when hours are added as needed." : undefined}
            >
              <input
                type="number"
                min="0"
                step="0.25"
                value={remaining}
                onChange={(e) => setRemaining(e.target.value)}
              />
            </Field>
            {item.progressTotal !== null && (
              <Field label={`Pages complete / ${item.progressTotal}`}>
                <input
                  type="number"
                  min="0"
                  max={item.progressTotal}
                  value={completed}
                  onChange={(e) => setCompleted(Number(e.target.value))}
                />
              </Field>
            )}
          </div>
          <button
            className="secondary"
            disabled={busy || !validRemaining || (remainingMinutes === undefined && completed === item.progressCompleted)}
            onClick={() => {
              if (remainingMinutes !== undefined && (item.dailyPlan ?? []).reduce((sum, day) => sum + day.minutes, 0) > Math.ceil(remainingMinutes / state.settings.slotMinutes) * state.settings.slotMinutes) {
                manage("exact", remainingMinutes);
                return;
              }
              return command({
                type: "progress",
                itemId: item.id,
                ...(remainingMinutes !== undefined ? { remainingMinutes } : {}),
                progressCompleted: completed,
              });
            }}
          >
            Save progress
          </button>
          {!!item.dailyPlan?.length && <p className="micro muted">To change which days you work or how many hours each day needs, use Edit hours. You can update remaining effort in the same save.</p>}
          <div className="form-grid progress-status">
            <Field label="Waiting reason (if pausing)">
              <input
                placeholder="e.g. Waiting on API access"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </Field>
            <div className="status-actions">
              {item.status === "waiting" ? (
                <button
                  className="secondary"
                  disabled={busy || !canResume}
                  onClick={() =>
                    command({
                      type: "status",
                      itemId: item.id,
                      status: "in_progress",
                      ...(remainingMinutes !== undefined ? { remainingMinutes } : {}),
                    })
                  }
                >
                  Resume work
                </button>
              ) : (
                <>
                  <button
                    className="secondary"
                    onClick={() =>
                      command({
                        type: "status",
                        itemId: item.id,
                        status: "in_progress",
                      })
                    }
                  >
                    Start work
                  </button>
                  <button
                    className="secondary"
                    disabled={!reason.trim()}
                    onClick={() =>
                      command({
                        type: "status",
                        itemId: item.id,
                        status: "waiting",
                        reason,
                        overrideProtected: override,
                      })
                    }
                  >
                    Mark waiting
                  </button>
                </>
              )}
            </div>
          </div>
          {sessions.some((s) => s.protected) && (
            <label className="check">
              <input
                type="checkbox"
                checked={override}
                onChange={(e) => setOverride(e.target.checked)}
              />
              I authorize changing this project’s protected sessions for the
              status action.
            </label>
          )}
        </section>
      )}
      {(item.checklist.length > 0 ||
        (owner && item.category === "landings")) && (
        <section className="detail-section">
          <h3>Landing checklist</h3>
          {item.checklist.map((c) => (
            <label key={c.id} className="check">
              <input
                type="checkbox"
                checked={c.done}
                disabled={!owner || busy}
                onChange={() =>
                  command({
                    type: "progress",
                    itemId: item.id,
                    checklist: item.checklist.map((x) =>
                      x.id === c.id ? { ...x, done: !x.done } : x,
                    ),
                  })
                }
              />
              {c.title}
            </label>
          ))}
          {owner && (
            <div className="inline-input">
              <input
                aria-label="New checklist item"
                placeholder="Add a page or QA step"
                value={checklistTitle}
                onChange={(e) => setChecklistTitle(e.target.value)}
              />
              <button
                className="icon-button"
                aria-label="Add checklist item"
                disabled={!checklistTitle.trim()}
                onClick={() => {
                  void command({
                    type: "progress",
                    itemId: item.id,
                    checklist: [
                      ...item.checklist,
                      {
                        id: crypto.randomUUID(),
                        title: checklistTitle,
                        done: false,
                      },
                    ],
                  });
                  setChecklistTitle("");
                }}
              >
                <Plus size={18} />
              </button>
            </div>
          )}
        </section>
      )}
      <section className="detail-section">
        <h3>
          <Paperclip size={16} />
          Files & references <span>{attachments.length}/5</span>
        </h3>
        {item.references.map((ref, i) => (
          <p className="reference" key={i}>
            {/^https?:\/\//i.test(ref) ? (
              <a href={ref} target="_blank" rel="noopener noreferrer">
                {ref}
              </a>
            ) : (
              ref
            )}
          </p>
        ))}
        {attachments.map((a) => (
          <div key={a.id}>
            <div className="attachment-row">
              <button
                className="attachment-title"
                onClick={() => setPreview(preview === a.id ? null : a.id)}
              >
                <FileText size={16} />
                <span>
                  {a.name}
                  <small>{(a.size / 1024).toFixed(0)} KB</small>
                </span>
              </button>
              <a
                className="icon-button"
                aria-label={`Download ${a.name}`}
                href={`/api/attachments/${a.id}?download=1`}
              >
                <Download size={16} />
              </a>
              {owner && (
                <button
                  className="icon-button"
                  aria-label={`Remove ${a.name}`}
                  onClick={async () => {
                    try {
                      onState(
                        (
                          await api("admin", {
                            type: "remove_attachment",
                            id: a.id,
                          })
                        ).state,
                      );
                    } catch (e) {
                      setError((e as Error).message);
                    }
                  }}
                >
                  <Trash2 size={14} />
                </button>
              )}
            </div>
            {preview === a.id && <AttachmentPreview attachment={a} />}
          </div>
        ))}
        {(owner ||
          (item.requesterId === state.actor.id &&
            state.actor.role === "requester")) && (
          <label className="upload-box">
            <Paperclip size={18} />
            <span>
              {busy ? "Uploading…" : "Attach files"}
              <small>Markdown, PDF or images · 5 files / 20 MB total</small>
            </span>
            <input
              type="file"
              accept=".md,.markdown,.pdf,.png,.jpg,.jpeg,.webp"
              multiple
              disabled={busy}
              onChange={(e) => {
                void upload(e.target.files);
                e.target.value = "";
              }}
            />
          </label>
        )}
      </section>
      {owner && (
        <section className="detail-section">
          <h3>Record a client update</h3>
          <p className="micro muted">
            Use this only after you actually update the client. Saving notifies
            Kyle and William; it does not send to the client.
          </p>
          <textarea
            rows={2}
            aria-label="Client update summary"
            value={clientUpdate}
            onChange={(e) => setClientUpdate(e.target.value)}
            placeholder="What did you tell the client?"
          />
          <button
            className="secondary"
            disabled={!clientUpdate.trim() || busy}
            onClick={() => {
              void command({
                type: "client_update",
                itemId: item.id,
                message: clientUpdate,
              });
              setClientUpdate("");
            }}
          >
            Record update
          </button>
        </section>
      )}
      <section className="detail-section">
        <h3>Activity</h3>
        {state.events
          .filter((e) => e.itemIds.includes(item.id))
          .slice(0, 10)
          .map((e) => (
            <div className="activity-line" key={e.id}>
              <span className="activity-dot" />
              <div>
                <p>{e.summary.join(" ")}</p>
                <small>
                  {e.actorName} ·{" "}
                  {new Date(e.createdAt).toLocaleString("en-US", {
                    timeZone: state.settings.timeZone,
                  })}
                </small>
              </div>
            </div>
          ))}
        {!state.events.some((e) => e.itemIds.includes(item.id)) && (
          <p className="muted">No recorded changes yet.</p>
        )}
      </section>
      {owner && item.status !== "cancelled" && (
        <button
          className="text-button danger"
          onClick={() =>
            command({
              type: "status",
              itemId: item.id,
              status: "cancelled",
              overrideProtected: override,
            })
          }
        >
          Cancel this work
        </button>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </div>
  );
}
