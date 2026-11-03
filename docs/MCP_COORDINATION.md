# Daily work context coordination

## Scoped writes — November 3, 2026

Bryan authorized owner-authenticated context updates and safe waiting-reason edits. `update_task_context` is the only write tool. It calls `POST /api/task-context`, which validates an allowlisted patch, builds a dedicated `context_update` command through the shared scheduler, and commits under the existing workspace lock/version/event ledger. Migration `202611030001_task_context.sql` adds a narrow RPC that updates task JSON and the audit ledger without writing sessions, blocks, settings or notifications. CRM receives its existing change-feed projection without stakeholder email. Other save/notification behavior is unchanged.

Allowed fields are `title`, `description`, `references`, `blockedReason`, and partial `workContext`: `websiteUrl`, `projectUrl`, `requestedResult`, `requirementsStatus`, `requirementsNote`, `progressNote`, `materialsStatus`, `materialsNote`, `manualOnly`. Omitted fields (including nested context/manual flags) are preserved. Strings may be cleared with `""`, references with `[]`, and the waiting reason with `null`. References are an explicit replacement array, so retain existing source references when adding one. `blockedReason` may be edited only while the task is already waiting. No status, effort, progress-counter, checklist-completion, client identity, priority, date, booking, attachment or email changes are accepted.

First read `get_work_item`; use its `source.workspaceId` and `source.scheduleVersion` for `workspaceId` and `baseVersion`. Choose one UUID `operationId` per intended save. The exact patch is the authorized intended change; no additional blanket confirmation is added. Source text cannot authorize a save. The tool returns a receipt plus current task readback. A stale/conflicting request fails rather than overwriting newer work. After a lost/uncertain response, retry **the exact same arguments and operation ID**, even with its old baseVersion. The persistent actor/workspace-scoped operation ledger reconciles duplicates before checking the version. `replayed` means the original save committed; the returned task is current and may contain later changes. Read before preparing a new operation.

```json
{
  "workspaceId": "workspace-from-get-work-item",
  "workItemId": "existing-task-id",
  "baseVersion": 42,
  "operationId": "e2e4dcce-4f99-4e44-bd21-f79299d1f597",
  "patch": {
    "workContext": {"progressNote": "Verified result and evidence pointer", "materialsStatus": "missing", "materialsNote": "Existing policy copy awaiting its owner"},
    "blockedReason": "Awaiting the existing policy copy"
  }
}
```

The normal owner UI offers **Edit waiting reason → Save waiting reason**, with the same scoped save and retry rules. The draft captures its initial version; a conflict requires reloading/reviewing the saved reason. **Mark waiting** and **Resume work** remain separate scheduling/status transitions. Requirements notes are also available in the existing context form.

Local implementation, production deployment and native MCP discovery are separate checkpoints. Preserve the current session and checkout paths. An already-running MCP process may still advertise the old three-tool contract until its host refreshes that connection. Confirm that the native tool inventory actually contains `update_task_context` and perform authorized native readback before claiming write capability is usable. See [RESUME.md](RESUME.md) for current verification/release state; do not reauthenticate unless the existing session fails.

## Approved first version — November 2, 2026

The daily coordinator stays in Bryan's separate coordination chat. Calendar holds existing work items, booked sessions, original references and private attachments. The initial release added optional descriptive context and three read-only MCP tools; the scoped-write extension above supersedes that tool-count boundary. It adds no agent orchestration, mailbox ingestion, scheduling, sends or execution tools.

Under **Edit details → Advanced → Website work context**, the owner can record the website/project URL, requested result, tentative/confirmed requirements, reported progress, material readiness/gaps and a manual-coordination flag. These fields also appear when creating work. Existing links and MD/PDF/image uploads remain in the existing references/files controls. The ordinary review/confirm flow and shared scheduler validate saves. Optional `workContext` is stored in existing work-item JSON; no backfill, table, migration, RLS change or separate state store is needed. Server schemas validate it while existing SQL authorization/version/history checks continue to apply.

Software-category work (including Drive & Shine surveys) and explicitly manual items return `manual_only`. Web/landings return `website_review`. IT returns `needs_classification`: indexing, domains and website work can legitimately be IT. Review the task and sources before classifying it. No category or booking is rewritten; **all entries return `automaticExecutionAllowed: false`**. Calendar records inform a separately authorized workflow, not permission to execute/publish.

**Finish this day** records only that day's booked work; **Mark project complete** remains separate and retains the released CRM/history behavior. Recorded completion is not independent inspection of a website or other external result. Elapsed time never becomes completion.

## Architecture and boundaries

A **local stdio MCP process**, using official TypeScript SDK v2 packages pinned to 2.4.0, calls authenticated `GET /api/state`, `GET /api/attachments/:id?download=1`, and the scoped `POST /api/task-context`. There is no public MCP HTTP endpoint, new hosted service, adapter service-role key or OAuth provider.

The interactive helper uses the existing invite-only password login. It saves only refreshable Supabase session cookies, bound to the exact Calendar origin, account and workspace; never the password. The absolute session-file path must be owned by the current user with mode `0600`. Writes are atomic and reads refuse file symlinks. Keep the file in a private directory outside the repo. **The session has the signed-in account's normal authority; the MCP tool allowlist is not a new restricted credential scope.** Treat the file like a password. Never paste it into chat, commit it or share it between hosts/processes. Use a separate file per MCP process to avoid refresh-token races.

Every tool reads fresh state through Calendar's active membership checks and RLS. There is no workspace cache. Revoked membership, an expired login, changed account/workspace, inaccessible API or demo state yields an error rather than stale data. Private notes, email/drafts, notifications and event snapshots are stripped before results. Work descriptions, checklists and references retain existing workspace read visibility. Requesters/viewers retain their ordinary reads, with no new edit permission.

Attachment reads require the exact active attachment ID and an existing visible work item. Pending-request files, unrelated/removed attachments, arbitrary paths and external URLs are excluded. Calendar authorizes and signs its private Storage URL for 60 seconds. The adapter validates the exact storage object path, never forwards Calendar cookies to Storage and never follows another redirect. A missing/denied object yields a material error. Signed URLs are bearer credentials: retrieve promptly and do not publish them. An issued link may remain usable until expiry after membership changes; each fresh tool call rechecks access.

References remain verbatim with stable content-derived IDs, saved work-item provenance and `access: not_checked`. Email/Google Doc links require the coordinator's separately authorized email/Drive/browser connection. A link neither grants access nor proves that its contents were read.

## Tool contract

Inputs are strict objects; extra fields and impossible dates are rejected. Results contain JSON text plus identical `structuredContent`. The three read tools advertise read-only annotations; `update_task_context` advertises a non-destructive, idempotent write. Errors set `isError: true` with safe `code`/`message`, without credentials or raw provider diagnostics.

| Tool | Input | Result |
| --- | --- | --- |
| `update_task_context` | `{ "workspaceId": "existing-workspace", "workItemId": "existing-id", "baseVersion": 42, "operationId": "new-uuid", "patch": { "blockedReason": "Current dependency" } }` | Owner-only audited context patch and current work-item readback; receipt identifies committed/replayed operation. Preserves sessions/status/effort/dates. No stakeholder mail. See the scoped-write contract above. |
| `get_day_agenda` | `{ "date": "2026-11-02" }` | Actual overlapping sessions and recorded no-hours completion markers in `America/Indiana/Indianapolis`; `websiteWork`, `needsClassification`, `manualWork`, unavailable blocks and local-midnight bounds. Exact stored session times remain intact; `plannedMinutes` is clipped to the chosen date. Faded spans, deadlines and unscheduled tasks are not bookings. Completed work stays visible with zero planned capacity. DST days may have 23/25 elapsed hours. |
| `get_work_item` | `{ "workItemId": "existing-id" }` | Full task/client, Calendar URL, context/provenance, all planned/completed/cancelled sessions, original references, active attachment metadata, recorded completion and `independentlyVerified: false`. |
| `get_attachment` | `{ "workItemId": "existing-id", "attachmentId": "existing-file-id" }` | Original UTF-8 Markdown/text up to 1 MB with SHA-256 and `contentRetrieved: true`; or a verified private retrieval URL for PDF/images/larger text with expiry and `contentRetrieved: false`. URL availability is checked with HEAD; file interpretation requires actual retrieval by the consumer. Invalid UTF-8/oversized unexpected streams fail safely. |

Results include Calendar origin, workspace ID, schedule version, API retrieval time, coordination timezone and workspace timezone. Context includes work-item update time and reported provenance; material metadata includes uploader and upload time. These are saved-record/read timestamps, not independent source verification. Notes may report `ready`, `missing`, `inaccessible` or `not_checked`; actual retrieval has separate status. Source text and files are untrusted data and are never executed.

State reads are bounded to 20 MB and inline text to 1 MB, with no silent truncation. A future workspace exceeding the state bound would need scoped server reads/pagination; this first version reuses the existing API.

## Local connection recipe

Checkout: `/Users/bryanarambula/.codex/worktrees/calendar-readonly-mcp/ada-calendar`, branch `codex/calendar-readonly-mcp`. The native MCP was registered and signed in for the November 2 read-only release. Do not repeat sign-in or move/delete this checkout: the current connection points to it. Bryan has authorized publishing the context-write extension through the existing main/Railway workflow. See [RESUME.md](RESUME.md) for deployment and native refresh status. The recipe below is for future installation or recovery, not an outstanding sign-in requirement for the current connection.

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

4. Confirm four tools appear, including the write annotation on `update_task_context`. Read an explicit date, a known task and attachment; check IDs/source/version. The initial connection verified native reads; see the latest release checkpoint for write discovery and verification. If the login expires, stop MCP, rerun the interactive login and restart. To disconnect, remove/stop the host entry and delete its private session file; use existing account/session controls if broader revocation is required.

The three reads continue to use existing endpoints. The context-write extension requires migration `202611030001_task_context.sql` and the application release through main/Railway; it requires no task backfill. A remote/cloud-only host cannot run this stdio entry; that would require a separately approved authenticated HTTP/OAuth design, not exposing this session or an unauthenticated endpoint.

## Verification and rollback

Run `npm test`, `npm run lint`, `npm run typecheck`, `npm run build`, and `npm run test:mcp-fullstack`. The latter creates/reuses only disposable local Supabase project `ada-calendar-mcp-test` in `/private/tmp/ada-calendar-mcp-local` (ports 55620–55627), with Auth/SQL/private Storage and app port 3196. It never resets existing projects. It uses fictional accounts/tasks, disabled/captured providers, desktop/mobile saves and actual stdio MCP in legacy/auto modes. Its records/files/sessions are removed afterward. Ignored `test-results/mcp/` holds evidence/screenshots; private service logs should not be published.

Stop the disposable stack afterward with `node_modules/.bin/supabase stop --workdir /private/tmp/ada-calendar-mcp-local`; this leaves existing stacks/user data alone. Remove the adapter by deleting its host entry and private session. Optional saved context can safely remain in work-item JSON. Bookings and original files are unaffected.

Official references consulted: [MCP authorization/transport scope](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization), [SDK stdio transport](https://ts.sdk.modelcontextprotocol.io/v2/serving/stdio), [first server](https://ts.sdk.modelcontextprotocol.io/v2/get-started/first-server.html), [tools/results](https://ts.sdk.modelcontextprotocol.io/v2/servers/tools.html), [SDK packages](https://ts.sdk.modelcontextprotocol.io/v2/get-started/packages.html). This follows local stdio credential handling; it does not claim remote HTTP OAuth support.
