# ADA Calendar for Kyle and Willian in Claude Code

Use your **own existing ADA Calendar account**. This grants your existing requester permissions: read Bryan’s shared workload and openings, book new work that fits, or submit a conflict for Bryan’s review. It grants no owner tools, private notes or private agency repository access. You cannot edit or complete existing work. Cowork and Bryan’s existing connections are separate.

## Install and sign in

Prerequisites: Node 22.22+ (Node 24 LTS recommended), Claude Code installed and signed in, internet access to ADA Calendar, and an active ADA requester account. macOS is tested; Windows/Linux instructions use the same Node scripts but require teammate verification.

1. Download `ada-calendar-mcp-1.3.0.tgz` and its `.sha256` from the public [ADA Calendar MCP release](https://github.com/bryguy-404/ADA-Calendar/releases/tag/mcp-v1.3.0). No repository invitation or access to Bryan’s private workflow library is needed. Check the archive hash (`shasum -a 256` on macOS; `Get-FileHash -Algorithm SHA256` on Windows) against the release checksum; extract the archive.
2. In a terminal inside the extracted folder, run `node install.mjs`. It prints your installation path and the next commands. It does not edit Claude configuration. Keep the extracted release for recovery.
3. Run the printed `node "…/ada.mjs" login` command. Enter **your** ADA email and password interactively; the password is hidden. Never paste credentials into Claude. A private refreshable session stays on your machine. Forgotten password: use the existing ADA browser sign-in recovery flow.
4. Run `node "…/ada.mjs" verify YYYY-MM-DD`, replacing the date with a real upcoming weekday. Check that the displayed identity is yours and the result shows Bryan’s shared capacity. This is read-only.
5. Run `node "…/ada.mjs" connect`. It registers only the new `ada-calendar-requester` entry in Claude Code’s user scope and refuses to overwrite an existing entry. Start a fresh Claude Code chat, run `/mcp`, and confirm the connection. An existing chat may need reconnecting.

The installer generates `claude-mcp.json` with absolute paths from **your** machine. It can also be used with Claude Code’s `--mcp-config` option for a temporary session. No password/token belongs in this config. Eight tools are advertised for compatibility; the API enforces your role, so existing-work and context-write tools remain unavailable to requesters.

## First prompts

- “Using ADA Calendar, show Bryan’s available hours next Tuesday. Don’t change anything.”
- “Find the exact client record for [client]. Don’t submit work yet.”
- “Submit a new [client] task: [scope]. Estimated effort is two hours; book two hours between [date] and [date]. Materials: [links]. If it cannot fit, send a pending request for Bryan’s review.”

Resolve ambiguous clients/dates first. The adapter prepares a review before submission. A **booked** receipt reserves time; **pending** means Bryan must review and no time or task was booked. **cannot_fit** means correct the indicated dates/effort first; nothing was submitted. A replay receipt describes the original submission, not another save. Scheduling does not authorize executing work or messaging anyone outside Calendar’s normal opted-in notifications.

## Update, remove and recover

- Keep the old version folder and its `registered-config.json` as your exact config backup. Install a newer release alongside it; the installer refuses to overwrite versions. Stop/reconnect the old MCP process before switching so two adapters do not refresh the same session concurrently.
- For an update, run `claude mcp remove --scope user ada-calendar-requester`, then the new version’s `connect` command. To roll back, remove that entry and run the old version’s `connect`. The shared session stays in the private installation root. These commands affect only this entry, not any other MCP connection.
- To remove access from this machine, stop the connection, run the same `claude mcp remove` command, then delete the installation root (including `session.json`). For account/session revocation use ADA’s existing account controls. Do not share or copy a session file.
- Missing Node/Claude: install the prerequisites and retry; no Calendar work was created. Package unavailable/checksum mismatch: stop and obtain the release; do not use Bryan’s working folder or request private repository access.
- Expired login: stop the MCP process, run `login` again yourself, then reconnect. Revoked membership requires the workspace owner to restore access; installing again cannot grant it.
- Stale preview: read availability again and prepare a new operation only after the API confirms the previous one was not applied. Uncertain/lost save response: retry the **identical commit arguments and operation ID** to reconcile it; do not create a new request. Keep operation ID/version/fingerprint in the chat until the result is confirmed. On a new chat without those values, check the browser’s work/request history before resubmitting.

Each teammate must complete their own installation, sign-in and read verification. Shipping this package does not mean either teammate’s machine is configured.
