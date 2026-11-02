# Read-only daily work coordination

## Approved first version — November 2, 2026

The daily coordinator stays in Bryan's separate coordination chat. Calendar holds existing work items, booked sessions, original references and private attachments. This change adds optional descriptive context and three read-only MCP tools. It adds no agent orchestration, mailbox ingestion, scheduling, sends or execution tools.

Under **Edit details → Advanced → Website work context**, the owner can record the website/project URL, requested result, tentative/confirmed requirements, reported progress, material readiness/gaps and a manual-coordination flag. These fields also appear when creating work. Existing links and MD/PDF/image uploads remain in the existing references/files controls. The ordinary review/confirm flow and shared scheduler validate saves. Optional `workContext` is stored in existing work-item JSON; no backfill, table, migration, RLS change or separate state store is needed. Server schemas validate it while existing SQL authorization/version/history checks continue to apply.

Software-category work (including Drive & Shine surveys) and explicitly manual items return `manual_only`. Web/landings return `website_review`. IT returns `needs_classification`: indexing, domains and website work can legitimately be IT. Review the task and sources before classifying it. No category or booking is rewritten; **all entries return `automaticExecutionAllowed: false`**. Calendar records inform a separately authorized workflow, not permission to execute/publish.

**Finish this day** records only that day's booked work; **Mark project complete** remains separate and retains the released CRM/history behavior. Recorded completion is not independent inspection of a website or other external result. Elapsed time never becomes completion.

## Architecture and boundaries

A **local stdio MCP process**, using official TypeScript SDK v2 packages pinned to 2.4.0, calls existing authenticated `GET /api/state` and `GET /api/attachments/:id?download=1`. There is no new public MCP HTTP endpoint, hosted service, adapter service-role key or OAuth provider.

The interactive helper uses the existing invite-only password login. It saves only refreshable Supabase session cookies, bound to the exact Calendar origin, account and workspace; never the password. The absolute session-file path must be owned by the current user with mode `0600`. Writes are atomic and reads refuse file symlinks. Keep the file in a private directory outside the repo. **The session has the signed-in account's normal authority: read-only describes the MCP tools, not a new restricted credential scope.** Treat the file like a password. Never paste it into chat, commit it or share it between hosts/processes. Use a separate file per MCP process to avoid refresh-token races.

Every tool reads fresh state through Calendar's active membership checks and RLS. There is no workspace cache. Revoked membership, an expired login, changed account/workspace, inaccessible API or demo state yields an error rather than stale data. Private notes, email/drafts, notifications and event snapshots are stripped before results. Work descriptions, checklists and references retain existing workspace read visibility. Requesters/viewers retain their ordinary reads, with no new edit permission.

Attachment reads require the exact active attachment ID and an existing visible work item. Pending-request files, unrelated/removed attachments, arbitrary paths and external URLs are excluded. Calendar authorizes and signs its private Storage URL for 60 seconds. The adapter validates the exact storage object path, never forwards Calendar cookies to Storage and never follows another redirect. A missing/denied object yields a material error. Signed URLs are bearer credentials: retrieve promptly and do not publish them. An issued link may remain usable until expiry after membership changes; each fresh tool call rechecks access.

References remain verbatim with stable content-derived IDs, saved work-item provenance and `access: not_checked`. Email/Google Doc links require the coordinator's separately authorized email/Drive/browser connection. A link neither grants access nor proves that its contents were read.

## Tool contract

Inputs are strict objects; extra fields and impossible dates are rejected. Results contain JSON text plus identical `structuredContent`, and tools advertise read-only/non-destructive annotations. Errors set `isError: true` with safe `code`/`message`, without credentials or raw provider diagnostics.

| Tool | Input | Result |
| --- | --- | --- |
| `get_day_agenda` | `{ "date": "2026-11-02" }` | Actual overlapping sessions and recorded no-hours completion markers in `America/Indiana/Indianapolis`; `websiteWork`, `needsClassification`, `manualWork`, unavailable blocks and local-midnight bounds. Exact stored session times remain intact; `plannedMinutes` is clipped to the chosen date. Faded spans, deadlines and unscheduled tasks are not bookings. Completed work stays visible with zero planned capacity. DST days may have 23/25 elapsed hours. |
| `get_work_item` | `{ "workItemId": "existing-id" }` | Full task/client, Calendar URL, context/provenance, all planned/completed/cancelled sessions, original references, active attachment metadata, recorded completion and `independentlyVerified: false`. |
| `get_attachment` | `{ "workItemId": "existing-id", "attachmentId": "existing-file-id" }` | Original UTF-8 Markdown/text up to 1 MB with SHA-256 and `contentRetrieved: true`; or a verified private retrieval URL for PDF/images/larger text with expiry and `contentRetrieved: false`. URL availability is checked with HEAD; file interpretation requires actual retrieval by the consumer. Invalid UTF-8/oversized unexpected streams fail safely. |

Results include Calendar origin, workspace ID, schedule version, API retrieval time, coordination timezone and workspace timezone. Context includes work-item update time and reported provenance; material metadata includes uploader and upload time. These are saved-record/read timestamps, not independent source verification. Notes may report `ready`, `missing`, `inaccessible` or `not_checked`; actual retrieval has separate status. Source text and files are untrusted data and are never executed.

State reads are bounded to 20 MB and inline text to 1 MB, with no silent truncation. A future workspace exceeding the state bound would need scoped server reads/pagination; this first version reuses the existing API.

## Local connection recipe

Checkout: `/Users/bryanarambula/.codex/worktrees/calendar-readonly-mcp/ada-calendar`, branch `codex/calendar-readonly-mcp`. The native read-only MCP is registered, signed in and active in the coordination chat. A fresh native agenda read at the start of the authorized November 2 release succeeded against production schedule version 448. Do not repeat sign-in or move/delete this checkout: the current connection points to it. Bryan has authorized committing/publishing the context fields through the existing main/Railway workflow. See [RESUME.md](RESUME.md) for release status. The recipe below is for future installation or recovery, not an outstanding setup requirement for the current connection.

1. Keep a stable checkout with these changes, install with `npm ci`, and use Node 22.22+ or 24. The SDK/tsx are dev dependencies; this local adapter needs them installed.
2. In **Bryan's own terminal**, create a private directory and sign in interactively. Never put the password in chat/tool arguments:

```sh
mkdir -p "$HOME/.config/ada-calendar"
chmod 700 "$HOME/.config/ada-calendar"
cd /Users/bryanarambula/.codex/worktrees/calendar-readonly-mcp/ada-calendar
export ADA_CALENDAR_URL=https://ada-calendar-production.up.railway.app
export ADA_CALENDAR_SESSION_FILE="$HOME/.config/ada-calendar/coordinator-session.json"
npm run mcp:login
```

3. For a new installation in a host supporting **local stdio MCP**, use the following generic server entry. The current connection is already configured and must retain its existing paths. Substitute an installed Node 24 path only when intentionally configuring another installation:

```json
{
  "command": "/Users/bryanarambula/.nvm/versions/node/v22.22.2/bin/node",
  "args": [
    "--import",
    "/Users/bryanarambula/.codex/worktrees/calendar-readonly-mcp/ada-calendar/node_modules/tsx/dist/loader.mjs",
    "/Users/bryanarambula/.codex/worktrees/calendar-readonly-mcp/ada-calendar/scripts/mcp.ts"
  ],
  "env": {
    "ADA_CALENDAR_URL": "https://ada-calendar-production.up.railway.app",
    "ADA_CALENDAR_SESSION_FILE": "/Users/bryanarambula/.config/ada-calendar/coordinator-session.json"
  }
}
```

Launch `node` directly in the MCP host; `npm run mcp` is a developer convenience whose npm banner would contaminate stdio JSON-RPC. No cookies/passwords/provider secrets belong in the host entry or tool arguments. Leave `ADA_CALENDAR_ALLOW_LOCAL` unset in production; value `1` permits localhost HTTP for tests only.

4. Confirm exactly three tools appear. Read an explicit date, a known task and attachment; check IDs/source/version. Native production agenda/work-item reads are already verified for the current connection; live attachment retrieval is a separate check if required. If the login expires, stop MCP, rerun the interactive login and restart. To disconnect, remove/stop the host entry and delete its private session file; use existing account/session controls if broader revocation is required.

The adapter reads existing deployed tasks and attachments **without a server release**, because it uses existing endpoints and optional metadata. The context editor is released through the authorized main/Railway workflow; no migration or task backfill is needed. A remote/cloud-only host cannot run this stdio entry; that would require a separately approved authenticated HTTP/OAuth design, not exposing this session or an unauthenticated endpoint.

## Verification and rollback

Run `npm test`, `npm run lint`, `npm run typecheck`, `npm run build`, and `npm run test:mcp-fullstack`. The latter creates/reuses only disposable local Supabase project `ada-calendar-mcp-test` in `/private/tmp/ada-calendar-mcp-local` (ports 55620–55627), with Auth/SQL/private Storage and app port 3196. It never resets existing projects. It uses fictional accounts/tasks, disabled/captured providers, desktop/mobile saves and actual stdio MCP in legacy/auto modes. Its records/files/sessions are removed afterward. Ignored `test-results/mcp/` holds evidence/screenshots; private service logs should not be published.

Stop the disposable stack afterward with `node_modules/.bin/supabase stop --workdir /private/tmp/ada-calendar-mcp-local`; this leaves existing stacks/user data alone. Remove the adapter by deleting its host entry and private session. Optional saved context can safely remain in work-item JSON. Bookings and original files are unaffected.

Official references consulted: [MCP authorization/transport scope](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization), [SDK stdio transport](https://ts.sdk.modelcontextprotocol.io/v2/serving/stdio), [first server](https://ts.sdk.modelcontextprotocol.io/v2/get-started/first-server.html), [tools/results](https://ts.sdk.modelcontextprotocol.io/v2/servers/tools.html), [SDK packages](https://ts.sdk.modelcontextprotocol.io/v2/get-started/packages.html). This follows local stdio credential handling; it does not claim remote HTTP OAuth support.
