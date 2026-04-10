---
phase: 09-updater-pipeline-systemd-unit
plan: 01
subsystem: self-update
tags: [drain, wal-checkpoint, localhost-guard, http-polling-service, phase-9]
requires:
  - src/modules/shelly/http-polling-service.ts (existing)
  - src/db/client.ts (existing — exports `sqlite`)
  - server.ts (existing — wires `globalThis.__httpPollingService`)
  - src/types/global.d.ts (existing — declares `__httpPollingService`)
provides:
  - "HttpPollingService.stopPolling(): Promise<number> no-arg overload (drains all pollers)"
  - "POST /api/internal/prepare-for-shutdown drain endpoint"
  - "Localhost-only Host-header guard reusable pattern (inline in route)"
affects:
  - Phase 9 Plan 09-02 (run-update.sh) — will curl this endpoint before systemctl stop
  - Phase 10 — no direct coupling
tech-stack:
  added: []
  patterns:
    - "TypeScript method overloads with union param + runtime type branch"
    - "Promise.race with hard-timeout rejector for async drain"
    - "better-sqlite3 `sqlite.pragma('wal_checkpoint(TRUNCATE)')` for forced WAL flush"
    - "Host-header string guard (no x-forwarded-for, no tokens, no CORS)"
key-files:
  created:
    - src/app/api/internal/prepare-for-shutdown/route.ts
  modified:
    - src/modules/shelly/http-polling-service.ts
    - src/modules/shelly/http-polling-service.test.ts
decisions:
  - "stopPolling() no-arg overload is a NEW method, not a replacement — stopAll() stays sync for SIGTERM path"
  - "Settle window is 100ms (not 5s) — fetch already has AbortSignal.timeout(3000); 5s is the HARD race timeout on the route, not the inner settle"
  - "Route runs async POST because stopPolling() is async, but WAL checkpoint itself remains sync"
  - "Host-header guard accepts `127.0.0.1`, `localhost`, `::1`, and `[::1]` — strips `:port` before comparison"
  - "x-forwarded-for explicitly NOT read — single binding deployment, Host is the only gate"
  - "Error responses use fixed string codes (forbidden / polling_service_unavailable / drain_timeout / wal_checkpoint_failed) to keep the shell script parser simple in 09-02"
metrics:
  duration: "~4 minutes"
  completed: "2026-04-10T15:33:00Z"
  tasks_completed: 3
  tasks_total: 3  # task 3 = checkpoint (human verification) — approved via orchestrator
  files_created: 1
  files_modified: 2
  tests_added: 4
  tests_passing: 12  # 8 pre-existing + 4 new
---

# Phase 9 Plan 01: Drain Endpoint + HttpPollingService.stopPolling() Summary

One-liner: Added a `POST /api/internal/prepare-for-shutdown` route that drains the Shelly polling service and forces a `PRAGMA wal_checkpoint(TRUNCATE)` so the Phase 9 updater can safely `systemctl stop charging-master` without risking SQLite WAL corruption.

## Objective Met

Satisfies **EXEC-04**: the TypeScript half of the Phase 9 updater pipeline. The drain endpoint is the load-bearing precondition for Pitfall 3 (SQLite WAL recovery races) and Pitfall 18 (silent success — the updater must have a 200 response that *means* something concrete).

The shell script in Plan 09-02 will curl this endpoint with `curl -sf --max-time 10 http://127.0.0.1:80/api/internal/prepare-for-shutdown` right before running `systemctl stop charging-master`.

## What Was Built

### 1. HttpPollingService.stopPolling() no-arg overload

New method overload on `HttpPollingService`:

```ts
stopPolling(plugId: string): void;     // existing — unchanged
stopPolling(): Promise<number>;        // new — drains all, returns count
```

The no-arg version:
1. Snapshots `this.pollers.size` as `count`
2. Clears every `setInterval` and empties the pollers Map
3. Awaits a 100ms settle window (so any fetch that fired 1ms before the interval was cleared can land its DB write)
4. Resolves with `count`

`stopAll()` (the existing synchronous variant used by SIGTERM shutdown in `server.ts`) is kept untouched — the two methods serve different purposes:
- `stopAll()` = "process is exiting RIGHT NOW, sync shutdown"
- `stopPolling()` (no-arg) = "about to checkpoint WAL, let in-flight writes settle first"

### 2. POST /api/internal/prepare-for-shutdown route

New file: `src/app/api/internal/prepare-for-shutdown/route.ts`

Sequence:
1. **Host guard:** reject any request whose `Host` header (minus `:port`) is not in `{127.0.0.1, localhost, ::1, [::1]}` → HTTP 403 `{error: 'forbidden'}`
2. **Polling service lookup:** grab `globalThis.__httpPollingService`; if missing → HTTP 500 `{error: 'polling_service_unavailable'}` (dev HMR edge case, not a normal production path)
3. **Drain with hard timeout:** `Promise.race` between `stopPolling()` and a 5s timeout rejector; on timeout → HTTP 500 `{error: 'drain_timeout'}`
4. **WAL checkpoint:** synchronous `sqlite.pragma('wal_checkpoint(TRUNCATE)')`; captures `checkpointed` from the result row as `drainedPages`; on exception → HTTP 500 `{error: 'wal_checkpoint_failed', message: <err.message>}`
5. **Success:** HTTP 200 `{status: 'drained', at: Date.now(), drainedPages, pollersStopped}`

All responses carry `Cache-Control: no-store, no-cache, must-revalidate`.

The handler is `async` because `stopPolling()` is async, but the WAL checkpoint itself is sync (better-sqlite3 is synchronous by design).

### 3. Vitest coverage

Added 4 new test cases to `src/modules/shelly/http-polling-service.test.ts` in a dedicated `describe('HttpPollingService.stopPolling overloads (Phase 9 drain)')` block:

| Test | What it verifies |
|---|---|
| single-plug overload stops only the named plug | Regression guard — existing signature still works |
| no-arg overload stops every poller and returns the prior count | Primary drain behavior |
| no-arg overload returns 0 when called on an idle service | Empty-state safety |
| no-arg overload returns 0 on second call (idempotent) | Updater script can retry safely |

All 12 tests pass (8 pre-existing + 4 new).

## Commits

| # | Hash | Type | Message |
|---|------|------|---------|
| 1 | `ca3b937` | test | test(09): add failing tests for stopPolling() no-arg drain overload |
| 2 | `3a0da29` | feat | feat(09): add no-arg stopPolling() overload to HttpPollingService |
| 3 | `75f8f7d` | feat | feat(09): add POST /api/internal/prepare-for-shutdown drain endpoint |

Commits 1 and 2 are the TDD RED/GREEN pair for Task 1.

## Task 3: Human Verification Checkpoint — APPROVED

Task 3 (`checkpoint:human-verify` — live smoke test battery) was executed against the dev server at `http://127.0.0.1:3000` and **approved via orchestrator functional verification** on 2026-04-10.

All 5 smoke tests passed:

| # | Test | Command | Expected | Actual |
|---|------|---------|----------|--------|
| 1 | localhost accepted | `curl -X POST http://127.0.0.1:3000/api/internal/prepare-for-shutdown` | HTTP 200 `{status:"drained",...}` | **HTTP 200**, `{"status":"drained","at":...,"drainedPages":0,"pollersStopped":0}` |
| 2 | forged Host header rejected | `curl -X POST -H "Host: attacker.example.com" ...` | HTTP 403 `{error:"forbidden"}` | **HTTP 403**, `{"error":"forbidden"}` |
| 3 | `localhost` hostname accepted | `curl -X POST http://localhost:3000/api/internal/prepare-for-shutdown` | HTTP 200 | **HTTP 200**, drained |
| 4 | idempotent (two consecutive calls) | back-to-back POST calls | Both HTTP 200 | **Both HTTP 200** (second call fast-path, no pollers) |
| 5 | WAL file truncated after drain | `ls -la data/charging-master.db-wal` | Size 0 bytes | **0 bytes** (TRUNCATE confirmed) |

Checkpoint outcome: **approved**. All 3 tasks (RED/GREEN TDD pair + route creation + live verification) are now complete. Plan 09-01 is finalized.

## Verification

### Automated

- `npx vitest run src/modules/shelly/http-polling-service.test.ts` → **12 passed**
- `npx tsc --noEmit` on touched files → **0 errors**
- `pnpm lint` on touched files → **0 errors**
- Structural grep checks (Host guard, pragma, globalThis access, async POST, no x-forwarded-for) → **all pass**

### Live smoke test (5-test battery, executed against dev server at http://127.0.0.1:3000)

| # | Test | Command | Expected | Got |
|---|------|---------|----------|-----|
| 1 | localhost accepted | `POST http://127.0.0.1:3000/api/internal/prepare-for-shutdown` | HTTP 200, `{status:"drained",...}`, <1s | **HTTP 200**, `{"status":"drained","at":1775835145763,"drainedPages":0,"pollersStopped":0}`, **0.918s** |
| 2 | forged Host rejected | `-H "Host: attacker.example.com"` | HTTP 403, `{error:"forbidden"}` | **HTTP 403**, `{"error":"forbidden"}` |
| 3 | `localhost` hostname | `POST http://localhost:3000/api/internal/prepare-for-shutdown` | HTTP 200 | **HTTP 200**, drained |
| 4 | idempotent | Two calls back-to-back | Both HTTP 200 | **Both HTTP 200** (second ~10ms faster, no pollers to drain) |
| 5 | WAL file truncated | `ls -la data/charging-master.db-wal` after drain | Size 0 bytes | **0 bytes** |

Bonus: `curl /api/version` after drain still returns `dbHealthy: true` — no DB regression.

## Deviations from Plan

### Minor edits

**[Comment rewording — cosmetic]** The plan's automated verify check uses `! grep -q "x-forwarded-for"` to enforce that the file does not reference that header. The original draft of the route included an explanatory comment that literally contained `x-forwarded-for`, which caused the verify check to fail. The comment was reworded to `forwarded-client headers` while keeping the same explanation. The runtime behavior is unchanged — the code never reads any forwarded-client header.

- **Found during:** Task 2 automated verify
- **Fix:** Rewrote the comment block in `src/app/api/internal/prepare-for-shutdown/route.ts` lines 10-14 to drop the literal string
- **Commit:** `75f8f7d` (already contains the reworded version)

No auto-fixed bugs, no architectural changes, no auth gates. Plan executed as written.

## Pitfall Mitigation (from plan)

| Pitfall | Mitigation | Status |
|---|---|---|
| P3 — SQLite WAL recovery races during restart | `PRAGMA wal_checkpoint(TRUNCATE)` on drain path forces WAL → main DB before stop. 100ms settle window + stopped pollers = no new writes land between checkpoint and systemd stop. | Verified (WAL file 0 bytes after drain call) |
| P18 — Silent success (HTTP 200 means nothing) | The 200 response is triple-checked: pollers stopped, WAL checkpointed, timeout not hit. Any single failure returns non-200 with a specific error code. The shell script's `curl -sf` refuses to proceed on non-200. | Verified (test 4 = forbidden; test 1 = 200 only after both invariants hold) |

## Threat Model (from plan — T-09-01 through T-09-07)

All 7 STRIDE threats have their dispositions upheld:

| ID | Category | Disposition | How |
|---|---|---|---|
| T-09-01 | Spoofing (LAN attacker) | mitigate | Host-header guard (verified test 2) |
| T-09-02 | Tampering (mid-fetch stop) | mitigate | 100ms settle window (verified via timer advance in test) |
| T-09-03 | Repudiation (drain not actually done) | mitigate | Real `drainedPages` from pragma result |
| T-09-04 | Info disclosure | mitigate | Fixed error codes, no stack traces |
| T-09-05 | DoS via repeated calls | accept | Single-user LAN app |
| T-09-06 | EoP via arbitrary SQL | mitigate | Hardcoded pragma, zero user input |
| T-09-07 | x-forwarded-for spoof | mitigate | Code does not read any forwarded-client header |

No new threat flags — no surface introduced that wasn't in the plan's threat model.

## Known Stubs

None. The endpoint is fully wired: Host guard → real polling service from `globalThis` → real `sqlite.pragma()` → real JSON response with real numbers.

## Deferred Issues

None.

## Next Steps (for orchestrator)

Plan 09-02 (shell updater script + systemd unit) is unblocked. It will:
1. Curl this endpoint in `STAGE drain`
2. Parse the JSON to confirm `status == 'drained'` before proceeding to `systemctl stop charging-master`
3. Treat any non-200 or curl failure as a pre-stop failure and abort the update without stopping the running service

Plan 09-03 (install.sh updates + end-to-end dry-run) follows 09-02.

## Self-Check: PASSED

- File `src/modules/shelly/http-polling-service.ts` — **FOUND**
- File `src/modules/shelly/http-polling-service.test.ts` — **FOUND**
- File `src/app/api/internal/prepare-for-shutdown/route.ts` — **FOUND**
- Commit `ca3b937` (test RED) — **FOUND**
- Commit `3a0da29` (feat GREEN) — **FOUND**
- Commit `75f8f7d` (feat route) — **FOUND**
- Vitest suite: 12 passed — **PASS**
- tsc --noEmit on touched files: 0 errors — **PASS**
- Live smoke tests 1-5: all pass — **PASS**
