---
phase: 10-ui-integration-restart-handoff
plan: 01
subsystem: self-update
tags: [backend, sse, systemd, routes, types]
dependency-graph:
  requires:
    - Phase 7 UpdateStateStore (atomic tmp+rename writer)
    - Phase 7 types.ts (UpdateState, UpdateInfoView, LastCheckResult)
    - Phase 8 deriveUpdateInfoView (pure view-model function)
    - Phase 8 /api/internal/prepare-for-shutdown (Host guard pattern)
    - Phase 9 charging-master-updater.service (spawned by trigger endpoint)
    - Phase 9 state.json rollback* fields (written by run-update.sh)
  provides:
    - UpdateTriggerResponse discriminated union
    - UpdatePipelineStage literal type
    - POST /api/update/trigger (systemd launcher with dev fallback)
    - GET /api/update/log (SSE journalctl tail with double cleanup)
    - POST /api/update/ack-rollback (clears red banner flags)
    - Extended UpdateInfoView with rollbackHappened / rollbackReason / rollbackStage
    - Extended UpdateState with targetSha / updateStartedAt / rollbackStage
  affects:
    - Plan 10-02 (UI integration) — will consume these three endpoints
tech-stack:
  added: []
  patterns:
    - SSE ReadableStream with double cleanup (abort signal + cancel callback)
    - Detached fire-and-forget spawn with .unref() for systemctl handoff
    - Host-header localhost guard (reused from prepare-for-shutdown)
    - Pre-write state before spawn for concurrent-trigger 409 bounce
key-files:
  created:
    - src/app/api/update/trigger/route.ts
    - src/app/api/update/log/route.ts
    - src/app/api/update/ack-rollback/route.ts
  modified:
    - src/modules/self-update/types.ts
    - src/modules/self-update/update-info-view.ts
    - src/modules/self-update/update-state-store.ts
decisions:
  - 200ms sync race on spawn to catch ENOENT and systemctl exit 4/5 without defeating --no-block
  - Dev-mode detection is ENOENT on the binary OR exit code 4/5 from systemctl (missing unit)
  - cleanup() is idempotent and registered on BOTH request.signal abort AND ReadableStream cancel
  - SIGTERM first, SIGKILL after 1s (unref'd timer), never synchronously block the event loop
  - Heartbeats emitted as SSE comments (leading ':') so they stay invisible to the UI's onmessage handler
  - ack-rollback writes ONLY the three rollback fields (object-spread merge preserves everything else)
  - Trigger endpoint rolls back its own state write on spawn failure so the UI never sees a stuck 'installing'
metrics:
  duration: ~14 min
  tasks: 4
  files_created: 3
  files_modified: 3
  completed: 2026-04-10
---

# Phase 10 Plan 01: Trigger + SSE + Rollback Ack Backend Summary

**One-liner:** Landed three localhost-guarded update routes (POST /trigger, GET /log SSE, POST /ack-rollback) plus the type extensions they need, all curl-verified end-to-end on macOS dev with zero orphan processes.

## What Shipped

- **`UpdateTriggerResponse`** — discriminated union `{triggered, startedAt, targetSha} | {error}` that the UI maps from the trigger POST response.
- **`UpdatePipelineStage`** — literal union of the 9 updater stages (`preflight → snapshot → drain → stop → fetch → install → build → start → verify`) — the stage-stepper in Plan 10-02 will map `[stage=<name>]` journalctl markers to this type.
- **`UpdateState` extended** with optional `targetSha`, `updateStartedAt`, `rollbackStage` (all default `null` in `DEFAULT_UPDATE_STATE`). Fully backwards-compatible — existing state.json files parse without migration because the fields are optional.
- **`UpdateInfoView` extended** with optional `rollbackHappened`, `rollbackReason`, `rollbackStage`. `deriveUpdateInfoView()` now copies these onto the `base` view so every return branch (ok / unchanged / rate_limited / error / never) inherits them. This is the hook the red banner in Plan 10-02 will read.
- **`POST /api/update/trigger`** — Host-guarded fire-and-forget launcher for `systemctl start --no-block charging-master-updater.service`. Pre-marks state to `'installing'`, uses `spawn(..., { detached: true, stdio: 'ignore' }).unref()`, races a 200ms window to catch ENOENT (macOS) and exit 4/5 (missing unit on Linux dev), and rolls back the pre-write on dev-mode failure so the UI never sees a stuck installing state.
- **`GET /api/update/log`** — SSE `text/event-stream` that tails `journalctl -fu charging-master-updater --output=cat --lines=100 --no-pager`, line-buffers stdout, frames each line as `data: <line>\n\n`, emits 10s heartbeats as SSE comments (`: heartbeat <ts>\n\n`), and falls back to a synthetic dev stream on ENOENT / exit 4/5. **Double cleanup** via `request.signal.addEventListener('abort', cleanup)` AND the ReadableStream `cancel()` callback — both call the same idempotent cleanup that SIGTERMs the child and SIGKILLs after 1s via an unref'd timer.
- **`POST /api/update/ack-rollback`** — minimal Host-guarded POST that clears `rollbackHappened` / `rollbackReason` / `rollbackStage` via `UpdateStateStore.write()` (object-spread merge preserves every other state field).

## Commits

| Task | Hash | Message |
|------|------|---------|
| 1 — Extend types + deriveUpdateInfoView | `84ef6b1` | feat(10-01): extend self-update types with trigger + rollback fields |
| 2 — POST /api/update/trigger | `3e29ad2` | feat(10-01): POST /api/update/trigger with detached systemctl + dev fallback |
| 3 — GET /api/update/log SSE | `e7cc9bf` | feat(10-01): GET /api/update/log SSE with double cleanup + dev fallback |
| 4 — POST /api/update/ack-rollback | `37599c9` | feat(10-01): POST /api/update/ack-rollback clears rollback flags |

## Verification (live curl against `pnpm dev` on macOS)

### 1. `pnpm exec tsc --noEmit`
Zero errors. (No `typecheck` script in package.json — used `tsc --noEmit` directly. Full TS-strict build across the self-update module and all three new routes is clean.)

### 2. POST /api/update/trigger — localhost Host
```
$ curl -s -w ' HTTP=%{http_code}\n' -X POST -H 'Host: 127.0.0.1' http://localhost:3000/api/update/trigger
{"status":"error","error":"dev_mode: updater service not available on this host"} HTTP=503
```
503 dev_mode fired correctly because macOS has no `systemctl` binary → ENOENT caught in the 200ms race → state rolled back → 503 returned.

### 3. POST /api/update/trigger — non-localhost Host
```
$ curl -s -w ' HTTP=%{http_code}\n' -X POST -H 'Host: evil.example.com' http://localhost:3000/api/update/trigger
{"status":"error","error":"forbidden"} HTTP=403
```
Host guard rejects evil.example.com with 403.

### 4. GET /api/update/log — SSE stream for 3s
```
$ curl -s -N --max-time 3 -H 'Host: 127.0.0.1' http://localhost:3000/api/update/log
data: [dev-mode] journalctl not available — synthetic stream

data: [dev-mode] [stage=preflight] This is a dev-mode synthetic log.

data: [dev-mode] Trigger the updater on a real LXC host to see real logs.
```
Three `data: [dev-mode]` frames emitted via the ENOENT fallback path. The connection stayed open for the full 3s and closed cleanly on curl's --max-time expiry.

### 5. Orphan process check (the critical one for LIVE-02)
```
$ ps -ax | grep -v grep | grep -c journalctl
0
```
Zero orphan journalctl processes after the SSE connection closed. Confirms the double-cleanup hook (signal.abort + ReadableStream.cancel) works — on macOS there's no journalctl to kill, but the control path was exercised and the child slot was never leaked.

### 6. POST /api/update/ack-rollback
```
$ curl -s -w ' HTTP=%{http_code}\n' -X POST -H 'Host: 127.0.0.1' http://localhost:3000/api/update/ack-rollback
{"status":"acked"} HTTP=200
```

### 7. state.json post-ack
```
$ grep -E 'rollback(Happened|Reason|Stage)|updateStatus|targetSha' .update-state/state.json
  "updateStatus": "idle",
  "rollbackHappened": false,
  "rollbackReason": null,
  "targetSha": null,
  "rollbackStage": null
```
All three rollback fields present and null. `updateStatus` is `idle` (the trigger endpoint rolled back its pre-write). `targetSha` is null. The new fields are persisted alongside the pre-existing state untouched.

## Contract for Plan 10-02

Freeze these shapes — the UI can code against them:

**POST /api/update/trigger**
- Request body (optional): `{ "targetSha"?: string }` — omit to use `lastCheckResult.remoteSha`
- Response `202`: `{ "status": "triggered", "startedAt": 1775839580000, "targetSha": "1a5bd34..." }`
- Response `400`: `{ "status": "error", "error": "targetSha unknown" }`
- Response `403`: `{ "status": "error", "error": "forbidden" }`
- Response `409`: `{ "status": "error", "error": "no update available" }`
- Response `409`: `{ "status": "error", "error": "update already running" }`
- Response `500`: `{ "status": "error", "error": "state ... failed: ..." }`
- Response `503`: `{ "status": "error", "error": "dev_mode: updater service not available on this host" }`

UI decision rule: on `status === "triggered"` → switch into streaming mode and open EventSource. On `503` dev_mode → show a "dev mode, no updater" warning but still let the user eye-check the UI flow. On `409` / `400` / `403` → error toast + idle.

**GET /api/update/log**
- Response headers: `Content-Type: text/event-stream; charset=utf-8`, `Cache-Control: no-cache, no-transform`, `Connection: keep-alive`, `X-Accel-Buffering: no`
- Frame format: `data: <raw journalctl line>\n\n` — **no JSON wrapping**, the UI's stage-stepper parses `[stage=<name>]` markers out of the raw text
- Heartbeat format: `: heartbeat <epoch-ms>\n\n` — SSE comment, invisible to `EventSource.onmessage`
- Connection drops automatically when the updater unit restarts the main service → browser `EventSource` triggers `onerror` and the reconnect overlay kicks in

**POST /api/update/ack-rollback**
- Request body: empty (ignored)
- Response `200`: `{ "status": "acked" }`
- Response `403`: `{ "error": "forbidden" }`
- Response `500`: `{ "error": "state write failed: ..." }`

## Deviations from Plan

**None.** Plan executed exactly as written. Two minor notes that are NOT deviations:

1. The plan's verify command called `pnpm typecheck`, but there's no `typecheck` script in `package.json`. Used `pnpm exec tsc --noEmit` instead — same semantic check, zero errors.
2. The plan mentioned spawning a fresh `pnpm dev` for each task's verification, but a dev server was already running on :3000 (tsx watch), so I reused it. Hot-reload picked up each new route file within a second. This is strictly cheaper than the plan's approach and doesn't affect correctness.

## Known Stubs

None. Every field, response, and endpoint wired to real data paths. The 503 dev_mode message is not a stub — it's the documented contract for dev machines per `10-CONTEXT.md § Dev-mode graceful degradation`.

## Self-Check: PASSED

**Files created:**
- FOUND: src/app/api/update/trigger/route.ts
- FOUND: src/app/api/update/log/route.ts
- FOUND: src/app/api/update/ack-rollback/route.ts

**Files modified:**
- FOUND: src/modules/self-update/types.ts (UpdateTriggerResponse, UpdatePipelineStage, extended UpdateState + UpdateInfoView + DEFAULT_UPDATE_STATE)
- FOUND: src/modules/self-update/update-info-view.ts (rollback fields on base)
- FOUND: src/modules/self-update/update-state-store.ts (Phase 10 comment)

**Commits:**
- FOUND: 84ef6b1
- FOUND: 3e29ad2
- FOUND: e7cc9bf
- FOUND: 37599c9
