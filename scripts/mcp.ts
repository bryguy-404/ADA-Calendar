import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { CalendarReadClient } from "../src/lib/mcp/client";
import { createCalendarMcpServer } from "../src/lib/mcp/server";
import { CalendarReadError } from "../src/lib/mcp/projection";

const file = process.env.ADA_CALENDAR_SESSION_FILE;
if (!file) {
  console.error("Set ADA_CALENDAR_SESSION_FILE to the private file created by mcp:login. No credentials belong in MCP tool arguments.");
  process.exitCode = 1;
} else {
  try {
    const client = new CalendarReadClient(process.env.ADA_CALENDAR_URL || "https://ada-calendar-production.up.railway.app", file, process.env.ADA_CALENDAR_ALLOW_LOCAL === "1");
    serveStdio(() => createCalendarMcpServer(client));
  } catch (error) {
    console.error(error instanceof CalendarReadError ? error.message : "Could not start Calendar MCP. Check the origin and private session configuration.");
    process.exitCode = 1;
  }
}
