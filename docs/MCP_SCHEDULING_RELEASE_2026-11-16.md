# MCP scheduling extension — November 16, 2026

Assignment: **2026-11-16/ada-calendar/mcp-scheduling**. Status: implemented, deployed and fully verified. Chat activation remains coordinator-owned.

Baseline remote main: `e797f45e6e36798cc4a7f2ff9e0ff7c5b19436b1`. Isolated branch: `codex/mcp-scheduling`. Active registered adapter and original checkout edits remain untouched. The active checkout's RESUME points here so the coordinator can inspect progress.

Required contract: compact exact client/task discovery (including unscheduled ongoing work), available slots, add work with source/context and optional bookings, clean-fit booking, exact identified planned-session moves, ongoing display/unknown effort independent of deadlines/milestones. Existing four tools continue unchanged. Source text is never authority and scheduled work does not grant website execution permission.

Implementation: reuse the shared scheduler and owner-authenticated server commit path, with persistent prepare/commit identity and bounded exact diffs. Reject stale/conflicting saves and any unrequested displacement. Preserve history and unrelated context/sessions. Make existing notification behavior explicit in previews/results. A stable operation ID must reconcile uncertain writes across process restarts.

Verification used isolated fictional Auth/PostgreSQL/stdio/browser fixtures with captured providers, plus lint/types/unit/build and relevant regressions. The external maintained Claude gateway will be imported/tested without editing or loading its configuration/session; new tool names must be filtered and denied. Evidence will distinguish output bytes/call counts from unmeasured model tokens.

The contract, completed local validation, deployment and preservation evidence are recorded below. No global skill updates, other-chat switch, app restart or live demonstration bookings are part of this assignment.

## Implementation

Remote main baseline `e797f45` already contains `088d208` (Willian notification pause). The original project checkout was older; no later notification behavior was overwritten.

The four additive tools use owner identity pinned to the private MCP session, fresh authenticated state and existing commit authorization. Immutable private `mcp_schedule_operations` records persist input, commands, fingerprint and exact diff under owner RLS. Actual writes use the existing schedule ledger/transaction, including full persistent operation lookup on replay. No separate scheduler was added.

Smart-fit placements become exact shared-scheduler commands before preview is stored, retaining IDs across restarts. Protected override is per requested session; unrelated work/history/blocks cannot change. Ongoing sets display span/open end and optional unknown effort while preserving milestones/deadlines/bookings. Delayed-create testing reproduced the server-generated creation timestamp changing between prepare/commit; only that new-item timestamp is excluded from the reviewed diff and returned in saved readback. Existing-item creation timestamps remain protected. Waiting ongoing changes do not schedule or resume work.

## Tool contracts and examples

All new tools are owner-only, strict typed objects. Fresh results include `source.workspaceId`, `source.scheduleVersion`, actor identity and saved timezone. Exact existing IDs are required; ambiguous matches are candidates, never authority to select a task. First use `get_work_item` before editing existing work. The existing read/context tool contracts are unchanged.

| Tool | Input | Output / bounds |
| --- | --- | --- |
| `find_calendar_items` | `kind: "clients"` or `"tasks"`, optional `query`, `clientId`, `status` (`active` default, `all`, `waiting`, `completed`, `cancelled`), `unscheduledOnly`, `limit` (1–25), `offset`, `baseVersion` | Compact exact IDs/name or title/status/ongoing/remaining effort/planned-session count. Continue with `nextOffset` and the first page's source version; a changed version rejects the page. |
| `get_available_slots` | `startDate`, `endDate` (at most 14 inclusive calendar days) | Shared-scheduler open intervals with UTC instants and saved workspace timezone. Weekdays, lunch, reserve, meetings, existing work and elapsed time remain unavailable. No reservation is made. |
| `prepare_schedule_change` | `workspaceId`, fresh `baseVersion`, new UUID `operationId`, one typed `change` | Persisted exact diff, operation/version/fingerprint and notification policy. At most 60 changed sessions and 60 KB diff. No calendar save/mail. |
| `commit_schedule_change` | Exact `workspaceId`, `baseVersion`, `operationId`, `reviewFingerprint` from prepare | Persistent committed/replayed receipt, applied diff, fresh current task/session readback, and `verification.matchesAppliedDiff` / `laterCalendarChanges`. Stale/conflicting plans fail; uncertain saves must retry the original operation. |

Illustrative change arguments only; replace fictional IDs/dates with verified task/source details:

```json
{"kind":"book","workItemId":"exact-task-id","booking":{"startDate":"2026-11-17","endDate":"2026-11-20","minutes":120,"distribution":"total","resumeWaiting":true}}
```

Booking adds only the requested ready portion, at most 31 calendar days per operation. `distribution:"per_day"` means the stated minutes on each selected workday; optional `dates` narrows the range. `resumeWaiting:true` explicitly resumes waiting work and clears its waiting reason; use only when authorized. No inferred total effort, recurrence or unrequested displacement. Existing sessions/history stay unchanged. Task limits, firm deadlines, focus minimums and saved calendar settings still apply.

```json
{"kind":"reschedule","moves":[{"sessionId":"exact-future-planned-session-id","start":"2026-11-18T14:00:00Z","end":"2026-11-18T15:00:00Z","overrideProtected":false}]}
```

Move at most 20 exact future planned sessions, retaining IDs/durations. Other bookings of the same task also remain unchanged. `overrideProtected:true` requires explicit owner authorization for that session. No resizing, deadline override, cancellation or completion is exposed.

```json
{"kind":"ongoing","workItemId":"exact-task-id","unknownEffort":true}
```

Sets `timelineMode:"span"` and `windowEnd:null`; optional `unknownEffort:true` sets estimate/remaining to null. Preserves target/milestone, firm deadline, status, source/context, bookings and history. It does not book repeated hours or complete the project. Inconsistent legacy state that the shared scheduler cannot safely validate fails closed rather than being rewritten.

```json
{"kind":"create","task":{"clientId":"exact-client-id","title":"Fictional requested update","description":"Verified source context","category":"web","webKind":"edit","estimatedMinutes":null,"windowStart":"2026-11-17","windowEnd":null,"targetDate":null,"deadline":null,"minimumSessionMinutes":15,"references":["https://example.test/original-brief"]},"booking":{"startDate":"2026-11-17","endDate":"2026-11-20","minutes":120,"distribution":"total"}}
```

Creation also accepts the existing full optional `workContext`, `dateConstraints`, priority and active requester ID. Without `booking`, it saves waiting/unscheduled work and reserves zero hours even if an estimate is supplied. The operation UUID becomes the task ID, and prepared booking IDs are frozen. New creation time is server-generated at commit and returned in current readback; it is not a reviewed placement. Creating clients, uploads, sending messages, completion and website execution are outside this contract.

Example commit envelope:

```json
{"workspaceId":"workspace-from-source","baseVersion":42,"operationId":"6b99cacb-2783-48a6-b6f2-6ef91adaae0e","reviewFingerprint":"exact-64-character-fingerprint-from-prepare"}
```

Never manufacture the fingerprint or update the version to force an old plan through. Reconcile an uncertain operation first, even with its old base version; only a new reviewed intent uses a new operation ID. A replay returns current state and does not undo subsequent legitimate edits.

## Notification and compatibility policy

Normal scheduler commits notify opted-in recipients using the existing transaction/outbox. Saved `receive_updates=false` preferences are untouched; Kyle and Willian remain opted out. No preview, failed/stale transaction or exact replay adds mail. Context updates remain silent. Tests explicitly exercised an opted-in fictional requester, capture, replay without duplicate mail, and opt-out suppression. No production test records, mail or worker invocation were used.

The maintained Claude gateway's three-read allowlist was imported and exercised without loading its config/session. It filters and rejects all five non-allowlisted tool names (the existing context write plus four additions); the separate Claude connection remains unchanged. Old context writes/read/attachment behavior, RLS, CRM silent context feed, desktop/mobile saves and recorded history all passed the actual local stack tests.

## Validation checkpoint and efficiency

- Final local `npm run check`: lint, generated route types/TypeScript, **1,483 tests in 82 files**, optimized production build passed. Log: `/private/tmp/ada-mcp-final-check.log`.
- Focused scheduler/server/client coverage: **48 tests** passed. Log: `/private/tmp/ada-mcp-focused.log`.
- Actual local Auth/PostgreSQL/Storage/browser/native-stdio acceptance passed, including both protocol modes, durable prepare + adapter/server restart, delayed create, unscheduled/scheduled creation, multi-slot booking, ID-preserving move, ongoing with retained bookings, stale/concurrent/replay rejection, roles/workspace isolation, immutable previews, unchanged history/unrelated rows, notifications, old tools, and Claude gateway. Log: `/private/tmp/ada-mcp-fullstack.log`; machine evidence and desktop/mobile screenshots: `.data/mcp-acceptance/`. The mobile waiting-reason screenshot was visually inspected.
- Local SQL lint found no new-function warning/error; two pre-existing warnings concern unused variables in `reply_crm_request` and `cancel_crm_task`. Log: `/private/tmp/ada-mcp-sql-lint.log`.
- Initial sandbox runs encountered Supabase telemetry write permissions and filesystem watcher restrictions; tests were rerun with normal local test permissions. An initial harness read used a service-role client against the deliberately owner-only preview table and correctly failed; the fixture now reads through the signed-in owner. Harness outputs moved under `.data` so Playwright cleanup cannot remove them. These were test setup corrections, not permission broadening.
- Full existing browser regression suite passed **190/190** scenarios in 9.4 minutes. Log: `/private/tmp/ada-mcp-browser.log`.

Measured fictional fixture payloads, UTF-8 JSON bytes: full state **13,669**; client discovery **298**; availability **621**; prepare **2,552**; commit/readback **2,677**. With IDs/version already known, scheduling uses two MCP calls (prepare + commit), each one compact authenticated endpoint call. Existing-task context/discovery/availability may add calls. These are output sizes/call counts, **not measured model-token savings**; MCP renders both text and structured content, and no browser token benchmark was taken.

## Release baseline, rollback and activation

Remote/main and deployed baseline: `e797f45e6e36798cc4a7f2ff9e0ff7c5b19436b1`; GitHub deployment `7529300209`. Migration commit: `e007429361a71c455aa0e3d0a6314dc7e7c81c12`. Production ledger confirms `202611160001`; it was applied before the application commit `96fb7773258aed78d47a6a29b5d1365fbb5bcdf5`. Both are pushed to main.

Read-only pre-release evidence at `.data/mcp-release-2026-11-16/before.json`: version **634**, 126 items, 229 sessions, 11 unavailable blocks. Only hashes/counts are saved in that evidence; no credentials or private task dumps are committed. The comparison must account for concurrent authorized changes, detailed below; do not claim that the entire window was unchanged. Original checkout dirty files and registered adapter code remain untouched.

Rollback: redeploy baseline `e797f45` or revert only this application change, leaving the additive preview table intact. Old app/tool contracts ignore it. Do not drop calendar history, revert actual user scheduling operations, or change saved email preferences. The actual scheduling data types/transaction remain the existing system's types. Persistent operation IDs stay recoverable if the extension is restored.

Activation is separate from release. The registered adapter still points at the original stable checkout and retains its existing private session. This assignment does not fast-forward that active checkout, edit its registration, restart Codex, switch other chats, update global skills or touch Claude's config/session. The coordinator can update the existing adapter checkout after preserving its assignment-note edit and refresh that one MCP connection using a supported host flow; verify actual native discovery of all eight tools afterward. Standalone eight-tool discovery does not prove a running chat refreshed. No reauthentication is needed unless the saved session actually expires.

## Production deployment and preservation

- Application **`96fb7773258aed78d47a6a29b5d1365fbb5bcdf5`** is on main. Railway deployment **`edf26a53-e2ae-4d6b-ab60-a77bb13b72cf`** succeeded; GitHub deployment **`7830354303`** reported success at **2026-11-16 16:50:01 UTC**. The commit status links directly to [the successful Railway deployment](https://railway.com/project/ad7671c5-a3ff-4e9a-83c6-968128c28246/service/680b842f-130b-4d4f-8982-646b99b2ef99?id=edf26a53-e2ae-4d6b-ab60-a77bb13b72cf&environmentId=c30682dc-3173-4bb8-bd99-e4e7fb4bb574).
- Migration-only commit `e007429` preceded the application. Dry run/apply identified exactly `202611160001_mcp_scheduling.sql`, no seeds/roles/Vault changes. Ledger readback confirms it. Logs: `/private/tmp/ada-mcp-migration-dry-run.log`, `/private/tmp/ada-mcp-migration-apply.log`, `/private/tmp/ada-mcp-migrations-after.log`.
- Hosted [CI run 43911391776](https://github.com/bryguy-404/ADA-Calendar/actions/runs/43911391776): Node 24 lint/types/1,483 unit-server tests/production build job `133453920506` passed. Browser job `133453919814` finished **189 passed / 1 failed** (including a failed retry): the existing mobile task-context fixture clicks day before the first-animation-frame mobile agenda initialization, then fails its setup assertion before any save. This same race was documented in the November 3 release. A narrow test-only fix waits for the initial agenda state before clicking day; all persistence, retry, version and history assertions remain intact. The replacement result is recorded below; do not call this initial run passing.
- Live access-token-only probes passed compact discovery/availability against the deployed application. They transmit **no refresh token**, never write the active session file, and verified that file byte-identical. Health returns 200; unauthenticated state returns 401 and unauthenticated commit returns 400 (existing route's sign-in rejection, no write). Evidence: `.data/mcp-release-2026-11-16/after-application.json` and the private `read-only-probe.mjs`.
- No second production stdio adapter was launched against the active session. Local fixture stdio already proved all eight tools and restart behavior. The running native connection still advertises exactly the original four tools; its live agenda read passed at version 637. New native chat discovery remains an activation step, not a verified outcome of this release.
- The baseline was taken during active authorized work. Version **634 → 635** recorded `complete_day`, changing one item's `remainingMinutes`, `forecastDate`, `updatedAt` and one session's `status`. **635 → 636** recorded `context_update` for `references`, `description`, `workContext`, `updatedAt`. **636 → 637** recorded `context_update` for `description`, `workContext`, `updatedAt`; no sessions changed in either context update. Coordinator confirmed concurrent authorized intake/work. Exact operation IDs and field names are privately retained in `.data/mcp-release-2026-11-16/changed-fields.json`; no source contents are committed.
- All three audit operations have `from_mcp_scheduling:false`; the production preview table remains **empty**. This release made no task/booking/history mutation or fixture operation. Counts remain **126 tasks / 229 sessions / 11 blocks**; setting/block hashes match the initial baseline, session hashes match version 636 after the recorded completion, and the membership/notification preference hash is unchanged. Preserve these legitimate changes; never restore v634. Evidence: `before.json`, `after-migration.json`, `after-application.json`, `release-audit.json`, `changed-fields.json`, `preferences-before.json`, `preferences-after.json` under the same private release directory.
- The original project remains at `088d208` with only its pre-existing `docs/RESUME.md` and `next-env.d.ts` edits. The active adapter checkout remains at `e797f45` with only its assignment-note edit. No registration, Claude configuration/session or global skill changed. The dedicated `ada-calendar-mcp-test` Docker stack was stopped with backup/volumes preserved; other projects were untouched.

## Hosted fixture correction

The initial hosted browser failure was the previously documented mobile fixture initialization race, not a save assertion or MCP scheduling failure. Commit **`55243d92d43f0317cda633963168f5eebd0648f9`** adds only a mobile agenda-initialization wait in `tests/e2e/task-context.spec.ts`; application source is unchanged. All **15 repeated scenarios** (three existing tests × five repetitions) passed in 33.4 seconds, followed by lint/type checking. Logs: `/private/tmp/ada-mcp-mobile-fixture.log`, `/private/tmp/ada-mcp-fixture-check.log`.

The correction is on main. Replacement full [CI run 43914840261](https://github.com/bryguy-404/ADA-Calendar/actions/runs/43914840261) **passed both jobs**: checks `133466087286` (Node 24 lint/types/1,483 tests/build) and browser `133466086765` (**190/190 passed in 10.8 minutes**). Railway deployment `c6c3fa08-c26d-4da4-8b0a-17d279712633` (GitHub record `7830823226`) succeeded with identical application source. The initial failed run is superseded by this verified result, not relabeled as passing. No additional migration or schedule mutation accompanies this test-only commit.

## Final handoff

Implementation, migration, main pushes, local verification, production delivery and final hosted CI are complete. The four new names are `find_calendar_items`, `get_available_slots`, `prepare_schedule_change`, `commit_schedule_change`. Existing read/context contracts and the separate Claude read-only gateway remain intact. The coordinator owns the intentional native connection activation; no active chat or registration was switched. Measured payload sizes/call counts are evidence of compact responses, not measured token savings. See the contracts and rollback above before activation.
