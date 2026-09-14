"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  Activity,
  ArrowDownLeft,
  ArrowUpRight,
  CalendarDays,
  CalendarClock,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Clock3,
  Coffee,
  Inbox,
  Layers3,
  LockKeyhole,
  Mail,
  Menu,
  Plus,
  Search,
  Settings2,
  StickyNote,
  Sparkles,
  Undo2,
  X,
} from "lucide-react";
import type {
  AppState,
  Category,
  EmailDraft,
  ScheduleProposal,
  UnavailableBlock,
  WorkCommand,
} from "@/lib/types";
import { addDays } from "@/lib/time";
import {
  dayOfWeek,
  localDate,
  instantMs,
  instantFromMs,
  minutesBetween,
} from "@/lib/time";
import { dayCapacity } from "@/lib/scheduler";
import { CATEGORY_LABELS } from "@/lib/defaults";
import { sortClientsByName } from "@/lib/clients";
import { formatHours } from "@/lib/work";
import { CalendarContent, type CalendarView } from "./calendar";
import { useCalendarClock } from "./calendar-clock";
import { DateSelectionActions } from "./date-selection-actions";
import { api, ApiError, dateLabel, Empty, Field, Modal, timeLabel } from "./ui";
import { WorkForm, ProposalCard } from "./work-form";
import { SessionManager } from "./session-manager";
import { WorkDetails } from "./work-details";
import {
  AssistantPanel,
  emptyAssistantDraft,
  selectedDatesLabel,
} from "./assistant-panel";
import {
  dateSelectionSchema,
  type AssistantDateSelection,
} from "@/lib/assistant-date-selection";
import { SettingsPanel } from "./settings-panel";
import { RequestReview, RequestAttachments } from "./request-review";
import { BrandLogo } from "./brand-logo";
import { NotesPanel } from "./notes-panel";
import { WorkspaceChat } from "./workspace-chat";
import { CalendarBookingMove } from "./calendar-booking-move";
import { MeetingForm } from "./meeting-form";
import type { CalendarBookingMoveSelection } from "@/lib/calendar-booking-move";

type Section = "calendar" | "work" | "requests" | "updates" | "notes";
function DraftCard({
  draft,
  onState,
}: {
  draft: EmailDraft;
  onState: (s: AppState) => void;
}) {
  const [subject, setSubject] = useState(draft.subject);
  const [body, setBody] = useState(draft.body);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function act(type: string) {
    setBusy(true);
    setError("");
    try {
      if (type !== "dismiss_draft") {
        const edited = await api("admin", {
          type: "edit_draft",
          id: draft.id,
          subject,
          body,
        });
        if (type === "edit_draft") {
          onState(edited.state);
          return;
        }
      }
      onState(
        (
          await api("admin", {
            type,
            id: draft.id,
            ...(type === "send_draft"
              ? { expectedSubject: subject, expectedBody: body }
              : {}),
          })
        ).state,
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="draft-card">
      <p className="eyebrow">DRAFT · NOT SENT</p>
      <p className="micro muted">To: Kyle and William</p>
      <Field label="Subject">
        <input value={subject} onChange={(e) => setSubject(e.target.value)} />
      </Field>
      <Field label="Message">
        <textarea
          rows={5}
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
      </Field>
      <div className="form-actions">
        <button
          className="secondary"
          disabled={busy}
          onClick={() => act("edit_draft")}
        >
          Save draft
        </button>
        <button
          className="secondary"
          disabled={busy}
          onClick={() => act("dismiss_draft")}
        >
          Dismiss
        </button>
        <button
          className="primary"
          disabled={busy}
          onClick={() => act("send_draft")}
        >
          <Mail size={15} />
          Send update email
        </button>
      </div>
      {error && <p className="error">{error}</p>}
    </div>
  );
}
export function Workspace({ initialState }: { initialState: AppState }) {
  const [state, setState] = useState(initialState);
  const now = useCalendarClock();
  const today = localDate(now ?? new Date().toISOString(), state.settings.timeZone);
  const [date, setDate] = useState(today);
  const [view, setView] = useState<CalendarView>("month");
  const [section, setSection] = useState<Section>("calendar");
  const stickyHeaderRef = useRef<HTMLDivElement>(null);
  const calendarToolbarRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const header = stickyHeaderRef.current;
    const main = header?.parentElement;
    if (!header || !main) return;
    const updateHeight = () => {
      main.style.setProperty(
        "--calendar-sticky-header-height",
        `${header.getBoundingClientRect().height}px`,
      );
    };
    updateHeight();
    const observer = new ResizeObserver(updateHeight);
    observer.observe(header);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const main = stickyHeaderRef.current?.parentElement;
    const toolbar = calendarToolbarRef.current;
    if (!main || !toolbar || section !== "calendar") return;
    const updateHeight = () => {
      main.style.setProperty("--calendar-toolbar-height", `${toolbar.getBoundingClientRect().height}px`);
    };
    updateHeight();
    const observer = new ResizeObserver(updateHeight);
    observer.observe(toolbar);
    return () => {
      observer.disconnect();
      main.style.removeProperty("--calendar-toolbar-height");
    };
  }, [section]);
  const [notesVisited, setNotesVisited] = useState(false);
  const [categories, setCategories] = useState<Category[]>([
    "web",
    "it",
    "landings",
    "software",
  ]);
  const [client, setClient] = useState("");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [form, setForm] = useState(false);
  const [formDates, setFormDates] = useState<{ start: string; end: string } | null>(null);
  const [findingTime, setFindingTime] = useState(false);
  const [editing, setEditing] = useState(false);
  const [assistant, setAssistant] = useState(false);
  const [assistantDraft, setAssistantDraft] = useState(emptyAssistantDraft);
  const [dateSelection, setDateSelection] =
    useState<AssistantDateSelection | null>(null);
  const [selectingDates, setSelectingDates] = useState(false);
  const [dateSelectionModal, setDateSelectionModal] = useState(false);
  const dateSelectionToolbarRef = useRef<HTMLDivElement>(null);
  const showDateSelectionToolbar = section === "calendar" && selectingDates && !dateSelectionModal;
  useEffect(() => {
    const main = stickyHeaderRef.current?.parentElement;
    const toolbar = dateSelectionToolbarRef.current;
    if (!main) return;
    const updateHeight = () => {
      const height = toolbar?.getBoundingClientRect().height ?? 0;
      main.style.setProperty("--calendar-selection-toolbar-height", `${height}px`);
    };
    updateHeight();
    if (!toolbar) return;
    const observer = new ResizeObserver(updateHeight);
    observer.observe(toolbar);
    return () => {
      observer.disconnect();
      main.style.removeProperty("--calendar-selection-toolbar-height");
    };
  }, [showDateSelectionToolbar]);
  const [calendarMoveSelection, setCalendarMoveSelection] = useState<CalendarBookingMoveSelection | null>(null);
  const [calendarMoveLocked, setCalendarMoveLocked] = useState(false);
  const [selectionAnchor, setSelectionAnchor] = useState<string | null>(null);
  const [confirmNewSelection, setConfirmNewSelection] = useState(false);
  const [pendingSelectionDate, setPendingSelectionDate] = useState<string | null>(null);
  const [settings, setSettings] = useState(false);
  const [help, setHelp] = useState(false);
  const [mobileNav, setMobileNav] = useState(false);
  const [proposal, setProposal] = useState<ScheduleProposal | null>(null);
  const [notice, setNoticeState] = useState<{ message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [block, setBlock] = useState<{ date: string; existing?: UnavailableBlock } | null>(null);
  const owner = state.actor.role === "owner";
  function beginDateSelection(day?: string) {
    setAssistantDraft(emptyAssistantDraft());
    setDateSelection(day ? { start: day, end: day, kind: "work_window" } : null);
    setSelectionAnchor(day ?? null);
    setPendingSelectionDate(null);
    setConfirmNewSelection(false);
    setSection("calendar");
    setView("month");
    setSelectingDates(true);
    setDateSelectionModal(Boolean(day));
  }
  function cancelDateSelection() {
    setDateSelectionModal(false);
    setSelectingDates(false);
    setDateSelection(null);
    setSelectionAnchor(null);
  }
  function requestDateSelection(day?: string) {
    if (state.actor.role === "viewer" || assistantDraft.busy) return;
    if (assistantDraft.text.trim() || assistantDraft.replyToOperationId || assistantDraft.proposal) {
      setPendingSelectionDate(day ?? null);
      setConfirmNewSelection(true);
    } else beginDateSelection(day);
  }
  function pickDate(day: string) {
    if (!selectingDates) {
      requestDateSelection(day);
      return;
    }
    if (!selectionAnchor) {
      setDateSelection({
        start: day,
        end: day,
        kind: dateSelection?.kind ?? "work_window",
      });
      setSelectionAnchor(day);
    } else {
      const [start, end] = [selectionAnchor, day].sort();
      const selection = dateSelectionSchema.safeParse({
        start,
        end,
        kind: dateSelection?.kind ?? "work_window",
      });
      if (!selection.success) {
        setNotice("Choose a date range of up to 366 days.");
        return;
      }
      setDateSelection(selection.data);
      setSelectionAnchor(null);
    }
  }
  function setNotice(message: string) {
    // A fresh object also restarts the timer for consecutive identical notices.
    setNoticeState(message ? { message } : null);
  }
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => {
      setNoticeState((current) => (current === notice ? null : current));
    }, 4000);
    return () => window.clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (window.matchMedia("(max-width: 760px)").matches) setView("agenda");
      const query = new URLSearchParams(window.location.search);
      const id = query.get("task") || query.get("work");
      if (id) setSelectedId(id);
    });
    return () => cancelAnimationFrame(frame);
  }, []);
  useEffect(() => {
    const refresh = () => {
      void api<AppState>("state")
        .then((next) => {
          // Never carry a private draft across an account/workspace change.
          if (
            next.actor.id !== initialState.actor.id ||
            next.workspaceId !== initialState.workspaceId ||
            next.actor.role !== initialState.actor.role
          )
            window.location.reload();
          else setState(next);
        })
        .catch(() => {});
    };
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [
    initialState.actor.id,
    initialState.actor.role,
    initialState.workspaceId,
  ]);
  function update(next: AppState) {
    const addedEmail = next.notifications.some(
      (n) => !state.notifications.some((previous) => previous.id === n.id),
    );
    setState(next);
    setNotice(
      !addedEmail
        ? "Workspace updated. No new emails generated."
        : next.mode === "demo"
          ? "Saved locally. Team update emails captured for review."
          : "Saved. Team update emails queued.",
    );
  }
  const active = state.items.filter(
    (i) => i.status !== "completed" && i.status !== "cancelled",
  );
  const filtered = useMemo(
    () =>
      state.items.filter(
        (i) =>
          categories.includes(i.category) &&
          (!client || client === i.clientId) &&
          `${i.title} ${state.clients.find((c) => c.id === i.clientId)?.name} ${i.description}`
            .toLowerCase()
            .includes(search.toLowerCase()),
      ),
    [state.items, state.clients, categories, client, search],
  );
  const calendarItems = filtered.filter(
    (i) => i.status !== "completed" && i.status !== "cancelled",
  );
  const selected = state.items.find((i) => i.id === selectedId);
  const currentSessions = state.sessions
    .filter(
      (s) =>
        s.status === "planned" &&
        localDate(s.start, state.settings.timeZone) >= today,
    )
    .sort((a, b) => a.start.localeCompare(b.start));
  const upcomingBlocks = state.blocks.filter(block => localDate(instantFromMs(instantMs(block.end) - 1), state.settings.timeZone) >= today)
    .sort((a, b) => a.start.localeCompare(b.start));
  const focusDate = [currentSessions[0] && localDate(currentSessions[0].start, state.settings.timeZone),
    upcomingBlocks[0] && (localDate(upcomingBlocks[0].start, state.settings.timeZone) < today ? today : localDate(upcomingBlocks[0].start, state.settings.timeZone))]
    .filter((day): day is string => !!day).sort()[0] ?? today;
  const nextSessions = currentSessions.filter(
    (s) => localDate(s.start, state.settings.timeZone) === focusDate,
  );
  const focusBlocks = upcomingBlocks.filter(block => localDate(block.start, state.settings.timeZone) <= focusDate && localDate(instantFromMs(instantMs(block.end) - 1), state.settings.timeZone) >= focusDate);
  const focusCapacity = dayCapacity(state, focusDate, now);
  const weekStart = addDays(date, 1 - dayOfWeek(date));
  const weekDays = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const weekCapacity = weekDays.reduce(
    (n, d) => n + dayCapacity(state, d, now).capacityMinutes,
    0,
  );
  const weekPlanned = weekDays.reduce(
    (n, d) => n + dayCapacity(state, d, now).plannedMinutes,
    0,
  );
  const waiting = active.filter((i) => i.status === "waiting");
  const unscheduled = active.filter(
    (i) =>
      i.status !== "waiting" &&
      (i.remainingMinutes === null ||
        i.remainingMinutes >
          state.sessions
            .filter((s) => s.workItemId === i.id && s.status === "planned")
            .reduce((n, s) => n + minutesBetween(s.start, s.end), 0)),
  );
  const pending = state.requests.filter((r) => r.status === "pending");
  const conflicts = active.filter(
    (i) =>
      (i.deadline && (!i.forecastDate || i.forecastDate > i.deadline)) ||
      (i.targetDate && i.forecastDate && i.forecastDate > i.targetDate),
  );
  async function command(c: WorkCommand) {
    setBusy(true);
    setNotice("");
    try {
      const operationId = crypto.randomUUID();
      const p = (
        await api<{ proposal: ScheduleProposal }>("commands", {
          commands: [c],
          operationId,
          action: "preview",
        })
      ).proposal;
      if (p.status === "ready" && !p.requiresApproval)
        update(
          (
            await api("commands", {
              commands: [c],
              operationId,
              baseVersion: p.baseVersion,
              reviewFingerprint: p.reviewFingerprint,
              action: "commit",
            })
          ).state,
        );
      else setProposal(p);
    } catch (e) {
      setNotice((e as Error).message);
      if (e instanceof ApiError && e.proposal) setProposal(e.proposal);
      if (e instanceof ApiError && e.state) update(e.state);
      throw e;
    } finally {
      setBusy(false);
    }
  }
  function navigate(direction: number) {
    if (view === "month") {
      const d = new Date(`${date.slice(0, 7)}-15T12:00:00Z`);
      d.setUTCMonth(d.getUTCMonth() + direction);
      setDate(d.toISOString().slice(0, 10));
    } else setDate(addDays(date, direction * (view === "week" ? 7 : 1)));
  }
  const nav = [
    { id: "calendar" as const, icon: CalendarDays, label: "Calendar" },
    { id: "work" as const, icon: Layers3, label: "All work" },
    { id: "requests" as const, icon: Inbox, label: "Requests" },
    { id: "updates" as const, icon: Activity, label: "Activity & email" },
    ...(owner
      ? [{ id: "notes" as const, icon: StickyNote, label: "Notes" }]
      : []),
  ];
  const dateSelectionDescription = dateSelection?.kind === "project_span"
    ? "Timeline only. No hours are reserved. Use Ask ADA, or choose Work window to book hours manually."
    : "Schedule within these dates, not on every day. Capacity checks still apply.";
  const dateSelectionActions = (
    <DateSelectionActions
      selection={dateSelection}
      owner={owner}
      onChange={setDateSelection}
      onCancel={cancelDateSelection}
      onAddWork={() => {
        if (!dateSelection || dateSelection.kind !== "work_window") return;
        setFormDates({ start: dateSelection.start, end: dateSelection.end });
        setSelectedId(null);
        setEditing(false);
        setForm(true);
      }}
      onAskAda={() => {
        setDateSelectionModal(false);
        setSelectingDates(false);
        setAssistant(true);
      }}
    />
  );
  return (
    <div className="app-shell">
      {mobileNav && (
        <button
          className="nav-scrim"
          aria-label="Close navigation"
          onClick={() => setMobileNav(false)}
        />
      )}
      <aside className={`sidebar ${mobileNav ? "nav-open" : ""}`}>
        <Link className="brand" href="/" aria-label="ADA Calendar home">
          <BrandLogo variant="sidebar" />
          <span className="brand-product">ADA CALENDAR</span>
        </Link>
        <div className="workspace-label">
          <span className="online-dot" />
          Agency workspace
          <LockKeyhole size={11} />
        </div>
        <nav>
          {nav.map((n) => (
            <button
              key={n.id}
              className={`nav-item ${section === n.id ? "selected" : ""}`}
              onClick={() => {
                if (n.id === "notes") setNotesVisited(true);
                setSection(n.id);
                setMobileNav(false);
              }}
            >
              <n.icon size={17} />
              {n.label}
              {n.id === "requests" && pending.length > 0 && (
                <span className="count">{pending.length}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-section">
          <p className="eyebrow">THE FOUR HATS</p>
          {(Object.keys(CATEGORY_LABELS) as Category[]).map((c) => (
            <button
              key={c}
              className={`category-filter ${categories.includes(c) ? "" : "filter-off"}`}
              onClick={() =>
                setCategories(
                  categories.includes(c)
                    ? categories.filter((x) => x !== c)
                    : [...categories, c],
                )
              }
            >
              <span className={`category-check category-${c}`}>
                {categories.includes(c) && <Check size={10} />}
              </span>
              {CATEGORY_LABELS[c]}
              <span>{active.filter((i) => i.category === c).length}</span>
            </button>
          ))}
        </div>
        <div className="sidebar-section clients-nav">
          <div className="sidebar-section-title">
            <p className="eyebrow">CLIENTS</p>
            {owner && (
              <button
                className="icon-button"
                aria-label="Manage clients"
                onClick={() => setSettings(true)}
              >
                <Plus size={13} />
              </button>
            )}
          </div>
          <button
            className={`client-filter ${!client ? "active" : ""}`}
            onClick={() => setClient("")}
          >
            <span className="client-dot" />
            All clients
          </button>
          {sortClientsByName(state.clients).map((c) => (
            <button
              title={c.name}
              className={`client-filter ${client === c.id ? "active" : ""}`}
              key={c.id}
              onClick={() => setClient(client === c.id ? "" : c.id)}
            >
              <span className="client-initial">{c.name[0]}</span>
              {c.name}
            </button>
          ))}
        </div>
        <div className="sidebar-bottom">
          {owner && (
            <button className="nav-item" onClick={() => setSettings(true)}>
              <Settings2 size={16} />
              Workspace settings
            </button>
          )}
          <button className="nav-item" onClick={() => setHelp(true)}>
            <CircleHelp size={16} />
            How this works
          </button>
          <div className="profile">
            <span className="avatar">{state.actor.name[0]}</span>
            <div>
              <strong>{state.actor.name}</strong>
              <small>
                {owner ? "Your time, protected" : `${state.actor.role} access`}
              </small>
            </div>
            {state.mode === "live" && (
              <button
                aria-label="Sign out"
                className="icon-button"
                onClick={async () => {
                  await api("auth/logout", {});
                  window.location.reload();
                }}
              >
                <ArrowUpRight size={15} />
              </button>
            )}
          </div>
        </div>
      </aside>
      <main className="workspace-main">
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="icon-button mobile-only"
              aria-label="Open navigation"
              onClick={() => setMobileNav(true)}
            >
              <Menu size={19} />
            </button>
            <span>Workspace</span>
            <ChevronRight size={13} />
            <strong>{nav.find((n) => n.id === section)?.label}</strong>
          </div>
          <div className="topbar-right">
            <span className="work-hours">
              <span className="online-dot" />
              9–5 · Monday–Friday
            </span>
            {state.mode === "demo" && (
              <label className="demo-switch">
                <span>SAMPLE PREVIEW</span>
                <select
                  aria-label="Preview as"
                  value={state.actor.id}
                  onChange={async (e) => {
                    await api("demo/actor", { id: e.target.value });
                    window.location.reload();
                  }}
                >
                  <option value="bryan">Bryan · owner</option>
                  <option value="kyle">Kyle · requester</option>
                  <option value="william">William · requester</option>
                  <option value="viewer">Teammate · viewer</option>
                </select>
              </label>
            )}
          </div>
        </header>
        <div ref={stickyHeaderRef} className={section === "calendar" ? "calendar-sticky-header" : undefined}>
          <div className="page-heading">
            <div>
              <p className="eyebrow">A LITTLE CLARITY GOES A LONG WAY</p>
              <h1>
                {section === "calendar"
                  ? owner
                    ? "Your plate, at a glance."
                    : "Bryan’s plate, at a glance."
                  : section === "work"
                    ? "Everything on the plate."
                    : section === "requests"
                      ? "Make room, thoughtfully."
                      : section === "notes"
                        ? "A place for your notes."
                        : "Everyone in the loop."}
              </h1>
              <p className="muted">
                {section === "calendar"
                  ? "The big picture. The focus time. Room for the unexpected."
                  : section === "work"
                    ? "Projects, batches, and the work that happens in between."
                    : section === "requests"
                      ? "Clean-fit work books directly. Changing commitments needs Bryan’s say."
                      : section === "notes"
                        ? "Lists, ideas, and details to come back to. Each note stays separate."
                        : "Committed changes, client updates, and the emails that keep everyone informed."}
              </p>
            </div>
            <div className="heading-actions">
              {state.actor.role !== "viewer" && section !== "notes" && (
                <>
                  <button
                    className="secondary"
                    disabled={assistantDraft.busy}
                    onClick={() => requestDateSelection()}
                  >
                    <CalendarDays size={16} />
                    Select dates
                  </button>
                  <button
                    className="secondary assistant-trigger"
                    onClick={() => {
                      setSelectingDates(false);
                      setAssistant(true);
                    }}
                  >
                    <Sparkles size={16} />
                    Ask ADA
                  </button>
                  <button
                    className="primary"
                    onClick={() => {
                      setFormDates(null);
                      setEditing(false);
                      setForm(true);
                    }}
                  >
                    <Plus size={17} />
                    {owner ? "Add work" : "Request work"}
                  </button>
                  {owner && <button className="secondary" onClick={() => setBlock({ date: dateSelection?.start ?? date })}>
                    <CalendarClock size={16} />Add meeting
                  </button>}
                </>
              )}
            </div>
          </div>
          {owner &&
            section !== "notes" &&
            state.aiUsageUsd >= state.settings.aiWarningUsd && (
              <div className="budget-note" role="status">
                <Sparkles size={16} />
                <span>
                  AI allowance: ${state.aiUsageUsd.toFixed(2)} of $
                  {state.settings.aiLimitUsd.toFixed(2)} this month (including
                  reserved calls).{" "}
                  {state.aiUsageUsd >= state.settings.aiLimitUsd
                    ? "New AI calls are paused."
                    : "Approaching your pause threshold."}{" "}
                  Manual scheduling remains available.
                </span>
                <button className="text-button" onClick={() => setSettings(true)}>
                  Manage allowance
                </button>
              </div>
            )}
          {section !== "notes" && (
            <div className="summary-strip">
              <div>
                <span className="summary-icon">
                  <Layers3 size={17} />
                </span>
                <span>
                  <strong>{active.length}</strong>active projects
                </span>
              </div>
              <div>
                <span className="summary-icon">
                  <Clock3 size={17} />
                </span>
                <span>
                  <strong>
                    {formatHours(weekPlanned)}
                    <small> / {formatHours(weekCapacity)}</small>
                  </strong>
                  planned this week
                </span>
                <div className="tiny-capacity">
                  <i
                    style={{
                      width: `${Math.min(100, (weekPlanned / (weekCapacity || 1)) * 100)}%`,
                    }}
                  />
                </div>
              </div>
              <button
                onClick={() => {
                  setSection("work");
                  setSearch("");
                }}
              >
                <span className="summary-icon">
                  <ArrowDownLeft size={17} />
                </span>
                <span>
                  <strong>{waiting.length}</strong>waiting on input
                </span>
              </button>
              <button onClick={() => setSection("requests")}>
                <span className="summary-icon">
                  <Inbox size={17} />
                </span>
                <span>
                  <strong>{pending.length}</strong>pending requests
                </span>
              </button>
            </div>
          )}
        </div>
        {owner && notesVisited && (
          <div className="notes-section" hidden={section !== "notes"}>
            <NotesPanel
              key={`${state.workspaceId}:${state.actor.id}:${state.actor.role}`}
              actorId={state.actor.id}
            />
          </div>
        )}
        <div
          className="content-columns"
          style={section === "notes" ? { display: "none" } : undefined}
        >
          <div className="primary-column">
            {(section === "calendar" || section === "work") && (
              <div ref={calendarToolbarRef} className={`calendar-toolbar${section === "calendar" ? " calendar-toolbar-sticky" : ""}`}>
                <div className="date-navigation">
                  <h2>
                    {dateLabel(date, {
                      month: "long",
                      ...(view === "day" ? { day: "numeric" } : {}),
                      year: "numeric",
                    })}
                  </h2>
                  <button
                    className="icon-button"
                    aria-label="Previous period"
                    onClick={() => navigate(-1)}
                  >
                    <ChevronLeft size={17} />
                  </button>
                  <button
                    className="icon-button"
                    aria-label="Next period"
                    onClick={() => navigate(1)}
                  >
                    <ChevronRight size={17} />
                  </button>
                  <button
                    className="today-button"
                    onClick={() => setDate(today)}
                  >
                    Today
                  </button>
                </div>
                {section === "calendar" ? (
                  <div className="view-switch" aria-label="Calendar view">
                    {(["month", "week", "day", "agenda"] as CalendarView[]).map(
                      (v) => (
                        <button
                          className={view === v ? "active" : ""}
                          key={v}
                          disabled={selectingDates && v !== "month"}
                          onClick={() => {
                            if (v === "day" && view !== "day") setDate(today);
                            setView(v);
                          }}
                        >
                          {v}
                        </button>
                      ),
                    )}
                  </div>
                ) : (
                  <div className="search-field">
                    <Search size={15} />
                    <input
                      aria-label="Search work"
                      placeholder="Search work or clients…"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                    />
                  </div>
                )}
              </div>
            )}
            {section === "calendar" && (
              <>
                {showDateSelectionToolbar && (
                  <div ref={dateSelectionToolbarRef} className="date-selection-toolbar">
                    <div aria-live="polite">
                      <p className="eyebrow">SELECTED DATES</p>
                      <strong>
                        {dateSelection
                          ? selectedDatesLabel(dateSelection)
                          : "Choose a day on the calendar"}
                      </strong>
                      <p className="micro muted">
                        {selectionAnchor
                          ? "Choose a second day for a range, or add work or ask ADA about this day."
                          : dateSelection
                            ? "Your range is selected. Another click starts a new range."
                            : "Click once for one day, then another day for a range. You can move between months."}
                      </p>
                      <p className="micro muted">
                        {dateSelectionDescription}
                      </p>
                    </div>
                    {dateSelectionActions}
                  </div>
                )}
                <CalendarBookingMove
                  state={state}
                  selection={calendarMoveSelection}
                  onClose={() => setCalendarMoveSelection(null)}
                  onInteractionLockChange={setCalendarMoveLocked}
                  onState={next => setState(current => next.workspaceId === current.workspaceId && next.actor.id === current.actor.id && next.actor.role === current.actor.role && next.version >= current.version ? next : current)}
                />
                <CalendarContent
                  state={state}
                  date={date}
                  items={calendarItems}
                  view={view}
                  onSelect={setSelectedId}
                  onSelectBlock={id => {
                    const existing = state.blocks.find(block => block.id === id);
                    if (existing) setBlock({ date: localDate(existing.start, state.settings.timeZone), existing });
                  }}
                  selectingDates={selectingDates}
                  dateSelection={selectingDates ? dateSelection : null}
                  onDate={pickDate}
                  onMoveBookings={owner ? setCalendarMoveSelection : undefined}
                  movingBookings={calendarMoveLocked || !!calendarMoveSelection || busy || dateSelectionModal || form || !!selected || findingTime || assistant || settings || help || !!proposal || !!requestId || !!block || confirmNewSelection || mobileNav}
                  onCommand={async (c) => {
                    try {
                      await command(c);
                    } catch {}
                  }}
                />
                <div className="calendar-legend">
                  <span>
                    <i className="legend-span" />
                    Project span · no time reserved
                  </span>
                  <span>
                    <i className="legend-session" />
                    Scheduled work
                  </span>
                  <span>
                    <LockKeyhole size={12} />
                    Protected focus
                  </span>
                  <span><CalendarClock size={12} />Meetings &amp; time off · fixed time</span>
                  <button className="text-button" onClick={() => setHelp(true)}>
                    Reading this calendar <CircleHelp size={12} />
                  </button>
                </div>
              </>
            )}
            {section === "work" && (
              <div className="all-work">
                {filtered.length ? (
                  <>
                    <div className="work-table-head">
                      <span>Project / client</span>
                      <span>Status</span>
                      <span>Remaining</span>
                      <span>Target</span>
                    </div>
                    {filtered.map((i) => (
                      <button
                        key={i.id}
                        className="work-table-row"
                        onClick={() => setSelectedId(i.id)}
                      >
                        <span>
                          <span
                            className={`category-dot category-${i.category}`}
                          />
                          <span>
                            <strong>{i.title}</strong>
                            <small>
                              {
                                state.clients.find((c) => c.id === i.clientId)
                                  ?.name
                              }
                            </small>
                          </span>
                        </span>
                        <span className="status-pill">
                          {i.status.replace("_", " ")}
                        </span>
                        <span>
                          {i.remainingMinutes === null
                            ? "Hours added as needed"
                            : formatHours(i.remainingMinutes)}
                        </span>
                        <span>
                          {i.targetDate ? dateLabel(i.targetDate) : "Flexible"}
                        </span>
                      </button>
                    ))}
                  </>
                ) : (
                  <Empty title="Nothing in this view">
                    Adjust the category, client, or search filters.
                  </Empty>
                )}
              </div>
            )}
            {section === "requests" && (
              <div className="requests-list">
                {!state.requests.length ? (
                  <Empty title="All clear for now">
                    Requests that would move existing work appear here.
                    Clean-fit bookings go straight onto the calendar.
                  </Empty>
                ) : (
                  state.requests.map((r) => (
                    <article className="request-card" key={r.id}>
                      <div className="request-top">
                        <span className="avatar">{r.requesterName[0]}</span>
                        <div>
                          <strong>
                            {r.proposal.commands.find(
                              (c) => c.type === "create",
                            )?.item.title || "Scheduling request"}
                          </strong>
                          <small>
                            {r.requesterName} ·{" "}
                            {dateLabel(
                              localDate(r.createdAt, state.settings.timeZone),
                            )}
                          </small>
                        </div>
                        <span className="status-pill">
                          {r.status.replace("_", " ")}
                        </span>
                      </div>
                      {r.note && <p>{r.note}</p>}
                      {r.proposal.conflicts.map((c, i) => (
                        <p className="conflict-line" key={i}>
                          {c.message}
                        </p>
                      ))}
                      {r.proposal.summary.map((s, i) => (
                        <p className="muted" key={i}>
                          {s}
                        </p>
                      ))}
                      {["pending", "needs_information"].includes(r.status) && (
                        <RequestAttachments
                          state={state}
                          request={r}
                          onState={update}
                        />
                      )}
                      {owner &&
                        ["pending", "needs_information"].includes(r.status) && (
                          <button
                            className="secondary"
                            onClick={() => setRequestId(r.id)}
                          >
                            Review with current schedule
                            <ArrowUpRight size={14} />
                          </button>
                        )}
                    </article>
                  ))
                )}
              </div>
            )}
            {section === "updates" && (
              <div className="updates-content">
                {state.emailDrafts
                  .filter((d) => d.status === "draft")
                  .map((d) => (
                    <DraftCard key={d.id} draft={d} onState={update} />
                  ))}
                <h3>Workspace activity</h3>
                {state.events.length ? (
                  state.events.map((e) => (
                    <div className="activity-line" key={e.id}>
                      <span className="activity-dot" />
                      <div>
                        <p>{e.summary.join(" ")}</p>
                        <small>
                          {e.actorName} ·{" "}
                          {new Date(e.createdAt).toLocaleString("en-US", {
                            timeZone: state.settings.timeZone,
                          })}
                          {e.undoneBy ? " · reversed" : ""}
                        </small>
                      </div>
                      {owner && !e.undoneBy && e.version === state.version && (
                        <button
                          className="text-button"
                          onClick={async () => {
                            try {
                              update((await api("undo", { id: e.id })).state);
                            } catch (error) {
                              setNotice((error as Error).message);
                            }
                          }}
                        >
                          <Undo2 size={13} />
                          Undo
                        </button>
                      )}
                    </div>
                  ))
                ) : (
                  <p className="muted">No committed changes yet.</p>
                )}
                <h3>
                  Email delivery{" "}
                  {state.mode === "demo" && (
                    <span className="status-pill">Captured · never sent</span>
                  )}
                </h3>
                <p className="micro muted">
                  Both Kyle and William receive each committed work update.
                  Drafts and previews send nothing.
                </p>
                {state.notifications.length ? (
                  state.notifications.map((n) => (
                    <details className="notification-card" key={n.id}>
                      <summary>
                        <Mail size={16} />
                        <span>
                          {n.subject}
                          <small>
                            To {n.recipientName} · {n.recipient}
                          </small>
                        </span>
                        <span
                          className={`delivery-status delivery-${n.status}`}
                        >
                          {n.status}
                        </span>
                      </summary>
                      <pre>{n.body}</pre>
                      {n.lastError && <p className="error">{n.lastError}</p>}
                    </details>
                  ))
                ) : (
                  <Empty title="No email events yet">
                    Save a work change to see its captured notifications here.
                  </Empty>
                )}
              </div>
            )}
          </div>
          <aside className="right-panel">
            <div className="focus-heading">
              <p className="eyebrow">
                {focusDate === today ? "TODAY’S FOCUS" : "UP NEXT"}
              </p>
              <span>
                {dateLabel(focusDate, { weekday: "short", day: "numeric" })}
              </span>
            </div>
            <h2>One thing at a time.</h2>
            <p className="muted small">
              Your work and meetings for{" "}
              {focusDate === today ? "today" : dateLabel(focusDate)}.
            </p>
            <div className="focus-capacity">
              <div>
                <strong>
                  {formatHours(focusCapacity.plannedMinutes)}
                  <span> planned</span>
                </strong>
                <small>
                  {formatHours(focusCapacity.availableMinutes)} open
                </small>
              </div>
              <div className="capacity-meter">
                <i
                  style={{
                    width: `${Math.min(100, (focusCapacity.plannedMinutes / (focusCapacity.capacityMinutes || 1)) * 100)}%`,
                  }}
                />
              </div>
            </div>
            <div className="focus-list">
              {[...focusBlocks, ...nextSessions].sort((a, b) => instantMs(a.start) - instantMs(b.start)).map((s, i) => {
                if ("kind" in s) return <button className="focus-card focus-meeting" key={`block-${s.id}`} onClick={() => setBlock({ date: focusDate, existing: s })}>
                  <div className="focus-card-top"><span>{localDate(s.start, state.settings.timeZone) < focusDate ? "Continues" : timeLabel(s.start, state.settings.timeZone)} — {localDate(s.end, state.settings.timeZone) > focusDate ? dateLabel(localDate(s.end, state.settings.timeZone)) : timeLabel(s.end, state.settings.timeZone)}</span><CalendarClock size={14} /></div>
                  <strong>{s.title}</strong><small>{s.kind === "meeting" ? "Meeting · fixed time" : "Time off · unavailable"}</small>
                </button>;
                const item = state.items.find((w) => w.id === s.workItemId);
                if (!item) return null;
                return (
                  <button
                    className={`focus-card category-${item.category}`}
                    key={s.id}
                    onClick={() => setSelectedId(item.id)}
                  >
                    <div className="focus-card-top">
                      <span>
                        {timeLabel(s.start, state.settings.timeZone)} —{" "}
                        {timeLabel(s.end, state.settings.timeZone)}
                      </span>
                      {s.protected && <LockKeyhole size={12} />}
                    </div>
                    <strong>{item.title}</strong>
                    <small>
                      {state.clients.find((c) => c.id === item.clientId)?.name}
                    </small>
                    <div className="focus-card-bottom">
                      <span>{CATEGORY_LABELS[item.category]}</span>
                      <span>
                        {i === 0
                          ? "Up first"
                          : formatHours(minutesBetween(s.start, s.end))}
                        <ArrowUpRight size={13} />
                      </span>
                    </div>
                  </button>
                );
              })}
              {!nextSessions.length && !focusBlocks.length && (
                <p className="muted">No upcoming sessions reserved.</p>
              )}
            </div>
            <div className="reserve-card">
              <Coffee size={18} />
              <div>
                <strong>
                  {state.settings.reserveMinutes > 0
                    ? "Room for the unexpected"
                    : "No automatic buffer"}
                </strong>
                <p>
                  {state.settings.reserveMinutes > 0
                    ? `${formatHours(state.settings.reserveMinutes)} reserved each workday. Only Bryan can use this time.`
                    : "All working hours after lunch are available. Add unexpected work when it comes up."}
                </p>
              </div>
            </div>
            {owner && (
              <button
                className="text-button add-block"
                onClick={() => setBlock({ date })}
              >
                <Plus size={14} />
                Add meeting or time off
              </button>
            )}
            {conflicts.length > 0 && (
              <div className="side-list">
                <h3>
                  Dates need attention <span>{conflicts.length}</span>
                </h3>
                {conflicts.slice(0, 4).map((i) => (
                  <button key={i.id} onClick={() => setSelectedId(i.id)}>
                    <span className="warning-dot" />
                    <span>
                      {i.title}
                      <small>
                        {i.deadline
                          ? "Firm deadline needs a valid plan"
                          : "Forecast is past target"}
                      </small>
                    </span>
                    <ArrowUpRight size={14} />
                  </button>
                ))}
              </div>
            )}
            <div className="side-list">
              <h3>
                Hours to plan <span>{unscheduled.length}</span>
              </h3>
              {unscheduled.slice(0, 3).map((i) => (
                <button key={i.id} onClick={() => setSelectedId(i.id)}>
                  <span className={`category-dot category-${i.category}`} />
                  <span>
                    {i.title}
                    <small>
                      {i.remainingMinutes === null
                        ? "Hours added as needed"
                        : `${formatHours(i.remainingMinutes)} remaining`}
                    </small>
                  </span>
                  <ArrowUpRight size={14} />
                </button>
              ))}
              <p className="micro muted">
                Open time reflects known sessions. These commitments may still
                need hours.
              </p>
            </div>
            {waiting.length > 0 && (
              <div className="side-list">
                <h3>
                  Waiting on input <span>{waiting.length}</span>
                </h3>
                {waiting.map((i) => (
                  <button key={i.id} onClick={() => setSelectedId(i.id)}>
                    <Clock3 size={14} />
                    <span>
                      {i.title}
                      <small>{i.blockedReason}</small>
                    </span>
                  </button>
                ))}
              </div>
            )}
            <div className="healthy-hours">
              <span className="online-dot" />
              <p>
                Good work. Healthy hours.
                <br />
                <small>Capacity is a boundary, not a challenge.</small>
              </p>
            </div>
          </aside>
        </div>
        {notice && (
          <div className="toast" role="status">
            <CheckCircle2 size={17} />
            <span>{notice.message}</span>
            {owner &&
              state.events[0]?.version === state.version &&
              !state.events[0]?.undoneBy && (
                <button
                  onClick={async () => {
                    try {
                      update(
                        (await api("undo", { id: state.events[0].id })).state,
                      );
                    } catch (e) {
                      setNotice((e as Error).message);
                    }
                  }}
                >
                  Undo
                </button>
              )}
            <button
              aria-label="Dismiss notification"
              onClick={() => setNotice("")}
            >
              <X size={15} />
            </button>
          </div>
        )}
      </main>
      <WorkspaceChat
        key={`helper-${state.workspaceId}-${state.actor.id}-${state.actor.role}`}
        state={state}
        onState={next => setState(current => next.workspaceId === current.workspaceId && next.actor.id === current.actor.id && next.actor.role === current.actor.role && next.version >= current.version ? next : current)}
        hidden={dateSelectionModal || form || !!selected || findingTime || assistant || settings || help || !!proposal || !!requestId || !!block || confirmNewSelection || mobileNav || !!calendarMoveSelection}
      />
      <Modal
        open={dateSelectionModal && selectingDates && !form}
        onClose={cancelDateSelection}
        title="Selected dates"
        description="Add work or ask ADA about your selection."
        wide
      >
        <div className="date-selection-modal">
          <div className="date-selection-summary">
            <CalendarDays size={22} aria-hidden="true" />
            <div>
              <strong>{dateSelection ? selectedDatesLabel(dateSelection) : "Choose a day"}</strong>
              <p className="micro muted">{dateSelectionDescription}</p>
            </div>
          </div>
          <button className="text-button" onClick={() => setDateSelectionModal(false)}>
            Change dates on calendar
          </button>
          {dateSelectionActions}
        </div>
      </Modal>
      <Modal
        open={form}
        onClose={() => setForm(false)}
        title={
          editing
            ? "Edit details"
            : owner
              ? "Make room for new work"
              : "Find an opening"
        }
        description="Choose days and hours, or keep an ongoing project visible."
        wide
      >
        <WorkForm
          key={`${form}-${editing}-${selectedId}`}
          state={state}
          date={!editing && formDates ? formDates.start : date}
          endDate={!editing ? formDates?.end : undefined}
          existing={editing ? selected : undefined}
          onSaved={update}
          onCommitted={() => {
            if (!editing && formDates) {
              cancelDateSelection();
              setFormDates(null);
            }
          }}
          onClose={() => setForm(false)}
          onFindTime={editing ? () => { setForm(false); setFindingTime(true); } : undefined}
        />
      </Modal>
      <Modal
        open={!!selected && !form && !findingTime}
        onClose={() => setSelectedId(null)}
        title={selected?.title || "Work details"}
        wide
      >
        {selected && (
          <WorkDetails
            key={`${selected.id}-${selected.updatedAt}`}
            item={selected}
            state={state}
            onState={update}
            onEdit={() => {
              setEditing(true);
              setForm(true);
            }}
            onCommand={command}
          />
        )}
      </Modal>
      <Modal open={!!selected && findingTime} onClose={() => setFindingTime(false)} title={selected ? `Add hours · ${selected.title}` : "Add hours"} wide>
        {selected && <SessionManager key={selected.id} item={selected} state={state} onSaved={update} onClose={() => setFindingTime(false)} />}
      </Modal>
      <Modal
        open={confirmNewSelection}
        onClose={() => setConfirmNewSelection(false)}
        title="Start a new instruction?"
      >
        <p>
          Your current ADA draft or follow-up is still open. Starting a new date
          selection will clear that unsent conversation; saved work will not
          change.
        </p>
        <div className="form-actions">
          <button
            className="secondary"
            onClick={() => {
              setConfirmNewSelection(false);
              setAssistant(true);
            }}
          >
            Keep current instruction
          </button>
          <button className="primary" onClick={() => beginDateSelection(pendingSelectionDate ?? undefined)}>
            Start a new instruction
          </button>
        </div>
      </Modal>
      <Modal
        open={assistant}
        onClose={() => {
          if (!assistantDraft.busy) setAssistant(false);
        }}
        title="Ask ADA"
        description="Less organizing. More room to work."
        wide
      >
        <AssistantPanel
          key={`${state.workspaceId}-${state.actor.id}`}
          state={state}
          draft={assistantDraft}
          onDraft={setAssistantDraft}
          dateSelection={dateSelection}
          onDateSelection={setDateSelection}
          onState={(next) => {
            update(next);
            if (next.emailDrafts.some((d) => d.status === "draft"))
              setSection("updates");
          }}
        />
      </Modal>
      <Modal
        open={settings}
        onClose={() => setSettings(false)}
        title="Workspace settings"
        wide
      >
        <SettingsPanel
          key={settings ? "open" : "closed"}
          state={state}
          onState={update}
        />
      </Modal>
      <Modal
        open={!!proposal}
        onClose={() => {
          setProposal(null);
          setRequestId(null);
        }}
        title="Schedule impact"
        wide
      >
        {proposal && (
          <>
            <ProposalCard
              proposal={proposal}
              state={state}
              busy={busy}
              onCommit={async (request) => {
                setBusy(true);
                try {
                  update(
                    (
                      await api("commands", {
                        commands: proposal.commands,
                        operationId: proposal.operationId,
                        baseVersion: proposal.baseVersion,
                        reviewFingerprint: proposal.reviewFingerprint,
                        action: request ? "request" : "commit",
                      })
                    ).state,
                  );
                  setProposal(null);
                  setRequestId(null);
                } catch (e) {
                  setNotice((e as Error).message);
                  if (e instanceof ApiError && e.proposal)
                    setProposal(e.proposal);
                  if (e instanceof ApiError && e.state) update(e.state);
                } finally {
                  setBusy(false);
                }
              }}
            />
          </>
        )}
      </Modal>
      <Modal
        open={!!requestId}
        onClose={() => setRequestId(null)}
        title="Review priority request"
        wide
      >
        {state.requests.find((r) => r.id === requestId) && (
          <RequestReview
            key={requestId}
            state={state}
            request={state.requests.find((r) => r.id === requestId)!}
            onState={update}
            onClose={() => setRequestId(null)}
          />
        )}
      </Modal>
      {block && <MeetingForm
        key={`${state.workspaceId}:${state.actor.id}:${block.existing?.id ?? "new"}`}
        state={state}
        date={block.date}
        existing={block.existing}
        onSaved={next => setState(current => next.version >= current.version ? next : current)}
        onCommitted={(next, date) => { update(next); setDate(date); }}
        onClose={() => setBlock(null)}
      />}
      <Modal
        open={help}
        onClose={() => setHelp(false)}
        title="A calendar for actual capacity"
      >
        <div className="help-content">
          <h3>Thin spans. Real focus.</h3>
          <p>
            A faded ribbon means the project is on Bryan’s plate. The thicker
            segments show the days with actual reserved hours. Switch to Week or
            Day for exact times. A lock marks protected work.
          </p>
          <h3>Work fits inside the workday.</h3>
          <p>
            Lunch, meetings, time off, and the unexpected-work reserve reduce
            available time. New requester work books only if the entire request
            fits without moving other commitments. Otherwise Bryan decides.
          </p>
          <h3>Meetings reserve their exact time.</h3>
          <p>
            Use Add meeting for a client call or time off. Enter the date and
            start/end times, preview any affected work, then confirm. Meetings
            appear in every calendar view and new work fits around them. Open
            a meeting to change or remove it.
          </p>
          <h3>Updates stay visible.</h3>
          <p>
            Every committed addition, edit, completion, and recorded client
            update produces an email to Kyle and William. Previewing a schedule
            or drafting a message produces none. Undo creates a corrective
            update; it cannot recall an email.
          </p>
          <h3>Your instructions, safely interpreted.</h3>
          <p>
            Type or record an instruction with the client, effort, dates, and
            priority. Review the transcript before sending. Clear commands can
            save automatically; unclear references ask for clarification. Only
            Bryan can authorize changes to protected work.
          </p>
          {state.mode === "demo" && (
            <p className="demo-note">
              You are exploring fictional sample work. No real messages are
              sent. The role selector exists only in local development and is
              unavailable in production.
            </p>
          )}
        </div>
      </Modal>
    </div>
  );
}
