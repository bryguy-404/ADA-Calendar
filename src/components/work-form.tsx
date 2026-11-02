"use client";
import { WorkContextFields } from "./work-context";
import { useState } from "react";
import { ArrowRight, Clock3, LockKeyhole, TriangleAlert } from "lucide-react";
import type {
  AppState,
  ScheduleProposal,
  WorkCommand,
  WorkItem,
} from "@/lib/types";
import { isDate, localDate, localDateTime, minutesBetween } from "@/lib/time";
import { defaultWorkPriority, newWorkItem } from "@/lib/work";
import { CATEGORY_LABELS } from "@/lib/defaults";
import { sortClientsByName } from "@/lib/clients";
import { api, ApiError, Field, dateLabel, timeLabel } from "./ui";
import { SmartFitFields } from "./smart-fit-fields";
import { DayHoursFields } from "./day-hours-fields";
import {
  parseDayHours,
  usableWorkDate,
  type DayHoursDraft,
} from "@/lib/day-hours";
import { effectiveTimelineMode } from "@/lib/work-timeline";
import {
  smartFitRequest,
  smartFitTotal,
  type SmartFitDraft,
} from "@/lib/smart-fit";

export function ProposalCard({
  proposal,
  state,
  onCommit,
  busy,
}: {
  proposal: ScheduleProposal;
  state: AppState;
  onCommit: (request: boolean) => void;
  busy?: boolean;
}) {
  const ready = proposal.status === "ready" && !proposal.requiresApproval;
  const requester = state.actor.role === "requester";
  const smartFit = proposal.commands.some(
    (command) =>
      command.type === "fit" ||
      command.type === "add_booking" ||
      (command.type === "create" && command.smartFit),
  );
  const dayEdit = proposal.commands.some(
    (command) => command.type === "set_day_hours",
  );
  const resumedItems = proposal.items.filter(
    (item) =>
      ["planned", "in_progress"].includes(item.status) &&
      state.items.some(
        (previous) => previous.id === item.id && previous.status === "waiting",
      ),
  );
  const changedWorkDates = proposal.items.flatMap((item) => {
    const before = state.items.find((previous) => previous.id === item.id);
    return before &&
      JSON.stringify(before.dateConstraints) !==
        JSON.stringify(item.dateConstraints)
      ? [{ before, after: item }]
      : [];
  });
  const describeWorkDates = (item: WorkItem) => {
    const dates = item.dateConstraints?.allowedDates ?? [];
    const earliest = item.dateConstraints?.earliestStart;
    return `${
      dates.length
        ? [...dates]
            .sort()
            .map((date) =>
              dateLabel(date, {
                month: "short",
                day: "numeric",
                year: "numeric",
              }),
            )
            .join(", ")
        : "Any working day"
    }${earliest ? `; starting ${dateLabel(earliest)}` : ""}`;
  };
  const visibleSessions = proposal.sessions.filter(
    (session) =>
      proposal.affectedItemIds.includes(session.workItemId) &&
      session.status === "planned" &&
      (!(smartFit || dayEdit) ||
        !state.sessions.some(
          (existing) =>
            existing.id === session.id &&
            JSON.stringify(existing) === JSON.stringify(session),
        )),
  );
  const underallocated = state.items.filter(
    (item) =>
      ["planned", "in_progress"].includes(item.status) &&
      item.remainingMinutes !== null &&
      item.remainingMinutes >
        state.sessions
          .filter((s) => s.workItemId === item.id && s.status === "planned")
          .reduce((sum, s) => sum + minutesBetween(s.start, s.end), 0),
  ).length;
  return (
    <div
      className={`proposal ${ready ? "proposal-ready" : "proposal-conflict"}`}
    >
      <h3>
        {ready ? <Clock3 size={18} /> : <TriangleAlert size={18} />}
        {ready ? "This fits your schedule" : "This needs a decision"}
      </h3>
      <p>
        {ready
          ? requester
            ? "Your entire request fits without moving existing work. You can book it directly."
            : smartFit
              ? "These are the new times ADA found. Existing bookings stay unchanged; only these dates will be used."
              : "Review the planned changes below. Work stays inside your configured hours."
          : "Nothing has moved. Existing commitments remain in place."}
      </p>
      {requester && underallocated > 0 && (
        <p className="micro">
          Capacity reflects reserved sessions. {underallocated} existing project
          {underallocated === 1 ? " still needs" : "s still need"} estimates or
          full scheduling; Bryan may need to reconcile that work.
        </p>
      )}
      <ul>
        {proposal.summary.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
        {proposal.conflicts.map((c, i) => (
          <li key={`c${i}`}>{c.message}</li>
        ))}
      </ul>
      {ready && changedWorkDates.length > 0 && (
        <div className="proposal-date-changes">
          {changedWorkDates.map(({ before, after }) => (
            <div key={after.id}>
              <strong>Scheduling limits · {after.title}</strong>
              <p>Before: {describeWorkDates(before)}</p>
              <p>After: {describeWorkDates(after)}</p>
            </div>
          ))}
        </div>
      )}
      {ready && resumedItems.length > 0 && (
        <div className="proposal-status-changes">
          {resumedItems.map((item) => (
            <p key={item.id}>
              <strong>
                {item.title}: Waiting →{" "}
                {item.status === "planned" ? "Planned" : "In progress"}.
              </strong>{" "}
              Confirming clears the waiting reason.
              {item.remainingMinutes === null
                ? " The project total stays unknown; more hours can be added later."
                : ""}
            </p>
          ))}
        </div>
      )}
      <div className="proposal-sessions">
        {visibleSessions
          .slice(0, smartFit || dayEdit ? undefined : 15)
          .map((s) => (
            <div key={s.id}>
              <span>
                {proposal.items.find((i) => i.id === s.workItemId)?.title}
              </span>
              <strong>
                {dateLabel(localDate(s.start, state.settings.timeZone))} ·{" "}
                {timeLabel(s.start, state.settings.timeZone)}–
                {timeLabel(s.end, state.settings.timeZone)}{" "}
                {s.protected && "🔒"}
              </strong>
            </div>
          ))}
      </div>
      {proposal.alternatives.length > 0 && (
        <div className="alternatives">
          <strong>Suggested openings</strong>
          {proposal.alternatives.map((a, i) => (
            <p key={i}>{a.label}</p>
          ))}
          <p className="micro">
            Adjust the dates above and preview again to choose an opening.
          </p>
        </div>
      )}
      {(ready || (requester && !smartFit)) && (
        <button
          type="button"
          className="primary"
          disabled={busy}
          onClick={() => onCommit(!ready)}
        >
          {busy
            ? "Saving…"
            : ready
              ? requester
                ? "Book this work"
                : "Confirm changes"
              : "Send priority request to Bryan"}
          <ArrowRight size={15} />
        </button>
      )}
    </div>
  );
}

export function WorkForm({
  state,
  date,
  endDate = date,
  existing,
  onSaved,
  onClose,
  onFindTime,
  onCommitted,
}: {
  state: AppState;
  date: string;
  endDate?: string;
  existing?: WorkItem;
  onSaved: (state: AppState) => void;
  onClose: () => void;
  onFindTime?: () => void;
  onCommitted?: () => void;
}) {
  const [firstDay] = useState(() => {
    const now = new Date().toISOString();
    return date === localDate(now, state.settings.timeZone)
      ? usableWorkDate(date, state.settings, now)
      : date;
  });
  const [item, setItem] = useState<WorkItem>(
    () =>
      existing ??
      newWorkItem(state.actor, date, {
        clientId: state.clients[0]?.id || "",
        windowEnd: endDate,
        priorityId: defaultWorkPriority("web", state.priorities),
      }),
  );
  const [priorityChosen, setPriorityChosen] = useState(Boolean(existing));
  const [hoursMode, setHoursMode] = useState<"total" | "days" | "ongoing">(
    () =>
      existing && effectiveTimelineMode(existing, state.sessions) === "span"
        ? "ongoing"
        : "total",
  );
  const [fit, setFit] = useState<SmartFitDraft>(() => ({
    startDate: firstDay,
    endDate: endDate < firstDay ? firstDay : endDate,
    hours: "1",
    distribution: "total",
  }));
  const [days, setDays] = useState<DayHoursDraft[]>(() => [
    { id: crypto.randomUUID(), date: firstDay, hours: "" },
  ]);
  const [bookOngoingNow, setBookOngoingNow] = useState(false);
  const [noEnd, setNoEnd] = useState(!existing?.windowEnd);
  const [exact, setExact] = useState(false);
  const [sessionDates, setSessionDates] = useState(date);
  const [start, setStart] = useState("09:00");
  const [end, setEnd] = useState("11:00");
  const [protect, setProtect] = useState(false);
  const [urgent, setUrgent] = useState(false);
  const [restrictWorkDates, setRestrictWorkDates] = useState(
    Boolean(existing?.dateConstraints?.allowedDates.length),
  );
  const [allowedWorkDates, setAllowedWorkDates] = useState(() => [
    ...(existing?.dateConstraints?.allowedDates ?? []),
  ]);
  const [earliestStart, setEarliestStart] = useState(
    existing?.dateConstraints?.earliestStart ?? "",
  );
  const [proposal, setProposal] = useState<ScheduleProposal | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [operationId, setOperationId] = useState(() => crypto.randomUUID());
  const constraints = {
    earliestStart: earliestStart || null,
    allowedDates: restrictWorkDates
      ? [...new Set(allowedWorkDates)].sort()
      : [],
  };
  const constraintsChanged =
    JSON.stringify(constraints) !==
    JSON.stringify(
      existing?.dateConstraints ?? { earliestStart: null, allowedDates: [] },
    );
  function invalidate() {
    setProposal(null);
    setError("");
    setOperationId(crypto.randomUUID());
  }
  function patch(values: Partial<WorkItem>) {
    setItem({ ...item, ...values });
    invalidate();
  }
  function changeMode(next: typeof hoursMode) {
    setHoursMode(next);
    setExact(false);
    invalidate();
    if (next === "ongoing" && !existing) {
      setNoEnd(true);
      setItem({ ...item, windowStart: date, windowEnd: null });
    }
  }
  async function preview(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (earliestStart && !isDate(earliestStart))
        throw new Error("Choose a valid earliest start, or leave it blank.");
      if (
        restrictWorkDates &&
        (!constraints.allowedDates.length ||
          constraints.allowedDates.some((day) => !isDate(day)))
      )
        throw new Error(
          "Choose each allowed work date, or uncheck Limit work to selected dates.",
        );
      const metadata: Partial<WorkItem> = {
        title: item.title,
        description: item.description,
        clientId: item.clientId,
        category: item.category,
        webKind: item.webKind,
        targetDate: item.targetDate,
        deadline: item.deadline,
        priorityId: item.priorityId,
        requestedPriorityId: item.requestedPriorityId,
        progressTotal: item.progressTotal,
        updateDate: item.updateDate,
        references: item.references,
        ...(item.workContext ? { workContext: item.workContext } : {}),
        ...(constraintsChanged ? { dateConstraints: constraints } : {}),
        ...(hoursMode === "ongoing"
          ? {
              windowStart: item.windowStart,
              windowEnd: noEnd ? null : item.windowEnd,
            }
          : {}),
      };
      let commands: WorkCommand[];
      if (existing) {
        commands = [{ type: "update", itemId: item.id, patch: metadata }];
      } else {
        const exactSessions = exact
          ? sessionDates.split(",").map((day) => ({
              id: crypto.randomUUID(),
              workItemId: item.id,
              start: localDateTime(day.trim(), start, state.settings.timeZone),
              end: localDateTime(day.trim(), end, state.settings.timeZone),
              protected: state.actor.role === "owner" && protect,
              status: "planned" as const,
              usesReserve: false,
            }))
          : undefined;
        const dailyPlan =
          !exact &&
          (hoursMode === "days" || (hoursMode === "ongoing" && bookOngoingNow))
            ? parseDayHours(days)
            : undefined;
        if (!exact && hoursMode === "days" && !dailyPlan?.length)
          throw new Error("Add at least one work day and its hours.");
        if (
          !exact &&
          hoursMode === "ongoing" &&
          bookOngoingNow &&
          !dailyPlan?.length
        )
          throw new Error(
            "Add a day and its hours, or uncheck Book some hours now.",
          );
        const request =
          hoursMode === "total" ? smartFitRequest(fit) : undefined;
        const total =
          hoursMode === "ongoing"
            ? null
            : request
              ? smartFitTotal(request, state.settings)
              : exactSessions
                ? exactSessions.reduce(
                    (sum, session) =>
                      sum + minutesBetween(session.start, session.end),
                    0,
                  )
                : dailyPlan!.reduce((sum, day) => sum + day.minutes, 0);
        if (state.actor.role === "requester" && (total === null || total <= 0))
          throw new Error(
            "Choose positive hours for the work you want to book.",
          );
        const created: WorkItem = {
          ...item,
          ...metadata,
          estimatedMinutes: total,
          remainingMinutes: total,
          status:
            hoursMode === "ongoing" && !dailyPlan?.length && !exact
              ? "waiting"
              : "planned",
          timelineMode: hoursMode === "ongoing" ? "span" : "bookings",
          minimumSessionMinutes: 15,
          windowStart:
            hoursMode === "total"
              ? fit.startDate
              : hoursMode === "days"
                ? (dailyPlan?.[0].date ??
                  localDate(exactSessions![0].start, state.settings.timeZone))
                : item.windowStart,
          windowEnd:
            hoursMode === "ongoing"
              ? noEnd
                ? null
                : item.windowEnd
              : hoursMode === "days"
                ? (dailyPlan?.at(-1)?.date ??
                  localDate(
                    exactSessions!.at(-1)!.start,
                    state.settings.timeZone,
                  ))
                : fit.endDate,
          ...(dailyPlan?.length && !exact ? { dailyPlan } : {}),
        };
        commands = [
          {
            type: "create",
            item: created,
            ...(request && !exact ? { smartFit: request } : {}),
            ...(exactSessions ? { urgent, sessions: exactSessions } : {}),
          },
        ];
      }
      setProposal(
        (
          await api<{ proposal: ScheduleProposal }>("commands", {
            commands,
            operationId,
            action: "preview",
          })
        ).proposal,
      );
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function commit(request: boolean) {
    if (!proposal) return;
    setBusy(true);
    setError("");
    try {
      const response = await api("commands", {
        commands: proposal.commands,
        operationId,
        baseVersion: proposal.baseVersion,
        reviewFingerprint: proposal.reviewFingerprint,
        action: request ? "request" : "commit",
      });
      onSaved(response.state);
      onCommitted?.();
      onClose();
    } catch (reason) {
      setError((reason as Error).message);
      setProposal(
        reason instanceof ApiError ? (reason.proposal ?? null) : null,
      );
      if (reason instanceof ApiError && reason.state) onSaved(reason.state);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={preview} className="work-form">
      <fieldset className="work-form-fields" disabled={busy}>
        {existing &&
          onFindTime &&
          !["completed", "cancelled"].includes(existing.status) && (
            <div className="inset">
              <p className="micro muted">
                Book more work without changing the project details.
              </p>
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  if (
                    (constraintsChanged ||
                      JSON.stringify(item) !== JSON.stringify(existing)) &&
                    !window.confirm(
                      "Discard these unsaved project edits and add hours instead?",
                    )
                  )
                    return;
                  onFindTime();
                }}
              >
                <Clock3 size={14} />
                Add hours
              </button>
            </div>
          )}
        <div className="form-grid">
          <Field label="Client">
            <select
              value={item.clientId}
              required
              onChange={(event) => patch({ clientId: event.target.value })}
            >
              {sortClientsByName(state.clients).map((client) => (
                <option key={client.id} value={client.id}>
                  {client.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Work category">
            <select
              value={
                item.category === "web" ? `web-${item.webKind}` : item.category
              }
              onChange={(event) => {
                const value = event.target.value;
                const category = value.startsWith("web")
                  ? "web"
                  : (value as WorkItem["category"]);
                patch({
                  category,
                  webKind: value.startsWith("web")
                    ? (value.split("-")[1] as "edit" | "build")
                    : null,
                  ...(!priorityChosen
                    ? state.actor.role === "owner"
                      ? {
                          priorityId: defaultWorkPriority(
                            category,
                            state.priorities,
                          ),
                        }
                      : {
                          requestedPriorityId: defaultWorkPriority(
                            category,
                            state.priorities,
                          ),
                        }
                    : {}),
                });
              }}
            >
              <option value="web-edit">Web · edit</option>
              <option value="web-build">Web · new build</option>
              <option value="it">IT</option>
              <option value="landings">Landings</option>
              <option value="software">Software</option>
            </select>
          </Field>
        </div>
        <Field label="What needs doing?">
          <input
            value={item.title}
            required
            maxLength={200}
            placeholder="e.g. South Bend service landings"
            onChange={(event) => patch({ title: event.target.value })}
          />
        </Field>
        <Field label="Description">
          <textarea
            rows={3}
            value={item.description}
            placeholder="Context, requirements, and what finished looks like…"
            onChange={(event) => patch({ description: event.target.value })}
          />
        </Field>
        <Field
          label={
            state.actor.role === "owner" ? "Priority" : "Suggested priority"
          }
        >
          <select
            value={
              state.actor.role === "owner"
                ? item.priorityId
                : item.requestedPriorityId || "normal"
            }
            onChange={(event) => {
              setPriorityChosen(true);
              patch(
                state.actor.role === "owner"
                  ? { priorityId: event.target.value }
                  : { requestedPriorityId: event.target.value },
              );
            }}
          >
            {state.priorities.map((priority) => (
              <option key={priority.id} value={priority.id}>
                {priority.label}
              </option>
            ))}
          </select>
        </Field>
        {!existing && (
          <>
            <div
              className="scheduling-mode work-hours-mode"
              role="group"
              aria-label="Hours for this work"
            >
              {(
                [
                  [
                    "total",
                    "Total hours",
                    "ADA fits the total into your chosen day or range.",
                  ],
                  [
                    "days",
                    "Days and hours",
                    "Choose how many hours to work on each day.",
                  ],
                  [
                    "ongoing",
                    "Ongoing",
                    "Keep it visible and add hours when needed.",
                  ],
                ] as const
              )
                .filter(
                  ([value]) =>
                    value !== "ongoing" || state.actor.role === "owner",
                )
                .map(([value, label, hint]) => (
                  <button
                    type="button"
                    key={value}
                    aria-pressed={hoursMode === value}
                    onClick={() => changeMode(value)}
                  >
                    <span>
                      <strong>{label}</strong>
                      <small>{hint}</small>
                    </span>
                  </button>
                ))}
            </div>
            {hoursMode === "total" && (
              <SmartFitFields
                value={fit}
                settings={state.settings}
                allowPerDay={false}
                onChange={(next) => {
                  setFit(next);
                  invalidate();
                }}
              />
            )}
            {hoursMode === "days" && !exact && (
              <DayHoursFields
                rows={days}
                settings={state.settings}
                onChange={(next) => {
                  setDays(next);
                  invalidate();
                }}
                defaultDate={firstDay}
              />
            )}
          </>
        )}
        {hoursMode === "ongoing" && (
          <section className="inset ongoing-work-fields">
            <h3>Project visibility</h3>
            <p className="micro muted">
              The faded ribbon keeps this project visible. Only booked hours use
              capacity.
            </p>
            <div className="form-grid">
              <Field label="Project starts">
                <input
                  type="date"
                  required
                  value={item.windowStart}
                  onChange={(event) =>
                    patch({ windowStart: event.target.value })
                  }
                />
              </Field>
              {!noEnd && (
                <Field label="Visible through">
                  <input
                    type="date"
                    required
                    min={item.windowStart}
                    value={item.windowEnd ?? ""}
                    onChange={(event) =>
                      patch({ windowEnd: event.target.value || null })
                    }
                  />
                </Field>
              )}
            </div>
            <label className="check">
              <input
                type="checkbox"
                checked={noEnd}
                onChange={(event) => {
                  setNoEnd(event.target.checked);
                  invalidate();
                }}
              />
              No end date — visible until completed or cancelled
            </label>
            {!existing && (
              <>
                <p className="micro muted">
                  Total hours stay unknown. You can add an estimate later.
                </p>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={bookOngoingNow}
                    onChange={(event) => {
                      setBookOngoingNow(event.target.checked);
                      invalidate();
                    }}
                  />
                  Book some hours now
                </label>
                {bookOngoingNow && !exact && (
                  <DayHoursFields
                    rows={days}
                    settings={state.settings}
                    onChange={(next) => {
                      setDays(next);
                      invalidate();
                    }}
                    defaultDate={firstDay}
                  />
                )}
              </>
            )}
          </section>
        )}
        <details className="work-advanced">
          <summary>Scheduling limits (optional)</summary>
          <p className="micro muted">
            Only limits you choose here restrict future bookings and moves.
          </p>
          <div className="form-grid">
            <Field label="Earliest allowed work day">
              <input
                type="date"
                value={earliestStart}
                onChange={(event) => {
                  setEarliestStart(event.target.value);
                  invalidate();
                }}
              />
            </Field>
            <Field label="Firm deadline (optional)">
              <input
                type="date"
                value={item.deadline ?? ""}
                onChange={(event) =>
                  patch({ deadline: event.target.value || null })
                }
              />
            </Field>
          </div>
          <label className="check">
            <input
              type="checkbox"
              checked={restrictWorkDates}
              onChange={(event) => {
                setRestrictWorkDates(event.target.checked);
                if (event.target.checked && !allowedWorkDates.length)
                  setAllowedWorkDates([date]);
                invalidate();
              }}
            />
            Limit work to selected dates
          </label>
          {restrictWorkDates && (
            <>
              {allowedWorkDates.map((day, index) => (
                <div className="allowed-work-date-row" key={index}>
                  <Field label={`Allowed work date ${index + 1}`}>
                    <input
                      type="date"
                      required
                      value={day}
                      onChange={(event) => {
                        setAllowedWorkDates(
                          allowedWorkDates.map((value, row) =>
                            row === index ? event.target.value : value,
                          ),
                        );
                        invalidate();
                      }}
                    />
                  </Field>
                  <button
                    type="button"
                    className="text-button"
                    aria-label={`Remove allowed work date ${index + 1}`}
                    onClick={() => {
                      setAllowedWorkDates(
                        allowedWorkDates.filter((_, row) => row !== index),
                      );
                      invalidate();
                    }}
                  >
                    Remove
                  </button>
                </div>
              ))}
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  setAllowedWorkDates([...allowedWorkDates, ""]);
                  invalidate();
                }}
              >
                Add allowed work date
              </button>
            </>
          )}
        </details>
        <details className="work-advanced">
          <summary>Advanced</summary>
          <Field label="Target finish (optional)">
            <input
              type="date"
              value={item.targetDate ?? ""}
              onChange={(event) =>
                patch({ targetDate: event.target.value || null })
              }
            />
          </Field>
          {item.category === "landings" && (
            <div className="form-grid">
              <Field label="Number of pages">
                <input
                  type="number"
                  min="1"
                  value={item.progressTotal ?? ""}
                  onChange={(event) =>
                    patch({
                      progressTotal: event.target.value
                        ? Number(event.target.value)
                        : null,
                    })
                  }
                />
              </Field>
              <Field label="Client update checkpoint">
                <input
                  type="date"
                  value={item.updateDate ?? ""}
                  onChange={(event) =>
                    patch({ updateDate: event.target.value || null })
                  }
                />
              </Field>
            </div>
          )}
          <WorkContextFields value={item.workContext} onChange={workContext => patch({ workContext })} />
          <Field label="Links or email references (one per line)">
            <textarea
              rows={2}
              value={item.references.join("\n")}
              onChange={(event) =>
                patch({
                  references: event.target.value.split("\n").filter(Boolean),
                })
              }
            />
          </Field>
          {!existing && (
            <>
              <label className="check">
                <input
                  type="checkbox"
                  checked={exact}
                  onChange={(event) => {
                    setExact(event.target.checked);
                    invalidate();
                  }}
                />
                Set exact times
              </label>
              {exact && (
                <div className="inset">
                  <Field label="Session dates (YYYY-MM-DD, comma-separated)">
                    <input
                      value={sessionDates}
                      required
                      onChange={(event) => {
                        setSessionDates(event.target.value);
                        invalidate();
                      }}
                    />
                  </Field>
                  <div className="form-grid">
                    <Field label="Start time">
                      <input
                        type="time"
                        step="900"
                        value={start}
                        onChange={(event) => {
                          setStart(event.target.value);
                          invalidate();
                        }}
                      />
                    </Field>
                    <Field label="End time">
                      <input
                        type="time"
                        step="900"
                        value={end}
                        onChange={(event) => {
                          setEnd(event.target.value);
                          invalidate();
                        }}
                      />
                    </Field>
                  </div>
                  {state.actor.role === "owner" && (
                    <>
                      <label className="check">
                        <input
                          type="checkbox"
                          checked={protect}
                          onChange={(event) => {
                            setProtect(event.target.checked);
                            invalidate();
                          }}
                        />
                        <LockKeyhole size={14} />
                        Protect these sessions
                      </label>
                      <label className="check">
                        <input
                          type="checkbox"
                          checked={urgent}
                          onChange={(event) => {
                            setUrgent(event.target.checked);
                            invalidate();
                          }}
                        />
                        This is an interruption; permit use of available reserve
                      </label>
                    </>
                  )}
                </div>
              )}
            </>
          )}
        </details>
        <p className="micro muted">
          {CATEGORY_LABELS[item.category]} · Files can be attached after the
          work is saved. Every committed change notifies Kyle and William.
        </p>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {proposal ? (
          <ProposalCard
            proposal={proposal}
            state={state}
            onCommit={commit}
            busy={busy}
          />
        ) : (
          <div className="form-actions">
            <button type="button" className="secondary" onClick={onClose}>
              Cancel
            </button>
            <button
              className="primary"
              disabled={busy || !state.clients.length}
            >
              {busy ? "Checking…" : "Review changes"}
              <ArrowRight size={16} />
            </button>
          </div>
        )}
      </fieldset>
    </form>
  );
}
