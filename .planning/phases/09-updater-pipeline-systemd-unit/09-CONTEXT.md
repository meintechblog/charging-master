# Phase 9: Updater Pipeline & systemd Unit - Context

**Gathered:** 2026-04-10
**Status:** Ready for planning
**Source:** Milestone v1.2 research (STACK/ARCHITECTURE/PITFALLS/SUMMARY) + install.sh inspection + Phases 7+8 interfaces

<domain>
## Phase Boundary

This phase delivers the **actual update mechanism** — everything that git-fetches, installs, builds, restarts, verifies, and rolls back. Single outcome: `systemctl start --no-block charging-master-updater.service` safely moves the LXC from an old commit SHA to a new one, or fails safely and reverts to the old SHA.

Deliverables:
1. `scripts/update/run-update.sh` — idempotent bash pipeline with two-stage rollback
2. `/etc/systemd/system/charging-master-updater.service` — `Type=oneshot` sibling unit
3. `POST /api/internal/prepare-for-shutdown` — WAL-checkpoint + graceful drain endpoint
4. Pre-flight checks, tarball snapshot, flock concurrency guard, pushover on success/failure
5. `update_runs` table populated per run (start/end/from/to/status/error/stage)
6. `install.sh` updates to install the new unit + make the script executable

**Explicitly NOT in Phase 9:**
- UI install button, log SSE stream, reconnect overlay → Phase 10
- Update detection / GitHub polling → done in Phase 8
- Version awareness / `/api/version` → done in Phase 7
- Changelog diff → v1.3
- Symlink-swap release layout → v1.3 (explicitly out of scope, locked at milestone start)

</domain>

<decisions>
## Locked Implementation Decisions

### Runtime facts (from install.sh inspection)
- **Install dir:** `/opt/charging-master` (owned by root)
- **Service name:** `charging-master` (existing unit, `Type=simple`, runs as root)
- **Production port:** 80 (`Environment=PORT=80` in the existing unit)
- **Dev port:** 3000 (via `pnpm dev`)
- **Run user:** root — no polkit, no sudoers needed
- **Node:** 22 LTS, pnpm 10
- **Current updater target:** the `do_update()` branch of install.sh already contains a naive update path — we are REPLACING that with the new shell pipeline + systemd-triggered flow

### The "kill your own parent" solution
- Updater runs in a dedicated systemd one-shot unit whose process tree is a SIBLING of charging-master, not a CHILD.
- Trigger from the app: `child_process.spawn('systemctl', ['start', '--no-block', 'charging-master-updater.service'], { detached: true, stdio: 'ignore' }).unref()`
- `--no-block` is load-bearing: without it the API route hangs waiting for a unit that will kill the caller.
- The updater unit survives `systemctl stop charging-master` because its cgroup is independent.

### Updater systemd unit
File: `/etc/systemd/system/charging-master-updater.service` (installed by install.sh)

```ini
[Unit]
Description=Charging-Master Self-Updater (one-shot)
After=network.target charging-master.service
# Do NOT use Requires= — the updater runs independently of charging-master's state

[Service]
Type=oneshot
WorkingDirectory=/opt/charging-master
ExecStart=/opt/charging-master/scripts/update/run-update.sh
User=root
# Log everything to journalctl; no log file management
StandardOutput=journal
StandardError=journal
SyslogIdentifier=charging-master-updater
# Never restart on failure — the script handles its own rollback
Restart=no
# Generous timeout: pnpm install + build on the LXC can be slow
TimeoutStartSec=900

[Install]
WantedBy=multi-user.target
```

NOT an `[Install]` target that enables on boot — we only `systemctl start` it on demand.

### Shell pipeline (`scripts/update/run-update.sh`)

**Lockfile:** Use `flock -n 9` on `.update-state/updater.lock` as FD 9 at the top of the script. If another updater run is already holding the lock, exit with code 2 and write `status=skipped, error="already running"` to `update_runs` without touching anything else.

**Pipeline stages** (must run in this exact order):

```
STAGE preflight    — disk >500MB, node >=22, pnpm 10, git clean working tree
STAGE snapshot     — tar.gz the working tree + .next/ minus node_modules
STAGE drain        — curl POST http://127.0.0.1:80/api/internal/prepare-for-shutdown
STAGE stop         — systemctl stop charging-master (waits for clean exit per TimeoutStopSec=5)
STAGE fetch        — git fetch origin main
STAGE reset        — git reset --hard origin/main
STAGE install      — pnpm install --frozen-lockfile
STAGE clean_build  — rm -rf .next (forces a clean build, avoids stale cache from pitfall P11)
STAGE build        — pnpm build (which runs gen:version + next build)
STAGE start        — systemctl start charging-master
STAGE verify       — health-probe loop (see below)
STAGE finalize     — write update_runs row status=success, pushover success
```

**Error handling:** `set -euo pipefail`, `trap 'on_error $? $LINENO $CURRENT_STAGE' ERR` and `trap on_exit EXIT`.

**Two-stage rollback** (triggered on any `on_error` from STAGE fetch onwards):

Stage 1 — Clean git rollback:
```
git reset --hard "$ROLLBACK_SHA"
pnpm install --frozen-lockfile
rm -rf .next
pnpm build
systemctl start charging-master
health-probe loop
```

If Stage 1 succeeds: `status=rolled_back`, `rollback_stage=stage1`, `error=<original stage + message>`, pushover "failed, rolled back".

If Stage 1 ITSELF fails at any step → Stage 2 — Tarball restore:
```
systemctl stop charging-master || true
tar -xzf .update-state/snapshots/$ROLLBACK_SHA.tar.gz -C /opt/charging-master
systemctl start charging-master
health-probe loop
```

If Stage 2 succeeds: `status=rolled_back`, `rollback_stage=stage2`, pushover "Stage 1 failed, restored from snapshot".

If Stage 2 fails: `status=failed`, `rollback_stage=stage2_failed`, pushover "CRITICAL: Stage 2 rollback failed — SSH required". Exit code 3. Leave everything as-is.

### Pre-shutdown drain endpoint

`POST /api/internal/prepare-for-shutdown` in `src/app/api/internal/prepare-for-shutdown/route.ts`:

1. Bind check: only respond to requests from `127.0.0.1` / `localhost`. Reject anything else with 403. (Header check on `x-forwarded-for` is NOT sufficient — check `request.headers.get('host')` === 'localhost' or `127.0.0.1`.)
2. Stop HttpPollingService gracefully: expose a new `stopPolling()` method on the global singleton that clears its interval. Await any in-flight HTTP GET to settle (≤5s timeout, then force).
3. Run `PRAGMA wal_checkpoint(TRUNCATE)` on the better-sqlite3 connection.
4. Return 200 with `{status: 'drained', at: Date.now()}`.
5. MUST complete in ≤10s or the caller's curl timeout fires.

**Reuse pattern from Phase 5/6:** `HttpPollingService` already exposes `start()` in `server.ts main()`. We add a `stopPolling()` method + update the global type in `global.d.ts` (already done in Phase 8 for `__updateChecker`). Same trick: stash on `globalThis.__httpPollingService`.

### Pre-flight checks (as bash functions)

```bash
preflight_disk() {
  local avail=$(df -BM /opt/charging-master | awk 'NR==2 {print $4}' | tr -d 'M')
  (( avail > 500 )) || die "Insufficient disk: ${avail}MB free, need 500"
}

preflight_node() {
  local major=$(node -v | sed 's/v//' | cut -d. -f1)
  (( major >= 22 )) || die "Node ${major} too old, need 22+"
}

preflight_pnpm() {
  local major=$(pnpm -v | cut -d. -f1)
  (( major >= 10 )) || die "pnpm ${major} too old, need 10+"
}

preflight_git() {
  # Working tree must be clean-ish — allow drizzle/ changes, forbid src/ or package.json changes
  local dirty=$(git status --porcelain | grep -vE '^\?\? \.update-state/|^\?\? \.next/|^ M tsconfig.tsbuildinfo' || true)
  [ -z "$dirty" ] || die "Working tree has uncommitted changes: $dirty"
}
```

Each pre-flight writes a line to journalctl via `log()` and fails fast via `die()`.

### Tarball snapshot

Path: `.update-state/snapshots/<old-sha>.tar.gz`

Contents: working tree minus `node_modules`, `.git`, `.update-state/snapshots` (recursive ouroboros!), `data/*.db-wal`, `data/*.db-shm`. Include `data/charging-master.db` (SQLite file — single-writer, WAL was checkpointed).

Retention: keep last 3 snapshots, delete older ones before creating a new one. Single-user app, no need to keep everything forever.

### Health probe (post-restart)

Poll loop:
```bash
health_probe() {
  local target_sha=$1
  local deadline=$(( $(date +%s) + 60 ))
  while (( $(date +%s) < deadline )); do
    local body
    body=$(curl -sf --max-time 2 http://127.0.0.1:80/api/version 2>/dev/null) || { sleep 2; continue; }
    local sha=$(echo "$body" | grep -o '"sha":"[a-f0-9]*"' | cut -d'"' -f4)
    local dbok=$(echo "$body" | grep -o '"dbHealthy":[a-z]*' | cut -d: -f2)
    if [[ "$sha" == "$target_sha" && "$dbok" == "true" ]]; then
      return 0
    fi
    sleep 2
  done
  return 1
}
```

- Up to 60 seconds
- Must match `sha === target_sha` AND `dbHealthy === true`
- Any other outcome (timeout, HTTP fail, wrong SHA, dbHealthy false) returns 1 → triggers rollback

### update_runs persistence

Phase 7 created the Drizzle schema. Phase 9 writes rows from bash via the `sqlite3` CLI (which is already on Debian LXC via better-sqlite3's build deps, or installable via `apt`). No Drizzle access from bash.

Write helpers:
```bash
DB=/opt/charging-master/data/charging-master.db

db_start_run() {
  sqlite3 "$DB" "INSERT INTO update_runs (start_at, from_sha, status) VALUES ($(date +%s)000, '$1', 'running');"
  sqlite3 "$DB" "SELECT last_insert_rowid();"
}

db_update_run() {
  local id=$1 field=$2 value=$3
  sqlite3 "$DB" "UPDATE update_runs SET $field = '$value' WHERE id = $id;"
}

db_finish_run() {
  local id=$1 status=$2 to_sha=$3 error=$4 rollback_stage=${5:-null}
  sqlite3 "$DB" "UPDATE update_runs SET end_at = $(date +%s)000, status = '$status', to_sha = '$to_sha', error_message = '$error', rollback_stage = $rollback_stage WHERE id = $id;"
}
```

Escape quotes via `${var//\'/\'\'}` before interpolation to avoid SQL injection from git commit messages. Better still: use `sqlite3` with `.param set` — but the escape-and-interpolate approach is simpler for bash and safe enough for a single-user local app.

### Pushover from shell

Credentials: reused from the app's settings table (same table the app writes to). Read via:
```bash
PUSHOVER_USER=$(sqlite3 "$DB" "SELECT value FROM settings WHERE key='pushover.user_key';")
PUSHOVER_TOKEN=$(sqlite3 "$DB" "SELECT value FROM settings WHERE key='pushover.api_token';")
```

Send via curl:
```bash
pushover_send() {
  local title=$1 message=$2 priority=${3:-0}
  [ -z "$PUSHOVER_USER" ] && return 0  # silently skip if not configured
  curl -sf -X POST https://api.pushover.net/1/messages.json \
    --data-urlencode "token=$PUSHOVER_TOKEN" \
    --data-urlencode "user=$PUSHOVER_USER" \
    --data-urlencode "title=$title" \
    --data-urlencode "message=$message" \
    --data-urlencode "priority=$priority" \
    >/dev/null 2>&1 || true
}
```

Failures are silent — a broken Pushover notification must NOT break the update. Settings keys must match the ones the notifications module uses (verify in Phase 4 code).

### Rollback-SHA persistence

Written to `.update-state/state.json` BEFORE `STAGE fetch` runs. The updater script reads it at startup (via `jq` or `grep` — `jq` preferred if available, `grep` fallback).

```bash
# At start of script
CURRENT_SHA=$(git rev-parse HEAD)
ROLLBACK_SHA=$CURRENT_SHA

# Persist atomically via python3 for proper JSON (avoid sed acrobatics)
python3 - <<EOF
import json, os
state_file = '.update-state/state.json'
with open(state_file) as f: state = json.load(f)
state['rollbackSha'] = '$CURRENT_SHA'
tmp = state_file + '.tmp'
with open(tmp, 'w') as f: json.dump(state, f, indent=2)
os.replace(tmp, state_file)
EOF
```

On success, rollback_sha is cleared (set to null) so the next update has a clean slate. On rollback, rollback_happened=true is written so the UI can flag it on next load.

### install.sh changes

Three changes to install.sh:

1. **Install phase:** after writing charging-master.service, also write charging-master-updater.service. `chmod +x scripts/update/run-update.sh`. Install `sqlite3` CLI via `apt-get install -y sqlite3`. Install `jq` for JSON parsing: `apt-get install -y jq`. Install `python3` which is already present on Debian 13 by default.

2. **Update phase (`do_update`):** leave the existing do_update intact for bootstrap/emergency use but add a comment pointing to the new systemctl path. This function stays as the "manual SSH escape hatch" if the in-app updater breaks irrecoverably.

3. **Uninstall phase:** remove `/etc/systemd/system/charging-master-updater.service` in addition to the main service.

### Security/permissions

- Updater unit runs as root (same as main app) — no privilege separation in v1.2.
- `.update-state/` is created by the app, so its permissions match the running user (root on LXC).
- The `/api/internal/prepare-for-shutdown` endpoint MUST reject non-localhost callers even though we're on a single-user LAN. This prevents a neighbor device from sending bogus shutdown requests.
- The updater script uses a hard-coded `http://127.0.0.1:80` — do NOT parametrize with env vars (less surface for mischief).

### Claude's Discretion
- Exact naming of bash helper functions.
- Whether to split pre-flight into one helper per check or one combined function (prefer per-check for clearer logs).
- Log format — structured lines starting with `[stage=fetch]` for easier journalctl filtering.
- Whether to use `jq` or `python3 json.load` for state.json edits (both pre-installed by install.sh changes; python preferred for consistency since it also handles the install.sh path).
- Snapshot directory layout: flat files in `snapshots/` with SHA filename, or SHA subdirs — flat files preferred (simpler globbing for retention).
- Whether to also capture the npm log on pnpm failure into the update_runs.error_message (truncated to 500 chars).

</decisions>

<canonical_refs>
## Canonical References

### Phase 7 artifacts (foundations this phase depends on)
- `src/lib/version.ts` — CURRENT_SHA baked at build time
- `src/app/api/version/route.ts` — the endpoint health-probe hits
- `src/modules/self-update/update-state-store.ts` — state.json access from Node (the shell reads/writes via python3)
- `.update-state/state.json` — shared state contract with the shell

### Phase 8 artifacts
- `src/modules/self-update/update-checker.ts` — not touched in Phase 9, but knows when remote SHA changed
- `globalThis.__updateChecker` convention — reused for `__httpPollingService` stop hook

### Phase 4/5/6 artifacts to reference
- `src/modules/charging/http-polling-service.ts` (find via Grep) — where to add `stopPolling()` method
- `src/modules/notifications/pushover.ts` (find via Grep) — settings key names for PUSHOVER_USER / PUSHOVER_TOKEN

### Existing infra
- `install.sh` — where charging-master.service is written; updater unit goes alongside
- `server.ts` — existing main() boot sequence
- `data/charging-master.db` — better-sqlite3 file (sqlite3 CLI will read the same file)

### Research
- `.planning/research/STACK.md` — systemctl --no-block mandate, no Node libraries for shell ops
- `.planning/research/ARCHITECTURE.md` — Q5 sequence diagram (read this, especially the restart handoff ASCII)
- `.planning/research/PITFALLS.md` — P1 (parent-kill), P2 (pnpm install race), P3 (SQLite WAL), P5 (lockfile drift), P6 (build failure mid-update), P7 (rollback failure), P11 (stale .next), P13 (permissions), P14 (disk), P15 (concurrent triggers), P16 (partial rollback), P18 (silent success)

</canonical_refs>

<specifics>
## Specific Requirements Mapped

- **EXEC-01** → updater systemd unit + install.sh install steps + scripts/update/run-update.sh existence
- **EXEC-02** → full pipeline ordering in run-update.sh (preflight → snapshot → drain → stop → fetch → reset → install → build → start → verify)
- **EXEC-03** → tarball snapshot step in run-update.sh, `.update-state/snapshots/<sha>.tar.gz`
- **EXEC-04** → `POST /api/internal/prepare-for-shutdown` with WAL checkpoint + HttpPollingService.stopPolling() + localhost guard
- **EXEC-05** → flock lockfile at top of run-update.sh
- **EXEC-06** → preflight_disk / preflight_node / preflight_pnpm / preflight_git functions
- **ROLL-01** → `trap on_error ERR` in run-update.sh
- **ROLL-02** → Stage 1 rollback: git reset + pnpm install + rm -rf .next + pnpm build + restart
- **ROLL-03** → Stage 2 rollback: tarball extract + restart
- **ROLL-04** → health_probe function with 60s deadline + SHA match + dbHealthy check
- **ROLL-05** → state.json rollback_happened flag written before exit
- **ROLL-06** → (UI banner is Phase 10 — Phase 9 only writes the flag, Phase 10 reads it)
- **ROLL-07** → pushover_send calls on success path and all failure paths
- **INFR-01** → charging-master-updater.service unit file + install.sh install step
- **INFR-02** → scripts/update/run-update.sh file + chmod +x in install.sh

</specifics>

<deferred>
## Deferred Ideas

- **Install button in UI** → Phase 10 (this phase only builds the backend; Phase 10 wires the button)
- **Live log streaming via SSE** → Phase 10
- **Reconnect overlay / auto-reload** → Phase 10
- **Boot-loop watchdog (v1.2 explicitly out of scope)** — if the new commit crashes on boot after health probe passes and the process crashes 30 seconds later, no auto-rollback will fire. User must SSH in.
- **Symlink-swap release layout** → v1.3
- **Migration auto-apply** → Never in v1.2

</deferred>

---

*Phase: 09-updater-pipeline-systemd-unit*
*Context gathered: 2026-04-10 from milestone research + install.sh inspection + Phase 7-8 interfaces*
