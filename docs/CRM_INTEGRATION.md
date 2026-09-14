# ADA Calendar / ADA CRM integration

## Approved outcome and implementation order

Calendar remains the authority for Bryan's capacity, booked work and approval decisions. CRM asks Calendar whether a new assignment fits, then displays Calendar's result. Work that fits can be booked and appear in both systems. Work that would move another commitment waits for Bryan's approval; protected time needs his explicit override.

Both applications keep their own repositories and deployments. Build Calendar's API first, connect the CRM second, and verify the complete flow before enabling it in the existing Railway/Supabase environments.

| Phase | Deliverable | Checkpoint |
| --- | --- | --- |
| 1. Secure foundation | Connection authentication, verified CRM requester identity, private source and operation records, connection check | Implemented locally; integration disabled |
| 2. Calendar scheduling API | Owner connection/client setup, capacity and previews, clean-fit booking, approval requests, replies, operation lookup and atomic change recording | Next |
| 3. CRM connection | Server API client, task form fields and review, guarded task creation/reassignment, linked task display | Pending |
| 4. Synchronization and recovery | Durable submissions, background changes polling, owner decisions and edits reflected in CRM, retry/reconciliation and notification coordination | Pending |
| 5. Complete verification and rollout | Two-application local scenarios, failure recovery, reviewed releases, controlled activation and rollback | Pending |

Each phase ends with a reviewable diff and its applicable checks. A foundation checkpoint does not demonstrate that the two deployed applications are connected. No CRM application code changes are included in Phase 1.

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
  "capabilities": ["connection_check"]
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

## Remaining implementation requirements

### Calendar API and approval flow

- Expose availability, previews, bookings, requests, replies and operation lookup under the versioned API base. Accept task requests, never caller-supplied schedule snapshots, actor roles or override commands. `src/lib/crm-integration.ts` holds the initial strict input contract.
- Add owner-only connection provisioning/rotation/disable and mapping confirmation. Create the banned technical identity through trusted Auth administration without invitation mail. Do not enable a production connection as part of a migration.
- Use the shared scheduler for every fit, alternative and displacement preview. Include all saved blocks/reserve and usable future capacity. Extend exact-time conflict explanations where necessary.
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

## Local verification checkpoint — September 14

- Foundation migration applied only to the isolated local ADA Supabase database.
- `npm run test:crm-db`: rollback-only SQL fixtures prove private grants, technical principal isolation, owner-confirmed mappings, source attribution, operation replay checks, final-result immutability, ordered changes/rollback, credential budget/disable behavior and unchanged workspace settings/bookings. It sends no mail and refuses to target anything except `supabase_db_ada-calendar`.
- `npm test`: **1,329 tests passed in 66 files**. `npm run lint`, `npm run typecheck`, and the optimized `npm run build` passed. The build initially hit a sandbox port restriction; after moving aside the cached compiler failure, the permitted fresh build passed with the new status route included.
- Unit tests mock CRM Auth and the connection repository; no real agency credentials or real CRM sessions are used. End-to-end two-application and hosted verification remain pending.
- No UI changed in this phase. No live feature flag, remote migration, real booking, email, GitHub push or deployment is included.
