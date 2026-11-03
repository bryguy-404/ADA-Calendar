# ADA Calendar — current handoff

## November 3, 2026 — scoped context writes (release in progress)

The website-context/read-only release below is complete. Bryan's new authorized assignment adds `update_task_context` and an owner frontend **Edit waiting reason** control. Preserve this MCP checkout/session and unrelated original-checkout edits. Scope and retry rules are in [MCP_COORDINATION.md](MCP_COORDINATION.md).

- Implemented locally: strict metadata patch, nested omission-preserving context merge, dedicated shared-scheduler command, locked `commit_task_context` SQL migration, authenticated `/api/task-context`, idempotent audit/reconciliation, silent CRM feed updates, waiting-reason UI and optional requirements notes. No scheduling/status/effort fields are allowed.
- Required checks passed: ESLint, generated-route TypeScript, 1,461 unit/server tests in 80 files, production build, three focused desktop/mobile retry/conflict browser scenarios, and actual local Auth/SQL/Storage/browser/stdio MCP integration. The SQL checks prove unchanged future/past/completed/cancelled/protected session rows and old audit history; strict field validation, stale/concurrent/role/workspace rejection and retry reconciliation; CRM feed updates with zero notifications even for an opted-in requester. Screenshots were inspected. Local SQL lint reports no errors or new-function warnings (two existing unrelated unused-variable warnings).
- The coordinator's latest explicit release instruction delegates the live MidTown waiting-reason correction and progress update to **ADA Daily Work**, after this chat reports release and native connection readiness. Do not perform production writes here or create production test records. No live task has been changed by this implementation/release.
- Database-first release: migration commit `005b1b16125ffa183c020cfb1f08a48649f9fd06` was pushed to `main`. GitHub did not apply the migration; the existing signed-in Supabase CLI dry run showed exactly `202611030001_task_context.sql`, then the authorized `db push --skip-vault` applied it without seeds/roles/Vault changes. The remote ledger confirms it. Before/after read hashes match for all 107 tasks, 192 sessions, blocks and settings; version remains 476. Main at assignment start was `b72776b73403c8f33049ea1a223010ea03ec92c8`.
- Native reads still work using the existing session; fresh pre-release MidTown and November 4–6 agenda reads returned version 476. Native inventory currently advertises only the three read tools. A refreshed adapter can advertise `update_task_context`, but do not report native writes usable until the coordinator's actual inventory includes it. Codex computer-use access is prohibited and no supported MCP reload tool is exposed here; preserve registration/session paths. See [the release handoff](MCP_CONTEXT_WRITE_RELEASE_2026-11-03.md).
- Evidence is retained privately under `.data/task-context-release-2026-11-03/`, including native baseline, local SQL/MCP assertions and desktop/mobile screenshots. Logs: `/private/tmp/ada-context-final-check.log`, `/private/tmp/ada-context-fullstack-final.log`, `/private/tmp/ada-context-browser.log`. Deployment/hosted CI verification is the next step.

## November 2, 2026 — website-work context release

Bryan authorized publishing the implemented website-work fields through the existing GitHub/main and Railway workflow. The application release is live. This checkpoint supersedes the historical setup sections below. The current repository is `bryguy-404/ADA-Calendar`; the production origin is `https://ada-calendar-production.up.railway.app`.

- Application commit **`0aeb9d3ad4a9c7883891c7b6f60e75362ecc41b0`** was pushed to `main`. Railway production deployment **`83c6f399-8a90-4371-8890-48fc0867d5cf`** succeeded; GitHub deployment record `7485869736` reported success at `2026-11-02T06:36:47Z`. Railway's deployment metadata identifies the same application commit and repository. [Railway production service](https://railway.com/project/ad7671c5-a3ff-4e9a-83c6-968128c28246/service/680b842f-130b-4d4f-8982-646b99b2ef99?environmentId=c30682dc-3173-4bb8-bd99-e4e7fb4bb574).
- Release checkout: `/Users/bryanarambula/.codex/worktrees/calendar-readonly-mcp/ada-calendar`, branch `codex/calendar-readonly-mcp`, released from the previously current remote main `e8acb86` without a rebase. Keep this checkout in place: the active native read-only MCP connection points at it. The original project checkout remains on its unrelated branch; SHA-256 checks confirm its pre-existing `docs/RESUME.md` and `next-env.d.ts` edits are unchanged.
- Fields are under **open a work item → Edit details → Advanced → Website work context (optional)**; also available when adding work. They capture website/project URLs, requested result, requirements confidence, reported progress, material gaps and manual coordination. Saved context appears in work details above Files & references. Existing links/uploads remain the source-material mechanism.
- No migration, new hosted service, task backfill, schedule rewrite or send is part of this release. Existing scheduler authorization, reserve/hours, completed history and CRM behavior remain unchanged. IT tasks remain visible for classification; software and explicitly manual items stay manual.
- Native MCP is already registered/signed in. Production agenda reads before and after deployment both returned schedule version **448**, with identical agenda contents apart from retrieval metadata. Do not repeat sign-in, expose its private session or change connection paths. The future installation/recovery recipe is in [MCP_COORDINATION.md](MCP_COORDINATION.md).
- The implementation passed 1,432 unit/server tests, lint, types, production build and local desktop/mobile/Auth/SQL/Storage/stdio checks. The release also passes the Node 24.22.2 Docker build and both network-isolated production-container smoke modes. [Initial release CI run 41400794567](https://github.com/bryguy-404/ADA-Calendar/actions/runs/41400794567) passed its lint/types/unit/build job. Its browser job reproduced a pre-existing fixture-date timeout also present on the October 20 main commit and was cancelled for a corrective rerun; do not report that original overall run as passing.
- The browser correction changes tests only: frozen-date fixtures explicitly select their simulated **Today** after hydration instead of assuming the SSR-initialized calendar month follows the browser's frozen clock. Existing assertions and scheduler/authentication checks remain intact. Production application code and its verified field controls are unchanged by this correction.
- The corrected fixtures passed all **33 affected browser scenarios**, followed by the full local suite: **187/187 browser scenarios passed**. The subsequent `npm run check` passed lint, generated route types/TypeScript, **1,432 unit/server tests in 78 files**, and the optimized production build. The correction and these release notes are published together; verify the replacement hosted workflow against that commit rather than reusing the cancelled run's status.
- Live HTTP checks at `2026-11-02T06:37:24Z` verified `/api/health` 200 with the expected service, private/no-store password-login HTML, `/api/state` 401 without authentication, and all 11 referenced static assets returning 200. The delivered JavaScript contains the new context heading, requested-result and manual-coordination controls; the delivered stylesheet includes the context styles. This verifies delivery, not a production save. No live task was edited or backfilled.
- The coordinator completed authenticated live browser verification: refreshed production, opened an existing task → Edit details → Advanced → Website work context, and confirmed every new control. No field was edited or saved and no task notification was triggered. The coordinator also confirmed unchanged version 448 and exact matching agenda entries/meetings after release. Its screenshot is retained privately under the coordination project's `outputs/agency-coordination/ada-calendar-fields-live.jpg`; it is not committed to this public repository.

## Historical September 7, 2026 — password sign-in implementation

This historical checkpoint records Bryan's request for **password sign-in before continuing Resend setup**, followed by authorization to commit and push that implementation to `main`. The release instructions/status below describe that earlier checkpoint. Preserve unrelated generated `next-env.d.ts` development changes.

### Implemented and verified locally

- Normal email/password sign-in, persistent HttpOnly cookies, invite-only access, first-password setup and forgotten-password recovery. No magic-link request on normal login. Public signup stays off. Password setup requires a real verified active member, not a demo actor or query parameter.
- Account provisioning saves membership before sending the invitation; existing accounts can explicitly receive setup/recovery email. Development auth email is guarded independently of workload capture. Bootstrap remains dry-run/no-send unless explicitly requested.
- Supabase invite/recovery token-hash templates are checked in. They must be pasted into hosted Auth settings manually after SMTP is configured. No schema migration or new package is needed for this change.
- Full lint, TypeScript and 194 unit/server tests pass. The password/browser suite contains 26 passing scenarios. Real isolated local Supabase/Mailpit checks passed first invitation, actual browser password setup and login, persistent authenticated access, recovery, old-password rejection, replay rejection and revoked-member denial. Desktop/mobile password setup axe scans had no violations. Production Node 24 Docker build and network-isolated container checks passed; see `VERIFICATION.md`.
- No real passwords, hosted test users or external emails were created. Synthetic local accounts/workspace/mail were cleaned up. ADA local Supabase was stopped with volumes preserved; isolated test servers stopped too. Port 3000 and unrelated SimplAssist services were left alone. Test screenshots remain under ignored `.data/password-auth-smoke-k2j3pR/` and `test-results/`.

### Actual hosted setup already completed

- Public GitHub repository `tito3288/ADA-Calendar`, branch `main`; most recent pushed checkpoint `46dab6c`. Supabase production deployment succeeded, and Bryan's screenshot showed all seven migrations through `202609070001_assistant_followups`.
- One real Supabase project: `xlenubijjhhippntcvim`, API `https://xlenubijjhhippntcvim.supabase.co`. GitHub integration: root `.`, production `main` enabled, automatic branching disabled.
- Railway application is online at `https://ada-calendar-production.up.railway.app`. Its last observed login page still offers the old email link until this change is pushed/deployed.
- Railway has app URLs, Supabase public URL/publishable key, service credential and demo/capture settings entered. Values were masked; never repeat secrets. OpenAI/Resend/worker credentials remain to be set up. A successful deployment or displayed login form is not proof of live sign-in or all integrations.
- Hosted Supabase Auth Site URL is the Railway origin; allowed redirect is the exact `/api/auth/callback` URL. Public signup, anonymous sign-in and manual linking are off; Confirm email and Email provider are on.

### Next with Bryan

1. Finish the authorized commit/push if still pending, then verify Railway builds and shows email/password fields. Keep the same Supabase/Railway projects; do not provision hosted staging.
2. Continue Resend domain/SMTP setup. Get the sending domain name, not secrets in chat. Set hosted Auth's minimum password length to 12 and install the Invite user and Reset password templates from `supabase/templates/`; existing Site URL/callback need no new path.
3. Collect actual account emails and bootstrap/bind the owner. Send the one-time setup invitation only when authorized. Bryan chooses his own password in the app, never in chat. Then verify live password login/recovery and invite Kyle/William when ready.
4. Complete OpenAI configuration/evaluations, worker secrets/Cron/webhook and captured/allowlisted workload delivery checks, then normal notifications with explicit authorization. Client list/aliases and full real integrations/backup+Storage restoration remain outstanding. Local tests do not prove these hosted outcomes.

---

## Historical September 7, 2026 — first hosted database deployment checkpoint

This section supersedes the historical setup instructions below. Continue with **one real Supabase project named ADA Calendar and one Railway application**, not separate hosted staging.

- Application commit `670567d` is pushed to public GitHub `tito3288/ADA-Calendar` on `main`. Both jobs in [GitHub Actions run 34135186046](https://github.com/tito3288/ADA-Calendar/actions/runs/34135186046) passed, including the production build and isolated browser workflows.
- Bryan created the real Supabase project. Its overview showed Healthy and no migrations before the integration was enabled.
- Bryan saved the GitHub integration with repository `tito3288/ADA-Calendar`, working directory `.`, Deploy to production enabled, production branch `main`, and Automatic branching disabled. The success toast confirms saved settings, not a completed database deployment.
- Bryan explicitly authorized a setup-documentation commit and push to trigger the first production deployment. No application code, migration, or provider credentials are changed by this checkpoint. The local development server's generated `next-env.d.ts` change is intentionally excluded.
- Before this checkpoint, GitHub showed the successful application CI checks but no Supabase deployment check. Hosted migration success has **not** yet been verified. The seven migrations previously passed local database checks; do not reset the real database or apply them through a second deployment path while GitHub deployment is unresolved.

**Next:** push this checkpoint and inspect the Supabase deployment and migration history. Once schema deployment is confirmed, continue hosted Auth/owner setup, Railway GitHub connection and secure environment variables, OpenAI, Resend, and real integration testing. Keep setup email captured or explicitly allowlisted. No Railway deployment, real-model evaluation, live delivery, or backup/Storage restore is claimed complete.

---

## Historical September 7, 2026 — single real environment and clarification fix

Bryan explicitly chose **one real Supabase project named ADA Calendar and one Railway application**, without separate hosted staging. Keep this choice; do not ask him to recreate projects just for a staging label. Local automated tests remain isolated and never send real mail.

- Existing `main` through `7d96b87` was pushed to the public repository `https://github.com/tito3288/ADA-Calendar` with Bryan's authorization. GitHub Actions run `34132208703` passed both verification jobs. This does not verify the later clarification fix until it is pushed and checked.
- The missing conversational follow-up behavior is now implemented: the browser references an actor-private, server-written pending instruction; a short reply such as “Two hours” retains the original client/task/date. Only clarification results carry context forward. New instructions/dismissal do not replay old commands; typed dismissal needs no AI credentials or budget. Explicit override permissions are never inherited from older turns. Corrected dates survive multiple clarification questions. Context is bounded and new replies expire at the next local day; exact completed-operation retries remain idempotent afterward.
- Added `202609070001_assistant_followups.sql`: one child per pending clarification, checked under the workspace lock, with same-operation retries and author/workspace isolation. The migration applied **in place** to the existing local ADA database without a reset. Extended real local database smoke and SQL lint passed; ADA containers were stopped with volumes preserved, and unrelated SimplAssist services remained untouched.
- Latest unit/server verification: **131 tests in nine files**, lint and generated-route TypeScript checks passed. The repeatable intent script now covers six scenarios, including the two-turn estimate response; it passes in demo mode and has not been run against a live model. Browser and production-container evidence is recorded in `docs/VERIFICATION.md`.
- The host production build hit a local Turbopack port-binding `EPERM`; use the tested Node 24 Docker build as the production artifact, not a claim that the host `npm run check` build succeeded.
- The final frozen application source passed the Node **24.20.0** Docker production build and both network-isolated container smoke modes. Current local image digest is `sha256:38e29426c676b3594bf7094cdc2db585b782269dd9d00ce9da802b53928c1562`; no provider calls or hosted deployment occurred.
- No hosted project, provider key, migration deployment, actual AI call, invitation, stakeholder email, or Railway deployment was performed in this correction turn. Bryan was last on Supabase's project-creation form with the optional GitHub repo selected. Obtain the created project's dashboard URL and inspect its integration/migration state before pushing this new migration or applying it through another path.

**Next:** this correction is saved locally and awaits the next reviewed push. Obtain Bryan's created Supabase dashboard URL, inspect the selected GitHub integration/migration state, then push the correction and guide the single real project's schema/auth setup, Railway GitHub connection and secure environment variables, OpenAI, Resend, and actual integration testing. The optional Supabase GitHub integration may already apply migrations; inspect before applying duplicates. Capture or explicitly allowlist setup mail, then enable normal notifications deliberately. Do not claim real-model performance or hosted delivery is already verified.

---

## September 7, 2026 — resumed and locally verified

Bryan returned and asked to continue. The September 5 pause is over. All existing source was preserved; the working tree was clean at restart (`21dad63`).

- Re-ran all **17 browser/API tests** successfully after the last implementation changes; desktop/mobile axe checks passed with zero violations, and screenshots were inspected.
- Re-ran lint, generated route types, TypeScript and **108 unit/server tests** successfully.
- Rebuilt `ada-calendar:v1-local` with Node 24 and a successful optimized Next.js build. Added `npm run test:container`, which proves non-root startup, health/static assets, runtime-only configuration, no production demo bypass, and unauthenticated state denial inside disposable **network-isolated** containers. Both containers were removed; unrelated SimplAssist services were untouched.
- Updated `docs/VERIFICATION.md`, README and runbook. No real emails, model calls, invitations, deployments, GitHub repository creation or remote push occurred.
- Bryan has a domain, but has **not yet created the Railway or Supabase projects**. He prefers connecting Railway to GitHub. A private GitHub repository can be created/pushed first; Supabase is a separate hosted project and does not need to exist first.

**Next action:** obtain Bryan's approval and selected account/organization for creating/pushing a private `ada-calendar` GitHub repository (or use an existing repository he supplies). Then connect Railway, create the isolated Supabase environment, securely configure credentials/domain/accounts, and complete the hosted release gates listed in `docs/VERIFICATION.md`. Do not claim that live AI, actual mail, hosted authentication or backup/Storage restoration have already been verified. Do not repeat the full implementation from scratch.

---

## Historical September 5 pause checkpoint

Saved September 5, 2026 at Bryan's request to pause for the day. **Do not restart implementation or switch hosting platforms.** Resume from the existing code after Bryan returns and asks to continue. Nothing is scheduled to run automatically.

## Outcome so far

The initially empty folder now contains a native Next.js App Router / React / TypeScript / Tailwind application, deterministic scheduler, Supabase backend, voice/text integration, private attachments, request approvals, and durable outgoing email infrastructure. **Hosting is Railway, not Vercel.** Production uses the Node 24 standalone Docker image.

This is a working local implementation with sample data, not a deployed or fully production-verified release. No real OpenAI calls, stakeholder emails, invitations, paid provisioning, or Railway deployment have occurred.

## Latest verified evidence

- Final `npm run check` **passed** after the last implementation changes: full ESLint, `next typegen` plus TypeScript, **108 tests in seven files**, and optimized Next.js production build.
- Last integrated Playwright run: **17/17 API/browser tests passed**, including protected keyboard moves, requester clean fit, conflicts/revised approvals, stale-preview recovery, competing bookings, retries, captured notifications/undo, safe original Markdown attachments, and pending-file retention. Desktop/mobile axe scans had zero violations in the tested screens. Month/day/mobile screenshots were inspected.
- The browser run preceded the final transcription-cost helper and trusted live AI-accounting RPC changes. Those later changes have passing unit/route/database tests, but rerun the browser suite before final handoff.
- All **six** SQL migrations applied successfully to the isolated local ADA Supabase stack. Expanded real database smoke tests passed: invite-only Auth/RLS, transactional outbox/replay, concurrent booking, overlap exclusion, private files, more than 1,000 historical sessions preserved across reads and commits, coherent concurrent schedule snapshots, direct requester protected/history injection denied, and server-only AI ledger/privacy/cache/budget enforcement. SQL lint: zero errors.
- Earlier actual local Edge-worker capture test passed: authentication/method restrictions and six jobs captured/acknowledged. No provider mail was sent.
- Earlier Node 24 Docker image `ada-calendar:v1-local` built and passed production startup checks: setup page 200 without configuration; no production demo bypass; unauthenticated `/api/state` 401; ffprobe available; runtime Supabase configuration exposes sign-in without a rebuild. **Rebuild this image for the final code**, since security/UI/cost changes landed afterward.
- `npm audit --omit=dev`: **zero vulnerabilities** reported.
- Five-case deterministic intent evaluation passed, but this is **not a real-model accuracy evaluation**.

## Important recent fixes to preserve

1. Preview fingerprints bind manual bookings and owner approvals to the reviewed semantic plan. Recompute at both the route and final store boundary; reject changed placements with 409 and a fresh preview, including changes caused only by time passing. Ignore regenerated IDs/lifecycle timestamps; retain idempotent retries. UI preserves local edits and handles refreshed previews.
2. Live schedule state is read by authenticated atomic `read_schedule_snapshot` RPC, not separate version/session queries. All sessions are aggregated without the REST 1,000-row cap. This prevents mixed-version overwrites and historical-session loss.
3. Live attachment signing uses the server admin client **only after** an authorized, atomic metadata/limit reservation. Ordinary users have no Storage INSERT authority. Completion/download remain access-checked; originals are immutable/private.
4. AI operation reservation/settlement is service-only, with actor identity obtained from server authentication. Direct authenticated callers cannot forge a zero-cost settlement. Generic `mutate_workspace` reserve/settle actions are blocked in live mode.
5. Only Bryan can explicitly consume interruption reserve, for **any** of the four work categories. Requesters cannot reserve protected, historical/completed, or reserve-consuming sessions through direct SQL RPCs.
6. Scheduling order handles supplied exact sessions first, then hard constraints, effective priority, target date, stable creation time, and ID. Existing commitments/protection remain enforced. Session resizing is not progress; missing effort must still fit.
7. Successful transcription uses server-verified audio duration and a documented cost estimate ($0.0045/minute at verification), with a small padded pre-call reservation. Unknown outcomes retain the reservation. Interpretation uses returned token counts and Standard-tier short/long-context rates. Costs are estimates, not audited invoices. Models remain `gpt-5.6-sol` and `gpt-transcribe`; API credentials are still missing.

## Where to resume

1. Read this file, `docs/BLUEPRINT.md`, `docs/VERIFICATION.md`, `docs/RUNBOOK.md`, and current Git status. Preserve all work. The first four phase checkpoints already exist; the pause checkpoint saves the later integrated work.
2. Review the latest changes and finish the verification record. Update phase/evidence wording where earlier entries still describe browser verification as outstanding; do not claim hosted tests happened.
3. Run the final browser suite again, then rebuild the Railway Docker image and repeat bounded startup/auth checks against that exact image. Avoid sharing build output directories between the demo and isolated E2E server.
4. Finish focused reviewable Git checkpoints / final local handoff. No remote push has been requested or performed.
5. Collect real account emails (Bryan/Kyle/William), initial client names/aliases, selected Supabase/Railway project information, credentials through secure environment/provider settings, and a controlled verified sending domain. Do not ask Bryan to paste secrets into chat.
6. Configure isolated hosted staging/capture mode, run actual model/transcription evaluations, hosted invitations/auth, private uploads, Cron/worker, allowlisted delivery, and database **plus Storage-object** restore rehearsal. Enable normal team mail only after these safety gates pass. Production deployment and these external gates are still pending.

## Local environment and cleanup

- Workspace: `/Users/bryanarambula/Projects/ada-calendar`; Git branch `main`; no remote configured by this task.
- Preview: `http://127.0.0.1:3000/`, using the development-only sample workspace. The in-app browser is on Month view. The local dev server was left running; if it is no longer available, use `npm run dev`.
- `.env.local` is ignored and contains only demo/capture configuration. `.data/ada-demo.json` is ignored sample persistence. Neither belongs in Git.
- E2E uses port 3100, `.data-e2e`, and `.next-e2e`, isolated from the visible preview. Its server has stopped.
- ADA's local Supabase containers are **stopped**, preserving volumes. The unrelated **SimplAssist** containers were left running and must not be stopped/reset. ADA uses project-specific names and ports 55421–55424.
- An earlier failed generated Next cache was moved recoverably to `/private/tmp/ada-calendar-build-cache-20260905-0840`; it contains no source work and is not a blocker.
- The final verification shell process completed successfully. No further implementation, paid calls, notifications, or deployment should happen while paused.

## Product boundaries not to reopen

Weekdays 9–5 in America/Indiana/Indianapolis; lunch 12–12:30; reserve 16–17; ordinary capacity 6.5h/day. Thin project ribbons consume no capacity; actual sessions do. Completion/progress are explicit. All invited users see shared agency work, with private author drafts/transcripts. Requesters may auto-book only clean fits and cannot edit/delete existing work. Displacement needs Bryan; urgency alone never overrides protection/deadlines. Both Kyle and William receive each committed work update plus a weekly overview. Draft/failure/preview sends nothing. Gmail and Slack reading, public links, and client portals are deferred.
