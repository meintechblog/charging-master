---
phase: 12-flat-power-defense
plan: 03
subsystem: charging
tags: [watchdog, max-session-duration, wall-clock, pushover, state-machine, fpd-04]

# Dependency graph
requires:
  - phase: 12-flat-power-defense
    plan: 01
    provides: |
      handleTransition('aborted') case with type-narrowed data.reason routing,
      pendingTransitionData per-plug Map for transition data flow, lastStopReason
      Map, transition(to, data?) signature on ChargeStateMachine, captureEventContext
      snapshot discipline (2640873), fireStalePowerNotification body-shape template,
      readStalePowerWindowSec helper pattern + 30s cache TTL.
provides:
  - "DEFAULT_MAX_SESSION_HOURS = 24 + readMaxSessionHours() 30s-cached config reader with __resetMaxSessionHoursCacheForTests companion"
  - "ChargeStateMachine.forceTimeout() — synchronous transition('aborted', {reason:'timeout'})"
  - "ChargeMonitor.checkSessionTimeout(plugId) — wall-clock based gate that calls machine.forceTimeout() when Date.now() - sessionStartedAt > maxMs AND state ∈ {detecting,matched,charging,countdown}"
  - "ChargeMonitor.fireTimeoutNotification — Pushover anomaly with title 'Watchdog: Session-Timeout', monospace=1 ASCII bar, mirrors fireStalePowerNotification verbatim"
  - "handleTransition('aborted') reason-routing: 'stale_power' → 12-01 path; 'timeout' → 12-03 path; default arm → console.warn + bail (PLAN-CHECK H3 resolution — abortSession bypasses handleTransition entirely so a defensive write would double-write)"
affects: [12-04 settings page max-session-hours input — config row charging.maxSessionHours is now consumed live]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Wall-clock watchdog (FPD-04) coexists with reading-based watchdog (FPD-01) in the same handleTransition('aborted') case — different mechanisms, unified dispatch via data.reason routing"
    - "Type-narrowed reason routing extended to a closed set {'stale_power','timeout'} — default arm is intentionally inert (warn-only, no DB write), preventing future tampering / unknown-reason DB pollution"
    - "ChargeStateMachine exposes two parallel force-* methods: forceStop (energy_fallback path, dest='stopping') vs forceTimeout (max-duration path, dest='aborted') — destinations differ because the semantics differ (graceful stop vs defensive kill)"
    - "Wall-clock derivation in fireTimeoutNotification body: hoursActive computed from abortCtx.startedAt (snapshot preserves startedAt past cleanupSession) — single math, no config re-read in the hot path"

key-files:
  created: []
  modified:
    - src/modules/charging/stop-mode.ts
    - src/modules/charging/stop-mode.test.ts
    - src/modules/charging/charge-state-machine.ts
    - src/modules/charging/charge-state-machine.test.ts
    - src/modules/charging/charge-monitor.ts
    - src/modules/charging/charge-monitor.test.ts

key-decisions:
  - "Wall-clock based, NOT reading-based (RESEARCH Pitfall 10) — FPD-04 is the last-line-of-defense and must fire even when readings have stopped entirely. FPD-01 is reading-based (polling gap pauses counter); FPD-04 is intentionally not."
  - "checkSessionTimeout reads Date.now() internally, NOT reading.timestamp — preserves the wall-clock contract even if the reading's timestamp source drifts (Shelly clock vs server clock)."
  - "forceTimeout destination is 'aborted' (NOT 'stopping') — the session is being defensively killed; we re-use the existing handleTransition('aborted') branch with reason-routing rather than synthesizing a graceful stopping flow."
  - "Defensive default arm in handleTransition('aborted') is INERT — console.warn only, no DB write (PLAN-CHECK H3). abortSession at charge-monitor.ts:327 writes stopReason='user_abort' DIRECTLY and never routes through handleTransition; a fallback write here would double-write the row or overwrite the user_abort marker."
  - "Tests use vi.useFakeTimers({ toFake: ['setTimeout','setInterval','Date'] }) per RESEARCH Pitfall 13 — keeps microtask channel live (setImmediate/process.nextTick stay real) so fire-and-forget Pushover/relay flows resolve via the natural event loop."
  - "Bug fix Rule 1: injectActiveSession test helper now anchors sessionStartedAt to Date.now() instead of the literal 1_000_000 (= 16 min after Unix epoch). Pre-fix, FPD-04's wall-clock check fired on every FPD-01/FPD-03 test because Date.now() - 1_000_000 ≈ 56 years > 24h."

patterns-established:
  - "Wall-clock watchdog — reads Date.now() in the check, NOT the reading's timestamp; gates on activeStates; calls force* on the state machine, caller early-returns + dispatches handleTransition"
  - "handleTransition('aborted') reason-routing as a closed set with an inert default arm — adding a new reason in a future plan requires both a state-machine force* method AND a new arm in the case block, no implicit fallback"

requirements-completed: [FPD-04]

# Metrics
duration: ~10min
completed: 2026-05-15
---

# Phase 12 Plan 03: Session Max-Duration Watchdog Summary

**Wall-clock based session-timeout watchdog: when `Date.now() - session.startedAt > readMaxSessionHours() * 3_600_000` (default 24h) AND state ∈ {detecting,matched,charging,countdown}, the session aborts via `machine.forceTimeout()` → `transition('aborted', {reason:'timeout'})` → Pushover anomaly with 'Watchdog: Session-Timeout' title + ASCII bar + DB `stop_reason='timeout'` + relay-off. Mechanism is intentionally different from FPD-01 (reading-based) per RESEARCH Pitfall 10 — this is the absolute last-line-of-defense and must fire even when readings have stopped entirely.**

## Reading-based (FPD-01) vs Wall-clock (FPD-04) distinction

| Aspect | FPD-01 (stale-power) | FPD-04 (max-duration) |
|---|---|---|
| Mechanism | reading-based counter on apower < 1W | wall-clock delta `Date.now() - sessionStartedAt` |
| Polling gap | counter pauses naturally (no readings → no increment) | gap does NOT pause — wall-clock advances regardless |
| Threshold | 300s window / 5s polling = 60 readings | 24h default |
| Trigger | `apower < threshold` for N consecutive readings | session has existed for > N hours |
| Why | catches "battery full but plug still on" | catches "system stuck on a session indefinitely" |
| Last-line-of-defense | no — relies on readings arriving | YES — fires even if Shelly is dead |

Both watchdogs exit via the same `handleTransition('aborted')` case but route to different notification + body templates via the `data.reason` field.

## Performance

- **Duration:** ~10 min
- **Started:** 2026-05-15T02:08:00Z
- **Completed:** 2026-05-15T02:14:00Z
- **Tasks:** 2 (4 commits — RED + GREEN per task)
- **Files modified:** 6

## Accomplishments

- **Config helper (stop-mode layer):** `readMaxSessionHours()` mirrors the existing `readMatcherRefreshReadings` 30s-cached pattern; default exported as `DEFAULT_MAX_SESSION_HOURS = 24`; companion `__resetMaxSessionHoursCacheForTests`. Strict integer guard (T-12-08 mitigation) rejects floats (`'12.5'` → default), 0, negative values, and non-numeric strings — would otherwise abort every session at startup.
- **State machine layer:** New `forceTimeout()` method — synchronous transition to `'aborted'` with `data={reason:'timeout'}`. Mirrors `forceStop()` shape but destination is `'aborted'` (NOT `'stopping'`) because the session is being defensively killed, not gracefully stopped. Reuses the existing `transition(to, data?)` signature from 12-01.
- **Monitor layer — checkSessionTimeout:** Private helper invoked from `handlePowerReading` after `machine.feedReading` returns. Reads `Date.now()` against `sessionStartedAt`, gates on `activeStates = ['detecting','matched','charging','countdown']`, calls `readMaxSessionHours()` once per check (which is itself 30s-cached). If the cap is breached, fires `machine.forceTimeout()` and returns `true`; caller early-returns + dispatches `handleTransition(plugId, prevState, machine.state, reading)` so the natural prevState-vs-newState dispatch routes the abort transition. Early-return is mandatory — without it, the recycle gate at `charge-state-machine.ts:96-109` would recycle `'aborted'` → `'idle'` before side-effects run.
- **Monitor layer — fireTimeoutNotification:** Copy of `fireStalePowerNotification` with new title `'Watchdog: Session-Timeout'` and body referencing `maxSessionHours`. Same Pushover POST shape, same `monospace='1'` ASCII bar attachment via `renderSocBandAscii({mode:'pushover'})`, same priority=1.
- **Monitor layer — handleTransition reason-routing (PLAN-CHECK H3):** The `'aborted'` case in `handleTransition` now routes by `data.reason` — `'stale_power'` → 12-01 path; `'timeout'` → 12-03 path; default arm → `console.warn('[handleTransition] unexpected aborted reason', {plugId, reason})` and bail. The default arm is intentionally INERT — `abortSession` (`charge-monitor.ts:327-342`) is the ONLY other path that produces an aborted session and it writes `stopReason='user_abort'` DIRECTLY to the DB, bypassing `handleTransition` entirely. A defensive fallback DB write here would either double-write (abortSession already wrote the row) or overwrite the `user_abort` marker.
- **handleTransition refactor:** `lastStopReason.set(plugId, reason)` is now done once at the top of the routing block (before `captureEventContext`) for BOTH reasons. Then a single `if (reason === 'stale_power') fireStalePowerNotification else fireTimeoutNotification` branch handles the Pushover dispatch. DB write uses `stopReason: reason` (single source of truth — no per-reason hardcoded string).

## handleTransition('aborted') reason-routing matrix

| `data.reason` | DB stopReason | Pushover title | Body marker | Producer |
|---|---|---|---|---|
| `'stale_power'` | `'stale_power'` | `'Watchdog: Akku voll?'` | `stop_reason=stale_power` | FPD-01 checkStalePower in ChargeStateMachine |
| `'timeout'` | `'timeout'` | `'Watchdog: Session-Timeout'` | `stop_reason=timeout` | FPD-04 checkSessionTimeout in ChargeMonitor |
| anything else | (no write) | (no fire) | — | (defensive — none currently produced) |

`abortSession` (`user_abort`) does NOT route through this table — it writes the DB directly and never sets `data.reason`.

## Task Commits

Each task was committed atomically; both TDD tasks split into RED (test) + GREEN (feat):

1. **Task 1 RED — stop-mode.test.ts readMaxSessionHours tests** — `bba0439` (test)
2. **Task 1 GREEN — stop-mode.ts readMaxSessionHours + DEFAULT_MAX_SESSION_HOURS** — `b3134b6` (feat)
3. **Task 2 RED — state-machine forceTimeout test + charge-monitor FPD-04 scenarios** — `ef47eda` (test)
4. **Task 2 GREEN — checkSessionTimeout + fireTimeoutNotification + handleTransition reason-routing** — `8e107ca` (feat)

## Files Created/Modified

- `src/modules/charging/stop-mode.ts` — `DEFAULT_MAX_SESSION_HOURS = 24`, `readMaxSessionHours` 30s-cached helper, `__resetMaxSessionHoursCacheForTests` companion
- `src/modules/charging/stop-mode.test.ts` — 4 new tests covering default-24h, valid integer parse, T-12-08 fallback (0/negative/float/non-numeric), 30s TTL cache
- `src/modules/charging/charge-state-machine.ts` — new `forceTimeout()` method (synchronous `transition('aborted', {reason:'timeout'})`)
- `src/modules/charging/charge-state-machine.test.ts` — 1 new test covering forceTimeout's transition + onTransition data parameter
- `src/modules/charging/charge-monitor.ts` — new import `readMaxSessionHours`, new `checkSessionTimeout` private method (wall-clock gate + activeStates filter + machine.forceTimeout + early-return), new `fireTimeoutNotification` private method, `handleTransition('aborted')` extended to route by `data.reason` with inert default arm (H3 resolution), `lastStopReason.set` now done once for both reasons before captureEventContext, DB write uses `stopReason: reason` instead of hardcoded `'stale_power'`
- `src/modules/charging/charge-monitor.test.ts` — Bug fix (Rule 1) in `injectActiveSession`: `sessionStartedAt` anchored to `Date.now()` instead of literal `1_000_000` (pre-fix every FPD-01/FPD-03 test would spuriously fire FPD-04 because the delta `Date.now() - 1_000_000` is ~56 years). 7 new FPD-04 integration tests covering: boundary just-under 24h (no fire); boundary just-over 24h (fire + relay-off + DB stop_reason=timeout + Pushover); custom maxSessionHours=12 (cache invalidation); idle-state inactive (does NOT fire at 25h); reason-routing isolation (stale_power still writes stop_reason=stale_power post-revision); forceTimeout exposed; H3 default-arm warn-only

## Test approach: vi.useFakeTimers per RESEARCH Pitfall 13

FPD-04 tests use `vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'Date'] })` to fake the wall-clock without breaking microtasks. Default `vi.useFakeTimers()` would also mock `setImmediate` / `process.nextTick`, which breaks `flushPromises()` patterns the fire-and-forget Pushover/relay paths rely on.

Pattern:
```ts
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'Date'] });
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  // ...
});

afterEach(() => {
  vi.useRealTimers();
});

it('FPD-04 boundary — just over 24h fires', () => {
  const t0 = Date.now();
  injectActiveSession(monitor, 'plug-1', 1, match, { state: 'charging' });
  setSessionStartedAt('plug-1', t0); // overwrite the injectActiveSession anchor

  vi.setSystemTime(new Date(t0 + (24 * 3600 + 1) * 1000));
  monitor.handlePowerReading(makePowerReading('plug-1', 40, 100, Date.now()));

  expect(switchRelayOffMock).toHaveBeenCalledTimes(1);
  // DB write stop_reason='timeout', Pushover title 'Session-Timeout', etc.
});
```

This is the CORRECT approach because the check is wall-clock based — the existing B2 / FPD-01 / FPD-02 / FPD-03 tests use the manual-timestamp B2 pattern (no fake timers) precisely because their checks are reading-based.

## Decisions Made

- **Wall-clock vs reading-based:** Locked by RESEARCH Pitfall 10 + CONTEXT.md. FPD-04 is the last-line-of-defense and must fire even when readings have stopped entirely (Shelly offline scenario). The alternative — counting readings — would let a 24h+ session survive arbitrary wall-clock time if the device is offline.
- **checkSessionTimeout reads Date.now() internally:** The plan suggested passing `reading.timestamp` as a parameter for symmetry with `checkStalePower`. We chose `Date.now()` internally so the wall-clock contract is preserved even if the Shelly clock drifts vs the server clock. Tests anchor `Date.now()` via `vi.setSystemTime`.
- **forceTimeout destination = 'aborted', NOT 'stopping':** A `'stopping'` destination would imply graceful target-reached cleanup (handleStopping → Pushover complete message). FPD-04 is a defensive kill; the user gets a "Session-Timeout" anomaly, not a "Akku voll!" confirmation. Reusing the existing `'aborted'` branch + reason-routing is cleaner than synthesizing a parallel graceful path.
- **Default arm inert (H3 resolution):** The only OTHER code path that produces an aborted session is `abortSession`, which writes `user_abort` DIRECTLY and bypasses handleTransition. A defensive DB write in the default arm would either double-write (abortSession's row already exists) or overwrite the `user_abort` stopReason. Inert is correct.
- **injectActiveSession sessionStartedAt anchor:** Pre-fix, the helper hardcoded `1_000_000` (≈ Unix epoch + 16 min). Post-12-03 every existing test broke because `Date.now() - 1_000_000 ≈ 56 years >> 24h` — FPD-04 spuriously fired on every reading. Rule 1 bug fix: anchor to `Date.now()`. Tests that DO care about session age (FPD-04 boundary tests) overwrite this immediately via `setSessionStartedAt(plugId, t0)`.
- **handleTransition refactor (DRY):** Pre-12-03 the `'stale_power'` arm hardcoded `stopReason: 'stale_power'` and `lastStopReason.set(plugId, 'stale_power')` inline. Post-12-03 both are derived from the type-narrowed `reason` variable (`stopReason: reason`, `lastStopReason.set(plugId, reason)`) — single source of truth, no per-reason string duplication, easier to extend with future reasons.

## Deviations from Plan

**Rule 1 - Bug fix:** `injectActiveSession` test helper hardcoded `sessionStartedAt` to `1_000_000`, which made the new FPD-04 wall-clock check (`Date.now() - sessionStartedAt > 24h`) spuriously fire on every FPD-01 / FPD-02 / FPD-03 test using the helper. Fix: anchor to `Date.now()` instead.
- **Found during:** Task 2 GREEN
- **Issue:** 7 existing tests regressed (FPD-01 INTEGRATION, counter resets, polling gap, captureEventContext warning, emitChargeEvent propagation, FPD-03 below-target, B2 integration)
- **Fix:** Updated `injectActiveSession` to call `internals.sessionStartedAt.set(plugId, Date.now())`. Added comment documenting that FPD-04 boundary tests overwrite this immediately.
- **Files modified:** `src/modules/charging/charge-monitor.test.ts` (injectActiveSession helper)
- **Commit:** `8e107ca` (merged into the GREEN commit)

No deviations from the plan's specified behavior or interfaces. The plan's task-2 action block explicitly anticipated this test-helper pattern question; the fix matches the plan's intent (tests should pass without requiring `sessionStartedAt` to be artificially old).

## Issues Encountered

- **7 existing tests regressed on first GREEN run** — see Rule 1 bug fix above. Root cause: existing test fixture used a hardcoded `1_000_000` timestamp (≈ 16 min after Unix epoch) that worked fine for reading-timestamp-based logic but breaks any wall-clock check because `Date.now() ≫ 1_000_000` in real wall-clock time.
- **No other issues.** The plan's reason-routing design (closed set + inert default) carried through cleanly. forceTimeout slotted into the existing transition + onTransition + pendingTransitionData plumbing without any state-machine refactor.

## Verification Gates (from PLAN `<verification>`)

| Gate | Threshold | Actual | Pass |
|---|---|---|---|
| `pnpm exec tsc --noEmit` (excluding pre-existing version.ts) | exit 0 | exit 0 | ✓ |
| `pnpm exec vitest run` (all) | all pass | 230/230 | ✓ |
| `pnpm exec vitest run src/modules/charging` | all pass | 166/166 | ✓ |
| `grep -n "checkSessionTimeout" src/modules/charging/charge-monitor.ts \| wc -l` | >= 2 | 2 | ✓ |
| `grep -n "maxSessionHours" src/modules/charging/stop-mode.ts src/modules/charging/charge-monitor.ts \| wc -l` | >= 3 | 3 | ✓ |
| `grep -n "forceTimeout" src/modules/charging/charge-state-machine.ts \| wc -l` | >= 1 | 2 | ✓ |
| `grep -n "'timeout'" src/modules/charging/charge-monitor.ts \| wc -l` | >= 2 | 4 | ✓ |
| `grep -nE "stop_reason='timeout'\|stopReason: 'timeout'\|stopReason: reason"` | >= 1 | 2 | ✓ |

## User Setup Required

None — no external service configuration required. The new `charging.maxSessionHours` config row is read from the existing `config` table and falls back to the 24h default when absent. FPD-05 (12-04) will surface a Settings page input for this knob.

## Next Phase Readiness

- **12-04 (Settings page surface for FPD-* knobs):** `charging.maxSessionHours` is now consumed live by `readMaxSessionHours()`. The Settings page adds a `useAutoSave('charging.maxSessionHours', value, 24)` input alongside the existing `stalePowerThresholdW` / `stalePowerWindowSec` / `lowConfidenceThreshold` / `matcherRefreshReadings` inputs from 12-01+12-02. Strict integer guard already enforced in `readMaxSessionHours` (T-12-08 mitigation), so the Settings input only needs an `<input type="number" step="1" min="1">` shape.
- **12-05 (UI watchdog indicators):** Unaffected — FPD-04 doesn't add new SSE fields. The `'aborted'` event already carries `state='aborted'` (the dashboard would render it as "session ended" via the existing terminal-state handling). If a UI surface for "timeout" specifically is needed, the `stopMode` SSE field already carries it via the watchdog Pushover; alternatively, a future plan could add a `stopReason?: string` field to ChargeStateEvent.

## Threat Flags

None. The threat model from the PLAN frontmatter (T-12-08 maxSessionHours=0/negative; T-12-09 clock skew) is mitigated as specified — readMaxSessionHours's strict integer guard rejects 0/negative/float, and clock-skew is accepted per RESEARCH §FPD-04.

## Self-Check: PASSED

- Modified files exist:
  - `src/modules/charging/stop-mode.ts` — FOUND
  - `src/modules/charging/stop-mode.test.ts` — FOUND
  - `src/modules/charging/charge-state-machine.ts` — FOUND
  - `src/modules/charging/charge-state-machine.test.ts` — FOUND
  - `src/modules/charging/charge-monitor.ts` — FOUND
  - `src/modules/charging/charge-monitor.test.ts` — FOUND
- Commits exist (verified via `git log --oneline -6`):
  - `bba0439` test(12-03): add failing tests for FPD-04 maxSessionHours config helper — FOUND
  - `b3134b6` feat(12-03): implement FPD-04 readMaxSessionHours (default 24h, T-12-08) — FOUND
  - `ef47eda` test(12-03): add failing tests for FPD-04 session-timeout watchdog — FOUND
  - `8e107ca` feat(12-03): wire FPD-04 session-timeout watchdog into ChargeMonitor — FOUND

---
*Phase: 12-flat-power-defense*
*Completed: 2026-05-15*
