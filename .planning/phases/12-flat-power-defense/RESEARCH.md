# Phase 12 Research — Flat-Power Defense

**Researched:** 2026-05-15 (post v1.3.1 d4242b3, ahead of FPD-01..05 planning)
**Author:** Researcher agent. Findings grounded in the existing `src/modules/charging/*` code, Phase 11 SUMMARYs, and a focused look at prior art for "smart-plug 0W battery-full" detection.
**Confidence:** HIGH on local-code claims (verified by file:line), MEDIUM on the monotonic-narrowing DTW analysis (justified mathematically + by code, no external paper directly cited), LOW on external prior-art (no smart-plug project found that solves this exact problem the same way).

## TL;DR

- **FPD-01 watchdog must mirror the existing `sustainedCount` / `idleCount` patterns in `charge-state-machine.ts`** (counter resets on signal, fires on threshold). Reading-based, NOT wall-clock — this is locked in CONTEXT §design-decision-1 and the project already does this for both detection (`SUSTAINED_READINGS = 6`) and learn-idle (`LEARN_IDLE_READINGS = 12`). Add `stalePowerCount` counter, reset on `apower >= threshold`, fire on `>= window/pollInterval` readings.
- **FPD-02 monotonic narrowing is already implemented in `charge-monitor.ts:723-731` (tryMatch) and we just need to RE-RUN tryMatch.** The existing `tryMatch()` already does the `Math.max(prior, candidate)` / `Math.min(prior, candidate)` band-clamping; calling it again with a longer buffer is the entire fix. No new math, no new module. The buffer source is the open question (in-memory ring buffer vs DB `power_readings` query) — recommendation below.
- **FPD-03 "v1.2 energy-based stop" was never committed as a literal formula** — git history shows `shouldStop` was first introduced in `e246f5e` (Phase 11) as the band-aware predicate. The CONTEXT.md formula `cumulativeEnergyWh >= (targetSoc - estimatedStartSoc)/100 * totalEnergyWh` is the SEMANTIC equivalent of what `updateSocTracking` ALREADY computes for the user-visible "Wh fehlen" badge (`charge-monitor.ts:907`). We can implement the fallback by re-using that exact arithmetic instead of inventing a new formula.

## Pitfalls (numbered list — gotchas the planner must avoid)

1. **Reading-based vs wall-clock confusion in FPD-01.** Wall-clock (`Date.now() - lastNonZeroReadingAt`) seems simpler but false-fires on any polling gap (Shelly offline 5 min → fires stale-power even though we have no idea what the charger was doing). Reading-based (count of consecutive sub-threshold readings) naturally pauses during offline windows because no readings arrive. CONTEXT.md design-decision-1 locks reading-based. Mirror the `idleCount` pattern at `charge-state-machine.ts:244-252`.

2. **Resetting `stalePowerCount` on Shelly-offline edges.** When polling fails entirely (no reading at all), the state-machine receives no `feedReading()` call. That's correct — the counter doesn't increment. But the counter ALSO doesn't reset. If charger draws 200W → offline 30s → resumes at 0W (Sanorum-style charger-restarts-and-finishes), we want the counter to start counting from the first 0W reading after the gap, NOT to retain pre-gap zero-readings. Solution: counter is plain monotonic on `apower < threshold` readings — it can only be reset by an `apower >= threshold` reading. Brief offline windows naturally "pause" it because no reading event arrives.

3. **Don't widen the band in FPD-02.** `tryMatch()` already enforces monotonic narrowing at `charge-monitor.ts:723-731`. When the planner adds the adaptive-refresh re-call, they must call the SAME `tryMatch()` path, not a parallel "applyMatch" that bypasses the clamp. If we introduce a different entry-point (e.g., `refreshMatch()`), it MUST share the clamp logic via a private helper.

4. **B2 integration-test invariant must not regress.** The B2 test at `charge-monitor.test.ts:649-720` proves aggressive-stop fires within <30 sim-seconds of band collapse. Phase 12 adds bandConfidence-aware fallback (FPD-03) — but that ONLY changes the shouldStop return shape when `bandConfidence < threshold`. The B2 scenario has `bandConfidence=0.96` so it MUST still hit the existing aggressive path. The planner must keep the B2 test green and add a sibling B3 test for the low-confidence fallback.

5. **Aggressive ordering trap (Phase-11 Pitfall 5) still applies to FPD-03.** `stop-mode.ts:41-55` enforces "width check FIRST, then target check" for aggressive mode. When extending shouldStop with a low-confidence energy-fallback branch, the new branch must come FIRST in the ordering — otherwise a wide-band socBest-on-target could trip aggressive before the low-confidence gate even runs. Order: `(1) low-confidence → energy fallback`, `(2) conservative`, `(3) aggressive`. Lock by unit test.

6. **`shouldStop` is called from BOTH `handleCharging` and `handleCountdown`** (`charge-state-machine.ts:194-223`). FPD-03's return-shape changes (`stop`, `mode`, `reason` instead of `boolean`) must be threaded through both callers. The state machine currently doesn't carry `cumulativeEnergyWh` — that's a ChargeMonitor concept. The planner must decide: (a) extend shouldStop signature to accept energy fields, OR (b) keep shouldStop band-only and add a separate `shouldStopEnergyFallback()` invoked from ChargeMonitor.updateSocTracking when bandConfidence is low. **Recommendation: (b)** — keeps stop-mode.ts pure, mirrors the existing "energy math lives in ChargeMonitor" pattern.

7. **Resume after restart must preserve FPD-01 watchdog state OR re-derive it.** `resumeActiveSessions` at `charge-monitor.ts:1161-1272` restores band fields from DB. If we don't persist `stalePowerCount`, a restart during a stale-power window resets the counter to zero — and an additional 5 min has to elapse before FPD-01 fires. This is acceptable (a restart is rare and the watchdog still eventually fires) BUT must be documented. Persisting the counter adds schema complexity for marginal benefit. **Recommendation: don't persist; document the post-restart 5-min re-arming.**

8. **CONTEXT.md's v1.2 energy-fallback formula does NOT match any committed code.** The formula `cumulativeEnergyWh >= (targetSoc - estimatedStartSoc)/100 * totalEnergyWh` reads like a stop predicate but git log shows `shouldStop` (in any form) only appears in commit `e246f5e` (Phase 11). The pre-v1.3 behavior was that `updateSocTracking` computed `soc = estimateSoc(socWh, totalWh, startSoc)` and the state machine compared `estimatedSoc >= targetSoc`. The semantic equivalent of the CONTEXT formula. So the "fallback" is really: "use the legacy soc-based predicate (`estimatedSoc >= targetSoc`)". The planner should phrase it this way in the plan to avoid implying we're reviving a literal removed formula.

9. **`renderSocBandAscii(mode: 'pushover')` is the ASCII flavor for the stale-power Pushover** — NOT the Unicode mode. Pushover lock screen mangles `▓▒░↑▲` (Phase 11 Pitfall 3). The existing `fireAnomalyNotification` at `charge-monitor.ts:504-551` already does this correctly with `monospace: '1'`. Re-use the pattern verbatim; just add a new title/body template.

10. **24h max-session-duration uses wall-clock, not reading count** — UNLIKE FPD-01. Rationale: 24h is an absolute upper bound on "even a fully-stuck system shouldn't hold a relay on indefinitely". Reading-based would mean 24h × 5s = 17,280 readings needed; on a Shelly that's offline 23h then briefly back online, reading-based would let the session survive much longer than 24h wall-clock. FPD-04 wants wall-clock specifically because it's the LAST-line-of-defense. Document explicitly that FPD-01 and FPD-04 are intentionally counted differently.

11. **Watchdog warning UI must use the SAME SSE event stream as everything else** — `/api/sse/charge`. Don't introduce a new endpoint. Extend `ChargeStateEvent` with two new fields (`watchdog: { kind, secondsAtZero, willFireAt }` or three flat fields — see "Open Questions"); the existing `useChargeStream` hook (already used by `charge-banner.tsx` AND `soc-band-indicator.tsx`) auto-picks them up.

12. **Acknowledge button persistence — localStorage by sessionId, not boolean.** A boolean dismissal would dismiss future stale_power banners for OTHER sessions on the same plug. Keyed by sessionId, the dismissal is naturally session-scoped: when the user starts a new session, the new sessionId is not in localStorage, and the banner re-arms.

13. **vi.useFakeTimers + React effects requires `act()`.** Phase 11's `soc-band-indicator.test.tsx` already uses `act()` for callback emits but does NOT use `useFakeTimers`. The FPD-05 watchdog warning is time-driven (banner shows seconds counting up); test must wrap timer-advances in `act(() => { vi.advanceTimersByTime(1000); })`. Gotcha: `vi.useFakeTimers()` defaults to mocking `setImmediate` and `process.nextTick` too, which breaks `flushPromises()` patterns. Use `vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'Date'] })` to keep microtasks live.

14. **FPD-02 buffer source: don't query the DB on every reading.** `power_readings` accumulates ~17k rows per 24h per plug. Querying `WHERE plug_id = ? AND timestamp >= session.startedAt` on every reading-cycle is wasteful when an in-memory ring is essentially free. Existing `detectionBuffers` (`charge-monitor.ts:65`) is the established pattern for an in-session ring; extend the same idea with a `chargingBuffers` map cleared on cleanupSession.

## Patterns to follow (file:line refs from project + external)

### Counter-based watchdog pattern (FPD-01)
- **Existing model:** `charge-state-machine.ts:168-178` (`handleIdle` — `sustainedCount++` on apower > threshold, reset to 0 on apower <= threshold, transition fires when `>= SUSTAINED_READINGS`).
- **Mirror:** `handleCharging`/`handleCountdown` get a `stalePowerCount` field that increments on `apower < STALE_POWER_THRESHOLD_W` (default 1.0 W) and resets on `apower >= STALE_POWER_THRESHOLD_W`. When `>= STALE_POWER_WINDOW_SEC / pollIntervalSec` (default 300/5 = 60 readings), fire a new `'stale_power'` synthetic transition.
- **Counter exposure for FPD-05 UI:** The state-machine should expose `stalePowerSeconds` (computed: `stalePowerCount * pollIntervalSec`) so `captureEventContext` can read it and emit it to the SSE stream. Mirrors how `socMin`/`socMax` flow today (`charge-monitor.ts:1031-1064`).

### Monotonic band clamp (FPD-02)
- **Existing site:** `charge-monitor.ts:715-739` in `tryMatch()`:
  ```ts
  const newSocMin = priorSocMin !== undefined
    ? Math.max(priorSocMin, candidateSocMin)
    : candidateSocMin;
  const newSocMax = priorSocMax !== undefined
    ? Math.min(priorSocMax, candidateSocMax)
    : candidateSocMax;
  ```
- **Theoretical justification:** Subsequence DTW computes `Δ_DTW(m)` = a per-reference-offset distance vector (`distances` Float64Array in `dtw.ts`). When the query grows from N to N+k samples (k>0), the accumulated cost at every reference offset can only stay the same or grow — DTW's accumulated cost is monotonic non-decreasing in query length under standard step-pattern constraints. Therefore the set of offsets within `(1 + thresholdPct) × best` of the new best is, in the limit, a SUBSET of (or different from but not strictly larger than) the prior set in absolute count. **Empirically observed in CONTEXT.md table:** band-widths went 27 → 0 → 29 → 5 → 10 across 5/10/20/40/70-min query windows for iPad Session 14. The "29" and "10" entries are wider than predecessors — which means **theoretical monotonicity is not strict**; the clamp at lines 715-739 is therefore a SOFT enforcement, not a math guarantee. Phase 11 chose the clamp because empirically widening from noise is always worse than holding a stale-but-narrow band. Plan 12 must keep this enforcement.
- **Source:** [Subsequence DTW (Audiolabs Erlangen FMP C7S2)](https://www.audiolabs-erlangen.de/resources/MIR/FMP/C7/C7S2_SubsequenceDTW.html) — the matching function ΔDTW(m) is the `distances` array. Also referenced inline in `curve-matcher.ts:82-84` and `curve-matcher.ts:48-51`.

### Stop predicate ordering (FPD-03)
- **Existing site:** `stop-mode.ts:41-55` — `shouldStop` checks aggressive's width FIRST then target. Comment block at lines 16-22 documents the trap. Phase 12 adds a low-confidence gate that runs BEFORE aggressive/conservative — same ordering discipline.
- **Recommendation for new signature:**
  ```ts
  // stop-mode.ts — extended (current return type is boolean)
  export type StopDecision =
    | { stop: false }
    | { stop: true; mode: 'aggressive' | 'conservative' | 'energy_fallback';
        reason: 'band_target' | 'energy_target' };

  export function shouldStop(opts: {
    mode: StopMode;
    socMin, socMax, socBest, targetSoc: number;
    bandConfidence: number;
    lowConfidenceThreshold: number;
    estimatedSoc: number;  // for energy_fallback
  }): StopDecision { ... }
  ```
  But see Pitfall 6 — prefer keeping shouldStop band-only and adding a separate fallback predicate invoked from ChargeMonitor.

### Pushover anomaly with ASCII bar (FPD-01 notification)
- **Existing site:** `charge-monitor.ts:504-551` (`fireAnomalyNotification`). Renders `renderSocBandAscii({ mode: 'pushover' })` (lock-screen-safe ASCII), POSTs with `monospace: '1'`. **Phase 12: extend with a new title (`'Battery full? Sitzung gestoppt'` or similar) and a new body template; share the bar-rendering code path.**

### Reading-based vs wall-clock (FPD-01 / FPD-04 split)
- **FPD-01 (reading-based):** Pattern `charge-state-machine.ts:244-252` (`handleLearning`'s `idleCount`).
- **FPD-04 (wall-clock):** Pattern `charge-state-machine.ts:239-242` (`LEARN_HARD_STOP_MS = 6h` absolute cap on learning sessions, evaluated as `timestamp - learnStartTimestamp`). This is the existing "absolute cap" precedent. FPD-04 is the same shape: `Date.now() - sessionStartedAt >= maxSessionHours * 3_600_000`.

### Settings auto-save (FPD config rows)
- **Existing pattern:** `charging-settings.tsx:13-37` defines `useAutoSave(key, value, initialValue)` with 500ms debounce. Phase 12 adds 4 new config rows; all use the same hook. Validation pattern at lines 53-57 (`validatedThreshold`) is the model for the new integer/numeric inputs (parse, clamp, fall back to initial on bad input).

### Test patterns (FPD-05 RTL + FPD-01/02 integration)
- **Mock SSE callback:** `soc-band-indicator.test.tsx:9-14` shows the locked pattern (vi.mock `@/hooks/use-charge-stream`, capture cb, replay synthetically with `act()`).
- **B2-style integration test:** `charge-monitor.test.ts:649-720` — manipulates `monitor` internals via typed cast `as unknown as MonitorInternals`. Same pattern for Phase 12: drive `handlePowerReading` in a loop with mocked timestamps + asserted relay-off side-effect.
- **Fake-timer config:** `vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'Date'] })` recommended (see Pitfall 13).

### External prior art (LOW confidence — no exact match found)
- [OpenEVSE Home Assistant integration](https://www.home-assistant.io/integrations/openevse/) and [EVCC](https://evcc.io/en/) both control DEDICATED EV chargers via vendor protocols (OpenEVSE has SOC pulled from the EV bus; EVCC integrates with vehicle APIs). Neither has a "smart-plug-only, no battery API" stale-power problem because they're not reading raw AC power; they have a charger handshake telling them "done". **Translation to charging-master:** we are alone in this design space — there's no upstream-project pattern to copy. The FPD-01 5-min/0W heuristic is bespoke and that's appropriate.
- Generic DTW background: [DTW (Wikipedia)](https://en.wikipedia.org/wiki/Dynamic_time_warping), [Subsequence DTW (Audiolabs Erlangen)](https://www.audiolabs-erlangen.de/resources/MIR/FMP/C7/C7S2_SubsequenceDTW.html).

## Per-requirement analysis

### FPD-01: Stale-Power Watchdog

**Q1 — Canonical Node/TS pattern for counter watchdog inside a state machine?**

Yes — mirror existing `sustainedCount` (idle→detecting transition, `charge-state-machine.ts:168-178`) and `idleCount` (learning→learn_complete, `charge-state-machine.ts:244-252`). The pattern is:

```ts
// Inside handleCharging / handleCountdown, after the existing shouldStop call:
if (apower < this.stalePowerThresholdW) {
  this.stalePowerCount++;
  if (this.stalePowerCount >= this.stalePowerWindowReadings) {
    this.transition('aborted', { reason: 'stale_power' });
    this.stalePowerCount = 0;
  }
} else {
  this.stalePowerCount = 0;
}
```

This is consistent with the codebase. **HIGH confidence.**

**Q2 — Edge case: Shelly offline (apower=0 for 10s gap) — reset or accumulate?**

When the Shelly is offline, no `feedReading()` call arrives at all. The counter neither increments nor resets — it's "paused". When polling resumes:
- If apower is again ≥ threshold → reset (genuine charging resumed)
- If apower is still < threshold → increment (continued stale)

This is the right behavior because we never have evidence of the charger state during the gap. **HIGH confidence — matches CONTEXT.md design-decision-1 verbatim.**

**Q3 — Prior art in OpenEVSE / EVCC / Home Assistant?**

None found that solves THIS specific problem (plug-side stale detection without a charger API). OpenEVSE and EVCC pull SOC from the vehicle bus; smart-plug Home Assistant integrations generally don't have a "battery full → stop" automation built in. The chargecontroller community sticks with vendor APIs. **The 5-min/0W heuristic is bespoke to this app and that's correct.** LOW confidence on external sources but HIGH confidence on the bespoke conclusion.

**Q4 — Pushover anomaly message UX best practice?**

Reuse `fireAnomalyNotification` body shape (`charge-monitor.ts:504-551`):
- title: `"Lade-Anomalie: <profile>"` or in our case `"Watchdog: 0 W seit 5 Min — Battery full?"`
- body: 2-3 sentences explaining; suggest user action ("Plug bleibt aktiv" → in our case "Plug abgeschaltet"); attach ASCII bar with `monospace=1`
- priority: 1 (matches existing anomaly priority)

**Recommended message** (German, consistent with codebase voice):
```
Watchdog: <profile> zieht seit X Min < 1 W. Wahrscheinlich Akku voll oder Charger fertig.
Plug abgeschaltet (stop_reason=stale_power). Falls falsch erkannt: neue Session manuell starten.

[ASCII bar]
```

**HIGH confidence.** Extend the existing path; do not create a new notification channel.

### FPD-02: Adaptive Matcher Refresh

**Q1 — Mathematical monotonic-narrowing guarantee?**

No strict guarantee. Subsequence DTW's accumulated cost matrix grows monotonically in query length per cell, but the BAND derived from `cutoff = best × (1 + thresholdPct)` is a RATIO comparison — the best score can shift as query grows and re-anchor the cutoff. CONTEXT.md's own table (4/10/20/40/70 min queries) shows band-widths going 27 → 0 → 29 → 5 → 10 — empirically non-monotonic.

**Therefore the clamp at `charge-monitor.ts:715-731` is a SOFT enforcement, intentionally chosen by Phase 11 to dampen matcher noise.** The clamp is the right design choice (widening on noise erases legitimate confidence). The planner must preserve it in FPD-02. **MEDIUM confidence on theory, HIGH confidence on "we already do the right thing and it works".**

**Q2 — Performance: findBestCandidate on iPad-sized curve at 5-min cadence?**

Per `curve-matcher.ts:6-12`: "DTW on 60–120 query samples × ~1.6k reference points is <1 ms per profile". iPad reference is 5782 points and Phase 12's query window will grow to ~720 readings (60min/5s). Conservatively: 720 × 5782 = 4.16M DTW cells, ~4-10 ms per profile per call. With ~3 profiles registered → 12-30 ms per re-run. **Per re-run cost is fine; we do it once per 60 readings = once per 5 min.** Synchronous in the polling-handler critical path is acceptable. No Worker offloading needed for v1. **HIGH confidence.**

**Q3 — Query buffer: in-memory ring vs DB query?**

In-memory ring buffer. Reasons:
- DB query on `power_readings` table grows with session length (~17k rows for 24h) — unbounded read cost.
- Existing pattern: `detectionBuffers` Map (`charge-monitor.ts:65`) already does this for the detection phase. Just extend with `chargingBuffers: Map<string, number[]>` cleared on `cleanupSession`.
- Restart-survival: not needed for FPD-02. After a restart, FPD-02 simply starts fresh (no buffer) and re-builds it on incoming readings. The OLD band is restored from DB; the buffer accumulates from there and re-refresh fires after `matcherRefreshReadings` new readings arrive. **Acceptable degradation.**

**HIGH confidence.**

**Q4 — Convergence: at what fraction of reference curve does iPad socBest stabilize?**

From CONTEXT.md table (iPad Session 14, 70 min real-data):
- 5 min: socBest=4, band=27 (wide, flat-region noise anchor)
- 10 min: socBest=31, band=0 (collapsed onto wrong offset — false confidence)
- 20 min: socBest=14, band=29 (re-widened, more honest)
- 40 min: socBest=34, band=5 (narrow but still anchored to wrong flat region)
- 70 min: socBest=31, band=10 (mild widening at session end)

**Conclusion: socBest oscillates 4-37 % across windows and never reflects real-SOC progress (0→65%) in pure flat-region data. The matcher CANNOT converge correctly on this data — that's the fundamental DTW-flat-power ambiguity Phase 12 is mitigating, NOT solving.** FPD-02's value is: when the iPad eventually hits taper (around 70-90% real SOC), the longer query window will localize correctly. For the first 70% of the iPad charge, FPD-02 does NOT help — that's why FPD-01 (stale-power) and FPD-03 (low-confidence fallback) are needed alongside.

**Implication:** the FPD-02 success criterion in CONTEXT DoD ("band narrowing monotonically + socBest crossing past the early-flat anchor when ≥40 min of readings are fed in") is achievable ONLY against the synthetic-iPad fixture (which has clean taper) — NOT against real iPad Session 14 data. The planner must split the test in two: synthetic-iPad asserts narrowing; real-Session-14 asserts the band stays honestly wide (doesn't falsely converge to a wrong narrow value). **HIGH confidence — directly from the numbers in CONTEXT.md.**

### FPD-03: Band-Confidence-Aware Stop Fallback

**Q1 — Legacy v1.2 energy-based stop formula — revive literally or normalize?**

Git history (commit `4d780ef`, `feat(03-01)`) is the first appearance of `charge-state-machine.ts` and it never had a `shouldStop(...)`-style helper. The stop logic was inline: `if (estimatedSoc >= targetSoc) → transition('countdown')`. `estimatedSoc` was computed by `updateSocTracking → estimateSoc(socWh, totalWh, startSoc)`.

**So the "v1.2 energy-based stop" formula in CONTEXT.md (`cumulativeEnergyWh >= (targetSoc - estimatedStartSoc)/100 * totalEnergyWh`) is the SEMANTIC INVERSE of what `estimateSoc` computes:**

```ts
// estimateSoc when startSoc > 0 (soc-estimator.ts:73-77):
remainingCapacityWh = totalWh * (1 - startSoc / 100)
soc = startSoc + (currentWh / remainingCapacityWh) * (100 - startSoc)
```

Solving `soc >= targetSoc` for `currentWh`:
```
currentWh >= (targetSoc - startSoc) / (100 - startSoc) * (totalWh * (1 - startSoc / 100))
            = (targetSoc - startSoc) / 100 * totalWh
```

Which is EXACTLY the CONTEXT formula. **So the "fallback" is mathematically identical to the legacy `estimatedSoc >= targetSoc` check.** This simplifies the implementation enormously:

```ts
// In ChargeMonitor.updateSocTracking, after the band update:
const bandConf = this.sessionBandConfidence.get(plugId) ?? 1;
const machine = this.machines.get(plugId)!;
if (bandConf < this.lowConfidenceThreshold && machine.estimatedSoc >= machine.targetSoc) {
  // Energy-fallback predicate — sidestep band-mode shouldStop entirely.
  machine.transition('countdown', { reason: 'energy_fallback' });
}
```

The fallback is "use the legacy soc-based check, which is mathematically the v1.2 energy formula". **HIGH confidence — verified by reading soc-estimator.ts:64-81 alongside CONTEXT formula.**

**Q2 — Threshold semantics: bandConfidence < 0.5 = width > 50%?**

Correct. `deriveBand` (`curve-matcher.ts:127-130`):
```ts
const bandConfidence = Math.max(0, 1 - (socMax - socMin) / 100);
```

So `0.5 ↔ width = 50` (band spans 50 percentage points). Half the SOC range is "plausible" — that's genuinely low confidence. The 0.5 threshold is reasonable. Tying it to an absolute SOC-width (like 20pp) is equivalent: `bandConfidence < 0.8` ↔ width > 20pp. Either expression works; **using bandConfidence keeps the threshold in the same units as the existing field**, so prefer `lowConfidenceThreshold = 0.5` (default) with the DB key `charging.lowConfidenceThreshold`. **HIGH confidence.**

**Q3 — UX: surface the fallback?**

Yes. The `ChargeStateEvent.stopMode` field doesn't exist today; charge-banner.tsx surfaces `state` but not stop-mode. Phase 12 should:
1. Add `stopMode?: 'aggressive' | 'conservative' | 'energy_fallback'` to `ChargeStateEvent`.
2. Persist `stopMode` to `chargeSessions` as a text col OR derive it on-the-fly from `stop_reason`. **Recommendation: store in `stop_reason` text** — values become `target_soc_reached_band` (current) and `target_soc_reached_energy_fallback`. Avoids a new col.
3. Pushover `complete` message mentions degraded mode: append "(Band-Schätzung unsicher — Energie-Fallback verwendet)" when stopMode is energy_fallback.

**MEDIUM confidence on UX wording, HIGH on mechanism.**

### FPD-04: Session Max Duration

**Q1 — Default 24h — false-positive risk for which battery types?**

E-bike PowerTube 625Wh full charge: ~6h at ~100W. iPad: ~2.5h at ~25-40W. Bosch GBA 10.8V: ~1h. Sanorum V17MAX (LiFePO4 small portable): ~3h. **24h is 4× the slowest legitimate charge.** Risk cases:
- Very slow trickle/repair mode chargers (some lead-acid chargers do 48h equalize cycles) — but these aren't supported devices in charging-master (we're a Li-ion / portable battery app, no lead-acid).
- Pause-then-resume — if user pauses charging mid-session via plug toggle, session stays "charging" with apower=0 → FPD-01 fires at 5 min, FPD-04 never reached.

**24h is safe. No legitimate use case in the supported device set exceeds 24h. HIGH confidence.**

**Q2 — Counter source: wall-clock or reading-count?**

Wall-clock. Rationale: this is the last-resort defense. A session that's 24h old by wall-clock has been around long enough that we want it killed regardless of whether readings have been arriving. FPD-01 already covers "lots of zero readings"; FPD-02 covers "matcher confidence isn't growing". FPD-04 catches the residual case: "system has been spinning on this session for a day, kill it." See Pitfall 10 — FPD-01 and FPD-04 use DIFFERENT counters intentionally.

Pattern is `charge-state-machine.ts:239-242` (`LEARN_HARD_STOP_MS`). Use `sessionStartedAt` already in the per-plug Map (`charge-monitor.ts:70`). **HIGH confidence.**

### FPD-05: UI Watchdog Indicators

**Q1 — CSS-animated countdown ring/bar matching Phase 11 design?**

Easiest pure-CSS pattern in the existing design language:
```tsx
<div className="relative h-1.5 bg-neutral-800 rounded-full overflow-hidden">
  <div
    className="h-full bg-amber-400 transition-[width] duration-500"
    style={{ width: `${(stalePowerSeconds / stalePowerWindowSec) * 100}%` }}
  />
</div>
```
Matches the existing detection-progress bar at `charge-banner.tsx:290-296` exactly (just amber instead of blue). **HIGH confidence.**

For a "ring", use the existing detecting-spinner svg pattern (`charge-banner.tsx:274-283`) with `strokeDasharray` tied to seconds — more code, same visual impact. **Recommendation: linear bar, not ring.**

**Q2 — Acknowledge button persistence?**

localStorage keyed by sessionId. Pattern:
```tsx
const ackKey = `watchdog-ack-${sessionId}`;
const [acked, setAcked] = useState(() => {
  if (typeof window === 'undefined') return false;
  return localStorage.getItem(ackKey) === '1';
});
const handleAck = () => {
  localStorage.setItem(ackKey, '1');
  setAcked(true);
};
```
- Survives reload (good)
- Auto-resets per new session (next session gets a new sessionId, key not in storage)
- No server round-trip (matches CONTEXT.md design-decision-7)

**HIGH confidence.**

**Q3 — RTL fake-timer gotchas with React + time-driven UI?**

Patterns in Phase 11 tests use `act()` wrapping for callback emits (`soc-band-indicator.test.tsx:18-27`). For time-driven UI:

```tsx
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'Date'] });
});
afterEach(() => {
  vi.useRealTimers();
});

it('shows seconds-counting-up warning', () => {
  render(<ChargeBanner ... />);
  emit({ state: 'charging', stalePowerSeconds: 60 });
  expect(screen.getByText(/60s/)).toBeInTheDocument();

  act(() => { vi.advanceTimersByTime(60000); });
  emit({ state: 'charging', stalePowerSeconds: 120 });
  expect(screen.getByText(/120s/)).toBeInTheDocument();
});
```

**Gotchas:**
- Default `vi.useFakeTimers()` fakes `setImmediate` and `queueMicrotask`, breaking RTL's `await waitFor()` and Promise-based assertions. Explicitly pass `toFake` to limit scope.
- `act()` is required around every timer-advance that triggers a setState. RTL emits a "not wrapped in act" warning otherwise.
- The watchdog seconds counter likely comes from the SSE event (server-emitted `stalePowerSeconds`), NOT a client-side `setInterval`. So the test drives the counter by re-firing `emit()` with incremented values — same pattern as Phase 11. **Fake-timers are needed only if the component animates between emits via local setInterval; the simpler design is "server pushes new value every poll cycle".** Recommended: no client-side setInterval, just emit-driven re-renders.

**HIGH confidence.**

### Cross-cutting concerns

**Persistence question — should watchdog state survive restart?**

`stalePowerSeconds` — NO. Reasons: (a) brief degradation acceptable, (b) avoids schema migration, (c) restart is rare. Document the post-restart 5-min re-arm.

`readingsSinceLastMatch` — NO. Same reasons; matcher just runs one cycle later than otherwise.

`sessionStartedAt` (for FPD-04) — ALREADY PERSISTED on `chargeSessions.startedAt`. Resume restores it via `sessionStartedAt.set(plugId, session.startedAt)` (`charge-monitor.ts:1245`). FPD-04 reads from this and computes wall-clock delta. Restart-survival is FREE here. **HIGH confidence.**

**Config row naming convention — `charging.X`**

Existing keys (verified): `charging.stopMode`, `charging.bandThreshold` (`stop-mode.ts:67, 89`; `charging-settings.tsx:46, 59`).

**Phase 12 new keys (recommended):**
- `charging.stalePowerThresholdW` (default `1.0`, real)
- `charging.stalePowerWindowSec` (default `300`, integer seconds)
- `charging.matcherRefreshReadings` (default `60`, integer)
- `charging.lowConfidenceThreshold` (default `0.5`, real in [0,1])
- `charging.maxSessionHours` (default `24`, integer)

All use the existing `useAutoSave` hook in `charging-settings.tsx`. **HIGH confidence — pattern matches verbatim.**

**Backwards compat for existing aborted sessions?**

No data migration needed. Existing rows have `state ∈ {complete, aborted, error}` and are terminal. Phase 12 only adds new `stop_reason` values (`stale_power`, `timeout`, `target_soc_reached_energy_fallback`) — these don't conflict with existing values. The history page reads `stop_reason` as a free-text label; new values just appear as new labels. **HIGH confidence.**

## Open questions for the planner

1. **ChargeStateEvent watchdog payload shape** — flat fields or nested object?
   - Flat (`stalePowerSeconds: number`, `watchdogKind: 'none'|'warning'|'fired'`, `watchdogWillFireAt: number`): simpler SSE wire format, matches existing `socMin`/`socMax` style.
   - Nested (`watchdog: { kind, secondsAtZero, willFireAt }`): cleaner type but adds an optional sub-object that consumers must guard.
   - **Recommendation:** flat. Matches established pattern.

2. **FPD-03 implementation site: extend shouldStop signature or add separate predicate?**
   - Option A: `shouldStop({ ..., bandConfidence, lowConfidenceThreshold, estimatedSoc })` returns `{ stop, mode, reason }`.
   - Option B: keep `shouldStop` band-only; add a `shouldStopEnergyFallback({ bandConfidence, threshold, estimatedSoc, targetSoc })` called from `ChargeMonitor.updateSocTracking` BEFORE the state-machine evaluates band mode.
   - **Recommendation: Option B.** Keeps `stop-mode.ts` pure (no DB lookup for estimatedSoc), and the energy path already lives in ChargeMonitor.

3. **Watchdog warning trigger threshold (CONTEXT.md says 60s)** — is 60s right or should it be configurable too?
   - Current spec: hardcoded 60s for warning, configurable 300s for fire.
   - Argument for: keeps config surface small.
   - Argument against: a user who sets `stalePowerWindowSec=120` will get the warning when there's only 60s left to fire — counter-intuitive.
   - **Recommendation:** make warning a percentage of fire-window. E.g., warning fires at 20% (so for default 300s window, warning at 60s; for 120s window, warning at 24s). Adds zero config rows. Document in code comment.

4. **FPD-01 fires from `handleCharging` OR `handleCountdown`** — both states need the watchdog. Do we duplicate the counter-increment logic in both handlers, or factor a private helper `checkStalePower()` called from each?
   - **Recommendation:** private helper. Matches the existing factoring style in `charge-state-machine.ts`.

5. **FPD-02 in-memory buffer eviction strategy** — when does the chargingBuffer grow unbounded?
   - 24h session × 5s polling = 17,280 readings × ~8 bytes = 138 KB per active session. Negligible.
   - **Recommendation:** no eviction. Buffer cleared on `cleanupSession`. If 5+ active plugs each run 24h sessions, total ~700 KB. Fine.

6. **Manual smoke test plan** — CONTEXT.md DoD bullet 6 says "induce 0W stale-power state via POST relay off mid-session". The plug-side relay-off will be observed by the polling service AS apower=0 readings — so this DOES exercise FPD-01. But the user's manual test should also include a "session-from-pre-update" check: deploy Phase 12, then verify an ALREADY-RUNNING session (started before deploy) starts emitting watchdog fields after restart. This validates the resume path.

7. **History page surfacing of new stop_reasons** — `stop_reason='stale_power'` and `stop_reason='timeout'` are new. The history UI today shows raw stop_reason text. Should the planner add a stop_reason → human-label mapping in one place? Look for an existing mapping in history-related components; if none exists, leave the text as-is and surface a translation layer in a later quick-task.

## References

- **Phase 11 RESEARCH.md** — `.planning/phases/11-soc-confidence-band-ascii-visualization/11-RESEARCH.md` (Phase 11 monotonic-narrowing rationale, the foundation FPD-02 extends).
- **Phase 11 Plan 11-02 SUMMARY** — `.planning/phases/11-soc-confidence-band-ascii-visualization/11-02-SUMMARY.md` (stop-mode + band wiring + B2 integration test).
- **CONTEXT.md** — `.planning/phases/12-flat-power-defense/CONTEXT.md` (problem statement, locked design decisions).
- **REQUIREMENTS.md** — `.planning/REQUIREMENTS.md:202-216` (FPD-01..05 acceptance criteria).
- **STATE.md** — `.planning/STATE.md` (current v1.3.1 deployment, baseline test count 171).

### Project file:line refs

- Counter-watchdog pattern (sustainedCount): `src/modules/charging/charge-state-machine.ts:168-178`
- Counter-watchdog pattern (idleCount on learning): `src/modules/charging/charge-state-machine.ts:244-252`
- LEARN_HARD_STOP_MS wall-clock pattern: `src/modules/charging/charge-state-machine.ts:239-242`
- shouldStop ordering trap: `src/modules/charging/stop-mode.ts:41-55`
- Monotonic band clamp: `src/modules/charging/charge-monitor.ts:715-731`
- estimateSoc (partial-charge formula = v1.2 energy stop equivalent): `src/modules/charging/soc-estimator.ts:64-81`
- updateSocTracking remainingWh computation (FPD-03 fallback math): `src/modules/charging/charge-monitor.ts:905-913`
- fireAnomalyNotification + monospace Pushover: `src/modules/charging/charge-monitor.ts:504-551`
- captureEventContext pattern (snapshot before await): `src/modules/charging/charge-monitor.ts:1012-1066`
- Resume after restart band reads: `src/modules/charging/charge-monitor.ts:1192-1234`
- useAutoSave settings hook: `src/components/settings/charging-settings.tsx:13-37`
- Detection progress bar (CSS pattern for FPD-05): `src/components/charging/charge-banner.tsx:290-305`
- RTL `act()` + SSE callback test pattern: `src/components/charging/soc-band-indicator.test.tsx:9-27`
- B2 integration test pattern: `src/modules/charging/charge-monitor.test.ts:649-720`
- ChargeStateEvent type: `src/modules/charging/types.ts:54-96`
- chargeSessions schema (stopReason text, no new col needed): `src/db/schema.ts:176-201`

### Git commit refs

- `e246f5e` feat(11-02): stop-mode module + band-aware state machine (SOCB-03) — FIRST appearance of shouldStop helper.
- `a724230` feat(11-02): DB persistence + resume + override band + <30s integration test — established the resume + B2 patterns.
- `7530d9a` feat(11-02): drizzle migration 0009 — band columns; no new migration needed for Phase 12.
- `2640873` fix(charging): snapshot event context before handleStopping await — the bug class Phase 12's watchdog snapshot must also avoid (extend captureEventContext with watchdog fields BEFORE any await).
- `d4242b3` v1.3.1 quick-260515-2e4 — DEFAULT_BAND_THRESHOLD_PCT 0.20 calibration that motivated this phase.

### External (LOW confidence)

- [Subsequence DTW (Audiolabs Erlangen FMP C7S2)](https://www.audiolabs-erlangen.de/resources/MIR/FMP/C7/C7S2_SubsequenceDTW.html) — the matching function ΔDTW(m) referenced by curve-matcher.ts.
- [Dynamic Time Warping (Wikipedia)](https://en.wikipedia.org/wiki/Dynamic_time_warping) — general DTW background.
- [OpenEVSE Home Assistant integration](https://www.home-assistant.io/integrations/openevse/) — checked for stale-power prior art (none found — they have vehicle API).
- [EVCC project](https://evcc.io/en/) — same conclusion.

**Pre-submission self-check:**
- [x] All FPD-01..05 + cross-cutting questions answered.
- [x] Negative claim "no exact prior art found" verified by 2 web searches; flagged LOW confidence.
- [x] file:line refs cite committed code, not speculation.
- [x] The v1.2 "energy-based formula" claim is grounded in git log + estimateSoc math, not training memory.
- [x] No new schema migration required (verified: existing `stop_reason` text + no new chargeSessions col).
- [x] Tech-stack constraints (Vitest 3.2.4 + RTL 16.3 + jsdom 26.1, all per CLAUDE.md) respected.
