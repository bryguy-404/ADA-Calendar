# ADA Calendar / ADA CRM integration

## Approved outcome and implementation order

Calendar remains the authority for Bryan's capacity, booked work and approval decisions. CRM asks Calendar whether a new assignment fits, then displays Calendar's result. Work that fits can be booked and appear in both systems. Work that would move another commitment waits for Bryan's approval; protected time needs his explicit override.

Both applications keep their own repositories and deployments. Build Calendar's API first, connect the CRM second, and verify the complete flow before enabling it in the existing Railway/Supabase environments.

| Phase | Deliverable | Checkpoint |
| --- | --- | --- |
| 1. Secure foundation | Connection authentication, verified CRM requester identity, private source and operation records, connection check | Committed locally as `a645fc5`; integration disabled |
| 2a. Availability and previews | Public workload projection, shared-scheduler fit/impact previews, alternatives and private expiring preview records | Committed locally as `fe5d3e1`; booking disabled |
| 2b. Calendar scheduling transactions | Owner connection/client setup, clean-fit booking, approval requests, replies, operation lookup and atomic change recording | Committed locally as `951f663`; activation disabled |
| 3. CRM connection | Server API client, task form fields and review, guarded task creation/reassignment, linked task display | CRM commit `9bf346b`; activation disabled |
| 4. Synchronization and recovery | Durable submissions, background changes polling, owner decisions and edits reflected in CRM, retry/reconciliation and notification coordination | Local checkpoint; CRM `5e88c15`; activation disabled |
| 5. Complete verification and rollout | Two-application local scenarios, failure recovery, reviewed releases, controlled activation and rollback | Pending |

Each checkpoint ends with a reviewable diff, applicable checks and a local commit on the integration branch. Phase 2 is split so its read/preview API can be reviewed before introducing scheduling transactions. A local checkpoint does not demonstrate that the two deployed applications are connected. No CRM application code changes are included in Phases 1, 2a or 2b.

## Product decisions retained from the plan

- Integrate new tasks assigned to Bryan and new reassignments to Bryan. Existing Bryan tasks are grandfathered; do not automatically import them.
- Any verified CRM agency teammate can submit without a separate Calendar account. The signed-in CRM user's verified identity is the requester; editable form fields and profile metadata grant no authority.
- An effort estimate is required before submission. The CRM can display hours; the API carries integer minutes in 15-minute increments.
- Support **due by a date**, **work on a specific day**, and **start at an exact time**. Due dates are firm unless explicitly flexible. Exact-time requests use the estimate to determine their end.
- Calendar's saved timezone, weekday boundaries, lunch and interruption reserve determine capacity. Preserve Bryan's saved zero-minute reserve. Faded spans reserve no time, and elapsed time is not completed work.
- A clean fit may book immediately. Displacement, protected-time changes and deadline exceptions require the applicable owner review. A requester cannot edit, move or complete existing Calendar work.
- Show affected work, proposed before/after bookings and alternative days. A later alternative outside a firm due date must clearly require relaxing that date; it cannot be silently selected.
- Show permitted work titles, clients and hours. Personal blocks appear as generic unavailable time. Never return personal notes, private drafts, transcripts or attachments through the CRM API.
- Match CRM clients to Calendar clients by suggested names/aliases, with owner confirmation before booking. Suggestions alone cannot authorize a mapping.
- After linking, Calendar governs schedule edits, completion and cancellation. CRM reflects the authoritative result.
- Calendar owns integrated booking/request notifications. Suppress duplicate CRM assignment mail for integrated tasks; keep CRM daily summaries.

## Phase 1 implementation

### Connection check

`GET /api/integrations/crm/v1/status` is a Node-runtime, server-to-server endpoint. It requires all of:

1. `ADA_CRM_INTEGRATION_ENABLED=true` on the Calendar server. Missing or false means disabled, including in demo mode.
2. An enabled, privately configured connection with a valid `Authorization: Bearer <connection credential>`.
3. `X-CRM-User-Token: <signed-in user's CRM access token>`.
4. Successful verification against the **configured CRM Supabase Auth project**, including a confirmed email in the configured agency domain, a valid user ID, and no anonymous/banned user.

Successful response:

```json
{
  "apiVersion": "1",
  "status": "authenticated",
  "bookingEnabled": false,
  "capabilities": ["connection_check", "availability", "previews"]
}
```

This endpoint exposes no schedule, user identity, internal workspace ID or credential. Responses are private/no-store. Calendar browser cookies do not authorize it or get refreshed by its proxy. Browser Origin headers are rejected; the future CRM backend must construct a new server request rather than forwarding browser headers wholesale. No cross-origin browser access is enabled.

The credential contains a connection UUID and 32 random bytes. Persist only its SHA-256 hash; store the issued secret only in the CRM server's protected configuration. Changing the stored hash revokes the old credential. Credentials and user tokens must never enter the CRM frontend bundle, URLs, logs, source task metadata or change feed. The browser already holds its own CRM login token; it supplies that token only to its same-origin CRM backend.

CRM Auth URLs are pinned to canonical hosted `https://<project>.supabase.co` origins. Verification uses a public/publishable key, refuses private service keys, disables redirects/caching, has an eight-second timeout and limits the provider response to 64,000 bytes. Provider/database failures return generic errors. Valid service credentials have a shared database budget of 120 requests per connection per minute; exhaustion returns 429 with Retry-After. Unknown/invalid credentials are denied before provider verification.

The separate internal service-auth helper will support recovery workers in later phases without storing teammates' login tokens. It is not itself a public worker endpoint.

### Private database records

Migration `202609140001_crm_integration_foundation.sql` adds:

| Table | Purpose |
| --- | --- |
| `crm_integrations` | Pinned CRM project, credential hash, disabled-by-default connection and change sequence |
| `crm_client_mappings` | Owner-confirmed CRM-to-Calendar client identity |
| `crm_task_links` | Permanent source task, verified requester and Calendar work/request identifiers |
| `crm_operations` | Immutable operation identity/input and final replay result |
| `crm_changes` | Ordered task changes for the later CRM synchronization worker |
| `crm_api_budgets` | Shared request budget across application instances |

All six tables have RLS enabled and no browser/anonymous grants or policies. Only trusted server code accesses them. The future owner setup handler must verify the live owner before using its service-only administration capability; SQL additionally validates the owner/workspace/client relationships. This phase provides the schema and credential utility, **not the owner setup screen or a provisioned connection**.

The connection's technical audit identity is a banned Auth user with trusted `ada_crm_principal` app metadata and **no Calendar workspace membership**. Setup rejects an ordinary account or existing member. A membership trigger prevents adding a tagged/registered principal as an owner, requester or viewer, even if someone later changes its Auth metadata. Existing Calendar authentication and scheduling RPCs consequently continue to deny that identity. No artificial user sessions or owner impersonation are introduced.

Phase 2 must introduce trusted internal scheduling context for this principal while retaining the same shared scheduler and SQL validation. Existing browser-facing RPCs must continue to derive identity from the authenticated Calendar user. Store the independently verified human CRM subject/email as immutable source attribution; the technical principal is never evidence of human owner approval.

`prepare_crm_operation` records intent only. Retrying the same operation ID requires the same connection, source task, human subject/email, action and exact input. It returns the saved status/result. It neither reserves capacity nor books a task. Final results cannot be replaced. Phase 2 must finalize the operation **in the same transaction** as its Calendar mutation, source link, notifications and change entry.

The private change-append helper updates the connection sequence and inserts the change in one transaction, with row locking to prevent a committed cursor skipping an earlier unfinished transaction. It is not executable by browser roles or directly by the service role; future scheduling functions call it internally. Changes should continue to accumulate while synchronization is disabled, for later catch-up. Feed response filtering and retention/reconciliation are still to be implemented.

No real connections, accounts or client mappings are seeded. The migration does not modify stored workspace settings, sessions, pending requests or events.

## Phase 2a: availability and review API

- `GET /api/integrations/crm/v1/availability?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD` returns up to 31 days of shared-scheduler capacity, usable future openings, booked work titles/clients/times, and generic unavailable ranges. It uses the workspace timezone and persisted settings, includes every session in a coherent database snapshot, and does not count unbooked spans as occupied time. Old planned work stays planned after its scheduled time passes.
- `POST /api/integrations/crm/v1/previews` accepts the strict task input contract and requires a confirmed client mapping. It supports day, exact-time and firm/flexible due-date requests. It returns `fits`, `needs_approval`, or `cannot_fit`, proposed times, affected work before/after, safe conflict explanations and up to three clean-fit alternatives. A later alternative explicitly marks whether the firm deadline must change. Selecting an alternative requires a new preview.
- Every response still says `bookingEnabled: false`. A fit is a preview, not a reservation or an accepted task. No booking or request-submission endpoint is implemented in this checkpoint.
- The shared scheduler now computes ordinary exact-time displacement for a requester as an approval proposal. Passing `approveDisplacement` cannot approve it for a requester. Protected, already-started, unknown-total and partially booked conflicts require explicit owner handling. Ordinary Calendar SQL authorization remains unchanged and continues to reject requester edits and technical-principal scheduling.
- Public responses are explicit field projections. They omit source descriptions, aliases, internal commands/fingerprints, block IDs/reasons, personal notes, drafts, transcripts, attachments and credentials. Both routes require the same service-plus-verified-teammate authentication as the connection check. Invalid or oversized bodies are bounded and sanitized; stalled uploads are cancelled after eight seconds.
- Migration `202609140002_crm_availability_previews.sql` adds a versioned client mapping and a private immutable `crm_previews` record. Each record binds the connection, verified human, source task/client, mapping revision, workspace version, normalized input, generated requester command, review fingerprint and a 15-minute expiry. SQL rejects stale workspace/mapping versions or invalid clocks before saving. API callers receive 409 and must request a fresh preview; the server does not silently regenerate it.
- Preview records are not exposed to browser roles and the service role cannot directly update/delete them. No schedule, task-link, request, event, email or workspace setting is written by previewing. Phase 2b must recheck the saved identity, mapping revision, expiry and freshly recomputed fingerprint before any actual booking. Expired-preview retention/cleanup belongs with the synchronization/recovery work in Phase 4.

## Remaining implementation requirements

### Calendar API and approval flow — implemented in Phase 2b

- Availability and preview endpoints are implemented in Phase 2a. Add bookings, requests, replies and operation lookup under the versioned API base. Continue accepting task requests, never caller-supplied schedule snapshots, actor roles or override commands. `src/lib/crm-integration.ts` holds the strict input and public response contracts.
- Add owner-only connection provisioning/rotation/disable and mapping confirmation. Create the banned technical identity through trusted Auth administration without invitation mail. Do not enable a production connection as part of a migration.
- Reuse the Phase 2a shared-scheduler adapter for every fresh fit and impact calculation; retain its public-field projection, blocks/reserve and usable-future-capacity rules.
- Previews expire after 15 minutes. Bind them to the verified requester, normalized input, mappings, workspace version, review fingerprint and relevant clock state. Recheck at commit. Return 409 for stale/changed intent, with no automatic authorization to replan and commit something different.
- Make clean-fit work/request creation and durable operation finalization atomic. Preserve requester-only new-work validation and all existing owner approval/protected-time rules.
- Record linked changes for every relevant Calendar owner action and approval outcome, including edits, completion, cancellation and Undo. Retain the source relationship after an approval becomes booked work.
- Return an explicit whitelist of public work fields. Personal unavailable blocks must lose their private title/reason. CRM private integration data never belongs in Calendar's shared AppState.

### CRM forms, task integrity and recovery

- Add a server-side Calendar API client; keep the connection credential out of the browser. Verify the CRM user at its backend and forward that user's access token for interactive Calendar calls.
- Require hours, category and scheduling mode for new integrated assignments/reassignments. Show fit/conflicts/alternatives and pending-owner-approval status in the CRM flow.
- Replace the integrated path's current direct browser task writes with guarded server operations. Enforce the same restrictions in CRM SQL so direct Supabase calls, owner dropdowns, client deletion cascades, completion controls and cleanup code cannot bypass Calendar authority.
- Persist a submission with a stable operation ID before contacting Calendar. Reconcile timeouts/interrupted responses through operation lookup before any new submission. Use retries only for the same intent; do not duplicate bookings, requests or emails.
- Preserve legacy task behavior for unrelated and grandfathered work. On linked tasks, replace the current 24-hour hard deletion with a 24-hour soft hide after completion, retaining source history and recovery records.
- Poll the Calendar change feed every 30 seconds in a leased background worker independent of email-worker settings. Advance its durable cursor only after applying changes. Display stale synchronization after two minutes. Catch up after a restart or temporary outage without requiring the teammate to stay signed in.
- Suppress CRM assignment mail for integrated tasks at the database enqueue boundary, including reassignment and retries. Keep Calendar notifications captured or explicitly allowlisted in development. Include linked work appropriately in CRM daily summaries.

### Testing and rollout

Each phase gets unit/contract tests, applicable local SQL tests, lint/type checks/builds, and browser checks for changed UI. The complete integration additionally needs two-application local coverage of free-slot booking, due-date fits, conflicts and alternatives, protected time, owner approval/rejection/reply, concurrent same-slot requests, stale previews, duplicate clicks/retries, interrupted writes, worker restarts, revoked users/credentials, client mismatch, old-task behavior, owner edits/Undo/completion and duplicate-email suppression.

Release through separately reviewed Calendar and CRM diffs. Apply Calendar's backward-compatible database changes through its existing deployment path, verify migration status, deploy its API with the feature disabled, then deploy the compatible CRM database/server/UI changes disabled. Do not use two competing migration deployment paths. GitHub pushes may trigger Railway/Supabase deployment and are a separate release step from these local edits.

Configure both existing live environments, confirm client mappings and run a controlled captured/allowlisted test before enabling eligible new Bryan assignments. Verify the task appears in Calendar and CRM, conflict approval and alternative dates, synchronization, and notification ownership. Local tests alone do not establish those hosted results.

For rollback, disable new integrated submissions and the connection as appropriate, show an explicit unavailable/pending state, and preserve existing linked bookings and operation history. Never fall back to unchecked local CRM booking when Calendar is unavailable. Reconcile outstanding submissions and catch up the change cursor when service resumes. Do not drop the integration tables or run a down migration that destroys links.

## Phase 1 verification — September 14

- Foundation migration applied only to the isolated local ADA Supabase database.
- `npm run test:crm-db`: rollback-only SQL fixtures prove private grants, technical principal isolation, owner-confirmed mappings, source attribution, operation replay checks, final-result immutability, ordered changes/rollback, credential budget/disable behavior and unchanged workspace settings/bookings. It sends no mail and refuses to target anything except `supabase_db_ada-calendar`.
- `npm test`: **1,329 tests passed in 66 files**. `npm run lint`, `npm run typecheck`, and the optimized `npm run build` passed. The build initially hit a sandbox port restriction; after moving aside the cached compiler failure, the permitted fresh build passed with the new status route included.
- Unit tests mock CRM Auth and the connection repository; no real agency credentials or real CRM sessions are used. End-to-end two-application and hosted verification remain pending.
- No UI changed in this phase. No live feature flag, remote migration, real booking, email, GitHub push or deployment is included.

## Phase 2a verification — September 14

- Local migration applied to `supabase_db_ada-calendar` only. `npm run test:crm-db` runs both rollback-only suites, covering private reads/previews, all 1,001 historical fixture sessions, identity binding, mapping revisions, expiry, stale rejection, revocation, and unchanged Calendar data with no outgoing mail.
- Planner/route/repository tests cover working hours, zero and nonzero saved reserve, lunch, weekends, elapsed work, private-data filtering, multi-day effort, exact-time displacement/approval, explicit-owner conflicts, firm/flexible dates and alternatives, schema/authentication failures, bounded/stalled uploads and no automatic stale retry. CRM Auth and repository calls are mocked in unit tests; complete two-application verification is still pending.
- **1,352 tests passed in 69 files**, along with lint, type checking and the optimized production build. Both local SQL suites passed. The build includes the status, availability and preview routes. No UI changed. Existing unrelated edits in `docs/RESUME.md` and `next-env.d.ts` stay outside the integration commits.
- The next checkpoint at that time was Phase 2b, documented below.


## Phase 2b: Calendar transactions and owner setup

The Calendar side now has the following additional Node-runtime routes. None changes a live feature flag as part of installation.

| Route | Authorization and result |
| --- | --- |
| `POST /api/integrations/crm/v1/bookings` | Service credential + verified CRM teammate. Accepts only `{operationId, previewId, note?}`. Commits the saved clean-fit intent; conflicts require the request route. |
| `POST /api/integrations/crm/v1/requests` | Same identity and input contract. Saves an approval request without changing booked capacity. Clean fits use the booking route. |
| `POST /api/integrations/crm/v1/replies` | Same identity; only the original source requester may answer a request awaiting information. Accepts `{operationId, externalTaskId, message}`. Keeps the conversation and returns it to pending owner review. A reply cannot replace scheduling commands or grant an override. |
| `GET /api/integrations/crm/v1/operations/:operationId` | Service credential only, for server recovery without saved login tokens. Returns the public completed result or `prepared`, `rejected`, `not_found`; never private operation input. |
| `GET /api/integrations/crm/v1/changes?after=0&limit=50` | Service credential only; ordered, connection-scoped public task changes, maximum 100 per page. Advance using `nextCursor` only after applying the returned changes. |
| `GET/POST /api/admin/crm` | Real Calendar owner session; POST also checks same origin. Read setup, create a disabled connection, replace its credential, enable/disable it, and confirm client mappings. No demo authority. |

`ADA_CRM_INTEGRATION_ENABLED` gates the service API. The additional `ADA_CRM_BOOKING_ENABLED` gates bookings, requests and replies; both default to false. Disabling new bookings leaves authenticated operation recovery and feed reads available while the connection remains enabled. Status advertises mutation capabilities only when both server flags are enabled. Per-connection enablement remains required independently.

### Transaction boundaries and identity

Migration `202609140003_crm_scheduling_transactions.sql` factors the existing SQL scheduling validators into private helpers accepting a trusted internal actor. Existing public Calendar RPCs continue deriving their actor exclusively from the actual session. CRM finalization constructs only a **requester** context for its banned technical principal and calls the same validation chain. Neither browser roles nor the service role may directly execute those actor-context helpers. No membership, synthetic session, owner role or `auth.uid()` override is granted to CRM.

The server loads the immutable preview, verifies its human and intent, replans its original commands using the current clock/snapshot, and compares the saved review fingerprint. The final SQL transaction locks the workspace, then the connection, and rechecks credential revocation, expiry, mapping revision, workspace version and proposal binding. It also checks the wall clock after acquiring the lock, so a session cannot begin in the past because the transaction waited. A stale review returns 409; it is never silently replaced by a different committed plan.

One transaction writes the booking or request, source link, final operation result, change record and queued notifications. Failed scheduling/link/outbox writes roll back together. Same-operation retries return the original result, including after the preview expires; actor, action or input changes are rejected. Different operations cannot duplicate a linked source task. Recovery's `not_found` is not permission to switch operation IDs while another attempt may still be in flight: retain the original durable CRM submission and retry/reconcile the same intent.

Owner approval retains the original work ID, requester and mapped client. Existing owner schedule commits record source-bound changes for edits, movements, completion, cancellation and Undo in their own transaction. A removed booking is published as `unbooked`; its permanent source link remains, preventing an automatic CRM retry from recreating undone work. Owner decisions and replies retain an explicit request conversation. The existing owner review screen displays that conversation and still requires a fresh approval preview and explicit protected-time overrides.

Feed entries and operation results use a fixed public projection: source/task identifiers, title, client, effort, priority, dates, session times/statuses, request status and an intentional decision note. They exclude descriptions, personal blocks, aliases, attachments, drafts and private snapshots. Changes continue to accumulate when a connection is disabled. Calendar queues notifications for the verified source requester and relevant owner; ordinary Calendar notifications for the same event/recipient deduplicate at the existing outbox constraint. No delivery worker is invoked by these routes.

### Owner setup

Settings now has a CRM tab. Creating a connection uses trusted Auth administration to make an already-banned audit identity without invitation mail or a password, then saves the disabled connection. The random connection key is shown once, is never included in setup reads or AppState, and only its hash is persisted. Replacing the key invalidates the old key. If setup loses a database response, it never deletes a possibly linked audit identity; any orphan remains banned and has no membership. Production installation should reconcile an interrupted setup before retrying it.

Client name/alias suggestions are local suggestions only. Bryan selects the actual Calendar client and confirms the CRM client ID explicitly. Mappings carry revisions; mapping changes invalidate earlier previews. Existing linked mappings cannot be reassigned through the foreign-key relationship, and mapped clients cannot be removed from Calendar's directory. This phase provides manual owner-confirmed setup; fetching the CRM's client directory is part of connecting the CRM side.

### Phase 2b verification — September 14

- `npm run test:crm-db` includes three rollback-only suites against `supabase_db_ada-calendar`. Transaction coverage includes owner-only setup, private helper grants, principal isolation, atomic booking/source/event/outbox writes, identity/input-bound retries, stale and conflicting attempts, post-lock clock rejection, requests, replies, owner approval, Undo, completion, disabled connection behavior, directory protection and unchanged zero-reserve settings.
- `npm run test:crm-scheduling` exercises the actual TypeScript planner, repository and submission code against local Supabase Auth/SQL with fictional accounts. It covers simultaneous duplicate submission, competing-slot concurrency, conflict-to-request, replies, owner-approved displacement and safe public results. Fixtures and their queued notifications are removed afterward; no mail is delivered and no CRM Auth provider is contacted.
- Existing `scripts/day-completion-smoke.ts` and `scripts/simple-day-hours-smoke.ts` passed against isolated local fixtures, covering daily hours, protected work, historical bookings, completion, stale/replay guards and exact Undo through the refactored SQL chain.
- **1,382 unit/contract tests passed in 72 files.** Four browser tests passed at desktop/mobile widths: connection setup, explicit client confirmation, feature-disabled status, demo isolation and request conversation display. The owner dialog passed accessibility checks; screenshots were visually inspected. Browser setup writes are intercepted fictional responses, not live connections.
- Type checking, lint and the optimized production build passed. The CRM application connection, durable worker, two-application tests and hosted rollout remain Phases 3–5. No GitHub push, remote migration, deployment, live flag change or real send is included.

## Phase 3: CRM task review and connection — September 14

The CRM implementation is committed locally as `9bf346b` on `codex/calendar-integration`. Its persistent worktree is `/Users/bryanarambula/Projects/ada-crm-calendar-integration`; the original `/Users/bryanarambula/Projects/ada-crm` checkout remains on its unchanged main branch. Calendar application code is unchanged in this phase. CRM implementation and deployment boundaries are documented in that worktree's `docs/CALENDAR_INTEGRATION.md`.

- The CRM's same-origin backend verifies the current confirmed agency identity with CRM Supabase Auth, then calls the Calendar API with a private service credential and the temporary human token. Requests are bounded, provider responses are allowlisted, and neither credentials nor human tokens are stored in tasks/submissions or exposed through public configuration.
- The deployed task form intercepts new Bryan assignments and new reassignments to Bryan. It collects quarter-hour effort, category/details, firm or flexible due date, particular day or exact start time. The review shows proposed work, affected commitments, conflicts and explicit alternative date/deadline choices. Changed inputs always require another preview. Fits book; other work goes to owner review without claiming that time is booked.
- CRM SQL installs disabled. Private configuration distinguishes permanent enforcement from reversible acceptance. Once activated, pausing cannot reopen unchecked direct inserts/reassignments. Existing Bryan tasks are grandfathered; linked tasks and in-flight reassignment sources are protected from browser edits/deletion and parent-client cascades.
- Some durable-submission foundations moved into this phase because safe task creation depends on them. The CRM saves the stable operation/source ID, verified actor, normalized intent, preview and existing task revision before contacting Calendar. Only the first begin transaction may dispatch. Duplicates check that operation. Confirmed results and linked CRM tasks materialize in one transaction; uncertainty stays pending, with a requester-only manual Check status action. `not_found` never silently frees a possibly in-flight operation. Definitive stale rejection requires another review.
- The task list and My Tasks display Calendar status, effort, schedule, timezone and intentional owner decision notes with editing disabled. Completed links retain history and use the existing 24-hour display cutoff. The SQL assignment-mail enqueue boundary suppresses duplicate linked-task mail; existing owner notifications remain intact until reassignment is confirmed. Daily summaries remain enabled through their existing separate worker.

**Verification:** CRM production/artifact build and JavaScript syntax checks passed; **55 unit/contract tests and five browser scenarios passed**. Fictional browser scenarios cover booking, conflict/alternative review, exact-time reassignment, pending approval, lost-response recovery, linked controls, legacy behavior, mobile layout and dark mode. Screenshots were visually inspected. Rollback-only SQL fixtures on `supabase_db_ada-calendar` passed for private grants, identity, activation/pause guards, grandfathering, task/preview revisions, single dispatch, retry protection, retained source history, confirmed materialization and mail suppression. These CRM schema changes were rolled back after testing; no real messages were sent.

**Next at the Phase 3 checkpoint (completed below):** Phase 4 adds the independent leased change poller and durable cursor, automatic reconciliation, owner decision/edit/completion/cancellation/Undo synchronization, requester replies, synchronization health, abandoned-review handling and pending-list pagination. Finish the safe client-directory setup workflow and daily-summary treatment of approval requests. Phase 3 alone does not automatically refresh linked tasks when Bryan later edits Calendar. Phase 5 still requires both actual local application stacks, concurrency/failure and notification checks, then separately reviewed release, controlled activation and rollback. Nothing has been pushed, deployed or enabled in production.


## Phase 4: synchronization, replies and recovery — September 14

Both codebases now contain the synchronization/recovery layer. CRM is committed locally as `5e88c15` on `codex/calendar-integration`. The Calendar changes remain on `codex/crm-integration-foundation`. This checkpoint does not connect or activate either hosted application; Phase 5 remains required.

### Calendar API additions

Migration `202609140004_crm_recovery.sql` adds private closed-operation records, a preparation/finalization fence, and two service-only functions. Both new routes use Node runtime, the existing connection authentication, strict empty JSON bodies, private/no-store responses, and sanitized stored output:

| Route | Purpose |
| --- | --- |
| `POST /api/integrations/crm/v1/operations/:operationId/settle` | Atomically return an existing completed result or permanently reject an uncertain operation ID |
| `POST /api/integrations/crm/v1/maintenance` | Delete at most 500 previews expired for more than seven days, excluding those referenced by prepared operations |

Settlement locks the same connection used by finalization. A concurrent booking either commits first and is returned unchanged, or loses to the closed-operation fence and cannot commit later. Settlement does not cancel booked work, move sessions, create notifications or grant scheduling authority. Operation lookup also returns rejected for a fenced ID that never reached preparation. Browser roles cannot inspect or mutate these records, and a missing/revoked credential fails closed. Closed IDs and attempted-operation history are retained permanently.

### CRM synchronization and requester workflow

The private `calendar_sync` row holds the durable cursor, a two-minute lease, next eligible run, last fully caught-up success and sanitized health. The worker runs independently of new-assignment and email flags, immediately on startup and then every 30 seconds when `ADA_CALENDAR_SYNC_ENABLED=true`. Each tick targets a 60-second budget, checks up to five oldest-unchecked pending operations, then processes up to four pages of 100 changes. Unknown sources, invalid sequences and lost leases never advance the cursor. Each page and its task updates commit atomically; per-task sequence checks prevent an older event from overwriting a recovered newer result.

The worker recovers pending bookings and replies without retaining a human token or redispatching a mutation. A prepared/not-found operation older than two minutes must pass through Calendar settlement before it can be rejected. Completed results materialize through their original finalizer. New attempts need a fresh review after rejection; ambiguous failures never fall back to unchecked CRM tasks.

The original verified requester can answer an owner's question in the CRM. Each reply has its own durable ID and one active reply per source; another teammate cannot reply or approve displacement. The CRM mirrors owner approval, edits, completion, cancellation and Undo. Completion clocks clear on Undo; cancelled, declined and unbooked records soft-hide after 24 hours without becoming completed work or losing their source history.

The UI checks sync health every 30 seconds and warns after two minutes without a fully caught-up result, or after a worker error. Pending/rejected confirmations survive reload, paginate with an ID cursor, and permit explicit dismissal of rejected attempts. My Day and captured daily summaries include linked planned/in-progress/waiting work and exclude pending/closed requests. Assignment-email suppression remains at the SQL enqueue boundary.

CRM now exposes its authenticated client directory as paginated IDs/names and provides Copy Calendar client ID in each client panel. Bryan still selects the actual Calendar client and confirms the mapping in owner-only settings. Name/alias matches remain suggestions. A connection UUID is pinned once enforced and cannot be replaced while retaining history; credential rotation keeps the same UUID and cursor.

Daily maintenance expires abandoned CRM reviews after one day, deletes cancelled never-dispatched reviews after seven more days, and invokes bounded Calendar preview cleanup. Submitted operation, reply, source and closed-ID history remains intact.

### Verification and rollout boundary

- Calendar: **1,385 tests passed in 72 files**, plus lint, type checking and production build. Three rollback-only SQL suites passed, including closure/replay, private grants, invalid credentials, bounded cleanup and prepared-preview retention.
- The real TypeScript planner/repository/Supabase smoke passed simultaneous duplicate booking, competing-slot scheduling and settlement-versus-booking races, replies, owner-approved displacement and queued-only notifications. Its generated local accounts/workspace/operation fences were removed afterward.
- CRM: **71 unit/contract tests and seven Chrome browser scenarios passed**, with build/syntax checks and rollback-only SQL tests. Coverage includes leases, cursor gaps, atomic page rollback, identity pinning, original-requester/concurrent replies, stale-event suppression, completion/Undo/decline, retention, daily summaries and mail suppression. Desktop/mobile screenshots were visually inspected and the local fixture had no browser errors.
- Browser tests run the real CRM UI, gateway and worker with explicitly fictional adapters. SQL tests separately exercise actual functions in the isolated local ADA database, rolling the entire CRM schema back. The two actual local HTTP/auth/database stacks together are still **Phase 5**, including restart, credential rotation/revocation, protected-time and cross-system failure/release checks.

Deploy Calendar's schema/API first, then CRM's compatible schema/server/UI, with activation disabled. CRM `deploy/calendar-sync.sql` must follow both `calendar-integration.sql` and the existing `my-day-emails.sql`; use each repository's existing reviewed migration path. In a later separately approved rollout, pin the connection and confirm mappings, enable enforcement with accepting paused, start sync and verify catch-up, then enable new assignments. Pause acceptance without dropping enforcement or history. No push, merge, production migration, deployment, activation or real send occurred in this checkpoint.
