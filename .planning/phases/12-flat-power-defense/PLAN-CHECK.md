# Phase 12 PLAN-CHECK

**Reviewed:** 2026-05-15
**Plans:** 12-01, 12-02, 12-03, 12-04
**Verdict:** HIGH — one BLOCKER must be fixed before execute, plus several HIGH-severity gaps. Plans are otherwise well-grounded and goal-aligned.

---

## DoD-backward traceability

| CONTEXT.md Definition of Done | Covered by plan(s) | Status |
|---|---|---|
| FPD-01..05 all ticked in REQUIREMENTS.md | 12-01 (FPD-01), 12-02 (FPD-02+03), 12-03 (FPD-04), 12-04 (FPD-05) | Covered |
| iPad Session 14 sweep shows monotonic narrowing + socBest crossing past flat anchor when ≥40 min | 12-02 Task 2 integration test against `ipad-session-14-readings.json` | Covered (caveat: RESEARCH §FPD-02 Q4 says socBest will NOT converge on real Session 14 because flat data structurally cannot disambiguate — plan correctly limits the assertion to "monotonic narrowing" only, not "socBest converges". DoD wording in CONTEXT.md is misleading; planner acknowledges this in 12-02 Task 2 behavior block — acceptable.) |
| FPD-01 integration test fires switchRelayOff within ≤5 min of 0W readings | 12-01 Task 2 | Covered (uses manual-timestamp B2 pattern, no fake timers — correct per RESEARCH Pitfall 13 + PATTERNS Pattern 9) |
| FPD-04 24h+ε boundary test | 12-03 Task 2 | Covered (uses `vi.useFakeTimers({ toFake: ['setTimeout','setInterval','Date'] })` — correct per RESEARCH Pitfall 13) |
| 171 baseline tests still pass | All 4 plans assert this in success_criteria | Covered |
| Settings page exposes 5 new config rows via useAutoSave | 12-04 Task 2 (5 inputs) | Covered |
| Manual smoke on 117 (induce 0W stale mid-session, verify Pushover + state=aborted) | 12-04 Task 3 (checkpoint:human-verify, gate=blocking) | Covered |

All five DoD bullets have plan coverage.

---

## Planner's 5 resolved Open Questions — actually encoded?

1. **state→monitor stop_reason via onTransition `data`** — 12-01 Task 1 extends `transition(to, data?: unknown)` and updates onTransition signature (`(from, to, data?: unknown) => void`). State machine ALREADY declares `onTransition: ((from, to, data?: unknown) => void) | null` at line 50 of `charge-state-machine.ts`, so this is in fact already in place — plan just needs to start using the existing `data` param. **Encoded — correct.**

2. **chargingBuffers in-memory Map cleared on cleanupSession** — 12-02 Task 2 explicitly: `private chargingBuffers = new Map<string, number[]>(); cleanupSession also chargingBuffers.delete(plugId)`. **Encoded.**

3. **stopMode='energy_fallback' field on ChargeStateEvent** — 12-02 Task 1 adds optional `stopMode?: 'aggressive' | 'conservative' | 'energy_fallback'` to ChargeStateEvent. **Encoded.**

4. **localStorage ack key `charging-watchdog-ack-${sessionId}`** — 12-04 Task 1: `localStorage.setItem(\`charging-watchdog-ack-\${sessionId}\`, '1')`. **Encoded with the exact key shape from user verification prompt.**

5. **20% of stalePowerWindowSec for warning trigger** — 12-01 Task 2 behavior: "if seconds >= 0.20 * windowSec → 'warning'". Hardcoded constant `0.20` with inline comment `// 20% of window — see CONTEXT design-decision` (Task 3 action). Not configurable. **Encoded as hardcoded (matches RESEARCH §FPD-05 OQ-3 recommendation).**

---

## BLOCKING issues

### B1 — `findBestCandidate` signature mismatch in Plan 12-02

**Severity:** BLOCKER
**Plan:** 12-02 Task 2
**Description:** Plan calls `findBestCandidate(buffer, [profileFromSession], { thresholdPct: readBandThreshold() })`. The actual signature in `src/modules/charging/curve-matcher.ts:141-144` is:

```ts
export function findBestCandidate(
  queryReadings: number[],
  profiles: ProfileWithCurve[]
): MatchResult | null
```

There is NO opts/thresholdPct third argument. The threshold `DEFAULT_BAND_THRESHOLD_PCT` is **hardcoded inside `deriveBand`** at line 172 of `curve-matcher.ts`. Calling with three args won't compile; executing 12-02 as written will fail `tsc --noEmit` immediately.

Additionally, the plan's "single profile array re-detection" choice (`[profileFromSession]`) is valid as a design but `findBestCandidate` requires the input to be `ProfileWithCurve` (with `curve` + `curvePoints` fields), not the bare `Profile` returned from `matchData`. The plan needs to call `loadProfilesWithCurves()` (line 810) and filter by id, OR persist `ProfileWithCurve` on first match.

**Also:** the existing `deriveBand` threshold parameter is read INSIDE `findBestCandidate` from the constant — to make the refresh respect `readBandThreshold()`, the plan would need to either (a) extend `findBestCandidate` to take a threshold opt and pass to `deriveBand`, or (b) extract & directly re-derive band from `subsequenceDtw` `distances`. Neither is currently scoped.

**Fix:** Plan 12-02 Task 2 action block must either:
1. Extend `findBestCandidate` signature to accept `opts?: { thresholdPct?: number }` (adds ~5 LOC + plumbing into `deriveBand` call at line 167-173) — small but real scope addition that must be in the plan.
2. OR explicitly use the existing constant default (drop the `readBandThreshold()` call from refreshMatch) and document that adaptive refresh respects whatever the matcher's compile-time default is.
3. AND clarify the profile lookup — `refreshMatch` must call `loadProfilesWithCurves()` and `.filter(p => p.id === match.profileId)[0]` (or similar) to get a `ProfileWithCurve`, not pass `this.matchData.get(plugId)` directly.

Both changes are mechanical but must be in the plan text — executor can't reasonably guess.

---

## HIGH-severity issues

### H1 — Plan 12-02 Task 3 ordering ambiguity around `forceStop` and `feedReading`

**Severity:** HIGH
**Plan:** 12-02 Task 3
**Description:** The plan says: "BEFORE calling `machine.feedReading(...)`, when state ∈ {charging, countdown} AND bandConfidence < threshold AND `shouldStopEnergyFallback(...)` is true → `machine.forceStop('energy_fallback')` which transitions to `'stopping'`". Then `machine.feedReading` still runs (the plan doesn't say to skip it). On the next reading after a forceStop, the recycle gate (line 76-85 of charge-state-machine.ts) recycles `'stopping'` → `'idle'`. But within the SAME `handlePowerReading` call, if we `forceStop` and THEN call `feedReading`, the state is now `'stopping'` and feedReading's recycle-gate code resets it to `'idle'` immediately — undoing the forceStop before `handleTransition` ever sees `from='charging' to='stopping'`.

Also: where does `machine.targetSoc` come from in the read? Plan reads `machine.targetSoc` to call `shouldStopEnergyFallback({ estimatedSoc: machine.estimatedSoc, targetSoc: machine.targetSoc })`. But `machine.estimatedSoc` is updated INSIDE `updateSocTracking` (line 882), which runs AFTER `handleTransition`. So at the dispatch point (before feedReading) on a NEW reading, `machine.estimatedSoc` still reflects the value from the PREVIOUS reading's updateSocTracking. That's OK (one tick of staleness is fine) but it means the energy-fallback check fires one reading later than band-mode shouldStop. Worth documenting; not a blocker.

**Fix:** Plan 12-02 Task 3 action block must specify:
- If forceStop fires, **skip `machine.feedReading` for this reading** (early-return from handlePowerReading after forceStop + handleTransition('charging','stopping')).
- Document explicitly that `estimatedSoc` is read one-reading stale; acceptable per design.

### H2 — Plan 12-01 Task 2 conflates `machine.stalePowerCount` exposure semantics

**Severity:** HIGH
**Plan:** 12-01 Task 2
**Description:** Task 2 says "promote state machine's `stalePowerCount` to public readonly (just remove `private`)". But Task 1 ALSO declares `private stalePowerCounts = new Map<string, number>();` in `ChargeMonitor` (a separate Map to mirror the counter for `captureEventContext`). Task 2 then says "Update from `handlePowerReading` AFTER `machine.feedReading`: read `machine.stalePowerCount`" — implying the monitor reads the machine's counter directly. Why does the monitor need a second `stalePowerCounts` Map if it reads from `machine.stalePowerCount`?

The behavior block has two contradictory designs side-by-side: (a) "New private Map `stalePowerCounts`" and (b) "Replace the new getter with a simpler approach: state machine exposes a public readonly field `stalePowerCount`". Two paths in the same task.

**Fix:** Plan 12-01 Task 2 must pick ONE: either monitor mirrors a Map (matches per-plug pattern, decouples machine), OR monitor reads `machine.stalePowerCount` directly (simpler but couples to state machine internals). Either is acceptable; the plan must not specify both — executor will pick arbitrarily.

### H3 — Plan 12-03 stop_reason routing is incomplete

**Severity:** HIGH
**Plan:** 12-03 Task 2 (depends on 12-01's `handleTransition('aborted')` case)
**Description:** Plan says: "Extend handleTransition('aborted') case from 12-01 to route by `data.reason`: 'stale_power' / 'timeout' / fallback (existing abortSession behavior)." But 12-01's Task 2 introduces the `'aborted'` case directly in handleTransition, NOT in abortSession. Existing `abortSession` at line 294-309 of `charge-monitor.ts` IS the user-abort path (`stopReason='user_abort'`) — it writes the DB directly without going through handleTransition.

The "fallback" arm 12-03 references doesn't exist as a clean path — handleTransition didn't previously have an `'aborted'` case at all (machine.abort just calls reset+goto idle and fires `onTransition(from, 'idle')`, never `'aborted'`). So 12-03's "fallback path" arm in the data.reason switch routes through handleTransition('aborted') for a reason the codebase doesn't currently produce. This is a no-op default arm but is misleading documentation that could confuse the executor.

**Fix:** Plan 12-03 Task 2 action block should state explicitly: "The 'aborted' case in handleTransition only sees `data.reason ∈ {'stale_power','timeout'}` because no other code path emits 'aborted' state transition. A defensive default arm logs an unexpected reason but doesn't do DB work — `abortSession` is the OTHER path that writes DB directly for user_abort and does NOT route through handleTransition."

### H4 — Plan 12-02's monotonic-clamp extraction is left as executor's-choice with consequences

**Severity:** HIGH
**Plan:** 12-02 Task 2
**Description:** Plan offers Option A (extract `private clampBand(prior, candidate)`) or Option B (inline Math.max/Math.min in refreshMatch). For Option A, the existing `tryMatch` clamp at lines 715-731 would need to be refactored to call the helper, OR there will be TWO sites with subtly-different clamp logic (refreshMatch's helper + tryMatch's inline). The plan doesn't say "if Option A, also refactor tryMatch". That's a drift risk: tryMatch already has the prior-undefined fallback (`priorSocMin !== undefined ? Math.max(...) : candidate`), refreshMatch only needs to handle the prior-defined case. Two slightly different clamps are a maintainability bomb.

**Fix:** Lock Option B (inline). Or, if Option A, the plan must mandate refactoring tryMatch to use the same helper.

### H5 — Plan 12-04 Task 1's `fraction` derivation is wrong when stalePowerFiresAt is undefined

**Severity:** HIGH
**Plan:** 12-04 Task 1
**Description:** Plan says: "Reads `secondsAtZero = stalePowerSeconds ?? 0`. `windowSec` is NOT in the event — derive `firesIn = Math.max(0, (stalePowerFiresAt ?? 0) - Date.now()) / 1000` and the bar fraction is `1 - firesIn / (firesIn + secondsAtZero)` (= secondsAtZero / windowSec). Acceptable approximation; document inline."

If `stalePowerFiresAt` is undefined (which Plan 12-01 Task 2 says happens whenever `kind !== 'warning'`), `firesIn = (0 - Date.now()) / 1000 = -very_negative`, then `Math.max(0, ...) = 0`. Then fraction = `1 - 0/(0 + secondsAtZero) = 1` (full bar). For the moment the kind transitions from 'warning' back to 'none' (impossible per design — but the warning could be the FIRST event the client receives and lag), the math NaN/divides-by-zero when both are 0. Edge cases will produce visual glitches.

Also: the algebraic identity `1 - firesIn/(firesIn + secondsAtZero) = secondsAtZero / windowSec` is only true when `firesIn + secondsAtZero = windowSec`, i.e., when the counter is monotonically increasing without resets. Acceptable approximation, but the math should be guarded: if `firesIn === 0`, treat fraction as 1 only when kind === 'warning'; otherwise fraction = 0 (hide the warning bar entirely).

**Fix:** Plan 12-04 Task 1 must specify: render the warning bar ONLY when `watchdogKind === 'warning'` (gate the fraction calculation). Inside that branch, treat `firesIn === 0` as fraction=1 (about to fire). NaN/divide-by-zero guards on `(firesIn + secondsAtZero) === 0`.

### H6 — Plan 12-01 / 12-02 emit `stopMode` on event but 12-01 plan does not surface `stopMode` value for non-aborted events

**Severity:** HIGH (cross-plan contract)
**Plan:** 12-01 + 12-02 + 12-04
**Description:** 12-02 Task 3 says emitChargeEvent reads `lastStopMode.get(plugId)` and includes it on the event. But aggressive/conservative paths fire via `handleStopping` (existing — see line 935-1001 of charge-monitor.ts), which calls `emitChargeEvent(plugId, 'complete', false, completionCtx)`. The completionCtx is created by `captureEventContext` BEFORE the await. For `stopMode` to be on the 'complete' event, `captureEventContext` must read `lastStopMode` and 12-02 must populate it BEFORE `handleStopping` runs. But the existing flow is: handleCharging → transition('countdown') → next reading → handleCountdown → transition('stopping') → handleTransition('stopping') → handleStopping. The `lastStopMode` Map is only written by 12-02 Task 3's energy_fallback path (synchronously before forceStop) AND by handleTransition('stopping') reading `machine.stopMode` (12-02 says "for the high-confidence path, populate `lastStopMode` in `handleTransition('stopping')` from `machine.stopMode`").

This means: for the band-mode aggressive/conservative path, `lastStopMode` is set when handleTransition('stopping') fires — but `captureEventContext` runs INSIDE handleStopping which IS in handleTransition('stopping'). So the populate-then-capture order works **only if 12-02 explicitly writes `lastStopMode` BEFORE `handleStopping` is invoked**, i.e., in the case block before the function call. Plan does not specify this ordering.

**Fix:** Plan 12-02 Task 3 action must specify: "Inside `handleTransition('stopping')` case (line 628 of charge-monitor.ts), set `lastStopMode.set(plugId, machine.stopMode)` BEFORE calling `this.handleStopping(plugId)`." And `captureEventContext` reads `lastStopMode.get(plugId)` and returns it. And `emitChargeEvent` writes `event.stopMode = effective.stopMode`.

12-04 Task 1 also doesn't currently include `stopMode` in the component-state-watch list. If FPD-03 surfaces energy_fallback, FPD-05 doesn't display it. Acceptable if scope is "FPD-05 = watchdog UI only" but worth noting as drift between FPD-03's "surface to user" and FPD-05's actual UI.

---

## MINOR issues

### M1 — Plan 12-03 has wrong cross-reference

**Plan 12-03 Task 1 action** says: "Copy the `readMatcherRefreshReadings` pattern from 12-02". This requires 12-02 to land first. But 12-03's `depends_on: [12-01]` — does NOT depend on 12-02. They are both Wave 2 (parallel). If 12-03 lands first, "copy from 12-02" is wrong reference; copy from `readBandThreshold` in stop-mode.ts instead. The plan acknowledges this with "or `readBandThreshold` if 12-02 hasn't landed yet" — acceptable but could be cleaner by just saying "copy `readBandThreshold` pattern" always.

### M2 — Plan 12-02 Task 2 iPad fixture path assumed but not confirmed

Plan 12-02 Task 2 says: "load the existing `ipad-session-14-readings.json` (committed in v1.3.1) ... The fixture probably lives at `src/__fixtures__/` or `src/modules/charging/__fixtures__/`. ... look up where the fixture is consumed today (search `ipad-session-14-readings.json`)".

Verified: fixture is at `src/modules/charging/fixtures/ipad-session-14-readings.json` and consumed by `src/modules/charging/curve-matcher.test.ts:11`. Plan's hedge ("probably") is acceptable but could just state the verified path.

### M3 — Plan 12-04 Task 1 ack lifecycle when sessionId changes mid-render

When `sessionId` prop changes (e.g., the SSE on-connect snapshot delivers a new active session after a page reload), `useState(() => localStorage.getItem(...))` does NOT re-run. Plan says "Reset to false when sessionId changes (new session)" but doesn't specify HOW (a `useEffect([sessionId], () => setAcked(localStorage.getItem(...)==='1'))`).

**Fix:** Plan 12-04 Task 1 action should add: "`useEffect` on `[sessionId]` to re-read the localStorage key when sessionId changes."

### M4 — atomic commit-per-task discipline OK

All four plans align with one commit per task convention (the plans don't reference commit boundaries explicitly but the success_gates after each `<task>` block are runnable atomically). No "kitchen sink" tasks — each task has 1-2 files of cohesive change.

### M5 — `files_modified` overlap inside Wave 2 (12-02 and 12-03)

12-02 modifies: `charge-monitor.ts`, `stop-mode.ts`, `types.ts`, `charge-monitor.test.ts`, `stop-mode.test.ts`
12-03 modifies: `charge-monitor.ts`, `stop-mode.ts`, `stop-mode.test.ts`, `charge-monitor.test.ts`

These run in parallel as Wave 2. If executed in two worktrees and merged, every shared file is a merge conflict candidate. The justification is: 12-02 touches `updateSocTracking` + `handleTransition('stopping')`; 12-03 touches `handlePowerReading` (new `checkSessionTimeout` call) + `handleTransition('aborted')`. They are functionally disjoint within the same file, but `stop-mode.ts` will receive concurrent additions of `readLowConfidenceThreshold` + `readMatcherRefreshReadings` (12-02) and `readMaxSessionHours` (12-03). Mechanical merge.

Not a blocker but worth flagging — executor should know to either serialize Wave 2 or expect a merge step. Plans say "Independent of 12-02 — pure wall-clock" and "Parallel-safe with 12-03", which is true semantically but not file-disjoint.

### M6 — No re-implementation of monotonic clamp / fireAnomalyNotification

Verified that Plan 12-02 explicitly re-uses (or extracts) the existing clamp at charge-monitor.ts:715-731, and Plan 12-01 / 12-03 re-use the `fireAnomalyNotification` body shape verbatim. No duplicate implementations planned. Good.

### M7 — Wave declarations are correct

- 12-01: wave 1, depends_on: [] — correct (foundation)
- 12-02: wave 2, depends_on: [12-01] — correct (extends ChargeStateEvent shape from 12-01)
- 12-03: wave 2, depends_on: [12-01] — correct (extends handleTransition('aborted') from 12-01)
- 12-04: wave 3, depends_on: [12-01, 12-02, 12-03] — correct (consumes all backend SSE fields)

### M8 — B2 test pattern correctly applied for FPD-01, fake-timer for FPD-04

- 12-01 Task 2 uses manual-timestamp loop (matches B2 pattern at charge-monitor.test.ts:649-720) — correct.
- 12-03 Task 2 uses `vi.useFakeTimers({ toFake: ['setTimeout','setInterval','Date'] })` for the wall-clock check — correct per RESEARCH Pitfall 13.

### M9 — Backend "warning" emit threshold of 20% is hardcoded

Plan 12-01 Task 3 hardcodes 0.20 in captureEventContext with an inline comment. Per RESEARCH Pitfall 13 + §FPD-05 Q1 + planner's own resolution, this is acceptable — keeps config surface small. Not a blocker.

---

## Summary table

| Severity | Count | Action |
|----------|-------|--------|
| BLOCKER  | 1 (B1: `findBestCandidate` signature) | Must revise 12-02 before execute |
| HIGH     | 6 (H1-H6) | Should revise; some are documentation-level, some are correctness |
| MINOR    | 9 (M1-M9) | Nice-to-fix; don't block execute |

---

## Top 3 findings

1. **B1 — 12-02 Task 2 calls `findBestCandidate` with a non-existent third opts arg.** `findBestCandidate(buffer, profiles)` has no opts; threshold is hardcoded via `DEFAULT_BAND_THRESHOLD_PCT` inside `deriveBand`. Plan must either extend the signature or drop the per-refresh threshold. Without this fix, 12-02 fails `tsc --noEmit` on first compile.

2. **H1 — 12-02 Task 3 energy-fallback dispatch order is unspecified.** After `machine.forceStop('energy_fallback')`, the plan doesn't say to skip the subsequent `machine.feedReading` call — which would recycle the just-entered `'stopping'` state back to `'idle'` via the existing recycle gate. Plan must specify early-return after forceStop.

3. **H6 — `stopMode` event field surface is ambiguous across plans.** 12-02 writes `lastStopMode` in `handleTransition('stopping')`, but `captureEventContext` (called from inside `handleStopping`) runs in the same call frame. Plan must specify that `lastStopMode.set(plugId, machine.stopMode)` happens BEFORE `handleStopping(plugId)` is invoked, so the snapshot reads the fresh value.

## Recommendation

Return to planner for revision of Plan 12-02 (addresses B1, H1, H4, H6) and Plan 12-01 (H2). Plans 12-03 (H3) and 12-04 (H5, M3) need targeted action-block clarifications but no structural changes. After revision, all plans should be ready to execute as Waves 1 → 2 → 3.
