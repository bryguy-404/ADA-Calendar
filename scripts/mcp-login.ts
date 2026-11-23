import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { CalendarReadError } from "../src/lib/mcp/projection";
import { saveSession, signIn } from "../src/lib/mcp/client";

async function main() {
  const file = process.env.ADA_CALENDAR_SESSION_FILE;
  if (!file || !process.stdin.isTTY) throw new CalendarReadError("interactive_login_required", "Run mcp:login in your own terminal with an absolute ADA_CALENDAR_SESSION_FILE. The parent directory must already exist and be private.");
  const origin = process.env.ADA_CALENDAR_URL || "https://ada-calendar-production.up.railway.app";
  const emailPrompt = createInterface({ input: process.stdin, output: process.stderr });
  const email = await emailPrompt.question(`Calendar sign-in (${origin})\nEmail: `); emailPrompt.close();
  const silent = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const passwordPrompt = createInterface({ input: process.stdin, output: silent, terminal: true });
  // Enable terminal raw input before displaying the prompt: fast input must never
  // arrive while the terminal still has kernel echo enabled.
  const passwordAnswer = passwordPrompt.question("");
  process.stderr.write("Password (hidden): ");
  const password = await passwordAnswer; passwordPrompt.close(); process.stderr.write("\n");
  const session = await signIn(origin, email.trim(), password, process.env.ADA_CALENDAR_ALLOW_LOCAL === "1");
  await saveSession(file, session);
  console.error("Signed in. A private refreshable Calendar session was saved; your password was not saved. Treat this file like a password. Your existing Calendar role controls which MCP actions are permitted.");
}
main().catch(error => { console.error(error instanceof CalendarReadError ? error.message : "Sign-in failed. Check the Calendar connection and private session file location."); process.exitCode = 1; });
