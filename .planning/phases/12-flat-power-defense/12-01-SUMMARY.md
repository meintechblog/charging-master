---
phase: 12-flat-power-defense
plan: 01
subsystem: charging
tags: [stale-power, watchdog, pushover, sse, state-machine, drizzle, sqlite]

# Dependency graph
requires:
  - phase: 11-soc-confidence-band-ascii-visualization
    provides: SOC confidence band (socMin/socMax/socBest/bandConfidence), renderSocBandAscii, fireAnomalyNotification template, captureEventContext snapshot-before-await discipline (2640873), aggressive/conservative shouldStop ordering, stop-mode 30s cached reader pattern
provides:
  - "stalePowerCount counter on ChargeStateMachine (public readonly) — single source of truth, mirrors sustainedCount pattern, reading-based so polling gaps pause naturally"
  - "checkStalePower() private helper invoked from handleCharging + handleCountdown before shouldStop"
  - "transition(to, data?) signature extension forwarding data to onTransition (existing call sites unchanged)"
  - "readStalePowerThresholdW() / readStalePowerWindowSec() 30s-cached config readers with __reset*ForTests companions"
  - "ChargeStateEvent watchdog fields: watchdogKind ('none'|'warning'|'fired'), stalePowerSeconds, stalePowerFiresAt — all optional, ephemeral"
  - "ChargeMonitor case 'aborted' branch — type-narrowed data.reason routes only the 'stale_power' path, leaves abortSession's user_abort path untouched"
  - "fireStalePowerNotification — copy of fireAnomalyNotification with new title 'Watchdog: Akku voll?' and stop_reason=stale_power body marker"
  - "lastStopReason map on ChargeMonitor — captures 'fired' kind in captureEventContext post-abort; cleared by cleanupSession"
  - "pendingTransitionData map — carries transition() data parameter across the synchronous feedReading → handleTransition boundary"
affects: [12-02 adaptive matcher refresh, 12-03 band-confidence fallback, 12-04 max-session-duration, 12-05 UI watchdog indicators]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Single source of truth for ephemeral counters — state machine exposes `public readonly` field; ChargeMonitor reads directly instead of mirroring into a parallel Map"
    - "Synchronous data flow across the feedReading → handleTransition boundary via a per-plug pendingTransitionData Map (set by onTransition, read + cleared in handleTransition)"
    - "case 'aborted' type-narrows the data parameter for tampering protection (threat T-12-01) — only accepts hardcoded reason strings, falls through for anything else so abortSession is not double-handled"
    - "Watchdog warning at 20% of configured window (relative, not hardcoded 60s) so custom windowSec values get proportional warnings"

key-files:
  created: []
  modified:
    - src/modules/charging/charge-state-machine.ts
    - src/modules/charging/stop-mode.ts
    - src/modules/charging/types.ts
    - src/modules/charging/charge-monitor.ts
    - src/modules/charging/charge-state-machine.test.ts
    - src/modules/charging/stop-mode.test.ts
    - src/modules/charging/charge-monitor.test.ts
    - src/app/api/sse/power/route.ts

key-decisions:
  - "Reading-based counter (NOT wall-clock) — Shelly polling gaps pause the counter naturally; counter only increments on actual sub-threshold readings"
  - "Transition target is the existing 'aborted' state (NOT a new 'stale_power' ChargeState) — avoids the recycle-gate footgun documented in PATTERNS Anti-pattern B"
  - "stalePowerCount is public readonly on ChargeStateMachine, NOT mirrored into a ChargeMonitor Map — single source of truth eliminates sync-drift risk (resolves PLAN-CHECK H2)"
  - "transition() extended with optional `data` parameter; reason flows state-machine → ChargeMonitor via onTransition callback (resolves OQ-1 from PATTERNS)"
  - "20% warning threshold computed from configured stalePowerWindowSec at captureEventContext time, NOT hardcoded — custom 120s window yields a 24s warning, default 300s yields 60s"
  - "lastStopReason persists from set-in-aborted-case → emit → cleanupSession (3 lines later), giving captureEventContext exactly one snapshot window to see 'fired' before the map clears"
  - "fireStalePowerNotification is a verbatim copy of fireAnomalyNotification body shape — no new switch case in notification-service.buildMessage (per phase_context constraint)"

patterns-established:
  - "FPD watchdog counter — reading-based, mirrors sustainedCount: increment on threshold cross, reset on opposite, fire-and-zero on window cross"
  - "Synchronous data parameter via per-plug pending Map — clean alternative to bolting state onto the state machine or routing through multiple transition variants"
  - "Type-narrowed reason routing in handleTransition — secures the new abort path against future tampering of the onTransition data payload"

requirements-completed: [FPD-01]

# Metrics
duration: 11min
completed: 2026-05-15
---

# Phase 12 Plan 01: Stale-Power Watchdog Summary

**Reading-based stale-power watchdog: 60 consecutive apower < 1W readings during charging/countdown fire `transition('aborted', { reason: 'stale_power' })` → Pushover anomaly with monospace ASCII bar + DB stop_reason='stale_power' + relay-off, with SSE watchdogKind 'warning' (≥20% of window) / 'fired' (post-abort) field flow for FPD-05 to consume.**

## Performance

- **Duration:** ~11 min
- **Started:** 2026-05-15T01:32:42Z
- **Completed:** 2026-05-15T01:43:40Z
- **Tasks:** 3 (5 commits — RED + GREEN per Task 1+2, single docs commit for Task 3)
- **Files modified:** 8

## Accomplishments

- **Watchdog counter (state-machine layer):** `stalePowerCount` exposed as public readonly on ChargeStateMachine; reading-based (increments on apower < 1.0W during charging+countdown, resets on apower >= 1.0W); fires `transition('aborted', { reason: 'stale_power' })` after 60 consecutive sub-threshold readings (= 300s default window / 5s poll interval); reset to 0 inside the fire path.
- **Config helpers (stop-mode layer):** `readStalePowerThresholdW()` / `readStalePowerWindowSec()` mirror the existing `readBandThreshold` 30s-cached pattern; defaults exported as `DEFAULT_STALE_POWER_THRESHOLD_W = 1.0` and `DEFAULT_STALE_POWER_WINDOW_SEC = 300`; both have `__reset*ForTests` companions.
- **Abort path (monitor layer):** `case 'aborted'` in `handleTransition` type-narrows the `data` parameter (threat T-12-01), routes only `reason === 'stale_power'` into the watchdog branch, snapshots `captureEventContext` BEFORE the fire-and-forget relay-off (2640873 discipline), fires Pushover anomaly via `fireStalePowerNotification`, writes the session row (`state='aborted'`, `stoppedAt=now`, `stopReason='stale_power'`), kicks the relay off with `canSwitchRelay` hysteresis, emits the 'aborted' charge event with `watchdogKind='fired'`, then `cleanupSession`.
- **Pushover anomaly:** New private method `fireStalePowerNotification` copies `fireAnomalyNotification`'s body shape verbatim — same Pushover POST, same `monospace='1'` ASCII bar attachment, same priority=1. Title 'Watchdog: Akku voll?' / body mentions the < 1 W stale window in minutes + `stop_reason=stale_power` marker.
- **SSE flow:** Three new optional fields on `ChargeStateEvent` (`watchdogKind`, `stalePowerSeconds`, `stalePowerFiresAt`) populated by `captureEventContext` and forwarded by `emitChargeEvent`. Reads `machine.stalePowerCount` directly — no Map mirroring. The 20% warning threshold is relative to `stalePowerWindowSec` (default 300s → warns at 60s; custom 120s → warns at 24s). `stalePowerFiresAt` populated only for the 'warning' kind. SSE on-connect snapshot intentionally omits the watchdog fields (ephemeral; post-restart 5-min re-arm accepted per RESEARCH Pitfall 7).

## Task Commits

Each task was committed atomically; TDD tasks split into RED (test) + GREEN (feat):

1. **Task 1 RED — state-machine + stop-mode tests** — `329b472` (test)
2. **Task 1 GREEN — state-machine + stop-mode implementation** — `5181bde` (feat)
3. **Task 2 RED — ChargeMonitor abort path + Pushover tests** — `33d24c5` (test)
4. **Task 2 GREEN — ChargeMonitor abort path + Pushover + SSE field flow** — `4594721` (feat)
5. **Task 3 — SSE pass-through docs comment** — `1764004` (docs)

## Files Created/Modified

- `src/modules/charging/charge-state-machine.ts` — public-readonly `stalePowerCount`, private `checkStalePower()`, `setMatch()` caches the watchdog config, `transition(to, data?)` extension, `reset()` zeroes the counter
- `src/modules/charging/stop-mode.ts` — `readStalePowerThresholdW` / `readStalePowerWindowSec` / `DEFAULT_STALE_POWER_THRESHOLD_W` / `DEFAULT_STALE_POWER_WINDOW_SEC` / `__resetStalePowerThresholdCacheForTests` / `__resetStalePowerWindowCacheForTests`
- `src/modules/charging/types.ts` — 3 new optional fields on `ChargeStateEvent`: `watchdogKind`, `stalePowerSeconds`, `stalePowerFiresAt`
- `src/modules/charging/charge-monitor.ts` — `lastStopReason` Map, `pendingTransitionData` Map, `getOrCreateMachine.onTransition` stashes data, `case 'aborted'` in `handleTransition`, new `fireStalePowerNotification` method, `captureEventContext` extended with three watchdog fields (reads `machine.stalePowerCount` directly), `emitChargeEvent` threads them through, `cleanupSession` clears both new Maps
- `src/modules/charging/charge-state-machine.test.ts` — 5 new tests covering 60-zero abort, mid-window reset, countdown-state firing, no-fire in idle/detecting/matched, reset() zeroes counter
- `src/modules/charging/stop-mode.test.ts` — 8 new tests covering both helpers' defaults, parsing, fallback paths, and 30s cache TTL
- `src/modules/charging/charge-monitor.test.ts` — 6 new integration tests covering the 60-zero end-to-end flow (relay off + DB row + Pushover POST with monospace=1 + title 'Watchdog' + body containing stop_reason=stale_power and ASCII glyph), counter-reset robustness, polling-gap robustness (fire across a gap), warning threshold at >=20%, emit propagation, and cleanupSession clearing the Map
- `src/app/api/sse/power/route.ts` — added comment documenting why the on-connect snapshot intentionally omits the watchdog fields (live path JSON-stringifies the full event, so the fields flow through automatically)

## Decisions Made

- **Counter visibility — public readonly, NOT mirrored on monitor (resolves PLAN-CHECK H2).** `ChargeMonitor.captureEventContext` reads `machine.stalePowerCount` directly. Mirroring into a per-plug Map on the monitor would create a sync drift risk: `checkStalePower` resets the counter to 0 inside the fire path, and the mirror would have to be updated atomically — a class of bug eliminated by single-source-of-truth.
- **Reason flows via `onTransition` data parameter (resolves PATTERNS OQ-1).** The state machine fires `transition('aborted', { reason: 'stale_power' })`; `getOrCreateMachine.onTransition` stashes the data in a per-plug `pendingTransitionData` Map; `handleTransition` reads + clears it. This is synchronous — `onTransition` fires inside `feedReading` and `handleTransition` runs in the very next line of `handlePowerReading`.
- **Pushover anomaly subtype — verbatim reuse of `fireAnomalyNotification` body shape.** No new switch case in `notification-service.buildMessage` (per phase_context constraint). The new `fireStalePowerNotification` is a sibling private method on ChargeMonitor, fully owning the title + body template + ASCII bar attachment.
- **20% warning is relative, not hardcoded.** `0.20 * stalePowerWindowSec` so a custom 120s window yields a 24s warning, not the default-hardcoded 60s. Computed at `captureEventContext` time; documented inline.
- **Counter is reading-based, NOT wall-clock.** Shelly polling gaps neither increment nor reset the counter. Test `FPD-01: polling gap pauses the counter` proves: 50 zeros + 25s no-reading gap + 10 zeros → fires on the 60th zero across the gap. Wall-clock would have false-fired during the gap.

## Deviations from Plan

None — plan executed exactly as written.

The plan was already revised post-PLAN-CHECK to address H2 (counter visibility) and the resolutions of PATTERNS OQ-1 (reason via onTransition data). All design choices specified in `<action>` blocks and the `phase_context` were carried out verbatim. The only minor implementation choice not pre-specified was the per-plug `pendingTransitionData` Map (vs. e.g. mutating onTransition state inline) — chosen because it keeps `getOrCreateMachine`'s `onTransition` callback small and gives `handleTransition` a single read+delete idiom that's easy to test (`internals.pendingTransitionData` is observable from the test surface).

## Issues Encountered

- **Initial RED suite asserted `lastStopReason` persisted post-abort.** First version of the integration test expected `lastStopReason.get('plug-1') === 'stale_power'` after the 60-reading loop completed. That was wrong: `cleanupSession` runs at the end of the abort branch (`emit → cleanupSession`) and clears the Map. The correct invariant — `watchdogKind='fired'` is captured on the emitted 'aborted' event because `captureEventContext` runs BEFORE `cleanupSession` — is now pinned by the test. Found mid-Task-2 GREEN; corrected the assertion in the same commit.
- **One tsc error in the test file's mock-call destructure** (`fetchSpy.mock.calls[0] as [string, ...]` — TS narrowed the array element type to a tuple that didn't overlap). Fixed by routing through `as unknown as [string, ...]`. No production code changed.

## Verification Gates (from PLAN `<verification>`)

| Gate | Threshold | Actual | Pass |
|---|---|---|---|
| `pnpm exec tsc --noEmit` | exit 0 | exit 0 | ✓ |
| `pnpm exec vitest run` (all) | all pass | 190/190 | ✓ |
| `pnpm exec vitest run src/modules/charging` | all pass | 126/126 | ✓ |
| `grep "stalePowerCount" src/modules/charging/charge-state-machine.ts \| grep -v '^//'` | >= 3 | 8 | ✓ |
| `grep "stop_reason.*stale_power\|stopReason.*stale_power" src/modules/charging/charge-monitor.ts` | >= 1 | 3 | ✓ |
| `grep "fireStalePowerNotification" src/modules/charging/charge-monitor.ts` | >= 2 | 2 | ✓ |
| `grep "watchdogKind" src/modules/charging/types.ts src/modules/charging/charge-monitor.ts` | both files | both files | ✓ |

## User Setup Required

None — no external service configuration required. The new `charging.stalePowerThresholdW` and `charging.stalePowerWindowSec` config rows are read from the existing `config` table and fall back to defaults (1.0 W / 300 s) when absent. FPD-05 will surface UI controls for these knobs later in Phase 12.

## Next Phase Readiness

- **12-02 (Adaptive matcher refresh):** Foundation in place. The state-machine's `transition(to, data?)` extension is now available to convey other transition reasons; FPD-02's matcher-refresh path can pass `{ reason: 'rematch' }` if needed (though the plan currently keeps `'charging'` as the emit-tag).
- **12-03 (Band-confidence fallback):** Unaffected by 12-01 — operates in the `updateSocTracking` path, doesn't touch the watchdog. The `stop_reason` text column will continue to be free-form when 12-03 adds `'low_confidence_energy_fallback'`.
- **12-04 (Max session duration):** Reuses the same `case 'aborted'` branch idiom; will pass `{ reason: 'timeout' }` through the same `onTransition` data channel. The type-narrowing pattern in `case 'aborted'` already shows how to safely add another reason string.
- **12-05 (UI watchdog indicators):** The three new SSE fields (`watchdogKind`, `stalePowerSeconds`, `stalePowerFiresAt`) are live on the wire. `useChargeStream` will surface them automatically; the FPD-05 React component just needs to render based on `event.watchdogKind`.

## Self-Check: PASSED

- Created files exist:
  - `src/modules/charging/charge-state-machine.ts` — FOUND (modified)
  - `src/modules/charging/stop-mode.ts` — FOUND (modified)
  - `src/modules/charging/types.ts` — FOUND (modified)
  - `src/modules/charging/charge-monitor.ts` — FOUND (modified)
  - `src/modules/charging/charge-state-machine.test.ts` — FOUND (modified)
  - `src/modules/charging/stop-mode.test.ts` — FOUND (modified)
  - `src/modules/charging/charge-monitor.test.ts` — FOUND (modified)
  - `src/app/api/sse/power/route.ts` — FOUND (modified)
- Commits exist (verified via `git log --oneline -10`):
  - `329b472` test(12-01): add failing tests for FPD-01 stale-power watchdog (helpers + counter) — FOUND
  - `5181bde` feat(12-01): implement FPD-01 stale-power watchdog (state machine + config helpers) — FOUND
  - `33d24c5` test(12-01): add failing tests for FPD-01 ChargeMonitor abort path + Pushover — FOUND
  - `4594721` feat(12-01): wire FPD-01 stale-power abort into ChargeMonitor + Pushover + SSE — FOUND
  - `1764004` docs(12-01): document FPD-01 watchdog field flow through the SSE snapshot path — FOUND

---
*Phase: 12-flat-power-defense*
*Completed: 2026-05-15*
