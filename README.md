# ADA Calendar

Bryan's shared workload calendar: protected focus, natural-language planning, capacity-aware requests, and a durable record of what changed.

The optional local [MCP connection](docs/MCP_COORDINATION.md) exposes a selected day's agenda, complete work-item context, authorized private materials and scoped owner-authorized context updates. Scheduling, effort and status changes remain separate. Its setup, deployment and native usability are documented separately from the web app.

## Local development

Use Node 24 (Node 22.22+ is compatible with the local tooling) and npm.

```sh
npm ci
npm run dev
```

Open http://localhost:3000. With `ADA_DEMO_MODE=true` in `.env.local`, development uses clearly labeled sample data, local persistence in `.data`, and captured notifications. The example people and work are not live commitments. Demo mode is disabled in production. Without live configuration, production shows a setup/sign-in screen and never exposes sample data as a real workspace.

Copy the keys from `.env.example` into your environment to connect Supabase, OpenAI and Resend. Keep API keys out of chat and source control. The app stays usable through manual controls when AI is unavailable. Actual OpenAI behavior requires a configured key and live evaluations.

## Verification

```sh
npm run test
npm run typecheck
npm run lint
npm run build
npm run test:e2e
```

Browser tests use isolated demo persistence and captured mail. Database tests require the local Supabase/Postgres runtime described in the runbook.

To verify the production image locally without contacting external services:

```sh
docker build -t ada-calendar:v1-local .
npm run test:container
```

The container check starts and removes only its own temporary network-isolated test containers. It does not deploy anything.

## Railway

This project deploys to **Railway**, with a Node 24 multi-stage Docker image and Next.js standalone output. Railway supplies `PORT`; the application listens on `0.0.0.0`. `/api/health` is the healthcheck. The database, private uploads, authentication and durable notification worker remain on Supabase.

Use **one real Supabase project named ADA Calendar and one Railway application**, per Bryan's September 7 decision. A separate hosted staging environment is not required. The current public GitHub repository is `bryguy-404/ADA-Calendar`; application access and stored workload data remain private. Review Supabase's selected GitHub integration and automatic-deployment settings before schema releases. Current release evidence is recorded in [docs/RESUME.md](docs/RESUME.md).

Set `ADA_DEMO_MODE=false` in production. Configure Supabase and a canonical HTTPS `APP_URL`. Verify the real integrations in this environment, keeping `EMAIL_MODE=capture` or explicitly allowlisted `test` delivery until sender verification, recipient configuration and workflow tests are complete and Bryan authorizes normal live notifications. Local automated tests remain isolated. API keys, backups and workload data never belong in Git. A backup/Storage restore rehearsal remains unverified and can use an isolated local destination rather than a second hosted project.

See [the blueprint](docs/BLUEPRINT.md), [setup and recovery](docs/RUNBOOK.md), and [implementation verification](docs/VERIFICATION.md).
