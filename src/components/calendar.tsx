"use client";
import { useEffect, useMemo, useRef, type CSSProperties } from "react";
import dynamic from "next/dynamic";
import { LockKeyhole, ArrowUpRight, GripVertical, CalendarClock, TreePalm, Check } from "lucide-react";
import type { AppState, UnavailableBlock, WorkCommand, WorkItem } from "@/lib/types";
import type { AssistantDateSelection } from "@/lib/assistant-date-selection";
import { addDays, dayOfWeek, instantFromMs, instantMs, localDate, localDateTime, minutesBetween } from "@/lib/time";
import { dayCapacity } from "@/lib/scheduler";
import { formatHours } from "@/lib/work";
import { workDaySummary, workTimeline } from "@/lib/work-timeline";
import { dateLabel, Empty, timeLabel } from "./ui";
import { calendarBookingMoveSourceUnavailableReason, type CalendarBookingMoveSelection } from "@/lib/calendar-booking-move";
import { useCalendarBookingDrag } from "./use-calendar-booking-drag";
import { useCalendarClock } from "./calendar-clock";

const TimedCalendar = dynamic(() => import("./timed-calendar"), {
  ssr: false,
  loading: () => <div className="empty">Loading timed calendar…</div>,
});
export type CalendarView = "month" | "week" | "day" | "agenda";
type Props = {
  state: AppState;
  date: string;
  items: WorkItem[];
  onSelect: (id: string) => void;
  onSelectBlock?: (id: string) => void;
  onDate: (date: string) => void;
  selectingDates?: boolean;
  dateSelection?: AssistantDateSelection | null;
  onMoveBookings?: (selection: CalendarBookingMoveSelection) => void;
  movingBookings?: boolean;
};
function lastBlockDate(block: UnavailableBlock, timeZone: string) {
  // End times are exclusive: an absence ending at midnight stops the day before.
  return localDate(instantFromMs(instantMs(block.end) - 1), timeZone);
}
function blockLabel(block: UnavailableBlock, timeZone: string) {
  const startDate = localDate(block.start, timeZone);
  const endDate = localDate(block.end, timeZone);
  return `${block.kind === "meeting" ? "Meeting" : "Time off"}: ${block.title}, ${dateLabel(startDate)} ${timeLabel(block.start, timeZone)}–${startDate === endDate ? "" : `${dateLabel(endDate)} `}${timeLabel(block.end, timeZone)} · Fixed unavailable time`;
}
export function MonthCalendar({
  state,
  date,
  items,
  onSelect,
  onSelectBlock,
  onDate,
  selectingDates = false,
  dateSelection,
  onMoveBookings,
  movingBookings = false,
}: Props) {
  const now = useCalendarClock();
  const first = date.slice(0, 7) + "-01";
  const start = addDays(first, -(dayOfWeek(first) % 7));
  const today = localDate(now ?? new Date().toISOString(), state.settings.timeZone);
  const canSelectDates = state.actor.role !== "viewer" && !movingBookings;
  const canMove = Boolean(onMoveBookings && state.actor.role === "owner" && !selectingDates && !movingBookings);
  const move = useCalendarBookingDrag(state, canMove, onMoveBookings);
  const movePicker = useRef<HTMLElement | null>(null);
  useEffect(() => {
    // Keep keyboard/touch destination controls discoverable even when a handle
    // was selected in a lower week; never shift focus during a native drag.
    if (move.source && !move.isDragging) movePicker.current?.focus();
  }, [move.source, move.isDragging]);
  const weeks = useMemo(
    () =>
      Array.from({ length: 6 }, (_, w) =>
        Array.from({ length: 7 }, (_, d) => addDays(start, w * 7 + d)),
      ),
    [start],
  );
  return (
    <>
    {state.actor.role !== "viewer" && !selectingDates && (
      <p className="micro muted">Double-click an empty day to select dates, or use Select dates.</p>
    )}
    {canMove && (
      <div className="calendar-booking-drag-tools">
        {move.source && !move.isDragging ? (
          <section ref={movePicker} tabIndex={-1} className="calendar-booking-drag-picker" aria-label="Choose a day for booked hours">
            <div>
              <p className="eyebrow">MOVE BOOKED HOURS</p>
              <strong>{move.source.label}</strong>
              <p>{formatHours(move.source.minutes)} from {dateLabel(move.source.date)}. Choose another day below, or enter a date. You’ll review the time before saving.</p>
            </div>
            <div className="calendar-booking-drag-picker-actions">
              <label>Move booking to date<input type="date" value={move.destination} onChange={e => move.setDestination(e.target.value)} /></label>
              <button className="primary" disabled={!move.destination} onClick={() => move.chooseDay(move.destination)}>Preview move</button>
              <button className="secondary" onClick={move.cancel}>Cancel move</button>
            </div>
          </section>
        ) : <p className="calendar-booking-drag-hint"><GripVertical size={14} /> Drag booked hours to another day, or use the move handle. Review before saving.</p>}
        <p className="calendar-booking-drag-status" role="status">{move.isDragging ? "" : move.message}</p>
        {move.isDragging && move.source && <p className="calendar-booking-drag-active" role="status">{move.hover?.reason || `Move ${formatHours(move.source.minutes)} to another day · review before saving`}</p>}
      </div>
    )}
    <div
      className={`month-calendar ${selectingDates ? "is-selecting-dates" : ""} ${move.source ? "is-moving-bookings" : ""} ${move.source && !move.isDragging ? "is-picking-booking-date" : ""}`}
      aria-label="Month workload calendar"
    >
      <div className="weekday-head">
        {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
          <span key={d}>{d}</span>
        ))}
      </div>
      {weeks.map((days, week) => {
        const visibleDates = (item: WorkItem) => {
          const timeline = workTimeline(item, state.sessions, state.settings.timeZone);
          const sessionDays = state.sessions
            .filter((s) => s.workItemId === item.id && s.status !== "cancelled")
            .map((s) => localDate(s.start, state.settings.timeZone));
          return days.filter(
            (d) =>
              (timeline && d >= timeline.start && (!timeline.end || d <= timeline.end)) ||
              sessionDays.includes(d),
          );
        };
        const ribbons = items.filter((item) => visibleDates(item).length > 0);
        const lanes: { end: number; count: number }[] = [];
        const fixedSpans = state.blocks
          .map((block) => ({
            block,
            visible: days.filter((d) => d >= localDate(block.start, state.settings.timeZone) && d <= lastBlockDate(block, state.settings.timeZone)),
          }))
          .filter(({ visible }) => visible.length > 0)
          .sort((a, b) => instantMs(a.block.start) - instantMs(b.block.start))
          .map(({ block, visible }) => {
            const from = days.indexOf(visible[0]);
            const to = days.indexOf(visible[visible.length - 1]);
            let lane = lanes.findIndex((l) => l.end < from);
            if (lane < 0) {
              lane = lanes.length;
              lanes.push({ end: to, count: 1 });
            } else lanes[lane] = { end: to, count: lanes[lane].count + 1 };
            return { block, from, to, lane };
          });
        const spans = ribbons
          .sort(
            (a, b) =>
              (workTimeline(a, state.sessions, state.settings.timeZone)?.start ?? a.windowStart).localeCompare(workTimeline(b, state.sessions, state.settings.timeZone)?.start ?? b.windowStart) ||
              a.createdAt.localeCompare(b.createdAt),
          )
          .map((item) => {
            const visible = visibleDates(item);
            const from = days.indexOf(visible[0]);
            const to = days.indexOf(visible[visible.length - 1]);
            let lane = lanes.findIndex((l) => l.end < from);
            if (lane < 0) {
              lane = lanes.length;
              lanes.push({ end: to, count: 1 });
            } else lanes[lane] = { end: to, count: lanes[lane].count + 1 };
            return { item, from, to, lane };
          });
        return (
          <div
            className="calendar-week"
            key={week}
            style={{ "--ribbon-lanes": lanes.length } as CSSProperties}
            onDragOver={e => move.dragOverWeek(e, days)}
            onDrop={e => move.dropOnWeek(e, days)}
            onDragLeave={move.leaveWeek}
          >
            <div className="day-backgrounds">
              {days.map((d) => {
                const capacity = dayCapacity(state, d, now);
                const isWorkday = state.settings.weekdays.includes(
                  dayOfWeek(d),
                );
                const inSelection = Boolean(
                  dateSelection &&
                  d >= dateSelection.start &&
                  d <= dateSelection.end,
                );
                return (
                  <button
                    key={d}
                    data-date={d}
                    className={`day-cell ${d.slice(0, 7) !== first.slice(0, 7) ? "outside-month" : ""} ${d === today ? "is-today" : d < today ? "is-past" : ""} ${!isWorkday ? "weekend" : ""} ${inSelection ? "date-selected" : ""} ${dateSelection && (d === dateSelection.start || d === dateSelection.end) ? "date-endpoint" : ""} ${move.hover?.date === d ? move.hover.reason ? "booking-drop-blocked" : "booking-drop-target" : ""}`}
                    onClick={event => {
                      if (move.suppressClick() || movingBookings) return;
                      if (move.source) move.chooseDay(d);
                      // Keyboard activation selects directly. In selection mode,
                      // ignore the second click of a double-click to keep the range anchor.
                      else if (canSelectDates && (event.detail === 0 || selectingDates && event.detail === 1)) onDate(d);
                    }}
                    onDoubleClick={() => {
                      if (canSelectDates && !selectingDates && !move.source && !move.suppressClick()) onDate(d);
                    }}
                    aria-pressed={selectingDates ? inSelection : undefined}
                    aria-description={canSelectDates && !selectingDates ? "Double-click, or press Enter or Space, to select this date." : undefined}
                    aria-label={`${dateLabel(d, { weekday: "long", month: "long", day: "numeric" })}, ${isWorkday ? `${formatHours(capacity.availableMinutes)} available, ${formatHours(capacity.plannedMinutes)} planned` : "Non-working day"}`}
                    title={
                      isWorkday
                        ? `${formatHours(capacity.availableMinutes)} left to book · ${formatHours(capacity.plannedMinutes)} planned · ${formatHours(capacity.capacityMinutes)} daily capacity. Only future openings before the workday ends count, in ${state.settings.slotMinutes}-minute increments. Lunch, interruption reserve and unavailable time are excluded.`
                        : "Non-working day"
                    }
                  >
                    <span className="day-header">
                      <span className="day-number">{Number(d.slice(-2))}</span>
                      {isWorkday && (
                        <span
                          className={`day-capacity ${capacity.availableMinutes === 0 ? "capacity-full" : capacity.availableMinutes <= 60 ? "capacity-low" : ""}`}
                        >
                          <span className="day-capacity-remaining">
                            <strong>
                              {formatHours(capacity.availableMinutes)}
                            </strong>
                            <span>left</span>
                          </span>
                          <small
                            className={`day-capacity-planned ${capacity.plannedMinutes === 0 ? "is-empty" : ""}`}
                          >
                            {formatHours(capacity.plannedMinutes)} planned
                          </small>
                        </span>
                      )}
                    </span>
                    {isWorkday && (
                      <span className="capacity-line" aria-hidden="true">
                        <i
                          style={{
                            width: `${Math.min(100, (capacity.plannedMinutes / (capacity.capacityMinutes || 1)) * 100)}%`,
                          }}
                        />
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
            <div
              className="ribbon-grid"
              style={{
                gridTemplateRows: `repeat(${Math.max(1, lanes.length)}, 26px)`,
              }}
            >
              {fixedSpans.map(({ block, from, to, lane }) => (
                <button
                  key={`block-${block.id}`}
                  type="button"
                  className={`fixed-block-ribbon fixed-block-${block.kind}`}
                  data-block-id={block.id}
                  draggable={false}
                  style={{ gridColumn: `${from + 1} / ${to + 2}`, gridRow: lane + 1 }}
                  disabled={selectingDates || !!move.source && !move.isDragging || !onSelectBlock}
                  onClick={() => { if (!move.suppressClick()) onSelectBlock?.(block.id); }}
                  aria-label={blockLabel(block, state.settings.timeZone)}
                  title={blockLabel(block, state.settings.timeZone)}
                >
                  {block.kind === "meeting" ? <CalendarClock size={12} aria-hidden="true" /> : <TreePalm size={12} aria-hidden="true" />}
                  <span className="fixed-block-time">{localDate(block.start, state.settings.timeZone) < days[from] ? "Continues" : timeLabel(block.start, state.settings.timeZone)}</span>
                  <span className="fixed-block-title">{block.title}</span>
                </button>
              ))}
              {spans.map(({ item, from, to, lane }) => {
                const client = state.clients.find(
                  (c) => c.id === item.clientId,
                );
                const label = `${client?.name} · ${item.title}`;
                const segments = days.slice(from, to + 1).map(d => {
                  const { plannedSessions: sessions, plannedMinutes: minutes, completedMinutes } = workDaySummary(item.id, state.sessions, d, state.settings.timeZone);
                  const sessionIds = sessions.map(s => s.id);
                  const reason = minutes ? calendarBookingMoveSourceUnavailableReason(state, sessionIds, new Date().toISOString()) : null;
                  return { d, sessions, sessionIds, minutes, completedMinutes, reason, draggable: canMove && minutes > 0 && !reason };
                });
                const mixedDay = segments.some(segment => segment.minutes > 0 && segment.completedMinutes > 0);
                const hasCompleted = segments.some(segment => segment.completedMinutes > 0);
                const onlyCompleted = hasCompleted && !segments.some(segment => segment.minutes > 0);
                return (
                  <div key={item.id} className={`project-ribbon-lane category-${item.category} ${hasCompleted ? "completed-ribbon-lane" : ""} ${mixedDay ? "completed-mixed-lane" : ""} ${onlyCompleted ? "completed-ribbon-muted" : ""}`} data-work-item-id={item.id} style={{ gridColumn: `${from + 1} / ${to + 2}`, gridRow: lane + 1 }}>
                  <button
                    disabled={selectingDates || !!move.source && !move.isDragging}
                    title={label}
                    onClick={() => { if (!move.suppressClick()) onSelect(item.id); }}
                    className={`project-ribbon category-${item.category} ${item.status === "waiting" ? "ribbon-waiting" : ""}`}
                  >
                    <span
                      className="ribbon-segments"
                      style={{
                        gridTemplateColumns: `repeat(${to - from + 1}, 1fr)`,
                      }}
                    >
                      {segments.map(({ d, sessions, sessionIds, minutes, completedMinutes, draggable }) => {
                        return (
                          <span
                            key={d}
                            data-booking-date={minutes ? d : undefined}
                            data-work-item-id={minutes ? item.id : undefined}
                            draggable={draggable}
                            onDragStart={e => move.startDrag(e, sessionIds, label)}
                            onDragEnd={move.endDrag}
                            className={
                              minutes
                                ? `ribbon-reserved ${draggable ? "booking-draggable" : ""} ${completedMinutes ? "completed-day-mixed" : ""}`
                                : completedMinutes
                                  ? "completed-day-base"
                                  : (() => { const timeline = workTimeline(item, state.sessions, state.settings.timeZone); return timeline && d >= timeline.start && (!timeline.end || d <= timeline.end); })()
                                  ? "ribbon-span"
                                  : "ribbon-gap"
                            }
                          >
                            {minutes > 0 && (
                              <span className="planned-day-amount" aria-label={`${formatHours(minutes)} planned`}>
                                {sessions.some((s) => s.protected) && (
                                  <LockKeyhole size={10} />
                                )}
                                {formatHours(minutes)}
                              </span>
                            )}
                            {completedMinutes > 0 && <span className="completed-day-segment" data-completed-date={d} data-work-item-id={item.id}
                              title={`${formatHours(completedMinutes)} done on ${dateLabel(d)}`} draggable={false}
                              onDragStart={event => { event.preventDefault(); event.stopPropagation(); }}>
                              <Check size={10} aria-hidden="true" />{formatHours(completedMinutes)} done
                            </span>}
                          </span>
                        );
                      })}
                    </span>
                    <span className="ribbon-title">
                      {(state.priorities.find((p) => p.id === item.priorityId)
                        ?.rank ?? 99) <= 1 && (
                        <b
                          className="ribbon-priority"
                          title={`${state.priorities.find((p) => p.id === item.priorityId)?.label} priority`}
                        >
                          {state.priorities.find(
                            (p) => p.id === item.priorityId,
                          )?.rank === 0
                            ? "!"
                            : "↑"}
                        </b>
                      )}
                      {client?.name} <span>· {item.title}</span>
                    </span>
                  </button>
                  {canMove && <div className="ribbon-move-handles" style={{ gridTemplateColumns: `repeat(${to - from + 1}, minmax(0, 1fr))` }}>
                    {segments.map(({ d, sessionIds, minutes, reason, draggable }) => <span key={d}>{draggable && (
                      <button type="button" className="booking-move-handle" data-booking-date={d} data-work-item-id={item.id}
                        aria-label={`Move ${label} on ${dateLabel(d)}`} title={reason || `Move ${formatHours(minutes)} from ${dateLabel(d)}`}
                        disabled={!draggable || !!move.source && !move.isDragging} draggable={draggable}
                        onClick={e => { e.stopPropagation(); if (!move.suppressClick()) move.pickSource(sessionIds, label); }}
                        onDragStart={e => move.startDrag(e, sessionIds, label)} onDragEnd={move.endDrag}>
                        <GripVertical size={14} aria-hidden="true" />
                      </button>
                    )}</span>)}
                  </div>}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
    </>
  );
}
export function Agenda({ state, date, items, onSelect, onSelectBlock }: Props) {
  const now = useCalendarClock();
  const sessions = state.sessions
    .filter(
      (s) =>
        s.status !== "cancelled" &&
        localDate(s.start, state.settings.timeZone) >= date &&
        items.some((i) => i.id === s.workItemId),
    )
    .map((session) => ({ kind: "session" as const, session, start: session.start, end: session.end, date: localDate(session.start, state.settings.timeZone) }));
  const sessionDates = new Set(sessions.map(session => session.date));
  const blocks = state.blocks.flatMap((block) => {
    const first = localDate(block.start, state.settings.timeZone);
    const last = lastBlockDate(block, state.settings.timeZone);
    const from = first < date ? date : first;
    const visibleDates = new Set<string>();
    // An absence can span years. Bound daily expansion while keeping unavailable
    // time alongside every work date already listed in the agenda.
    for (let d = from, count = 0; d <= last && count < 31; d = addDays(d, 1), count++) visibleDates.add(d);
    for (const d of sessionDates) if (d >= from && d <= last) visibleDates.add(d);
    return [...visibleDates].sort().map((d) => {
      const start = instantFromMs(Math.max(instantMs(block.start), instantMs(localDateTime(d, "00:00", state.settings.timeZone))));
      const end = instantFromMs(Math.min(instantMs(block.end), instantMs(localDateTime(addDays(d, 1), "00:00", state.settings.timeZone))));
      const continuesThrough = d < last && !visibleDates.has(addDays(d, 1)) ? last : null;
      return { kind: "block" as const, block, start, end, date: d, continuesThrough };
    });
  });
  const upcoming = [...sessions, ...blocks].sort((a, b) => instantMs(a.start) - instantMs(b.start));
  const days = [
    ...new Set(
      upcoming.map((entry) => entry.date),
    ),
  ];
  if (!days.length)
    return (
      <Empty title="A little breathing room">
        No work sessions, meetings or time off from this date. Unscheduled and waiting projects
        remain on your plate.
      </Empty>
    );
  return (
    <div className="agenda">
      {days.map((d) => (
        <section key={d}>
          <h3>
            {dateLabel(d, { weekday: "long", month: "long", day: "numeric" })}
            <span>
              {formatHours(dayCapacity(state, d, now).plannedMinutes)} work planned · {formatHours(dayCapacity(state, d, now).availableMinutes)} left
            </span>
          </h3>
          {upcoming
            .filter((entry) => entry.date === d)
            .map((entry) => {
              if (entry.kind === "block") {
                const { block, start, end } = entry;
                return (
                  <button
                    type="button"
                    className={`agenda-item agenda-fixed-block fixed-block-${block.kind}`}
                    key={`block-${block.id}`}
                    data-block-id={block.id}
                    draggable={false}
                    onClick={() => onSelectBlock?.(block.id)}
                    disabled={!onSelectBlock}
                    aria-label={blockLabel(block, state.settings.timeZone)}
                  >
                    <span className="agenda-time">
                      {instantMs(start) > instantMs(block.start) ? "Continues" : timeLabel(start, state.settings.timeZone)}
                      <small>{localDate(end, state.settings.timeZone) > d ? "Midnight" : timeLabel(end, state.settings.timeZone)}</small>
                    </span>
                    <span className="agenda-fixed-icon" aria-hidden="true">{block.kind === "meeting" ? <CalendarClock size={15} /> : <TreePalm size={15} />}</span>
                    <span className="agenda-fixed-title">
                      <strong>{block.title}</strong>
                      <small>{block.kind === "meeting" ? "Meeting" : "Time off"} · Fixed time</small>
                      {entry.continuesThrough && <small>Continues through {dateLabel(entry.continuesThrough, { month: "short", day: "numeric", year: "numeric" })}</small>}
                    </span>
                    <span className="agenda-end">
                      {formatHours(minutesBetween(start, end))}
                      <ArrowUpRight size={16} aria-hidden="true" />
                    </span>
                  </button>
                );
              }
              const s = entry.session;
              const item = state.items.find((i) => i.id === s.workItemId)!;
              const completed = s.status === "completed";
              return (
                <button
                  className={`agenda-item ${completed ? "completed-agenda-session" : ""}`}
                  key={s.id}
                  data-session-id={s.id}
                  data-session-status={s.status}
                  onClick={() => onSelect(item.id)}
                >
                  <span className="agenda-time">
                    {timeLabel(s.start, state.settings.timeZone)}
                    <small>{timeLabel(s.end, state.settings.timeZone)}</small>
                  </span>
                  <span className={`category-dot category-${item.category}`} />
                  <span>
                    <strong>{item.title}</strong>
                    <small>
                      {state.clients.find((c) => c.id === item.clientId)?.name}
                    </small>
                  </span>
                  <span className="agenda-end">
                    {completed ? <Check size={14} aria-hidden="true" /> : s.protected && <LockKeyhole size={14} />}
                    {formatHours(minutesBetween(s.start, s.end))}{completed ? " done" : ""}
                    <ArrowUpRight size={16} />
                  </span>
                </button>
              );
            })}
        </section>
      ))}
    </div>
  );
}
export function CalendarContent(
  props: Props & {
    view: CalendarView;
    onCommand: (command: WorkCommand) => Promise<void>;
  },
) {
  if (props.view === "month") return <MonthCalendar {...props} />;
  if (props.view === "agenda") return <Agenda {...props} />;
  return <TimedCalendar {...props} view={props.view} />;
}
