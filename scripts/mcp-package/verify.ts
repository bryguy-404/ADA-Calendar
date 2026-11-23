import { CalendarReadClient } from "../../src/lib/mcp/client";
const client = new CalendarReadClient(process.env.ADA_CALENDAR_URL || "https://ada-calendar-production.up.railway.app", process.env.ADA_CALENDAR_SESSION_FILE!, process.env.ADA_CALENDAR_ALLOW_LOCAL === "1");
async function main() {
  const state = await client.state();
  const date = process.argv[2];
  if (!date) throw new Error("Supply YYYY-MM-DD for a read-only availability check.");
  const availability = await client.scheduling("availability", { startDate: date, endDate: date });
  console.log(JSON.stringify({ actor: state.actor, workspaceId: state.workspaceId, availability }, null, 2));
}
main().catch(() => { console.error("Verification failed. Check the date, sign in again, and confirm your active Calendar membership."); process.exitCode = 1; });
