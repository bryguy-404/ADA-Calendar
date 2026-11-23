# Requester MCP release — November 23, 2026

## Behavior

Kyle and Willian can install the portable adapter in Claude Code and sign in with their own existing requester memberships. Compact discovery returns shared client/task identifiers; availability describes Bryan’s saved workload, not a teammate’s personal calendar. New submissions require a positive effort estimate and booking dates/minutes. Client, scope, references and work context use the existing task contract.

A clean fit uses the shared scheduler and ordinary requester transaction. A capacity conflict creates an ordinary pending request visible in Bryan’s Requests screen, with no task, booking, displacement or history change. Invalid dates/constraints return `cannot_fit` without creating a request. Requesters cannot supply requesterId, edit existing work, change completion/context, bypass protected time or create owner-only unknown-effort work. Requested priority remains advisory under existing scheduler rules.

Prepare persists an actor/workspace-scoped immutable operation. Commit verifies the saved input, command scope, fingerprint, fresh permissions and version. Exact retries check the committed event ledger and exact pending-request row before stale-version rejection, including requests outside the 200-row UI feed. Pending receipts include the original submission outcome and current request status. Uncertain responses require the same operation ID/arguments; no blind resubmission.

The migration changes only the private preview SELECT policy and guarded preparation RPC. Existing calendar write RPCs, shared scheduler rules, memberships, preferences and history schema are unchanged. Ordinary notification suppression remains in the existing SQL enqueue path.

## Distribution and compatibility

`npm run mcp:package` builds a dependency-contained Node adapter, hidden-password login, read verification, installer, config helper, third-party notices and checksummed manifest. The archive is `ada-calendar-mcp-1.3.0.tgz`, with a SHA-256 sidecar. Only enumerated build files are included; no credential, session, host config, private agency library or application checkout is distributed. The public repository was verified public; the release download needs no new repository permission.

Setup, ordinary prompts, update/removal and recovery: [MCP_TEAMMATE_SETUP.md](MCP_TEAMMATE_SETUP.md). Install into a new version directory; keep the prior version/config for rollback. Installation does not register anything until the teammate explicitly runs `connect`; that refuses to overwrite the existing alias. Each teammate must enter their own password and verify a read. Their actual machines are not configured by this release. macOS clean installation is tested; Windows/Linux native installation remains unverified.

Codex and Bryan’s separately verified Claude Code owner connection retain all eight tools and existing registration/session paths. Cowork’s maintained read-only allowlist remains read-only. The installed owner source checkout and older primary checkout are not replaced by the isolated implementation.

## Verification

- Lint, TypeScript, 1,487 unit/server tests in 82 files, and local production webpack build passed. Webpack is used locally because this isolated checkout links dependencies outside its Turbopack root; CI uses the standard production build on Node 24.
- Actual dedicated local Supabase/Auth/SQL/API/stdio tests cover owner, requester, viewer, another workspace and revoked membership; clean-fit booking; pending conflict; exact replay after server/adapter restart; competing versions; ID spoofing and existing/protected-work denial; invalid effort; immutable preview RLS; unchanged unrelated work/history/settings; saved notification opt-outs; and pending lookup beyond the bounded history feed. Unit tests simulate lost responses after commit/request persistence.
- The ordinary owner request-review screen displays the fictional pending submission; existing desktop/mobile context workflows pass.
- A clean temporary archive installation signs in interactively with fictional requester credentials, verifies identity/capacity, lists eight tools, and completes a real native Claude Code discovery → availability → prepare → commit cycle. A validly signed expired local session with an unusable refresh token is denied by the actual authenticated API. The hidden-password timing issue found by the PTY test was fixed before distribution. No host MCP config was changed by the rehearsal.
- Existing owner scheduling and context checks and maintained Cowork read-only allowlist checks pass. No production work or external stakeholder messages were created for testing.
- Private evidence: isolated checkout `.data/mcp-acceptance/evidence.json`, `native-requester-claude.json`, `requester-pending-review.png`, and `.data/requester-fullstack.log`.

## Release procedure and rollback

Production dry run identifies only `20261123205744_requester_mcp_previews.sql`, with no seed, role or Vault update. Commit/push the migration first, apply that exact version, then commit/push the API/adapter and verify Railway, CI, health and read-only owner access. Publish the checked archive/checksum under `mcp-v1.3.0` only after release verification. The CLI is used for the migration to retain the exact checked-in version; the connected migration tool assigns its own version.

Rollback is a forward Git revert of the API change followed by normal deployment. Retain existing requests, events, history and immutable operation rows. If requester preview access must also be withdrawn, use a new reviewed migration restoring the prior owner-only policy/function; do not delete history or reuse a migration version. Teammates can remove the isolated Claude alias and restore their prior version/config. Owner/Cowork registrations remain untouched.

The pre-release read-only production baseline is version 785 with unchanged saved settings and active requester opt-outs. Supabase advisories were recorded before release; existing intentional guarded [SECURITY DEFINER](https://supabase.com/docs/guides/database/database-linter?lint=0029_authenticated_security_definer_function_executable)/RLS patterns and the existing [Auth password-protection advisory](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection) are not changed. The dependency audit also retains existing application/tooling findings, including Next.js and Zod; this feature does not perform a framework/security dependency upgrade. Follow-up should evaluate the [Next.js security advisories](https://github.com/vercel/next.js/security/advisories) and [Zod oversized-collection advisory](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5). The stdio adapter remains local/authenticated and network response/body limits remain enforced.

## Verified release

- Migration commit `2c91948` is on main; exact migration `20261123205744` applied successfully.
- API/adapter commit `d1e61d0e5a844dcad130c400ebd1910c2bf851ca` is on main. [CI run 45269013686](https://github.com/bryguy-404/ADA-Calendar/actions/runs/45269013686) passed both jobs: 1,487 unit/server tests, standard Node 24 production and portable-package builds, and **190 browser tests** (10.2 minutes).
- Railway app deployment `92193bb2-2879-4c49-a6c1-dabcac66693c` succeeded. Production health returned 200; the existing native owner connection read the new API successfully with actorRole owner and schedule version 785.
- [MCP v1.3.0 download](https://github.com/bryguy-404/ADA-Calendar/releases/tag/mcp-v1.3.0) is published at the API commit. Archive SHA-256: `c53bbb2f7a5ab7151a68211c5527cc272aeda92ee9c4d2ff1585a2fe9833bc6b`. Both archive and checksum were downloaded without GitHub authentication, matched the local build byte-for-byte, and the downloaded installer ran successfully in another isolated folder without changing host configuration.
- Post-release production verification still reports version 785, exactly matching work/settings hashes, active requester roles and both saved opt-outs. Supabase advisor categories/counts match the baseline. No production test records or stakeholder sends occurred.
- All fictional MCP accounts were removed; only the dedicated local test stack was stopped, with volumes retained. Existing owner/Cowork registrations, session files, installed adapter checkout and unrelated primary-checkout edits were preserved.

Remaining teammate steps: download/check/extract the archive, run the installer, enter their own ADA credentials in the interactive login, verify a read, connect the separate Claude entry, and start/reconnect a chat. Neither teammate’s machine has been configured or natively verified yet. No release permission or package-access gap remains. The coordinator can use this record and the setup guide; do not repeat the implementation or create Calendar work to test access.
