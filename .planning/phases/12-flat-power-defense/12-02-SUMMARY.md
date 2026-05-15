---
phase: 12-flat-power-defense
plan: 02
subsystem: charging
tags: [adaptive-matcher, dtw, energy-fallback, band-confidence, stop-mode, sse, state-machine, drizzle, sqlite]

# Dependency graph
requires:
  - phase: 12-flat-power-defense
    plan: 01
    provides: ChargeStateMachine transition(to, data?) signature, captureEventContext snapshot-before-await discipline, lastStopReason / pendingTransitionData per-plug stash pattern, 30s-cached config-reader pattern (readStalePower*), public readonly counter pattern (stalePowerCount)
  - phase: 11-soc-confidence-band-ascii-visualization
    plan: 02
    provides: socMin/socMax/socBest/bandConfidence band field set, monotonic-narrowing clamp at tryMatch (Math.max / Math.min inline at the matched-commit site), sessionSocMin / sessionSocMax / sessionBandConfidence Maps, B2 integration test pattern (manual-timestamp loop driving handlePowerReading)
provides:
  - "DEFAULT_MATCHER_REFRESH_READINGS = 60; readMatcherRefreshReadings() — positive-integer-only, T-12-07 mitigation rejects 0/negative/float (prevents tight-loop matcher invocation)"
  - "DEFAULT_LOW_CONFIDENCE_THRESHOLD = 0.5; readLowConfidenceThreshold() — clamped to (0, 1], T-12-05 mitigation"
  - "shouldStopEnergyFallback({estimatedSoc, targetSoc}): boolean — pure predicate, algebraic inverse of v1.2 formula per RESEARCH §FPD-03 Q1 derivation"
  - "ChargeStateEvent.stopMode?: 'aggressive' | 'conservative' | 'energy_fallback' — terminal-event surface for UI / Pushover differentiation"
  - "ChargeStateMachine.forceStop(reason: string) — synchronous wrapper around transition('stopping', {reason}); enables the energy-fallback dispatch path WITHOUT touching the recycle gate"
  - "ChargeMonitor.chargingBuffers Map<plugId, {apower:number[], profile:ProfileWithCurve}> — per-plug in-memory ring of apower readings PLUS the cached ProfileWithCurve so refreshMatch does NOT re-query loadProfilesWithCurves() every 60 readings"
  - "ChargeMonitor.readingsSinceLastMatch counter Map — gates refreshMatch firing every matcherRefreshReadings (default 60 ≈ 5 min at 5s polling)"
  - "ChargeMonitor.lastStopMode Map<plugId, ...> — written synchronously BEFORE handleStopping invocation; cleared in cleanupSession"
  - "refreshMatch(plugId, timestamp) — re-runs findBestCandidate with TWO args only, applies INLINE Math.max / Math.min clamp (no helper extraction), persists narrowed band to DB, re-emits 'charging' charge event with the refreshed band"
  - "Energy-fallback dispatch in handlePowerReading BEFORE machine.feedReading — early-returns after forceStop to prevent recycle-gate undo (PLAN-CHECK H1)"
  - "Synchronous 'stopping' charge-event emission inside handleTransition('stopping') case — SSE clients see stopMode tag immediately, not behind the relay-off await"
affects: [12-04 max-session-duration, 12-05 UI watchdog indicators (stopMode badge surface for FPD-03 differentiation)]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "INLINE monotonic-narrowing clamp (Math.max / Math.min) in refreshMatch — NO helper extraction; mirrors tryMatch clamp at the matched-commit site (resolves PLAN-CHECK H4 drift risk). The clamp IS the rejection: a widening edge in the candidate is silently held at the prior cached value."
    - "ProfileWithCurve cached on the chargingBuffer value type (NOT re-queried per refresh) — handleTransition('charging') runs loadProfilesWithCurves() ONCE and stashes the matched profile; refreshMatch reads cached entry."
    - "Energy-fallback dispatch ORDER: lastStopMode.set BEFORE forceStop BEFORE handleTransition('stopping') (which calls handleStopping → captureEventContext snapshot reads lastStopMode synchronously). Early-return from handlePowerReading AFTER the synchronous dispatch chain so machine.feedReading never runs on the dispatch reading (PLAN-CHECK H1)."
    - "High-confidence stopMode surface via handleTransition('stopping') case writing lastStopMode = machine.stopMode BEFORE invoking handleStopping (PLAN-CHECK H6). Idempotent for energy_fallback: the case checks the Map first and does NOT overwrite a pre-set 'energy_fallback' with machine.stopMode."
    - "findBestCandidate two-argument call site discipline — re-bound via `import * as curveMatcher` namespace so vi.spyOn(curveMatcher, 'findBestCandidate') intercepts production calls in tests (signature at curve-matcher.ts:141-144 has no opts arg, B1 resolved)."
    - "Synchronous 'stopping' charge-event emit in handleTransition('stopping') BEFORE the fire-and-forget handleStopping promise — SSE consumers see stopMode immediately; the post-await 'complete' event also carries it via the captureEventContext snapshot."

key-files:
  created: []
  modified:
    - src/modules/charging/stop-mode.ts
    - src/modules/charging/stop-mode.test.ts
    - src/modules/charging/types.ts
    - src/modules/charging/charge-monitor.ts
    - src/modules/charging/charge-monitor.test.ts
    - src/modules/charging/charge-state-machine.ts

key-decisions:
  - "PLAN-CHECK B1 resolved: findBestCandidate is called with exactly two args; threshold is the compile-time DEFAULT_BAND_THRESHOLD_PCT = 0.20 baked into deriveBand (curve-matcher.ts:172). Adaptive refresh respects the v1.3.1-tuned threshold by design — readBandThreshold is NOT imported in refreshMatch."
  - "PLAN-CHECK H1 resolved: handlePowerReading early-returns after machine.forceStop('energy_fallback') + manual handleTransition('stopping') dispatch. Without the early-return, the next machine.feedReading would hit the recycle gate (charge-state-machine.ts:76-85) and reset 'stopping' to 'idle' before handleStopping's relay-off + DB write fired."
  - "PLAN-CHECK H4 resolved: monotonic clamp stays INLINE in refreshMatch (Math.max / Math.min — 2 LOC). NO helper extraction. The existing tryMatch clamp at the matched-commit site is untouched. Two-site duplication of 2 LOC is acceptable; helper extraction risks drift between the two sites because tryMatch handles the prior-undefined fallback branch while refreshMatch only runs when prior is defined."
  - "PLAN-CHECK H6 resolved: handleTransition('stopping') case writes lastStopMode = machine.stopMode BEFORE invoking handleStopping. The captureEventContext snapshot inside handleStopping reads lastStopMode synchronously; without the pre-write, complete events emit stopMode=undefined."
  - "shouldStopEnergyFallback is a pure 3-line function — algebraically identical to estimatedSoc >= targetSoc per RESEARCH §FPD-03 Q1 derivation (the CONTEXT.md v1.2 formula `cumulativeEnergyWh >= (targetSoc - startSoc)/100 * totalEnergyWh` is the inverse of estimateSoc's partial-charge formula). Caller gates on bandConfidence — predicate stays decoupled from the matcher."
  - "ProfileWithCurve cached on chargingBuffer value type (NOT re-queried) — addresses the performance dimension of OQ-2: in-memory ring beats DB query (~138 KB / 24h for the apower array; the cached profile is a few KB shared across the session)."
  - "Energy-fallback emits BOTH a synchronous 'stopping' charge event (in handleTransition('stopping')) AND the post-await 'complete' event from handleStopping. Both carry stopMode='energy_fallback' so SSE consumers see the tag immediately; the DB stop_reason stays 'target_soc_reached' (OQ-3) — the stopMode field is the dedicated mode-surface."
  - "B2 integration test estimatedSoc lowered from 80 to 50 in the wide-band phase (Rule 1 fix). Pre-FPD-03 the test setup was exactly the scenario FPD-03 short-circuits via energy-fallback; promoting estimatedSoc to 80 only at band-collapse time preserves the test's semantic intent (proves narrow-band aggressive stop fires <30s) while keeping the band-confidence and SOC dimensions decoupled."

metrics:
  duration: ~1h
  completed: 2026-05-15
---

# Phase 12 Plan 02: FPD-02 Adaptive Matcher Refresh + FPD-03 Band-Confidence-Aware Energy Fallback Summary

Adaptive in-charge matcher refresh + energy-fallback dispatch — refreshMatch re-runs findBestCandidate every 60 readings during state==='charging' with INLINE monotonic narrowing and a cached ProfileWithCurve; energy-fallback dispatch in handlePowerReading short-circuits the band-mode shouldStop when bandConfidence < 0.5 AND estimatedSoc >= targetSoc, with stopMode surfaced on the 'stopping' and 'complete' SSE events.

## chargingBuffers vs detectionBuffers

| Aspect | detectionBuffers (Phase 1, pre-existing) | chargingBuffers (this plan) |
| ----- | ----- | ----- |
| Lifecycle | Set in handleTransition('detecting'); cleared by cleanupSession AND by tryMatch's match-commit path (via setMatch / state transition) | Set in handleTransition('charging'); cleared by cleanupSession |
| Value type | `number[]` (apower readings only) | `{apower: number[]; profile: ProfileWithCurve}` — profile cached ONCE on first init so refreshMatch never re-queries loadProfilesWithCurves() |
| Purpose | Initial detection (probe matcher every 12 readings until confidence threshold met) | Adaptive in-charge refresh (re-probe matcher every 60 readings to narrow the band as more samples accumulate) |
| Match-result effect | tryMatch commits via setMatch() → state advances to 'matched' | refreshMatch updates band Maps + machine fields + DB row IN PLACE (no state transition) |

Both live on ChargeMonitor as `private Map<plugId, …>`; both are bounded by `cleanupSession`. Memory ceiling: ~138 KB / 24h per active plug for the apower array + a few KB for the cached profile (RESEARCH §FPD-02 Q3 + Pitfall 14).

## refreshMatch flow + monotonic-narrowing clamp (inline, no helper)

```text
updateSocTracking (every reading during charging/countdown)
  └─ buffer = chargingBuffers.get(plugId)
  └─ buffer.apower.push(reading.apower)
  └─ counter++ in readingsSinceLastMatch
  └─ when counter >= readMatcherRefreshReadings() (default 60):
       counter = 0
       void refreshMatch(plugId, timestamp)  // fire-and-forget

refreshMatch(plugId, timestamp):
  entry = chargingBuffers.get(plugId)
  if !entry || entry.apower.length === 0: return
  candidate = curveMatcher.findBestCandidate(entry.apower, [entry.profile])  // TWO ARGS ONLY
  if !candidate: return
  priorSocMin = sessionSocMin.get(plugId); priorSocMax = sessionSocMax.get(plugId)
  if priorSocMin === undefined || priorSocMax === undefined: return  // not yet seeded
  // INLINE MATH — no helper extraction (PLAN-CHECK H4):
  newSocMin = Math.max(priorSocMin, candidate.socMin)
  newSocMax = Math.min(priorSocMax, candidate.socMax)
  // The clamp IS the rejection: widening edge → held at prior value. Log if either edge widens.
  if candidate.socMin < priorSocMin || candidate.socMax > priorSocMax:
    console.debug('[refreshMatch] widening candidate clamped to prior band', ...)
  sessionSocMin / sessionSocMax / sessionBandConfidence.set(...)
  machine.{socMin,socMax,socBest,socBandConfidence} = ...
  cachedMatch.{socMin,socMax,socBest,bandConfidence} = ...  // so updateSocTracking propagates from narrowed values next tick
  db.update(chargeSessions).set({ socMin, socMax, bandConfidence })
  emitChargeEvent(plugId, 'charging')  // OQ-5 — same tag, CSS transitions animate
```

The iPad Session 14 fixture replay (n=60 → 120 → 240 → 480 → 720) proves the SAFETY property: band width is strictly non-increasing across batches. socBest does NOT converge on real flat-region data (RESEARCH §FPD-02 Q4 — fundamental DTW-flat-power ambiguity); the test correctly asserts narrowing, NOT correctness.

## findBestCandidate signature respected (PLAN-CHECK B1)

```ts
// curve-matcher.ts:141-144 (verified)
export function findBestCandidate(
  queryReadings: number[],
  profiles: ProfileWithCurve[]
): MatchResult | null;
```

No third opts argument exists. The band threshold `DEFAULT_BAND_THRESHOLD_PCT = 0.20` is baked into deriveBand at curve-matcher.ts:172 — the v1.3.1-tuned value. Adaptive refresh respects the same threshold as initial-match by design. `grep -nE 'findBestCandidate\(' src/modules/charging/charge-monitor.ts` confirms both call sites (tryMatch line 889, refreshMatch line 1195) are 2-arg.

## Energy-fallback dispatch ordering (PLAN-CHECK H1 + H6)

```text
handlePowerReading(reading):
  machine = getOrCreateMachine(plugId); prevState = machine.state
  // FPD-03 LOW-CONFIDENCE GATE — runs BEFORE machine.feedReading
  if (prevState ∈ {charging,countdown}
      AND machine.socBandConfidence < readLowConfidenceThreshold()  // default 0.5
      AND machine.targetSoc > 0
      AND shouldStopEnergyFallback({estimatedSoc: machine.estimatedSoc, targetSoc: machine.targetSoc})):
    lastStopMode.set(plugId, 'energy_fallback')    // ← H6: BEFORE forceStop
    machine.forceStop('energy_fallback')           // ← synchronous transition('stopping', {reason})
    handleTransition(plugId, prevState, 'stopping', reading)  // ← runs handleStopping synchronously
    return                                          // ← H1: EARLY RETURN, feedReading is NEVER called

  machine.feedReading(apower, timestamp)
  newState = machine.state
  ... (regular flow, including handleTransition for state changes)
```

**Why the early-return matters**: charge-state-machine.ts:76-85 has a recycle gate — entering `feedReading` with `state==='stopping'` resets it to `'idle'` and clears machine fields. Without the early-return, calling `feedReading` on the dispatch reading would undo the forceStop BEFORE handleStopping's relay-off + DB write fire. The early-return is the dispatch boundary.

**Why lastStopMode is written BEFORE forceStop**: handleStopping → captureEventContext reads `lastStopMode.get(plugId)` synchronously (Phase 11 2640873 snapshot-before-await discipline). The Map write must precede the synchronous transition chain.

## handleTransition('stopping') write-before-handleStopping (PLAN-CHECK H6)

```ts
case 'stopping': {
  if (this.lastStopMode.get(plugId) !== 'energy_fallback') {
    this.lastStopMode.set(plugId, machine.stopMode);  // 'aggressive' | 'conservative'
  }
  this.emitChargeEvent(plugId, 'stopping');  // synchronous — SSE clients see stopMode immediately
  this.handleStopping(plugId);               // async — emits 'complete' post-await with same stopMode via snapshot
  break;
}
```

The idempotency check (`!== 'energy_fallback'`) ensures the dispatch path's pre-write isn't clobbered when handleTransition('stopping') is invoked manually from handlePowerReading after forceStop. For band-mode stops (aggressive / conservative), the case writes from `machine.stopMode` because machine.stopMode is the user's policy choice and forceStop wasn't called.

## shouldStopEnergyFallback algebraic equivalence

RESEARCH §FPD-03 Q1 proves:

```
soc = startSoc + (currentWh / (totalWh * (1 - startSoc/100))) * (100 - startSoc)
soc >= targetSoc  ⇔  currentWh >= (targetSoc - startSoc) / 100 * totalWh   ← v1.2 formula
                  ⇔  estimatedSoc >= targetSoc                              ← our predicate
```

So `shouldStopEnergyFallback` is a pure 3-line function with no DB lookup, no bandConfidence dependency (the caller gates on bandConfidence before invoking). The CONTEXT.md "energy formula" and the v1.2 "soc >= target" predicate are mathematically the same statement — we picked the cheaper one.

## New config keys + defaults

| Key | Default | Range | Cache TTL |
| --- | --- | --- | --- |
| `charging.matcherRefreshReadings` | 60 | positive integer (Number.isInteger gate rejects floats; T-12-07 mitigation rejects 0/negative) | 30s |
| `charging.lowConfidenceThreshold` | 0.5 | (0, 1] (T-12-05 mitigation clamps out-of-range) | 30s |

Both readers mirror the readBandThreshold pattern (stop-mode.ts:91-117); both have companion `__reset*ForTests` helpers for the test suite.

## Test additions count + iPad fixture replay

| File | Test description | Result |
| --- | --- | --- |
| stop-mode.test.ts | readLowConfidenceThreshold: default / parse / range gate / cache | green |
| stop-mode.test.ts | readMatcherRefreshReadings: default / parse / integer gate / cache | green |
| stop-mode.test.ts | shouldStopEnergyFallback: exact target / one-below / well-above / zero/zero edge | green |
| charge-monitor.test.ts | refreshMatch — narrowing-reject (widening clamped to prior) | green |
| charge-monitor.test.ts | refreshMatch — narrowing-accept (tighter candidate updates band + machine) | green |
| charge-monitor.test.ts | refreshMatch — partial-narrowing (Math.max tightens, Math.min holds) | green |
| charge-monitor.test.ts | updateSocTracking accumulates apower + triggers refreshMatch every N readings | green |
| charge-monitor.test.ts | handleTransition('charging') initializes chargingBuffer with cached ProfileWithCurve | green |
| charge-monitor.test.ts | cleanupSession clears chargingBuffers + readingsSinceLastMatch | green |
| charge-monitor.test.ts | iPad Session 14 monotonic narrowing property (n=60 → 120 → 240 → 480 → 720) | green — band width strictly non-increasing |
| charge-monitor.test.ts | High-confidence aggressive emits stopMode='aggressive' on complete event | green |
| charge-monitor.test.ts | handleTransition('stopping') sets lastStopMode BEFORE handleStopping (H6 ordering) | green |
| charge-monitor.test.ts | Low-confidence + on-target: energy_fallback fires + event carries stopMode='energy_fallback' + DB stop_reason='target_soc_reached' | green |
| charge-monitor.test.ts | Low-confidence + on-target: feedReading NOT called on dispatch reading (H1 early-return) | green |
| charge-monitor.test.ts | Low-confidence + below target: NO dispatch, feedReading IS called | green |
| charge-monitor.test.ts | High-confidence bandConfidence=0.96: low-confidence gate does NOT intercept (B2 invariant) | green |
| charge-monitor.test.ts | cleanupSession clears lastStopMode | green |
| charge-monitor.test.ts | ChargeStateMachine.forceStop synchronously transitions to 'stopping' | green |

**Suite totals**: 218 / 218 (was 210 / 210 after Task 2; net +8 new tests in Task 3 plus the existing B2 test re-validated under the new behavior).

## Verification

```
$ pnpm exec tsc --noEmit
(exit 0, no output)

$ pnpm exec vitest run
 Test Files  15 passed (15)
      Tests  218 passed (218)

$ grep -nE 'chargingBuffers|readingsSinceLastMatch' src/modules/charging/charge-monitor.ts | wc -l
13

$ grep -nE 'shouldStopEnergyFallback|readLowConfidenceThreshold|readMatcherRefreshReadings' src/modules/charging/stop-mode.ts | wc -l
3

$ grep -n 'stopMode' src/modules/charging/types.ts | wc -l
1

$ grep -n 'energy_fallback' src/modules/charging/charge-monitor.ts | wc -l
10

$ grep -n 'lastStopMode' src/modules/charging/charge-monitor.ts | wc -l
8

$ grep -nE 'findBestCandidate\(' src/modules/charging/charge-monitor.ts
889:    const candidate = curveMatcher.findBestCandidate(buffer, profiles);
1195:    const candidate = curveMatcher.findBestCandidate(entry.apower, [entry.profile]);
```

Both findBestCandidate calls are 2-arg. All success-criteria grep counts cleared.

## Deviations from Plan

### Auto-fixed (Rule 1)

**1. [Rule 1 - Bug] B2 integration test estimatedSoc lowered from 80 to 50 in wide-band phase**

- **Found during**: Task 3 full-suite run after wiring the energy-fallback dispatch
- **Issue**: The B2 test's wide-band phase used `estimatedSoc=80, targetSoc=80, bandConfidence=0.4`. Under FPD-03's design, this is exactly the canonical scenario the energy-fallback gate is designed to short-circuit (bandConfidence < 0.5 AND estimatedSoc >= targetSoc fires the fallback on the FIRST reading). The test's pre-FPD-03 assumption was "wide-band gate holds the stop"; under FPD-03 the wide-band stop IS the energy-fallback path.
- **Fix**: Adjusted the initial scenario to `estimatedSoc=50, socBest=50, targetSoc=80` so the wide-band phase legitimately does NOT trip any gate. The test still proves the narrow-band aggressive stop fires <30s — promoting estimatedSoc / socBest to 80 at band-collapse time (which is what updateSocTracking does in production when the matcher's socBest moves).
- **Files modified**: `src/modules/charging/charge-monitor.test.ts` (B2 test setup block)
- **Commit**: f6951ec (the GREEN commit folds in the B2 adjustment alongside the FPD-03 implementation)

**2. [Rule 1 - Bug] Energy-fallback integration test made async with microtask flush**

- **Found during**: Task 3 RED→GREEN — the test asserted `state='complete'` DB write but handleStopping's `await switchRelayOff(...)` resolves on the microtask queue
- **Issue**: Synchronous assertion of the post-await DB write fails because the await hasn't resolved by the time `expect` runs
- **Fix**: Made the test `async`, added two `await new Promise(r => setImmediate(r))` flushes between the dispatch call and the DB-write / 'complete'-event assertions. Aligns with the existing handleStopping integration test (line 408-432) which does the same. The synchronously-emitted 'stopping' charge event (added in handleTransition('stopping')) still validates the stopMode tag without the flush.
- **Files modified**: `src/modules/charging/charge-monitor.test.ts` (energy_fallback test only)
- **Commit**: f6951ec

### Auto-added (Rule 2)

**1. [Rule 2 - Missing Critical Functionality] Synchronous 'stopping' charge-event emission in handleTransition('stopping')**

- **Found during**: Task 3 GREEN run — RED's "event carries stopMode='energy_fallback'" assertion failed because no charge event was emitted between the dispatch and the post-await 'complete'
- **Issue**: The pre-existing handleTransition('stopping') only invoked handleStopping fire-and-forget; the FIRST charge event was 'complete' AFTER the relay-off await. SSE consumers (and tests) waiting on stopMode would not see it until the await resolved. Worse, if the relay-off was slow (real Shelly with retry/backoff), the dashboard UI would render the wrong state in the interim.
- **Fix**: Added `this.emitChargeEvent(plugId, 'stopping');` immediately AFTER `this.lastStopMode.set(...)` and BEFORE `this.handleStopping(plugId);`. The captureEventContext snapshot reads the freshly-set lastStopMode synchronously. SSE consumers now see the 'stopping' state with the correct stopMode tag immediately; the post-await 'complete' event also carries it (the snapshot is re-captured at handleStopping's start).
- **Files modified**: `src/modules/charging/charge-monitor.ts` (handleTransition('stopping') case)
- **Commit**: f6951ec

### Inline-clamp simplification (also Rule 2-adjacent)

The PLAN's Task 2 step 6 specified a two-step rejection: "If candidate violates narrowing... keep cached, log... and exit." Combined with step 5's `Math.max / Math.min` inline math, this duplicates the safety guarantee. Step 5's clamp ALONE already enforces "band can ONLY narrow" — Math.max of (priorSocMin, candidateSocMin) trivially holds the prior value when candidate.socMin < priorSocMin.

The implementation adopts the simpler clamp-only design AND retains a `console.debug` trace when either edge widens (for observability). This matches the test "partial-narrowing: only one edge narrows, the wider edge is held" which would have failed under a strict reject-and-bail policy. The plan was internally inconsistent on this point; the SAFETY property is preserved by the clamp alone.

## Backwards Compatibility

- **B2 integration test** (Phase 11): green after the Rule 1 fix above. Semantic intent ("aggressive stop fires <30s after band collapse + socBest >= target") preserved.
- **Override path** (PUT /api/charging/sessions/[id]): unaffected. overrideSession collapses the band to zero-width at estimatedSoc and bandConfidence=1; the energy-fallback gate's `bandConfidence < 0.5` predicate is false on overridden sessions.
- **Phase 11 resume after restart**: unaffected. resumeActiveSessions restores band fields from DB rows. chargingBuffers and lastStopMode are intentionally NOT persisted (resume-degradation: refreshMatch fires after the next 60 readings post-resume; lastStopMode is irrelevant for an in-progress session).
- **Phase 12 FPD-01 watchdog**: unaffected. checkStalePower is called inside handleCharging / handleCountdown — BOTH paths are reached via machine.feedReading. The energy-fallback dispatch short-circuits feedReading for ONE reading (the dispatch reading), so the stale-power counter is briefly paused that tick. Acceptable — the next reading will either continue the stale-power count (if apower stays sub-threshold) OR fire energy-fallback again (if the conditions persist). The watchdog still eventually fires.

## Self-Check: PASSED

Files created or modified:
- `src/modules/charging/stop-mode.ts` — FOUND
- `src/modules/charging/stop-mode.test.ts` — FOUND
- `src/modules/charging/types.ts` — FOUND
- `src/modules/charging/charge-monitor.ts` — FOUND
- `src/modules/charging/charge-monitor.test.ts` — FOUND
- `src/modules/charging/charge-state-machine.ts` — FOUND
- `.planning/phases/12-flat-power-defense/12-02-SUMMARY.md` — FOUND (this file)

Commits (verified via `git log --oneline`):
- de87b62 test(12-02): RED — failing tests for low-confidence threshold + matcher-refresh-readings helpers + energy-fallback predicate — FOUND
- cd3865a feat(12-02): GREEN — stop-mode helpers + energy-fallback predicate + stopMode event field — FOUND
- 25149a2 test(12-02): RED — failing tests for FPD-02 chargingBuffers + adaptive matcher refresh — FOUND
- f9fc88e feat(12-02): GREEN — FPD-02 adaptive matcher refresh during state=charging — FOUND
- 1ce99b5 test(12-02): RED — failing tests for FPD-03 energy-fallback dispatch + stopMode field — FOUND
- f6951ec feat(12-02): GREEN — FPD-03 energy-fallback dispatch + stopMode event surface — FOUND
