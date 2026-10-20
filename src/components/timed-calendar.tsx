"use client";
import Calendar from "@fullcalendar/react";
import timeGridPlugin from "@fullcalendar/react/timegrid";
import interactionPlugin from "@fullcalendar/react/interaction";
import classicPlugin from "@fullcalendar/react/themes/classic";
import "@fullcalendar/react/skeleton.css";
import "@fullcalendar/react/themes/classic/theme.css";
import "@fullcalendar/react/themes/classic/palette.css";
import type { AppState, WorkCommand, WorkItem } from "@/lib/types";
import { addDays, dayOfWeek, localDate, localDateTime, addMinutes, minutesBetween } from "@/lib/time";
import { formatHours } from "@/lib/work";
import { dateLabel, timeLabel } from "./ui";
import { calendarHistory } from "@/lib/work-timeline";
import { Check } from "lucide-react";

const colors = {
  software: "#493f65",
  web: "#234554",
  landings: "#51452c",
  it: "#285044",
};
export default function TimedCalendar({
  state,
  date,
  items,
  onSelect,
  onSelectBlock,
  view,
  onCommand,
}: {
  state: AppState;
  date: string;
  items: WorkItem[];
  onSelect: (id: string) => void;
  onSelectBlock?: (id: string) => void;
  view: "week" | "day";
  onCommand: (command: WorkCommand) => Promise<void>;
}) {
  const start = addDays(date, -(dayOfWeek(date) % 7));
  const history = calendarHistory(items, state.sessions, state.settings.timeZone);
  const completions = history.completions.filter(marker => view === "day" ? marker.date === date : marker.date >= start && marker.date < addDays(start, 7));
  const backgrounds = Array.from({ length: 7 }, (_, i) =>
    addDays(start, i),
  ).flatMap((d) => [
    {
      id: `lunch-${d}`,
      title: "Lunch",
      start: localDateTime(
        d,
        state.settings.lunchStart,
        state.settings.timeZone,
      ),
      end: localDateTime(d, state.settings.lunchEnd, state.settings.timeZone),
      display: "background",
      color: "#676c77",
      editable: false,
      interactive: false,
    },
    {
      id: `reserve-${d}`,
      title: "Unexpected-work reserve",
      start: localDateTime(
        d,
        state.settings.reserveStart,
        state.settings.timeZone,
      ),
      end: addMinutes(
        localDateTime(d, state.settings.reserveStart, state.settings.timeZone),
        state.settings.reserveMinutes,
      ),
      display: "background",
      color: "#c69c42",
      editable: false,
      interactive: false,
    },
  ]);
  return (
    <div className="timed-calendar" data-color-scheme="dark">
      {completions.length > 0 && <section className="project-completion-markers" aria-label="Completed projects">
        {completions.map(({ item, date: completedDate }) => (
          <button type="button" key={item.id} data-project-completion-id={item.id} data-completed-date={completedDate} onClick={() => onSelect(item.id)}>
            <Check size={16} aria-hidden="true" />
            <span><strong>{item.title} · Completed</strong><small>{state.clients.find(client => client.id === item.clientId)?.name} · {dateLabel(completedDate)} · No hours recorded</small></span>
          </button>
        ))}
      </section>}
      <Calendar
        key={`${view}-${date}-${state.version}`}
        plugins={[timeGridPlugin, interactionPlugin, classicPlugin]}
        initialView={view === "week" ? "timeGridWeek" : "timeGridDay"}
        initialDate={date}
        timeZone={state.settings.timeZone}
        headerToolbar={false}
        height="auto"
        allDaySlot={false}
        slotMinTime={state.settings.dayStart}
        slotMaxTime={state.settings.dayEnd}
        slotDuration="00:15:00"
        slotHeaderInterval="01:00:00"
        weekends={false}
        nowIndicator
        editable={state.actor.role === "owner"}
        eventOverlap={(stillEvent) => stillEvent.extendedProps.sessionStatus === "completed"}
        events={[
          ...backgrounds,
          ...state.blocks.map((b) => ({
            id: `block-${b.id}`,
            title: `${b.kind === "meeting" ? "Meeting" : "Time off"} · ${b.title}`,
            start: b.start,
            end: b.end,
            editable: false,
            startEditable: false,
            durationEditable: false,
            interactive: Boolean(onSelectBlock),
            color: b.kind === "meeting" ? "#384759" : "#41433b",
            contrastColor: "#e6edf3",
            className: `timed-fixed-block fixed-block-${b.kind}`,
            extendedProps: { blockId: b.id },
          })),
          ...history.sessions
            .map((s) => {
              const item = items.find((i) => i.id === s.workItemId)!;
              const completed = s.status === "completed";
              return {
                id: s.id,
                title: `${completed ? `✓ ${formatHours(minutesBetween(s.start, s.end))} done · ` : s.protected ? "🔒 " : ""}${state.clients.find((c) => c.id === item.clientId)?.name} · ${item.title}`,
                start: s.start,
                end: s.end,
                color: completed ? "#28302d" : colors[item.category],
                contrastColor: completed ? "#b4c0b8" : "#e9edeb",
                editable: !completed && state.actor.role === "owner" && !s.protected,
                ...(completed ? { startEditable: false, durationEditable: false, className: "completed-time-session" } : {}),
                extendedProps: { workItemId: item.id, sessionStatus: s.status },
              };
            }),
        ]}
        eventDidMount={(info) => {
          const blockId = info.event.extendedProps.blockId as string | undefined;
          const block = state.blocks.find((b) => b.id === blockId);
          if (!block) {
            const session = state.sessions.find(session => session.id === info.event.id);
            if (session) {
              info.el.dataset.sessionId = session.id;
              info.el.dataset.sessionStatus = session.status;
              const label = `${info.event.title}, ${dateLabel(localDate(session.start, state.settings.timeZone))} ${timeLabel(session.start, state.settings.timeZone)}–${timeLabel(session.end, state.settings.timeZone)}`;
              info.el.setAttribute("aria-label", label);
              info.el.title = label;
            }
            return;
          }
          const startDate = localDate(block.start, state.settings.timeZone);
          const endDate = localDate(block.end, state.settings.timeZone);
          const label = `${block.kind === "meeting" ? "Meeting" : "Time off"}: ${block.title}, ${dateLabel(startDate)} ${timeLabel(block.start, state.settings.timeZone)}–${startDate === endDate ? "" : `${dateLabel(endDate)} `}${timeLabel(block.end, state.settings.timeZone)} · Fixed unavailable time`;
          info.el.dataset.blockId = block.id;
          info.el.setAttribute("aria-label", label);
          info.el.title = label;
        }}
        eventClick={(info) => {
          const blockId = info.event.extendedProps.blockId as string | undefined;
          if (blockId) {
            onSelectBlock?.(blockId);
            return;
          }
          const id = info.event.extendedProps.workItemId as string | undefined;
          if (id) onSelect(id);
        }}
        eventDrop={(info) => {
          const start = info.event.startStr;
          const end = info.event.endStr;
          info.revert();
          if (start && end && !info.event.extendedProps.blockId && state.sessions.some((s) => s.id === info.event.id && s.status === "planned"))
            void onCommand({
              type: "move",
              sessionId: info.event.id,
              start,
              end,
            });
        }}
        eventResize={(info) => {
          const start = info.event.startStr;
          const end = info.event.endStr;
          const original = state.sessions.find((s) => s.id === info.event.id);
          info.revert();
          if (start && end && original?.status === "planned" && !info.event.extendedProps.blockId)
            void onCommand({
              type: "schedule",
              itemId: original.workItemId,
              sessions: state.sessions
                .filter(
                  (s) =>
                    s.workItemId === original.workItemId &&
                    s.status === "planned",
                )
                .map((s) => (s.id === original.id ? { ...s, start, end } : s)),
            });
        }}
      />
      <p className="micro muted">
        Meetings and time off are fixed; work is scheduled around them. Open a calendar event for details.
        {state.settings.reserveMinutes > 0 && " Amber shading is your interruption reserve."}
        {" "}Completed hours stay visible as done. Completed and protected sessions cannot be dragged.
      </p>
    </div>
  );
}
