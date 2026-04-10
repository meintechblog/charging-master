# Research Summary — v1.2 Self-Update

**Project:** Charging-Master
**Domain:** In-app self-update for a systemd-managed Next.js 15 server on Debian LXC
**Researched:** 2026-04-10
**Confidence:** HIGH

---

## Executive Summary

Charging-Master v1.2 adds a production-quality in-app self-update mechanism: the app detects new commits on GitHub, lets the user review and trigger an update on-click, streams the live install log, handles the server restart gracefully in the browser, and rolls back automatically on failure. This is a well-trodden pattern in self-hosted tools (Home Assistant Supervisor, Portainer, Sonarr) and the research across all four files is tightly convergent — no framework debates, no library choices to make, just careful plumbing.

The fundamental architectural insight that shapes every other decision is the "kill your own parent" problem: the Node process that triggers the update is the same process that will be restarted by it. The solution — and the single highest-stakes decision of the milestone — is a dedicated `charging-master-updater.service` systemd `Type=oneshot` unit that runs in its own cgroup as a sibling of the main service, not a child. All update logic runs inside that unit. The Node app only fires-and-forgets a `systemctl start --no-block` call. Get this right first; everything else plugs in around it.

The main risks are: rollback that itself fails (mitigated by a pre-update snapshot tarball as the escape hatch), `pnpm install` corrupting `better-sqlite3` native bindings if the main service is still running during install (mitigated by stopping the app before `pnpm install`, not after), and the browser showing a blank error page during the 30-90 second restart window (mitigated by the reconnect overlay polling `/api/version`). All three are well-understood and preventable with the patterns documented in the research.

---

## Load-Bearing Decisions

These five decisions are architectural constraints that shape every other implementation choice. They must be locked before writing a single line of feature code.

### Decision 1: Dedicated `charging-master-updater.service` as the parent-kill solution

The updater runs as a systemd `Type=oneshot` unit with no dependency on `charging-master.service`. The Node app triggers it via `child_process.spawn('systemctl', ['start', '--no-block', 'charging-master-updater.service'], { detached: true, stdio: 'ignore' }).unref()`. The `--no-block` flag is load-bearing: without it the API route hangs waiting for a unit that will kill the process it is waiting in. The `detached: true` + `unref()` combination ensures Node's event loop does not hold a handle on the systemctl call, so the caller process can exit cleanly while systemd continues. This is the correct answer; no alternatives are viable.

### Decision 2: Stop-before-install pipeline order (not restart-after-build)

The update pipeline order must be: `git fetch/reset` -> `systemctl stop charging-master.service` -> `pnpm install` -> `pnpm build` -> `systemctl start charging-master.service` -> health check. The naive order (`pnpm build` -> `systemctl restart`) is wrong: the main service's open file handles on `better-sqlite3`'s native `.node` binding race with `pnpm install` overwriting it. Stopping first creates a planned downtime window of 30-120 seconds, acceptable for a single-user LAN app.

### Decision 3: Generated `src/lib/version.ts` (not `NEXT_PUBLIC_*` env vars)

A prebuild script (`scripts/build/generate-version.mjs`) writes `src/lib/version.ts` with `CURRENT_SHA`, `CURRENT_SHA_SHORT`, `BUILD_TIME_ISO`, and `BRANCH` as static string exports. Both server code and client components import from `@/lib/version` — one source of truth. The `NEXT_PUBLIC_*` alternative works for the client but creates two read paths (server reads `process.env`, client reads the inlined constant) that can drift. `src/lib/version.ts` is git-ignored and regenerated on every `pnpm build`.

### Decision 4: `.update-state/state.json` for cross-process state (not SQLite)

The state shared between the Node app and the bash updater script lives in `/opt/charging-master/.update-state/state.json`. SQLite is rejected for this role because the bash updater cannot sanely read/write it on failure paths without depending on the `sqlite3` CLI. The JSON file uses atomic tmp-file + rename writes. The `UpdateStateStore` TypeScript class owns all Node-side reads/writes; the bash script has a `write_state()` function. Both agree on the schema at design time.

### Decision 5: Snapshot tarball as the rollback escape hatch

Before any git/pnpm operation, the updater tars `node_modules/` and `.next/` into `/var/lib/charging-master/snapshots/<sha>-prev.tgz`. If both the forward update and the clean rollback (git-reset + pnpm-install + pnpm-build) fail, the updater extracts the tarball and restarts — no network, no pnpm, no git required. Without this escape hatch, a disk-full or network-failure scenario during rollback leaves the box permanently down.

---

## Key Findings

### Recommended Stack

Zero new production dependencies. The entire self-update feature is built with Node.js built-ins plus tools already on the Debian LXC.

**Core technologies for this milestone:**
- `node:child_process.spawn` — systemctl trigger, journalctl log tail, git operations in the updater script
- `node:fetch` with ETag caching — GitHub commits API, single endpoint, no auth, 4 req/day under the 60/h unauthenticated limit
- `ReadableStream` + `text/event-stream` — live log SSE, reuses the existing power-chart SSE pattern exactly
- `setInterval` in `server.ts` — 6h background check, boots alongside `HttpPollingService` and `ChargeMonitor` in `main()`
- `scripts/update/run-update.sh` — bash pipeline with `trap ERR` rollback, sentinel lines for stage parsing, atomic state.json writes
- `systemd Type=oneshot` — the one new infrastructure artifact; written by `install.sh`, never `[Install]`ed

**Do not add:** `simple-git`, `@octokit/rest`, `isomorphic-git`, `node-cron`, `pm2`, `execa`, `electron-updater`, `update-notifier`. Each is explicitly rejected in STACK.md with rationale.

### Expected Features

All 13 table-stakes features (T1-T13) are in scope for v1.2. The UX bar is set by Home Assistant Supervisor, Portainer, and Sonarr. The gap between amateur and professional self-update is almost entirely in feedback during the install window and reconnect handling after restart.

**Must have — v1.2 launch blockers (T1-T13):**
- Version display: short SHA + build timestamp in Settings header (T1, T13)
- Dedicated `/settings/updates` screen (T2)
- "Update available" badge on Settings nav (T3) + last-check timestamp (T4)
- Explicit Install button, never auto-applies (T5)
- Live SSE log stream from `journalctl -fu charging-master-updater` (T6)
- Staged progress states: idle -> checking -> available -> pulling -> installing -> building -> restarting -> verifying -> done/failed (T7)
- Reconnect overlay polling `/api/version` every 2s with auto-reload (T8)
- Success state showing old SHA -> new SHA (T9)
- Failure banner + rollback visibility, never silent (T10)
- "Check now" manual button with 5-minute server-side rate limit (T11)
- "You're up to date" empty state (T12)

**Should include if capacity allows (P2 polish, cheap):**
- D2: Reconnect countdown with explanatory copy ("usually 30-60 seconds")
- D3: Reconnect timeout hint with SSH fallback command after 90s
- D4: Pushover notification on rollback (one-line reuse of existing integration)
- D8: Copy log to clipboard button

**Defer to v1.3+:**
- D1: Changelog preview via GitHub compare API (highest-value deferral; consider promoting if GitHub client already wired)
- D5: Update history table
- D7: Global in-progress indicator across all pages

**Never build (anti-features A1-A13):**
- Auto-install without confirmation
- Forced update modal blocking UI
- Opaque spinner during install (must be live log)
- Silent rollback (must be visible failure banner)
- Client-side GitHub polling (must be server-side only)

### Architecture Approach

The new domain slots cleanly into the existing `server.ts`-as-long-lived-process architecture. `UpdateChecker` is a singleton booted in `main()` alongside `HttpPollingService` and `ChargeMonitor`. State flows through the existing `EventBus`. Route handlers are thin shims. The only structural novelty is the out-of-process updater unit and the cross-process state file.

**Major components:**

1. **`src/lib/version.ts`** — git-ignored generated file; baked constants imported by both server routes and client components

2. **`src/modules/self-update/`** — domain module:
   - `update-checker.ts` — 6h interval singleton, compares GitHub SHA to `CURRENT_SHA`, emits `update:check` on EventBus
   - `github-client.ts` — single `fetch()` to `/commits/main` with ETag support, zod-validated response
   - `update-state-store.ts` — atomic reads/writes of `.update-state/state.json`; shared schema with the bash script
   - `update-trigger.ts` — spawns `systemctl start --no-block` (detached, unref), writes `status=updating` before spawn
   - `journal-tailer.ts` — per-SSE-subscriber ephemeral `journalctl -fu` child; bypasses EventBus

3. **`src/app/api/version/route.ts`** — fast GET returning current SHA + state; the browser reconnect polling target

4. **`src/app/api/update/start/route.ts`** — POST; validates no update in flight, calls trigger, returns 202

5. **`src/app/api/update/log/route.ts`** — SSE GET; instantiates JournalTailer, cleans up on `request.signal.abort`

6. **`scripts/update/run-update.sh`** — bash pipeline with stop-before-install order, `::STAGE::` sentinel lines, `trap ERR` rollback

7. **`/etc/systemd/system/charging-master-updater.service`** — `Type=oneshot`, `TimeoutStartSec=900`, no `[Install]`, no coupling to main service

### Critical Pitfalls — Watch Out For

1. **Parent-kill via cgroup inheritance** — updater running as a child of `charging-master.service` gets killed by systemd's `KillMode=control-group` when the main service restarts, leaving `node_modules/` half-written. The `Type=oneshot` sibling unit with `--no-block` + `detached: true` + `unref()` is the only correct fix. (PITFALLS.md §1)

2. **`better-sqlite3` binding race** — `pnpm install` running while the main service holds open file handles on the native `.node` binding produces "Could not locate the bindings file" on the next boot. Stop the main service before `pnpm install`, not after. Add `pnpm rebuild better-sqlite3` post-install. (PITFALLS.md §2)

3. **Rollback that itself fails** — a git-reset rollback that then re-runs `pnpm build` can fail for the same reasons the forward update failed (stale `.next/` cache, disk full, network down). The pre-update snapshot tarball is the mandatory escape hatch: no network, no pnpm, pure filesystem restore. (PITFALLS.md §6, §7)

4. **Browser stays on old version after restart** — EventSource auto-reconnect does not cause a page reload. The reconnect overlay must poll `/api/version` and trigger `window.location.reload()` when the returned SHA differs from the SHA baked into the current page. The expected-new-SHA must be stored in localStorage before triggering the update. (PITFALLS.md §10)

5. **Stale `.next/` cache breaking the post-reset build** — run `rm -rf .next` unconditionally before every `pnpm build` in the updater pipeline (forward and rollback both). Non-negotiable. (PITFALLS.md §11)

---

## Conflicts and Open Decisions

These tensions between research documents require an explicit decision before implementation begins.

### Conflict A: `NEXT_PUBLIC_*` env vars vs generated `src/lib/version.ts`

STACK.md recommends injecting version constants via `next.config.ts`'s `env` block. ARCHITECTURE.md recommends a generated `src/lib/version.ts` file.

**Recommendation: generated file.** Creates one import path for both server and client, aligns with `src/lib/` conventions, avoids two read paths that can drift. Both researchers agree on using a prebuild script; only the output format differs.

### Conflict B: In-place update vs symlink-swap deployment model

PITFALLS.md §6 strongly recommends the symlink-swap pattern as the most robust rollback strategy (atomic, no rebuild needed). ARCHITECTURE.md and STACK.md design around in-place git-reset.

**Recommendation: in-place for v1.2, document symlink-swap as the v1.3 upgrade path.** Symlink-swap is architecturally better but is a larger scope change. In-place + snapshot tarball escape hatch is a reasonable starting point for a single-developer v1.2. Mark as known technical debt.

### Conflict C: SQLite WAL drain before stop

PITFALLS.md §3 recommends a `POST /api/internal/prepare-for-shutdown` endpoint that checkpoints the SQLite WAL before stopping the main service. ARCHITECTURE.md does not include this in the component list.

**Recommendation: include in Phase 2 as a mandatory pre-stop step.** This is a correctness concern (interrupted charging sessions lose the last 30 seconds of power samples, leave `ended_at = null` forever), not polish. The endpoint is internal-only and cheap to add.

---

## Implications for Roadmap

The four researchers independently converged on four phases. Minor differences reconciled below.

### Phase 1: Infrastructure Foundation

**Rationale:** The `Type=oneshot` systemd unit and the version-baking mechanism are prerequisites for every other component. No update logic can be tested without the unit. No version display can be built without `src/lib/version.ts`. Build this first even if it produces no visible UI.

**Delivers:**
- `charging-master-updater.service` unit file (written by `install.sh`)
- `scripts/build/generate-version.mjs` + `src/lib/version.ts` (git-ignored, prebuild)
- `package.json` script changes (`gen:version && next build`, `gen:version && tsx watch server.ts`)
- `src/lib/version.ts` added to `.gitignore`
- GitHub API preflight compatibility check (pnpm/Node version gate before triggering)
- `timedatectl` sync check in `install.sh`

**Addresses features:** T1 (version display data), T13 (build timestamp)
**Avoids pitfalls:** Pitfall 1 (parent-kill), Pitfall 13 (permissions documented), Pitfall 17 (clock sync)
**Research flag:** Standard patterns — skip phase research

### Phase 2: Updater Pipeline

**Rationale:** The bash pipeline with its rollback trap is the critical path. Everything in the UI and backend depends on the pipeline producing reliable state transitions. Build and test the pipeline in isolation via SSH before wiring up any UI.

**Delivers:**
- `scripts/update/run-update.sh`: git stash -> fetch -> reset -> `systemctl stop main` -> `rm -rf .next` -> `pnpm install` -> `pnpm rebuild better-sqlite3` -> `pnpm build` -> `systemctl start main` -> health check
- `trap ERR` rollback: Stage 1 (clean rebuild) -> Stage 2 (tarball restore) -> Stage 3 (Pushover + PANIC file)
- Pre-update snapshot tarball at `/var/lib/charging-master/snapshots/<sha>-prev.tgz`
- `::STAGE::` sentinel lines for UI step parsing
- `POST /api/internal/prepare-for-shutdown` (WAL checkpoint + pause writes)
- `flock` file lock to prevent concurrent runs
- Pre-flight checks: disk space, git repo cleanliness, pnpm/Node version compatibility, clock sync
- `update_log` Drizzle schema for persistent log after run

**Addresses features:** T6 (log source), T7 (stage markers), T10 (rollback state)
**Avoids pitfalls:** Pitfall 2, 3, 4, 5, 6, 7, 11, 14, 15, 16
**Research flag:** Complex — consider brief research on `flock` + systemd concurrency if unfamiliar

### Phase 3: Backend Domain Module + API Routes

**Rationale:** With the pipeline verified, wire up the TypeScript side. This phase produces a fully functional backend — the update can be triggered via `curl` and monitored via `curl -N`.

**Delivers:**
- `src/modules/self-update/` — all five module files
- `server.ts` modification: `UpdateChecker` booted in `main()`, `updateChecker.stop()` in shutdown
- `globalThis.__updateStateStore` and `globalThis.__updateChecker` exposed for route handlers
- `GET /api/version` — current SHA + state (browser reconnect poll target)
- `POST /api/update/start` — validates no in-flight update, triggers unit, returns 202
- `GET /api/update/status` — full state.json for UI reconnect
- `GET /api/update/log` — SSE, `journalctl -fu charging-master-updater`, process cleanup on abort
- `POST /api/version/check` — force-run GitHub check, 5-min server-side rate limit
- `X-App-Version` header on all responses

**Addresses features:** T3 (badge data), T4 (last-check), T5 (trigger), T6 (SSE endpoint), T11 (check now)
**Avoids pitfalls:** Pitfall 8 (rate limit/ETag), Pitfall 9 (stale check SHA), Pitfall 12 (health check), Pitfall 15 (concurrency gate)
**Research flag:** Standard patterns — skip phase research

### Phase 4: Settings UI

**Rationale:** By Phase 4 the backend is fully functional. The UI is a read-heavy consumer of Phase 3 endpoints. Build UI last so it can be tested against real data flows, not mocks.

**Delivers:**
- `/settings/updates` page (Next.js App Router server component)
- `VersionBadge` component (imports from `@/lib/version`, client component)
- Update-available badge on Settings nav item
- Staged progress stepper (parses `::STAGE::` markers from SSE log stream)
- Live log panel (monospace, auto-scroll, EventSource client)
- Reconnect overlay: spinner + elapsed counter + explanatory copy, polls `/api/version` every 2s, `window.location.reload()` on SHA change, stores expected-new-SHA in localStorage before triggering
- Success state (old SHA -> new SHA)
- Failure banner (persistent, links to log, never silent)
- "You're up to date" empty state
- "Check now" button with client-side debounce
- Confirmation dialog before install
- D2/D3: Reconnect countdown + timeout hint with SSH fallback command
- D4: Pushover on rollback (one-line)
- D8: Copy log to clipboard

**Addresses features:** T1-T13 complete, D2, D3, D4, D8
**Avoids pitfalls:** Pitfall 10 (browser reconnect), Pitfall 12 (health gate: HTTP 200 + SHA match + DB-ready)
**Research flag:** Standard patterns — skip phase research

### Phase Ordering Rationale

- Phase 1 before Phase 2: the unit file must exist before `run-update.sh` can be tested via `systemctl start`
- Phase 2 before Phase 3: backend routes depend on state.json schema being stable; stabilizing the pipeline first locks the schema
- Phase 3 before Phase 4: UI built against real endpoints so the reconnect overlay and SSE parsing can be tested end-to-end
- The pipeline (Phase 2) is the highest-risk component; it should be validated in isolation via SSH before any UI exists

### Research Flags

Phases needing deeper research during planning:
- **Phase 2:** `flock` + systemd concurrency interaction has a few edge cases; worth 30 minutes of focused research if the pattern is unfamiliar

Phases with standard patterns (skip research-phase):
- **Phase 1:** systemd unit files and prebuild scripts are well-documented
- **Phase 3:** follows existing module + route conventions exactly
- **Phase 4:** follows existing SSE + React patterns exactly

---

## Requirements-Ready Feature List

Grouped by phase for the requirements step.

### Phase 1 — Infrastructure

| ID | Feature | Notes |
|----|---------|-------|
| P1-1 | `charging-master-updater.service` systemd unit | `Type=oneshot`, no `[Install]`, written by `install.sh` |
| P1-2 | `scripts/build/generate-version.mjs` prebuild script | Writes `src/lib/version.ts` |
| P1-3 | `package.json` script updates | `build` and `dev` run `gen:version` first |
| P1-4 | `.gitignore` update | Add `src/lib/version.ts` |
| P1-5 | GitHub compatibility preflight | Fetch candidate `package.json`, check `packageManager` and lockfile version |
| P1-6 | `timedatectl` sync check in `install.sh` | Warn if clock not synchronized |

### Phase 2 — Updater Pipeline

| ID | Feature | Notes |
|----|---------|-------|
| P2-1 | `scripts/update/run-update.sh` | Full pipeline with `trap ERR` |
| P2-2 | Pre-flight checks | Disk space, git cleanliness, flock availability |
| P2-3 | `rm -rf .next` before every build | Forward and rollback paths both |
| P2-4 | `systemctl stop main` before `pnpm install` | Not after build |
| P2-5 | `pnpm rebuild better-sqlite3` post-install | Belt-and-braces |
| P2-6 | `::STAGE::` sentinel lines | Parseable by UI step display |
| P2-7 | `trap ERR` rollback function | Stage 1: clean rebuild; Stage 2: tarball; Stage 3: Pushover + PANIC file |
| P2-8 | Pre-update snapshot tarball | `/var/lib/charging-master/snapshots/<sha>-prev.tgz` |
| P2-9 | `flock` concurrency lock | Wraps entire updater script |
| P2-10 | `POST /api/internal/prepare-for-shutdown` | WAL checkpoint + pause writes before stop |
| P2-11 | Health check after restart | Poll `localhost:3000/api/version` for up to 60s, verify new SHA |
| P2-12 | `update_log` Drizzle schema | Persist last run's log for post-run display |

### Phase 3 — Backend Module + API

| ID | Feature | Notes |
|----|---------|-------|
| P3-1 | `src/modules/self-update/update-checker.ts` | 6h singleton, EventBus integration, booted in `server.ts` |
| P3-2 | `src/modules/self-update/github-client.ts` | `fetch` + ETag + zod validation |
| P3-3 | `src/modules/self-update/update-state-store.ts` | Atomic state.json reads/writes |
| P3-4 | `src/modules/self-update/update-trigger.ts` | `detached: true` + `unref()` spawn |
| P3-5 | `src/modules/self-update/journal-tailer.ts` | Per-subscriber child, SIGTERM on disconnect |
| P3-6 | `server.ts` modification | Boot UpdateChecker, stop in shutdown |
| P3-7 | `GET /api/version` | Fast, no external calls; `X-App-Version` header |
| P3-8 | `POST /api/update/start` | Concurrency gate, returns 202 |
| P3-9 | `GET /api/update/log` | SSE, process cleanup required |
| P3-10 | `GET /api/update/status` | Full state for reconnect |
| P3-11 | `POST /api/version/check` | Force-check, 5-min rate limit |
| P3-12 | `X-App-Version` header on all responses | Enables client SHA-mismatch detection |

### Phase 4 — Settings UI

| ID | Feature | Notes |
|----|---------|-------|
| P4-1 | `/settings/updates` page | Server component reads version + state |
| P4-2 | `VersionBadge` component | Imports from `@/lib/version`, no API call |
| P4-3 | Update-available badge on Settings nav | Client component, polls `/api/version` |
| P4-4 | Last-check timestamp | "2h ago" + absolute on hover |
| P4-5 | Staged progress stepper | Parses `::STAGE::` from SSE stream |
| P4-6 | Live log panel | Monospace, auto-scroll, EventSource |
| P4-7 | Reconnect overlay | Spinner + elapsed counter + copy; polls `/api/version`; auto-reload on SHA change |
| P4-8 | Reconnect timeout + SSH hint (>90s) | D3 — cheap, include |
| P4-9 | Expected-new-SHA in localStorage | Set before triggering, read by overlay |
| P4-10 | Success state (old SHA -> new SHA) | T9 |
| P4-11 | Failure banner (persistent, links to log) | T10 |
| P4-12 | "You're up to date" empty state | T12 |
| P4-13 | "Check now" button with client debounce | T11 |
| P4-14 | Pushover on rollback | D4 — one-line reuse |
| P4-15 | Copy log to clipboard | D8 — one-line |
| P4-16 | Confirmation dialog before install | ~10 min, prevents accidental clicks |

---

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | Zero new dependencies. All choices are Node.js built-ins or already-installed packages. |
| Features | HIGH | Patterns verified across Home Assistant, Portainer, Sonarr, Grafana. Strong convergence. |
| Architecture | HIGH | Verified against actual source files (`server.ts`, existing SSE route). Not speculative. |
| Pitfalls | HIGH | systemd cgroup semantics, pnpm native binding behavior, SQLite WAL are well-documented. MEDIUM only on pnpm@10 edge cases. |

**Overall confidence:** HIGH

### Gaps to Address

- **Conflict B (symlink-swap vs in-place):** User must decide before Phase 2. In-place recommended for v1.2 and documented as tech debt.
- **Conflict C (WAL drain scope):** Confirm whether charging sessions in progress should block or be interrupted before the updater stops the service.
- **Health check implementation detail:** Does the updater shell script poll `localhost:3000/api/version` or use `systemctl is-active` + port check? HTTP poll recommended (verifies app logic, not just process existence).
- **Log persistence strategy:** `update_log` Drizzle table vs flat file per run. Decision needed before Phase 2 schema work.
- **D1 changelog preview:** Deferred to v1.3+ but the GitHub client already supports it. If promoted to v1.2, only requires the compare API endpoint and a collapsed commit list UI.

---

## Sources

### Primary (HIGH confidence)
- GitHub REST rate limits docs — unauthenticated 60/h, 304 does not count against quota
- Next.js instrumentation.ts docs — canonical process-lifetime singleton entry point
- systemd.exec / systemctl(1) man pages — `--no-block`, cgroup semantics, `Type=oneshot`
- Shelly Plug S Gen3 API docs — existing stack, unchanged for this milestone
- pnpm@10 docs — `--frozen-lockfile`, `onlyBuiltDependencies`

### Secondary (MEDIUM confidence)
- Home Assistant, Portainer, Sonarr update UX — feature patterns from direct usage
- ArchWiki Polkit reference — non-root trigger alternative (documented but not needed for this LXC)
- vercel/next.js discussions #15849, #50181 — `git rev-parse HEAD` in `next.config.ts` pattern

### Tertiary (LOW confidence)
- pnpm@10 + better-sqlite3 binding edge cases — flagged as MEDIUM in PITFALLS.md §2; verify during Phase 2 on the actual LXC

---
*Research completed: 2026-04-10*
*Ready for roadmap: yes*
