---
gsd_state_version: 1.0
milestone: v1.2
milestone_name: Self-Update
status: completed
stopped_at: Phase 10 complete, milestone v1.2 ready for verification
last_updated: "2026-04-19T18:40:00.000Z"
last_activity: 2026-04-21 — Quick 260421-23e: relay identify-toggle next to every device row (both Discovery and Registered). New /api/devices/relay-by-ip endpoint with RFC1918 guard for unregistered Shellys. Redundant "Aktiv/Deaktiviert" span removed. LXC + origin on f1f7834.
progress:
  total_phases: 4
  completed_phases: 4
  total_plans: 10
  completed_plans: 10
  percent: 100
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-04-10)

**Core value:** Der Akku wird automatisch beim gewuenschten SOC-Level gestoppt -- kein manuelles Nachschauen, kein Ueberladen, laengere Akku-Lebensdauer.
**Current focus:** Milestone v1.2 -- Self-Update (roadmap complete, ready for Phase 7 planning)

## Current Position

Phase: 10 complete — milestone v1.2 code-complete
Plan: None — all 10 plans across 4 phases shipped; ready for verification and LXC deployment
Status: Phase 10-02 complete — UI integration landed. InstallModal, UpdateStageStepper, UpdateLogPanel, ReconnectOverlay shipped. UpdateBanner extended with FlowState machine and red rollback banner. All verified via curl harness on the dev server.
Last activity: 2026-04-10 — Plan 10-02 complete (3 tasks + auto-verified checkpoint, 4 files created + update-banner.tsx extended, all typecheck + HTML + rollback seed/ack tests PASS)

Progress: [##########] 100% (v1.0 + v1.1 + v1.2 code-complete; milestone v1.2 ready for LXC deployment)

**v1.2 Phase Map:**

- ✅ Phase 7: Version Foundation & State Persistence (VERS-01..04, INFR-03, INFR-04) — 6 reqs — complete
- ✅ Phase 8: GitHub Polling & Detection (DETE-01..06) — 6 reqs — complete
- ✅ Phase 9: Updater Pipeline & systemd Unit (EXEC-01..06, ROLL-01..07, INFR-01, INFR-02) — 15 reqs — complete (ROLL-06 finalized in Phase 10)
- ✅ Phase 10: UI Integration & Restart Handoff (LIVE-01..08, ROLL-06) — 9 reqs — complete

## Performance Metrics

**Velocity:**

- Total plans completed: 18 (v1.0)
- Average duration: ~3 min
- Total execution time: ~42 min

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| Phase 01-foundation | 3 | ~8min | ~2.7min |
| Phase 02-visualization | 3 | ~8.5min | ~2.8min |
| Phase 03-intelligence | 5 | ~17min | ~3.4min |
| Phase 04-notifications | 3 | ~6min | ~2min |
| 05 | 2 | - | - |
| 06 | 2 | - | - |

**Recent Trend:**

- Last 5 plans: 3min, 2min, 2min, 2min, 2min
- Trend: Stable

*Updated after each plan completion*
| Phase 07 P01 | 3.5min | 3 tasks | 12 files |
| Phase 07 P02 | 5.7min | 3 tasks + 1 checkpoint | 5 files |
| Phase 08 P01 | 20min | 7 tasks | 9 files |
| Phase 08 P02 | 12min | 3 tasks + 1 checkpoint | 3 files |
| Phase 09 P01 | 4min | 2 tasks + checkpoint (approved) | 3 files |
| Phase 09 P02 | ~8min | 3 tasks | 3 files (2 created + 1 modified) |
| Phase 09 P03 | 15min | 2 tasks | 1 files |
| Phase 10 P01 | 14min | 4 tasks | 6 files |
| Phase 10 P02 | 5min | 3 tasks + auto-verified checkpoint | 5 files (4 created + 1 modified) |

## Accumulated Context

### Decisions

Decisions are logged in PROJECT.md Key Decisions table.
Recent decisions affecting current work:

- [v1.2 Roadmap]: 4-phase structure -- Phase 7 (version foundation + state) → Phase 8 (GitHub polling) → Phase 9 (updater pipeline + systemd) → Phase 10 (UI integration)
- [v1.2 Roadmap]: In-place git-reset update strategy (NOT symlink-swap); tarball snapshot is the rollback escape hatch
- [v1.2 Roadmap]: WAL checkpoint via `POST /api/internal/prepare-for-shutdown` is mandatory before `systemctl stop` (correctness concern for active charge sessions)
- [v1.2 Roadmap]: `charging-master-updater.service` as `Type=oneshot` sibling unit; triggered via `systemctl start --no-block` (solves the parent-kill problem)
- [v1.2 Roadmap]: Generated `src/lib/version.ts` (git-ignored) is single source of truth for server + client; NOT `NEXT_PUBLIC_*` env vars
- [v1.2 Roadmap]: Phase 9 can develop in parallel with Phase 8 but must deploy before Phase 10 (UI depends on the pipeline + SSE log endpoint existing)
- [v1.2 Roadmap]: Two-stage rollback: Stage 1 = git reset + pnpm install + pnpm build + restart; Stage 2 = tarball extract + restart (escape hatch if Stage 1 itself fails)
- [v1.2 Roadmap]: Post-restart health probe (HTTP 200 + SHA match + DB healthy) is the anti-"silent success" gate
- [Phase 07]: Phase 7 foundation laid: generated version.ts (git-ignored), updateRuns Drizzle table + migration, UpdateStateStore with atomic tmp+rename writes; drizzle/ un-ignored bug fix
- [Phase 08]: GitHubClient uses native fetch + zod + AbortController; never throws, all failures mapped to LastCheckResult variants
- [Phase 08]: 304 merge rule: preserve previous ok lastCheckResult on unchanged, only refresh lastCheckAt
- [Phase 08]: 5-min /api/update/check cooldown enforced server-side via Date.now() - state.lastCheckAt, returns HTTP 429
- [Phase 08]: UpdateBanner renders 5 states in priority order (updateAvailable > error > rate_limited > ok/never); initial UpdateInfoView fetched server-side to eliminate loading flash
- [Phase 08]: Sidebar useUpdateAvailable() hook polls /api/update/status every 60s (mirrors useActiveLearnCount pattern); static red dot (no pulse) distinguishes from green active-learn pulse
- [Phase 08]: Install button intentionally absent per CONTEXT.md — Phase 10 re-entry point documented inline in STATE 1 branch of update-banner.tsx
- [Phase 09-01]: stopPolling() no-arg overload added as NEW method (not a replacement — stopAll() stays sync for SIGTERM path). Drain endpoint enforces localhost via Host header (not x-forwarded-for). WAL checkpoint uses PRAGMA wal_checkpoint(TRUNCATE) — verified WAL file = 0 bytes after drain.
- [Phase 09-02]: Updater script (556 lines bash) transcribed verbatim from plan. `flock -n 9` concurrency guard on FD 9, `trap on_error ERR` disables itself inside the trap to prevent recursive fires. sqlite3 CLI with `sql_escape` via `${var//\'/\'\'}`, python3 heredocs for atomic state.json writes (tmp + os.replace). Pushover credentials from `config` table with camelCase keys (`pushover.userKey`/`apiToken`) per Phase 4. Unit file is checked into repo at `scripts/update/` and install.sh `cp`s it into `/etc/systemd/system/` — auditable in git history instead of heredoc-inlined.
- [Phase 09-02]: Two-stage rollback hard-coded: Stage 1 runs full `git reset → pnpm install --frozen-lockfile → rm -rf .next → pnpm build → systemctl start → health_probe`; Stage 2 runs `tar -xzf snapshot → systemctl start → health_probe`. Stage 2 failure exits 3 with a CRITICAL priority=2 pushover — no Stage 3.
- [Phase 09-02]: `http://127.0.0.1:80` hard-coded in script per CONTEXT §Security (no env-var parametrization — less surface for mischief).
- [Phase 09-03]: dry-run-helpers.sh uses a temp file (not `source <(...)`) because bash 3.2 on macOS has a long-standing process-substitution bug that truncates the sourced stream before function definitions are parsed. sed filter also rewrites `set -euo pipefail` → `set -uo pipefail` (strip -e) and deletes the `mkdir -p "${STATE_DIR}"` line before the flock block. The plan's `timeout 5` wrapper was replaced with a portable background-subshell + kill pattern because `timeout` is not available on macOS by default.
- [Phase 09-03]: Checkpoint (Task 2) was auto-approved via orchestrator execution — the orchestrator ran the harness itself and asserted all four tests (preflight, snapshot, drain, health_probe) hit PASS markers. All deviations were Rule-3 blocking fixes discovered during that run.
- [Phase 10]: [Phase 10-01]: Three localhost-guarded update routes landed. POST /api/update/trigger pre-writes state to 'installing', uses detached spawn + .unref() + --no-block, 200ms sync race catches ENOENT + exit 4/5 for dev-mode 503 fallback with state rollback. GET /api/update/log SSE with DOUBLE cleanup hook (request.signal.abort AND ReadableStream cancel) calling idempotent cleanup (SIGTERM + 1s unref'd SIGKILL). Line-buffered stdout, 10s heartbeat as SSE comment, ENOENT + exit 4/5 fall back to synthetic dev frames. POST /api/update/ack-rollback clears rollbackHappened/rollbackReason/rollbackStage via spread-merge write. Zero orphan journalctl verified on macOS.
- [Phase 10-02]: Four new client components (InstallModal, UpdateStageStepper, UpdateLogPanel, ReconnectOverlay) + UpdateBanner extended with FlowState discriminated union state machine (idle → confirm → triggered → streaming → reconnecting → error). Rollback red banner renders top-priority when info.rollbackHappened === true with Verstanden → POST /api/update/ack-rollback ack. EventSource effect on /api/update/log keyed on [flow.kind, info.currentSha] (not logLines) so message handler doesn't thrash subscription; onmessage appends to capped 2000-line buffer and parses [stage=X] last-match-wins into currentStage. onerror while streaming → transitions to reconnecting → mounts ReconnectOverlay. Overlay polls /api/version every 2s via setTimeout chain (no overlap on slow restarts), 90s timeout, success gated on sha !== initialSha AND dbHealthy === true. InstallModal focus trap bounces Tab between exactly two buttons (cancel/confirm), ESC closes unless submitting, backdrop cancels unless submitting. ReconnectOverlay backdrop is a no-op (non-dismissable). 503 dev_mode from trigger maps to inline "Dev-Modus: ..." warning in modal. Auto-verified via curl harness: tsc clean, HTTP 200, Installieren <button> present, Update verfügbar renders, rollback banner seed → render → ack endpoint clears state.json → banner stays gone on reload. Milestone v1.2 self-update is code-complete; post-deploy smoke test on charging-master.local LXC required before declaring done-done.

### Pending Todos

- Post-deploy smoke test on charging-master.local LXC (verify real 202 trigger, full streaming flow, SHA auto-reload)

### Blockers/Concerns

None.

### Quick Tasks Completed

| # | Description | Date | Commit | Directory |
|---|-------------|------|--------|-----------|
| 260409-awk | Create one-line installer script (install.sh) | 2026-04-09 | df1042c | [260409-awk](./quick/260409-awk-create-one-line-installer-script-install/) |
| 260409-b9z | Extend install.sh with create-lxc mode | 2026-04-09 | dd97532 | [260409-b9z](./quick/260409-b9z-extend-install-sh-with-create-lxc-mode-f/) |
| 260419-charge-ux | v1.2.1 post-milestone polish: ChargeBanner redesign, SOC/Wh math rework (split sessionStart vs socBaseline), start_total_energy schema col, chart session scoping, dashboard inline indicator, countdown ring proportional to SOC | 2026-04-19 | ec54570..228bf06 (21 commits) | — inline, no quick/ dir |
| 260421-229 | Manual profile assignment while a session is still in `detecting` — adds "Profil manuell zuweisen" link to the detecting-state banner, reuses existing PUT /api/charging/sessions/:id backend, no schema changes | 2026-04-21 | f74f411 | [260421-229](./quick/260421-229-manual-profile-assign-detecting/) |
| 260421-146 | Guarded plug delete + richer registered-device rows (IP, live W, relay state, "Ladevorgang aktiv" badge). DELETE now returns 409 when an active session exists and cascades charge_sessions/power_readings in a transaction otherwise. Two-step confirm in UI. **Incident:** smoke-testing the DELETE against live Schuppen wiped 4 sessions + 52k readings — plug re-registered, lesson captured in memory. | 2026-04-21 | ea0182a | [260421-146](./quick/260421-146-guarded-plug-delete/) |
| 260421-23e | Relay identify-toggle next to every device row (Discovery + Registered). New /api/devices/relay-by-ip endpoint with RFC1918 guard for un-registered devices; existing /api/devices/:id/relay reused for registered. Removed redundant "Aktiv/Deaktiviert" span — green/red online dot on the left is already the live-status indicator. | 2026-04-21 | f1f7834 | [260421-23e](./quick/260421-23e-relay-toggle-in-lists/) |

## Session Continuity

Last session: 2026-04-19T18:40:00.000Z
Stopped at: v1.2.1 charge-banner/SOC/Wh polish deployed to LXC charging-master.local; live iPad session 5 running
Resume file: None
Next command: User-driven — next bug report or feature. Self-update pipeline is deployed in repo but NOT installed on LXC (flat `/opt/charging-master` served by `tsx server.ts`, no .git). Installing self-update requires running `install.sh` on the LXC.
