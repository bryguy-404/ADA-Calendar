# ADA Calendar operations

## Environments and prerequisites

The application runs on Railway as a Next.js/Node container. Supabase provides Auth, Postgres, private Storage, pgmq and the bounded email worker. Resend delivers transactional email. There is no Gmail or Slack reader in version one.

Bryan's September 7 decision is to deploy and test against **one real Supabase project named ADA Calendar and one Railway application**. Do not require or provision a separate hosted staging environment. Local automated tests remain isolated; hosted checks use the real configuration without treating the environment as disposable. This changes the environment plan, not the requirement to verify authentication, AI, uploads, scheduling, background processing and recovery before claiming them complete.

The daily interruption reserve is for unexpected work in any category. Only Bryan can explicitly authorize its use; requesters' automatic clean-fit bookings cannot consume it.

- Local development: Node 22.22+ or Node 24, npm, Docker/OrbStack for database verification. The Railway image uses Node 24.
- Production: Railway project, Supabase project, OpenAI API credentials, Resend credentials and a verified sending domain. API subscription costs are separate from consumer ChatGPT subscriptions.
- Account setup requires the actual owner and recipient email addresses. Never use the sample addresses as live recipients.
- `.env.example` documents app variables. Store real values in `.env.local` or provider secret settings; never commit them.
- `ADA_DEMO_MODE=true` is development-only. Production requires live authentication/configuration and fails closed when they are missing.
- Keep `EMAIL_MODE=capture` for local development and the initial real-environment setup. `test` only sends to `EMAIL_TEST_ALLOWLIST`; `live` must be set explicitly in the production worker after verification and Bryan's authorization to enable normal stakeholder delivery. Captured messages are not later replayed automatically.

## Local database and verification

Run `npm exec supabase start`. This project uses its own `ada-calendar` container names and ports:

| Service | Local URL/port |
| --- | --- |
| Supabase API | `http://127.0.0.1:55421` |
| Postgres | `127.0.0.1:55422` |
| Studio | `http://127.0.0.1:55423` |
| Captured authentication mail | `http://127.0.0.1:55424` |

The nondefault ports avoid other Supabase projects on 5432x. Do not stop/reset another project's containers. `npm exec supabase status` displays local development keys; they are not production credentials.

Apply migration changes to this disposable local database with `npm exec supabase db reset -- --local`. This resets the ADA local database, so export any local work you intend to keep first. Never pass `--linked` to a test reset.

`node --import tsx scripts/database-smoke.ts` verifies real authentication, database permissions, concurrent bookings, overlap constraints, operation replay, private uploads, trusted AI accounting, and pgmq acknowledgments. It also verifies atomic reads above 1,000 historical sessions and a subsequent lossless commit; planner state is read through one consistent JSON snapshot, not separate capped table requests. It refuses non-local/non-ADA endpoints, creates randomly identified fixtures, removes those fixtures afterward, and never calls an external email provider. Run application checks with `npm run check` and browser tests with `npm run test:e2e`.

`node --import tsx scripts/password-auth-smoke.ts` starts an isolated Next server on port 3201 against the already-running local ADA Supabase. It verifies the captured SMTP host before any send, exercises invitation/password/recovery/session flows with synthetic accounts and checks password-page accessibility. It never uses the hosted project or changes the user-owned port 3000 server. The local template's Site URL remains port 3000; the test validates its URL and transfers only the callback path/query to port 3201. It removes its own fixture users, workspace, captured mail and temporary build, retaining screenshots under ignored `.data/`. Never replace its local-only endpoint guards with hosted URLs.

For the additional local Edge-runtime gate, serve `notification-worker` with a local env file containing `EMAIL_MODE=capture`, `APP_URL=http://localhost:3000`, and the fixture-only `WORKER_SECRET=ada-local-fixture-only-worker-token`. Then run `ADA_WORKER_SMOKE=true node --import tsx scripts/database-smoke.ts`. It checks 401 for a missing token, 405 for GET, and captured/acknowledged queue delivery through the actual local function. This known fixture token must never be used in a hosted environment.

## Production database and owner setup

Review all files in `supabase/migrations` before deploying them in order to the selected Supabase project. Keep database migrations versioned with application releases. A migration rollback is a forward corrective migration or a tested restore, not a production database reset.

On September 7 Bryan saved the real project's GitHub integration with repository `tito3288/ADA-Calendar`, working directory `.`, Deploy to production enabled, production branch `main`, and Automatic branching disabled. Use this integration as the current migration deployment path: pushes to `main` can apply pending migrations and deploy the declared notification worker. Its [documented production behavior](https://supabase.com/docs/guides/deployment/branching/github-integration) does not apply local API/Auth settings or seed files by default. Configure hosted Auth separately.

The settings-save toast is not migration evidence. After a push, check the deployment result and hosted migration history before continuing; a passing application CI run alone does not verify the database. If the integration does not run or fails, inspect the reason before using a CLI fallback. Do not run two independent deployment paths for the same schema change. Keep an explicit migration review step even though there is no hosted staging project.

Disable public signup and anonymous sign-in; keep the Email provider and email confirmation enabled. Set Auth's minimum password length to 12. Configure Supabase Auth's Site URL and the exact allowed callback URL `<APP_URL>/api/auth/callback`. Configure custom SMTP (Resend SMTP is supported) before inviting real users; Supabase's built-in mailer is for development. Authentication emails and workload notifications are distinct flows.

### Password sign-in and email templates

Normal sign-in uses **email and password**, not a magic-link request. The browser retains a Supabase session in HttpOnly, SameSite=Lax cookies (Secure on HTTPS); the server refreshes sessions. Users do not need a new email every time they open the calendar. Signing out, cleared browser cookies or configured session expiry can require another password sign-in. Public signup remains disabled, and Auth identity alone does not grant workspace membership.

Initial invitation: recipient opens the email once, chooses a password, then signs in. Forgotten password: `/auth/forgot-password` sends a reset link only for an active member, with the same visible acknowledgment for known and unknown addresses. `/auth/password` requires a verified session and active membership, and its POST rechecks both. A password change requests global sign-out and clears this browser's session; already-issued access JWTs are subject to Supabase's token expiry, so do not describe this as immediate revocation of every access token. No passwords or auth tokens are returned in response JSON, workload events, or notifications. New passwords require at least 12 characters and at most 72 UTF-8 bytes (Supabase's bcrypt constraint); passwords are never trimmed.

In the hosted Supabase **Authentication → Email templates**, paste the checked-in templates manually:

- **Invite user:** [invite.html](../supabase/templates/invite.html), with `{{ .SiteURL }}/api/auth/callback?token_hash={{ .TokenHash }}&type=invite`.
- **Reset password:** [recovery.html](../supabase/templates/recovery.html), with `{{ .SiteURL }}/api/auth/callback?token_hash={{ .TokenHash }}&type=recovery`.

Set Site URL to the final app origin. The templates use a server-verifiable token hash instead of the default implicit-token fragment, so opening the link on another browser/device does not depend on a PKCE verifier in the original browser. Successful callbacks immediately redirect to a token-free URL; expired/replayed links show a fixed notice, never the provider error or token. Do not embed access/refresh tokens in query strings or logs. Same-browser PKCE recovery is also accepted. Legacy `type=email` callbacks remain compatible, but the application no longer offers magic-link login.

The local CLI loads these templates from `supabase/config.toml`; GitHub's production integration does **not** install hosted Auth configuration/templates. Verify hosted invite → password setup → password login → sign-out → login, plus recovery, before inviting the team.

`EMAIL_MODE=capture` governs workload mail, not Supabase Auth SMTP. During development, the shared Auth email guard permits only loopback Supabase (local captured SMTP) or `EMAIL_MODE=test` with an explicitly allowlisted recipient. In production, intentional invitations/recovery use the configured Auth SMTP independently. Never assume workload capture blocks authentication email.

Bootstrap is deliberately dry-run by default:

```sh
node --env-file=.env.local --import tsx scripts/bootstrap.ts --owner-email bryan@your-domain.com
```

Review its displayed target, then add `--apply` to create the owner/workspace records. This alone sends no invitation email. Add `--send-invites` only when intentionally sending password setup email after SMTP and templates are configured. Without `--invite-email`, the recipient is the owner; with it, only the specified teammate receives setup email. The dry run displays the target. Existing unconfirmed accounts receive an invitation; existing confirmed accounts receive a recovery link to set/change their own password. Rerunning with `--send-invites` is an explicit resend, not automatic mail on every bootstrap run. For a real send from a development shell, use `EMAIL_MODE=test` with the exact recipient in `EMAIL_TEST_ALLOWLIST` (or intentionally execute the production bootstrap with `NODE_ENV=production`); capture alone is not sufficient authorization. Add a teammate using `--invite-email`, `--invite-name`, and `--invite-role requester` or `viewer`. The owner cannot be demoted/invited as another role. Real client names/aliases are entered in Settings; the script creates only the Internal / Other client.

Bootstrap needs `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and `APP_URL` for invitation redirects. Its service key is never returned to the browser. Both bootstrap and the owner invitation API create/reuse the account **without sending**, save membership, then explicitly deliver the setup email. Failed multi-step provisioning can leave an unbound Auth account; it has no workspace access until membership is successfully created. Failed delivery can leave a valid bound account; retrying reuses that account and membership. Never remove existing accounts just to resend a setup link.

## Railway deployment

The source and migrations are in the **public repository `bryguy-404/ADA-Calendar`** (the older setup sections use its former `tito3288` owner). Publish authorized releases to `main` and verify the existing Railway application's actual deployment, not just Git push or CI success. Keep `.env.local`, recordings, sample persistence, workload data, and all credentials excluded. A public source repository does not make the application or its data public. Use the existing single application's [GitHub deployment workflow](https://docs.railway.com/quick-start), rather than provisioning another service. Supabase is the separate database service; its GitHub integration handles schema deployments independently of Railway and application CI. See [RESUME.md](RESUME.md) for current release evidence.

Deploy the repository using its Dockerfile. Configure `APP_URL` and `NEXT_PUBLIC_APP_URL` to the final HTTPS Railway/custom domain, public Supabase URL/key, and server-only Supabase/OpenAI/Resend secrets. Set `ADA_DEMO_MODE=false`. The app listens on Railway's provided port. Test the real integrations on this one application with captured or explicitly allowlisted mail before authorizing normal stakeholder delivery. No preview application is required; if one is introduced later, never connect it to the real database or live stakeholder mail.

Keep Supabase Auth session-refresh responses private and uncached. Invite-only application membership is checked at the server and with database RLS. Railway availability is not needed for already queued notification jobs because the worker lives on Supabase; links remain useful when the app is back online.

Before deploying a changed container, run:

```sh
docker build -t ada-calendar:v1-local .
npm run test:container
```

This checks the local image with no mounted files, no exposed host ports and no external networking. It creates only two uniquely named temporary ADA containers, then removes them. It checks Node 24/non-root execution, an arbitrary supplied port, health/static assets, ffprobe, no bundled local environment/demo persistence, production demo denial, and runtime configuration without rebuilding. It does not connect to real Supabase or verify Railway itself.

## Notification worker and Cron

Deploy `supabase/functions/notification-worker` to the same Supabase project. Configure these Edge Function secrets independently of Railway:

- `WORKER_SECRET`: a strong random value used exclusively to authenticate Cron invocations.
- `EMAIL_MODE=capture` initially, later `test` or `live` explicitly.
- `EMAIL_TEST_ALLOWLIST`, `EMAIL_FROM`, `RESEND_API_KEY`, and `APP_URL` as appropriate.
- Supabase supplies `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` to hosted functions.

JWT gateway verification is disabled for this one function because it validates the independent worker secret itself. The worker accepts POST only. An absent/incorrect secret receives 401; missing delivery credentials in test/live mode receive 503 before jobs are claimed.

Create a Supabase Cron job running once per minute that POSTs to `https://<project-ref>.supabase.co/functions/v1/notification-worker` with `Authorization: Bearer <WORKER_SECRET>`. Store the endpoint and secret in Supabase Vault and reference them from `net.http_post`; do not embed production secrets in migration files. Use the Supabase Cron dashboard and test its invocation with capture mode first. Configure one job, not duplicate jobs per app replica. Supabase Cron and `pg_net` are managed database extensions enabled through Supabase Integrations; they are not Node timers.

Each invocation processes at most ten jobs with an eight-second provider timeout per job. pgmq leases work for two minutes; a crashed worker leaves messages available for another invocation. The successful database transaction creates the schedule change, immutable work event, notifications, and pgmq message together. Rolling back the transaction creates none of them.

`queued` means persisted but unsent; `captured` means intentionally not delivered; `sent` means provider accepted; `delivered` means recipient mail server accepted; `bounced`/`failed` need attention. `uncertain` means the send outcome cannot safely be retried blindly. None prove the human opened/read the message.

Transient failures retry with backoff, stable idempotency keys, and a bounded attempt count. Resend deduplicates for 24 hours; this worker stops uncertain old jobs at 23 hours. Reconcile them with the provider dashboard and delivery logs before manually sending anything again. Never turn all captured/uncertain rows back into queued in bulk. Updating a row alone does not recreate its archived pgmq message.

The same worker checks the weekly schedule (Friday 15:00 by default, workspace timezone) and creates one summary per recipient/date. Stale pending upload reservations release their capacity after one day; uploaded originals are not physically deleted by that cleanup.

Set the Resend delivery webhook URL to `<APP_URL>/api/email/webhook` and configure `RESEND_WEBHOOK_SECRET` in Railway. Signature verification uses the raw body. Receipt IDs deduplicate callbacks; later callbacks cannot downgrade delivered mail to sent. Review the actual configured route before registering a provider webhook after route changes.

## Attachments and recovery

`work-attachments` is private. File metadata is reserved before a signed upload is created; pending plus ready reservations enforce five files/20 MB total per work item inside a locked transaction. Pending priority-request files are visible only to the request author and owner, then become shared work attachments when approved without changing item IDs. Completion verifies the stored object's size. URLs for downloads expire; public access is denied. Originals are immutable and upload URLs disable overwrite.

Removing an attachment marks metadata as removed. It does not delete the blob, so an operator can restore that row after checking work-item limits and permissions. Keep permanent deletion as an explicit retention/administration action. Do not delete objects by broad bucket prefix.

Supabase database backups contain attachment metadata, not the Storage object bytes. A complete backup plan must export both database data and the private attachment objects. Keep encrypted copies separately; save each object's exact key, content type, byte count, and checksum. Never place backups in a public bucket or repository.

To rehearse recovery, restore into an **isolated local Supabase instance** with email capture mode, no outbound SMTP/provider credentials, and no Cron delivery job. A second paid hosted project is not required. Keep the local destination separate from the real project's credentials and validate the destination before any restore or reset. Restore Auth identities/memberships, workspaces, events and queue state from a consistent database backup; document any managed-platform settings or roles that need separate recreation. Restore Storage objects at their original keys, then verify checksum and signed download of representative Markdown/PDF/image files. Verify role access, schedule version and overlap constraints. Protect the restored real data locally and keep it out of Git. Reconcile sent/provider IDs before any future live recovery so restores do not replay old mail. Test the app against the local restoration while leaving the real project unchanged.

This production-data backup-and-restore rehearsal has not yet been performed. Local migration resets and fixture tests verify application behavior, not recovery of the real project's data or its attachment bytes. Complete and record the isolated restore rehearsal and any limitations before treating recovery as verified; a local rehearsal alone does not establish every hosted recovery procedure.

## Budget and operational checks

Monitor Railway usage, Supabase quotas and OpenAI cost separately; the approximately $100/month target is not a universal provider hard cap. The application warns at $20 AI usage and reserves budget before calls against a $25 default ceiling. Unknown call outcomes retain the conservative reservation; manual scheduling remains available. A retry returns a private cached result or reports the still-processing/failed operation without creating another paid request.

AI operation creation and settlement are service-role-only database calls. The app verifies the signed-in actor before delegating; SQL then binds the operation to that active member and workspace. Browser-authenticated users cannot fabricate zero-cost settlements or cached provider results. Private operation reads remain author-scoped under RLS. The generic workspace-mutation RPC cannot bypass this accounting boundary.

The displayed AI allowance includes cost estimates and outstanding reservations, not an audited provider invoice. Successful text calls use returned token counts. Successful recordings use server-verified duration (rounded up to seconds) at the documented `gpt-transcribe` estimate of $0.0045/minute; the pre-call recording reservation includes a 50% margin and a one-cent minimum. Recheck [OpenAI pricing](https://developers.openai.com/api/docs/pricing) and reconcile actual provider charges during the live trial and after pricing changes. The app does not silently substitute another model when the configured V1 model is unavailable.

Supabase Pro's spend cap excludes compute and certain add-ons. Resend Free has a 100/day quota; two stakeholders consume two emails per event before owner/auth notices, so production Pro is usually appropriate for the chosen notification volume. Review pending/failed/uncertain notifications, Cron runs and storage reservations periodically.

Production credentials, real model accuracy, live delivery, and Railway deployment must each be verified explicitly during setup. Passing local tests does not establish those external outcomes.
