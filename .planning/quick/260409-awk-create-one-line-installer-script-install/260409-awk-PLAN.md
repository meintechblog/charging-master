---
phase: quick
plan: 260409-awk
type: execute
wave: 1
depends_on: []
files_modified:
  - install.sh
autonomous: true
must_haves:
  truths:
    - "curl -sSL .../install.sh | bash -s -- install sets up a working charging-master on a fresh Debian LXC"
    - "curl -sSL .../install.sh | bash -s -- update pulls latest code and rebuilds without data loss"
    - "curl -sSL .../install.sh | bash -s -- uninstall removes everything cleanly"
  artifacts:
    - path: "install.sh"
      provides: "One-line installer script with install/update/uninstall modes"
---

<objective>
Create a self-contained `install.sh` at the repo root that enables one-line installation, update, and uninstall of charging-master on Debian LXC containers.

Purpose: Users can deploy with `curl -sSL https://raw.githubusercontent.com/meintechblog/charging-master/main/install.sh | bash -s -- install` without manual steps.
Output: `install.sh` — a single bash script handling all three modes.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@CLAUDE.md
@package.json
@src/lib/env.ts
@drizzle.config.ts
@server.ts (first 30 lines — custom server entry point)
@README.md (lines 162-196 — existing deployment instructions and systemd template)
</context>

<tasks>

<task type="auto">
  <name>Task 1: Create install.sh with install/update/uninstall modes</name>
  <files>install.sh</files>
  <action>
Create `install.sh` at the repo root. The script must be POSIX-compatible bash (#!/usr/bin/env bash) with `set -euo pipefail`.

**Structure:**
- Parse first positional argument: `install`, `update`, `uninstall`. Default to `install` if no argument. Print usage and exit 1 on unknown command.
- Use colored output (green for success, yellow for warnings, red for errors) with fallback for non-TTY.
- Define constants at top: `INSTALL_DIR=/opt/charging-master`, `SERVICE_NAME=charging-master`, `REPO_URL=https://github.com/meintechblog/charging-master.git`, `NODE_MAJOR=22`, `REQUIRED_PNPM=10`.

**install mode — `do_install` function:**
1. Check running as root (required for systemd + /opt access). Exit 1 if not root.
2. Check OS is Debian/Ubuntu (read /etc/os-release). Warn but continue on other distros.
3. Install system deps if missing: `apt-get update && apt-get install -y curl git build-essential python3` (build-essential + python3 needed for better-sqlite3 native compilation).
4. Install Node.js 22 if `node --version` is missing or major version != 22:
   - Use NodeSource setup: `curl -fsSL https://deb.nodesource.com/setup_22.x | bash -` then `apt-get install -y nodejs`.
5. Install pnpm if missing: `corepack enable && corepack prepare pnpm@latest --activate`. If corepack not available, fall back to `npm install -g pnpm@10`.
6. Clone repo: `git clone "$REPO_URL" "$INSTALL_DIR"`. If dir already exists, print error suggesting `update` mode and exit 1.
7. `cd "$INSTALL_DIR"` and run:
   - `pnpm install --frozen-lockfile` (fall back to `pnpm install` if lockfile mismatch)
   - `pnpm build` (runs `next build`)
   - `mkdir -p data` (ensure data directory exists for SQLite)
   - `pnpm db:push` (runs `drizzle-kit push` for schema migration)
8. Create systemd service file at `/etc/systemd/system/charging-master.service`:
   ```
   [Unit]
   Description=Charging-Master Web App
   After=network.target

   [Service]
   Type=simple
   WorkingDirectory=/opt/charging-master
   ExecStart=/usr/bin/npx tsx server.ts
   Restart=on-failure
   RestartSec=5
   Environment=NODE_ENV=production
   KillMode=control-group
   TimeoutStopSec=5

   [Install]
   WantedBy=multi-user.target
   ```
   Note: Use `NODE_ENV=production` (not development like the README example).
9. `systemctl daemon-reload && systemctl enable --now charging-master`
10. Print success message with URL: `http://<hostname>:3000` (use `hostname -I | awk '{print $1}'` for IP).

**update mode — `do_update` function:**
1. Check `$INSTALL_DIR` exists. Exit 1 if not (suggest install first).
2. `cd "$INSTALL_DIR"`
3. `systemctl stop charging-master` (ignore error if not running)
4. `git fetch origin && git reset --hard origin/main` (force update to latest)
5. `pnpm install --frozen-lockfile` (fall back to `pnpm install`)
6. `pnpm build`
7. `pnpm db:push` (apply any schema changes — SQLite data is preserved)
8. `systemctl start charging-master`
9. Print success message.

**uninstall mode — `do_uninstall` function:**
1. Confirm with user: prompt "Are you sure? This will remove charging-master and all data. [y/N]". If piped (non-interactive), require `--yes` flag or exit.
2. `systemctl stop charging-master 2>/dev/null || true`
3. `systemctl disable charging-master 2>/dev/null || true`
4. `rm -f /etc/systemd/system/charging-master.service`
5. `systemctl daemon-reload`
6. `rm -rf "$INSTALL_DIR"`
7. Print success message. Do NOT uninstall Node.js/pnpm (user may need them for other things).

**Edge cases to handle:**
- Script must work when piped (`curl ... | bash`): detect non-interactive for uninstall confirmation.
- `--yes` flag support for non-interactive uninstall: parse it from args after the command.
- Print each step with a prefix like `[charging-master]` so output is clear.
- If any step fails, the `set -e` will abort with the last error visible.

Make the file executable: the file itself should have `chmod +x` noted, but also add `chmod +x install.sh` as a git attribute or note.
  </action>
  <verify>
    <automated>bash -n /Users/hulki/codex/charging-master/install.sh && echo "Syntax OK"</automated>
  </verify>
  <done>
    - install.sh exists at repo root with valid bash syntax
    - Three modes implemented: install, update, uninstall
    - install mode: installs Node.js 22, pnpm, clones repo, builds, migrates DB, sets up systemd
    - update mode: pulls latest, rebuilds, migrates, restarts service
    - uninstall mode: stops service, removes files, cleans up systemd
    - Script is safe to pipe from curl
  </done>
</task>

</tasks>

<verification>
- `bash -n install.sh` passes (no syntax errors)
- Script contains all three functions: do_install, do_update, do_uninstall
- Script sets NODE_ENV=production in systemd unit
- Script uses /opt/charging-master as install directory
- Script handles better-sqlite3 build deps (build-essential, python3)
</verification>

<success_criteria>
A user can run `curl -sSL https://raw.githubusercontent.com/meintechblog/charging-master/main/install.sh | bash -s -- install` on a fresh Debian LXC and get a running charging-master instance at port 3000.
</success_criteria>

<output>
No summary file needed for quick tasks.
</output>
