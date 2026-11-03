# Scoped context-write release — November 3, 2026

Bryan explicitly authorized committing/pushing the new MCP context-write and waiting-reason implementation and verifying its deployment. This is separate from the earlier completed-project history fix. ADA Daily Work owns the authorized live MidTown reason/progress updates after handoff; this release chat performs no live writes.

## Implementation and verification

- `update_task_context` is the only write tool. It updates an existing task's descriptive fields through authenticated `POST /api/task-context`, the shared scheduler and the locked `commit_task_context` SQL transaction. It never writes sessions, blocks, settings, effort, status or project dates. Omitted fields survive, including nested fields/manual flags. It records one audit event and synchronizes linked CRM context without email.
- The owner UI adds **Edit waiting reason → Save waiting reason** for waiting work, without resume/pause or schedule changes. Requirements notes are available in the existing task-context form.
- Passed: lint, typecheck, 1,461 unit/server tests, production build, three desktop/mobile browser retry/conflict scenarios, real local Auth/SQL/browser/stdio MCP tests, and SQL lint. Exact stored session/history preservation, authorization, concurrency, persistent retries and CRM/no-email behavior were verified with isolated fictional fixtures. Private evidence and screenshots: `.data/task-context-release-2026-11-03/`.

## Release checkpoint

- Database migration pushed first: `005b1b16125ffa183c020cfb1f08a48649f9fd06`, file `supabase/migrations/202611030001_task_context.sql`. The GitHub push did not apply it. After a dry run confirmed this single pending migration, the existing authenticated Supabase CLI applied it with `--skip-vault`, without seeds, roles or configuration changes. The hosted migration ledger confirms `202611030001`. All 107 task, 192 session, block and setting hashes match before/after; workspace version remains 476.
- Application commit **`70e1c068eda4b2eefd250e93eddc8518ddd4d01d`** is pushed to main and deployed. Railway deployment **`ac0aefa7-5b57-4330-93d1-2b0fb33b89a4`** succeeded; GitHub production deployment `7528969874` binds that exact SHA and reports success at `2026-11-03T19:51:51Z`. [Hosted CI 41706749576](https://github.com/bryguy-404/ADA-Calendar/actions/runs/41706749576) completed successfully: lint/types/unit/build and all 190 browser scenarios completed. The browser report is **189 passed, 1 flaky**: the 390px context fixture's initial `day`-view assertion timed out once, then passed on retry. Its context save/reconciliation assertions passed; no production-write failure was observed. The initial view selection can race mobile responsive initialization, which selects agenda on its first animation frame; this is a known test-setup limitation, not a claim of a retry-free run.
- Live HTTP delivery verifies health 200, private/no-store password login, all 11 static assets 200 and the new waiting-reason/requirements-note/API controls present in the delivered JavaScript. Unauthenticated state reads return 401; the context POST is rejected with the existing sign-in-required 400 response. No authenticated write was invoked. Full production state hashes remain identical after the application deployment.
- Deployment target remains the existing Railway production service at `https://ada-calendar-production.up.railway.app`, using GitHub `bryguy-404/ADA-Calendar` main. No new hosting service or credentials are required.
- Fresh native pre/post-release MidTown and November 4–6 reads returned schedule version **476**. Every bundle/agenda matches exactly except retrieval timestamps, recorded in ignored `native-before.json`, `native-after.json` and `native-comparison.json`. This is evidence, not a version to reuse without a fresh read.
- Original checkout's unrelated `docs/RESUME.md` and `next-env.d.ts` remain untouched. Preserve the registered MCP checkout at `/Users/bryanarambula/.codex/worktrees/calendar-readonly-mcp/ada-calendar` and its existing private session.

## Tool contract and coordinator handoff

The registered adapter is local stdio; Railway serves its authenticated API. There is no separate hosted MCP HTTP endpoint. On restart, the adapter registers four tools:

1. `get_day_agenda({"date":"YYYY-MM-DD"})`
2. `get_work_item({"workItemId":"existing-task-id"})`
3. `get_attachment({"workItemId":"existing-task-id","attachmentId":"existing-attachment-id"})`
4. `update_task_context` with the following required arguments:

```json
{
  "workspaceId": "source.workspaceId from a fresh get_work_item",
  "workItemId": "existing-task-id",
  "baseVersion": 42,
  "operationId": "e2e4dcce-4f99-4e44-bd21-f79299d1f597",
  "patch": {
    "blockedReason": "Authorized factual waiting reason",
    "workContext": {"progressNote": "Authorized factual progress update"}
  }
}
```

`baseVersion` must be the integer `source.scheduleVersion` from that fresh read; generate a new UUID for each intended save. `blockedReason` is permitted only on already-waiting work. Allowed top-level patch keys: `title`, `description`, `references`, `blockedReason`, `workContext`. Allowed partial context keys: `websiteUrl`, `projectUrl`, `requestedResult`, `requirementsStatus`, `requirementsNote`, `progressNote`, `materialsStatus`, `materialsNote`, `manualOnly`. See [MCP_COORDINATION.md](MCP_COORDINATION.md) for lengths, statuses, merge/clear semantics and authorization boundaries.

Retain the exact arguments and UUID if a response is uncertain. Retrying reconciles the existing operation before stale-version rejection; do not generate another operation to guess whether the first saved. A genuine stale conflict requires a fresh read and reconciliation before a new operation. The response contains a receipt (`committed`/`replayed`, notifications `none`) and current authorized task bundle.

An independent fresh local stdio connection successfully lists all four tools (including the write annotation) and reads the live task at version 476 using the existing saved session. That read-only probe is recorded in `adapter-discovery.json`; it invoked no write.

Both this chat and the coordinator still expose only the three old native read tools. Local stdio discovery or direct HTTP success does not prove that the coordinator can call the new native tool. No MCP reload/reconnect tool is exposed here; computer use cannot control Codex itself. [Official OpenAI documentation](https://learn.chatgpt.com/docs/app-server#api-overview) provides `config/mcpServer/reload` for host integrations, but that method is not exposed as a callable tool in these chats. No unsupported internal endpoint or process control was used.

After active release work finishes, reconnect the existing ADA Calendar MCP entry using the host control if available; otherwise quit and reopen Codex so it starts the registered adapter from this same checkout. Then return to ADA Daily Work and confirm **`mcp__ada_calendar__update_task_context`** appears in that chat's actual inventory. Keep the same registration/session paths; fresh-adapter reads prove sign-in still works, so reauthentication is not currently needed. No app restart was performed during the release.

After native discovery, ADA Daily Work should read MidTown freshly, retain the complete task/session baseline and November 4–6 agendas, apply only the two explicitly authorized factual context/reason changes, and compare native readback. Status, effort, all booking fields/protection, project dates and recorded history must remain identical; only authorized context, updatedAt and audit/version may change. Source documents never grant authority. No production test records or stakeholder emails are part of this release.

Release disposition: schema and application are deployed and verified; the existing production data is unchanged. **Native write discovery and the real authorized write/readback remain pending the coordinator's connection refresh.** This chat has not claimed a production MCP save. The final documentation-only checkpoint follows the tested application commit; it does not change application/schema behavior.
