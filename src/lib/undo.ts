import { isInstant, localDate } from "./time";
import { commandSchema } from "./schemas";
import type { ScheduleSnapshot, WorkActivity, WorkEvent } from "./types";
import { hasEventSnapshots } from "./work-activity";

/** Publish only the narrow completion identity from authoritative saved commands. */
export function completedDayFromCommands(commands: unknown): WorkEvent["completedDay"] {
  if (!Array.isArray(commands) || commands.length !== 1) return undefined;
  const result = commandSchema.safeParse(commands[0]);
  return result.success && result.data.type === "complete_day" ? { itemId: result.data.itemId, date: result.data.date } : undefined;
}

// Event snapshots come from both JSON files and PostgreSQL JSONB. Property order
// must not make an unchanged historical session appear to have been edited.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([,child])=>child!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([key,child])=>`${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`;
  return JSON.stringify(value);
}

/** This UI-readable check is repeated by the server and the locked SQL commit.
 * It never grants authority or replaces full restored-schedule validation. */
export function undoUnavailableReason(
  state: ScheduleSnapshot & { events: WorkActivity[] },
  event: WorkActivity,
  now: string,
): string | null {
  if (!isInstant(now)) return "The scheduling clock is unavailable. Refresh before undoing a change.";
  if (!state.events.some(candidate=>candidate.id===event.id) || event.undoneBy || event.version!==state.version)
    return "Only the latest unchanged schedule change can be undone. A newer change was saved or this change was already undone.";
  if (!hasEventSnapshots(event)) return "Refresh to check the latest change before undoing it.";
  const before=new Map(event.before.sessions.map(session=>[session.id,session]));
  const after=new Map(event.after.sessions.map(session=>[session.id,session]));
  // Only this latest day-completion event may reverse its own recorded status.
  // A changed current snapshot, unrelated history or changed source body is not
  // an eligible completion rollback, even if an event's version was retained.
  const completedDay = event.completedDay && canonical(state.items)===canonical(event.after.items)
    && canonical(state.blocks)===canonical(event.after.blocks)
    && state.sessions.length===event.after.sessions.length && event.before.sessions.length===event.after.sessions.length
    && state.sessions.every(session=>canonical(session)===canonical(after.get(session.id))) ? event.completedDay : undefined;
  for (const session of state.sessions) {
    const restored=before.get(session.id);
    if (restored && canonical(restored)===canonical(session)) continue;
    if (!isInstant(session.start)) return "A changed work session has invalid dates. Refresh and review it before undoing.";
    const reversesThisCompletion = completedDay && restored?.status==="planned" && session.status==="completed"
      && session.workItemId===completedDay.itemId && localDate(session.start,state.settings.timeZone)===completedDay.date
      && canonical({ ...restored,status:"completed" })===canonical(session);
    // Historical work stays immutable except for reversing the exact status
    // transition just recorded by this single, unchanged day completion.
    if (session.status!=="planned" && !reversesThisCompletion)
      return "Undo would change completed or cancelled work. Use a new scheduling instruction instead.";
  }
  // The server and SQL require the latest event's exact before snapshot.
  // Restoring that existing planned booking is not a new booking in the past.
  return null;
}
