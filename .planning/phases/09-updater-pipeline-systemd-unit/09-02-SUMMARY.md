---
phase: 09-updater-pipeline-systemd-unit
plan: 02
subsystem: self-update
tags: [updater, bash-pipeline, systemd, two-stage-rollback, health-probe, install-sh, phase-9]
requires:
  - src/app/api/internal/prepare-for-shutdown/route.ts (from Plan 09-01)
  - src/app/api/version/route.ts (from Phase 7)
  - data/charging-master.db (update_runs table from Phase 7, config table from Phase 4)
  - .update-state/state.json (from Phase 7 UpdateStateStore)
  - install.sh (existing installer)
provides:
  - "scripts/update/run-update.sh — full 12-stage update pipeline with flock concurrency guard"
  - "scripts/update/charging-master-updater.service — Type=oneshot sibling systemd unit"
  - "Two-stage rollback (git-reset + rebuild / tarball extract)"
  - "60-second health_probe (SHA match + dbHealthy=true gate)"
  - "state.json mutations via atomic python3 heredoc (rollbackSha, rollbackHappened)"
  - "update_runs persistence via sqlite3 CLI with sql_escape helper"
  - "Pushover send from config.pushover.userKey / config.pushover.apiToken (silent on failure)"
  - "install.sh drops updater unit + installs sqlite3/jq + chmods script + uninstall cleanup"
affects:
  - Phase 9 Plan 09-03 — will dry-run individual helper functions (sql_escape, state mutations, snapshot retention)
  - Phase 10 — will trigger via `systemctl start --no-block charging-master-updater.service`, read rollbackHappened flag for red banner
tech-stack:
  added: []
  patterns:
    - "flock -n 9 on dedicated FD for non-blocking concurrency guard"
    - "trap 'on_error $? $LINENO' ERR with per-stage rollback decision via case block"
    - "Two-stage rollback escalation (Stage 1 git + rebuild, Stage 2 tarball extract)"
    - "Heredoc python3 atomic state.json writes (tmp + os.replace)"
    - "sql_escape via bash parameter expansion ${var//\\'/\\'\\'}"
    - "Health probe polling loop with deadline computed once before iteration"
    - "Tarball snapshot retention via ls -1t | tail -n +N + xargs rm"
key-files:
  created:
    - scripts/update/charging-master-updater.service
    - scripts/update/run-update.sh
  modified:
    - install.sh
decisions:
  - "Updater unit file is checked into the repo at scripts/update/ and install.sh `cp`s it into /etc/systemd/system/ — makes it auditable in git history instead of inlined as heredoc"
  - "The [Install] section WITH WantedBy=multi-user.target is kept in the unit file, but install.sh does NOT run `systemctl enable` — the unit is trigger-on-demand only"
  - "http://127.0.0.1:80 is hard-coded, not parametrized via env vars — CONTEXT §Security forbids parameterization to reduce surface"
  - "sqlite3 CLI for update_runs writes instead of Drizzle — keeps bash decoupled from the TypeScript stack"
  - "python3 heredoc for state.json mutations instead of jq — one tool dependency instead of two (install.sh still installs jq as belt-and-braces)"
  - "pushover credentials read from `config` table with CAMELCASE keys (pushover.userKey, pushover.apiToken) per Phase 4 notification-service.ts"
  - "error_message truncated to 500 chars before DB insert to prevent git commit messages from blowing up the column"
  - "Stage 1 rollback runs full install + rm -rf .next + build even if nothing semantically changed — idempotent and covers the case where `fetch` succeeded but `install` failed mid-file-write"
  - "on_error disables the ERR trap inside itself (`trap - ERR`) to prevent recursive trap firing on rollback failures"
  - "Pre-change stages (init/lock/preflight/snapshot/drain/stop) do NOT trigger rollback — the old code is still running, just mark run failed and pushover"
metrics:
  duration: "~8 minutes"
  completed: "2026-04-10T17:50:00Z"
  tasks_completed: 3
  tasks_total: 3
  files_created: 2
  files_modified: 1
  lines_bash: 556
---

# Phase 9 Plan 02: Updater Pipeline + systemd Unit + install.sh Summary

One-liner: Delivered the complete bash update pipeline (`scripts/update/run-update.sh`, 556 lines), the `Type=oneshot` systemd sibling unit that runs it, and the `install.sh` changes that drop both into place — so the future Phase 10 install button can trigger a full pre-flight → snapshot → drain → stop → git-reset → rebuild → verify cycle with automatic two-stage rollback on any failure.

## Objective Met

Satisfies the single largest concentration of requirements in milestone v1.2: **EXEC-01, EXEC-02, EXEC-03, EXEC-05, EXEC-06, ROLL-01, ROLL-02, ROLL-03, ROLL-04, ROLL-05, ROLL-07, INFR-01, INFR-02** (13 requirements). Plan 09-01 already landed EXEC-04 (drain endpoint); all EXEC/ROLL/INFR-1/2 requirements of Phase 9 are now in the tree.

ROLL-06 (UI red banner on rollback) is NOT satisfied here — that's Phase 10's job. This plan WRITES `rollbackHappened=true` to state.json; Phase 10 reads it.

## What Was Built

### 1. `scripts/update/charging-master-updater.service` (31 lines)

A minimal `Type=oneshot` systemd unit that runs the updater script as root with `WorkingDirectory=/opt/charging-master`, `TimeoutStartSec=900` (15 min), and `Restart=no` (the script owns its own rollback, systemd restart would double-fire it).

Deliberately has NO `Requires=`, `BindsTo=`, or `PartOf=` — the updater is a sibling of `charging-master.service`, not a dependent. This is the structural mitigation for Pitfall 1 (parent-kill): because the updater runs in its own cgroup, `systemctl stop charging-master` (which the updater calls mid-pipeline) does not affect the updater itself.

The `[Install]` section is present (`WantedBy=multi-user.target`) for future flexibility, but install.sh does NOT run `systemctl enable` on this unit — it's trigger-on-demand via `systemctl start --no-block` only.

### 2. `scripts/update/run-update.sh` (556 lines)

The full pipeline. Twelve stages executed in strict order:

| Stage | What | Fails how |
|-------|------|-----------|
| 1. preflight_disk | `df -BM ${INSTALL_DIR}` > 500MB | die, no rollback |
| 2. preflight_node | `node -v` major >= 22 | die, no rollback |
| 3. preflight_pnpm | `pnpm -v` major >= 10 | die, no rollback |
| 4. preflight_git | working tree clean (allow-list) | die, no rollback |
| 5. snapshot | `tar -czf .update-state/snapshots/<sha>.tar.gz` with retention=3 | die, no rollback |
| 6. drain | `curl -sf -X POST --max-time 10 http://127.0.0.1:80/api/internal/prepare-for-shutdown` | die, no rollback |
| 7. stop | `systemctl stop charging-master` | die, no rollback |
| 8. fetch | `git fetch origin main` | Stage 1 rollback |
| 9. reset | `git reset --hard origin/main` | Stage 1 rollback |
| 10. install | `pnpm install --frozen-lockfile` | Stage 1 rollback |
| 11. clean_build | `rm -rf .next` | Stage 1 rollback |
| 12. build | `pnpm build` | Stage 1 rollback |
| 13. start | `systemctl start charging-master` | Stage 1 rollback |
| 14. verify | `health_probe` — 60s / SHA match / dbHealthy=true | Stage 1 rollback |
| 15. finalize | state.json + update_runs success + pushover | — |

Key mechanisms:

- **Concurrency guard:** `exec 9>"${LOCK_FILE}"; flock -n 9 || exit 2` at the top of the script. Second invocation writes a `skipped` row to `update_runs` and exits 2 immediately.
- **Error trap:** `trap 'on_error $? $LINENO' ERR` — `on_error` computes the failed stage from `CURRENT_STAGE`, then disables the trap (`trap - ERR`) to prevent recursive fires, then routes to either "no rollback" (pre-change stages) or Stage 1 rollback.
- **Two-stage rollback:**
  - **Stage 1:** `systemctl stop || true` → `git reset --hard ROLLBACK_SHA` → `pnpm install --frozen-lockfile` → `rm -rf .next` → `pnpm build` → `systemctl start` → `health_probe`. Each step returns 1 on failure, escalating to Stage 2.
  - **Stage 2:** checks snapshot exists → `systemctl stop || true` → `tar -xzf .update-state/snapshots/$ROLLBACK_SHA.tar.gz -C /opt/charging-master` → `systemctl start` → `health_probe`. Each step on failure writes `rollback_stage=stage2_failed` to `update_runs`, sends a CRITICAL pushover with priority=2, and exits 3.
- **Health probe:** 60s deadline, `curl -sf --max-time 2 http://127.0.0.1:80/api/version` every 2s, requires body to contain `"sha":"$target"` AND `"dbHealthy":true`. Any other outcome returns 1.
- **state.json mutations:** Three python3 heredocs (`state_set_installing`, `state_set_success`, `state_set_rolled_back`) that atomically rewrite the file via tmp + `os.replace()`. Single dependency on python3 only.
- **update_runs persistence:** Four sqlite3 CLI helpers (`db_start_run`, `db_update_stage`, `db_finish_run`, + `sql_escape` helper). SQL injection defense via `${var//\'/\'\'}`. `error_message` truncated to 500 chars before insert.
- **Pushover:** Reads credentials from the `config` table with camelCase keys (`pushover.userKey`, `pushover.apiToken` — matching Phase 4's `notification-service.ts`). Silent-on-failure via `|| log "pushover send failed (non-fatal)"`. Failure to notify NEVER fails the update.

### 3. `install.sh` modifications

Four changes, non-destructive to the existing logic:

1. **Line 59** — `apt-get install` list gets `sqlite3 jq` added: `curl git build-essential python3 sqlite3 jq`
2. **After the main service heredoc** — new blocks 9a and 9b that (a) `cp` `${INSTALL_DIR}/scripts/update/charging-master-updater.service` to `/etc/systemd/system/charging-master-updater.service` (with a `warn` fallback if the repo copy is missing), and (b) `chmod +x` the updater script. Followed by `systemctl daemon-reload` + `systemctl enable --now charging-master` — explicitly NOT enabling the updater unit.
3. **`do_update()` comment** — a 10-line header marks the legacy function as the "EMERGENCY SSH ESCAPE HATCH" and points at the new systemctl path. The function body is unchanged.
4. **`do_uninstall()`** — `rm -f "/etc/systemd/system/charging-master-updater.service"` added alongside the main service removal. Log message pluralized from "Removing service file..." to "Removing service files...".

All six `charging-master-updater.service` references (two documentation comments, one `cp` source, one `cp` target, one `rm` removal, and one log line) are accounted for.

## Structural Verification (local, dev machine)

End-to-end pipeline validation is NOT possible on the dev machine: there is no `systemctl`, no `/opt/charging-master`, no port 80, no root. Verification is therefore structural — grep for required fragments, `bash -n` syntax check, and visual review.

### `scripts/update/run-update.sh`

| Check | Result |
|-------|--------|
| `bash -n scripts/update/run-update.sh` | PASSED |
| `test -x scripts/update/run-update.sh` | PASSED (chmod +x applied) |
| `shellcheck -S error` | NOT AVAILABLE on dev machine (`command -v shellcheck` returned not-found). Script will be shellcheck-verified on the LXC post-deploy or via Plan 09-03 if installed. |
| Fragment grep | ALL 28 checked fragments FOUND: `flock -n 9`, `preflight_disk`, `preflight_node`, `preflight_pnpm`, `preflight_git`, `do_snapshot`, `prepare-for-shutdown`, `git fetch origin main`, `pnpm install --frozen-lockfile`, `rm -rf .next`, `pnpm build`, `health_probe`, `dbHealthy`, `do_rollback_stage1`, `do_rollback_stage2`, `tar -xzf`, `pushover.userKey`, `pushover.apiToken`, `update_runs`, `rollbackHappened`, `trap 'on_error`, `http://127.0.0.1:80`, `python3`, `sqlite3`, `db_start_run`, `on_error`, `127.0.0.1:80`, `trap` |

### `scripts/update/charging-master-updater.service`

| Check | Result |
|-------|--------|
| File exists | PASSED |
| Contains `Type=oneshot` | PASSED |
| Contains `ExecStart=/opt/charging-master/scripts/update/run-update.sh` | PASSED |
| Contains `After=network.target charging-master.service` | PASSED |
| Contains `Restart=no` | PASSED |
| Contains `TimeoutStartSec=900` | PASSED |
| Contains `SyslogIdentifier=charging-master-updater` | PASSED |
| Does NOT contain `Requires=`, `BindsTo=`, `PartOf=` | PASSED (Pitfall 1 mitigation preserved) |
| `systemd-analyze verify` | NOT AVAILABLE on dev (macOS). Will be verified on the LXC post-deploy. |

### `install.sh`

| Check | Result |
|-------|--------|
| `bash -n install.sh` | PASSED |
| Contains `sqlite3 jq` in apt install list | PASSED |
| Contains `charging-master-updater.service` reference | PASSED (6 references — matches expected pattern) |
| Contains `chmod +x.*run-update.sh` | PASSED |
| Contains `EMERGENCY SSH ESCAPE HATCH` comment | PASSED |
| Does NOT contain `systemctl enable.*charging-master-updater` | PASSED (trigger-on-demand preserved) |

## Commits

| SHA | Task | Message |
|-----|------|---------|
| b6fd19b | Task 1 | `feat(09): add charging-master-updater.service systemd unit file` |
| ef01e41 | Task 2 | `feat(09): add run-update.sh pipeline with two-stage rollback` |
| 0d2b1ea | Task 3 | `chore(09): install updater service, sqlite3+jq, chmod run-update.sh` |

## Deviations from Plan

None. The script, unit file, and install.sh changes were transcribed verbatim from the plan's action blocks. No bug fixes, no missing-critical-functionality additions, no architectural deviations encountered during transcription.

Tools unavailable on the dev machine (shellcheck, systemd-analyze) are documented above as DEFERRED to the LXC post-deploy — NOT fixed on dev (Plan 09-03's territory). These are not deviations, they are the expected limits of structural verification on macOS.

## Deferred to LXC Deployment

End-to-end validation must happen on the LXC after `install.sh update` (or Plan 09-03's scripted dry-run where feasible):

1. `shellcheck -S error scripts/update/run-update.sh` must pass with zero errors (warnings acceptable).
2. `systemd-analyze verify /etc/systemd/system/charging-master-updater.service` must pass.
3. `systemctl start --no-block charging-master-updater.service` must enqueue the job without blocking the caller.
4. A full pipeline run against a known-good commit must reach finalize and write `status=success` + `currentSha=<new>` to state.json.
5. A deliberately broken commit (e.g. `pnpm build` failure) must trigger Stage 1 rollback successfully.
6. A deliberately broken commit + sabotaged Stage 1 (e.g. `rm -rf node_modules` mid-rollback) must trigger Stage 2 tarball extract successfully.
7. Pushover must deliver success and failure notifications when credentials are configured.

Plan 09-03 handles the subset of the above that can be exercised on dev (sql_escape unit tests, state.json python heredoc unit tests, snapshot retention logic in a scratch dir, etc.).

## Self-Check: PASSED

**Files created and verified on disk:**

- FOUND: `/Users/hulki/codex/charging-master/scripts/update/charging-master-updater.service`
- FOUND: `/Users/hulki/codex/charging-master/scripts/update/run-update.sh` (executable)
- FOUND: `/Users/hulki/codex/charging-master/install.sh` (modified)

**Commits verified in git log:**

- FOUND: `b6fd19b` — `feat(09): add charging-master-updater.service systemd unit file`
- FOUND: `ef01e41` — `feat(09): add run-update.sh pipeline with two-stage rollback`
- FOUND: `0d2b1ea` — `chore(09): install updater service, sqlite3+jq, chmod run-update.sh`

**Verification passes:**

- PASSED: `bash -n scripts/update/run-update.sh`
- PASSED: `bash -n install.sh`
- PASSED: all 28 required grep fragments present in run-update.sh
- PASSED: `test -x scripts/update/run-update.sh`
- PASSED: unit file has `Type=oneshot` and no `Requires=/BindsTo=/PartOf=`
- PASSED: install.sh has sqlite3+jq, charging-master-updater.service (6 refs), chmod +x run-update.sh, SSH escape hatch comment, no `systemctl enable` of updater
