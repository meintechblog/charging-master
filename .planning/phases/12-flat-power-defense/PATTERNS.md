# Phase 12 Patterns Analysis

**Mapped:** 2026-05-15
**Scope:** FPD-01..05 (Flat-Power Defense)
**Codebase head:** Phase 11 deployed (d4242b3) — band fields are required, ASCII bar wired through SSE + Pushover, stop-mode resolver cached.

The good news: ~80% of FPD-01..05 reuses load-bearing infrastructure that Phase 11 just landed. The watchdog counter mirrors `sustainedCount`; the matcher refresh re-uses `findBestCandidate`; the new config rows reuse `readStopMode/readBandThreshold`; the ASCII bar attachment in Pushover is already a working call site we copy. The only genuinely new construct is **FPD-05's CSS-animated watchdog warning indicator** — and even that mirrors `SocBandIndicator`'s `--soc-*` variable pattern.

## File-by-file analog map

| New / modified file | Role | Data flow | Closest existing analog | Match quality | Why this fits |
|---------------------|------|-----------|-------------------------|---------------|---------------|
| `src/modules/charging/charge-state-machine.ts` (modify) | domain — state machine | event-driven | self (in-place extension) | exact | Adds `stalePowerSeconds` counter analogous to existing `sustainedCount` (line 53); add `stale_power` and `timeout` transition paths analogous to existing `'stopping'`/`'learn_complete'` exits (lines 195-223, 244-249). Same `transition()` helper, same `feedReading` switch, same `reset()` cleanup. |
| `src/modules/charging/charge-monitor.ts` (modify) | domain — orchestrator | event-driven + DB-IO | self (extends existing `updateSocTracking`, `handleTransition`, `fireAnomalyNotification`) | exact | New `readingsSinceLastMatch` counter mirrors `anomalyDeviationCount` (line 102). New `'stale_power'` and `'timeout'` cases in `handleTransition` mirror the existing `'learn_complete'` block (lines 633-657) which also calls `switchRelayOff` + emit charge event without going through `handleStopping`. The new adaptive-refresh re-runs `findBestCandidate` (line 672) the same way `tryMatch` already does — same monotonic-narrowing block at lines 715-733 is the template. |
| `src/modules/charging/stop-mode.ts` (modify) | domain — pure policy | request-response | self (extends `shouldStop`) | exact | `readBandThreshold()` (line 79) already shows the read-config-with-30s-cache pattern for a numeric value; the new `readLowConfidenceThreshold()` is a copy. `shouldStop`'s extended return shape mirrors the literal-union pattern from `StopMode` (line 29). |
| `src/modules/charging/types.ts` (modify) | domain — type defs | (none) | self (extends `ChargeStateEvent`) | exact | Same pattern as Phase 11's band-field additions (lines 92-95): optional fields, comment explaining provenance, no breaking change to existing producers. |
| `src/modules/notifications/notification-service.ts` (modify) | domain — pushover dispatch | event-driven | `fireAnomalyNotification` in `charge-monitor.ts` lines 504-551 | exact | The cleanest analog for the new `stale_power` Pushover message is the existing in-monitor anomaly notification, NOT a `buildMessage` switch case. Both fire as "anomaly" priority=1 with the ASCII band attached and `monospace=1`. Re-using `fireAnomalyNotification` keeps the Phase 11-03 wiring intact; only the message template changes. |
| `src/app/api/sse/power/route.ts` (modify) | API — SSE handler | streaming | self (the existing on-connect snapshot at lines 55-77) | exact | New `watchdog` payload fields piggyback on the existing `ChargeStateEvent` plumbing. No new SSE endpoint needed — the per-event JSON shape just grows. The on-connect replay branch (lines 30-77) does NOT need to hydrate watchdog state because the watchdog counter is ephemeral by design (resets on the next reading). |
| `src/components/charging/charge-banner.tsx` (modify) OR `src/components/charging/watchdog-banner.tsx` (new) | component — live status | streaming | `SocBandIndicator` (`src/components/charging/soc-band-indicator.tsx` lines 78-109) | exact | The yellow countdown indicator uses the same CSS-variable-driven pattern: render a container with `style={{ '--watchdog-fraction': X }}` and a `<div>` that interpolates width via `style={{ width: 'calc(var(...) * 100%)' }}`. Reuse the `useChargeStream` subscription pattern from line 35. |
| `src/components/settings/charging-settings.tsx` (modify) | component — form | request-response | self (lines 112-148, the existing Advanced section) | exact | Five new advanced inputs replicate the `useAutoSave('charging.bandThreshold', ...)` pattern (line 58-62). Same `inputClasses`/`labelClasses` constants, same number-input layout, same `valuesParse`-then-`useAutoSave` flow as the threshold input. |
| `src/modules/charging/charge-state-machine.test.ts` (modify) | test | unit | self (existing band-aware tests, lines 309-368) | exact | New stalePower transitions mirror the existing aggressive/conservative transition tests — same `feedReadings` helper, same `expect(machine.state).toBe(...)` assertions. |
| `src/modules/charging/charge-monitor.test.ts` (modify) | test | integration + unit | "B2 integration" test in same file lines 649-727 | exact | The FPD-01 5-min @ 0W integration test is structurally identical: `injectActiveSession`, drive 60 readings via `handlePowerReading`, assert `switchRelayOffMock.mock.calls.length > 0` and `state==='aborted'` with `stopReason==='stale_power'`. **NOTE: B2 does NOT use `vi.useFakeTimers()` — it advances `t` manually inside the loop.** That same approach is correct here. |
| `src/modules/charging/stop-mode.test.ts` (modify) | test | unit | self (existing aggressive/conservative tests, lines 54-100) | exact | New low-confidence-fallback cases mirror the existing `shouldStop` tests. New `readLowConfidenceThreshold` cache tests mirror `readBandThreshold` tests at lines 138-161. |
| `src/components/charging/charge-banner.test.tsx` or `watchdog-banner.test.tsx` (new) | test | component | `soc-band-indicator.test.tsx` (lines 1-91) | exact | Same `useChargeStream` mock pattern (lines 8-14), same `emit()` helper (lines 18-26), same `getByTestId` + style-getPropertyValue assertions for the CSS variables. |

**No analogs found:** none. Every new construct has a direct in-tree analog that landed during Phases 10–11.

## Critical patterns to follow

### Pattern 1 — Counter mirroring `sustainedCount` (FPD-01)

`charge-state-machine.ts:53` declares `private sustainedCount = 0;` and `handleIdle` (lines 167-178) increments on every reading above `CHARGE_THRESHOLD`, transitions on `>= SUSTAINED_READINGS`, and resets to 0 on the first under-threshold reading. Then `reset()` zeroes it (line 291).

**For FPD-01:**
- Declare `private stalePowerSeconds = 0;` (or `stalePowerCount` if reading-based, which is the locked design from CONTEXT.md decision 1).
- Increment in `handleCharging`/`handleCountdown` when `apower < STALE_POWER_THRESHOLD_W`, reset to 0 when `apower >= threshold`.
- When count crosses the configured threshold (default 60 readings @ 5s = 5 min), call `this.transition('aborted')` — but the abort path needs to convey `stop_reason='stale_power'`, which is **NOT** how the state machine currently signals reasons. See Open Question 1.
- Add the counter to `reset()` at line 290.

### Pattern 2 — Non-`handleStopping` exit path (FPD-01 + FPD-04)

The state machine has two distinct "exit" patterns:
1. **`'stopping'` → `handleStopping`** (`charge-monitor.ts` lines 935-1001): the target-soc-reached path. Uses `captureEventContext` snapshot, awaits `switchRelayOff`, writes `stopReason: 'target_soc_reached'`.
2. **`'learn_complete'`** (`charge-monitor.ts` lines 633-657) and **`'aborted'`** (via `abortSession` line 294-309): direct DB-write + relay-off + emit, NO `captureEventContext` snapshot.

FPD-01 and FPD-04 should follow pattern 2 (direct write + relay-off), NOT pattern 1. Reasons:
- The watchdog never needs the elaborate "completion summary" Pushover message that `handleStopping` produces.
- Going through `handleStopping` would race with the existing target-soc-reached path if the watchdog fires while the band is also crossing target.
- The `'learn_complete'` block at line 633-657 is the exact template: DB-set state + stoppedAt + stopReason, then `switchRelayOff` with `lastRelayOff` hysteresis check, then `emitChargeEvent`.

**Pitfall:** the `'learn_complete'` block does NOT `cleanupSession` — it relies on the next reading hitting the recycle gate in `feedReading` (`charge-state-machine.ts` lines 76-85). FPD-01's `'aborted'` exit needs `cleanupSession` because no further reading is expected (relay is off → polling continues but apower=0 won't trigger anything). Mirror `abortSession`'s line 307 explicit `cleanupSession(plugId)`.

### Pattern 3 — Adaptive matcher refresh (FPD-02)

`tryMatch` at `charge-monitor.ts` lines 668-763 is the template. The new "refresh in charging" path needs:
- A query buffer of apower readings from session start. **No existing in-memory cache exists** for this. `tryMatch` reads `buffer` from `this.detectionBuffers` (a Map written only during `state=detecting`), and the buffer is `delete`d at `cleanupSession` (line 1141). For FPD-02 we either (a) keep `detectionBuffers` populated past `detecting`, or (b) introduce a new `chargingBuffers` Map. **Recommendation: option (b)** — separate Maps for separate phases, avoid coupling the matcher's commit threshold to the live re-evaluator's logic.
- A reading counter analogous to `anomalyDeviationCount` (line 102) — `private readingsSinceLastMatch = new Map<string, number>()` — incremented inside `updateSocTracking` and reset to 0 when the matcher re-runs.
- The monotonic-narrowing block at lines 715-733 is reusable verbatim. `Math.max(priorSocMin, candidateSocMin)` and `Math.min(priorSocMax, candidateSocMax)` — and **DO NOT** widen.

**Pitfall:** when the new MatchResult violates monotonic narrowing (i.e., `candidateSocMin < priorSocMin` OR `candidateSocMax > priorSocMax`), keep the cached band, do NOT update the in-memory Maps or DB. This is the "noise rejection" rule from CONTEXT decision 3.

### Pattern 4 — Config row consumption (FPD-01..04 thresholds)

`stop-mode.ts` lines 79-105 (`readBandThreshold`) is the template. Key properties:
- Module-scope cached value + cached-at timestamp.
- 30-second TTL.
- Synchronous DB read inside a `try/catch` — never throws (DB-unreachable falls back to default).
- Parsed once, validated, then cached.
- Test helper `__resetBandThresholdCacheForTests()` for unit-test isolation.

**For FPD:** five new helpers (one per config key) in `stop-mode.ts` OR a new `watchdog-config.ts`. Recommend keeping them in `stop-mode.ts` since they all read `charging.*` keys and the file is already the "charging policy reader." Each helper exports a `__reset*ForTests` companion.

Settings UI keys to add:
- `charging.stalePowerThresholdW` (number, default 1.0)
- `charging.stalePowerWindowSec` (integer, default 300)
- `charging.matcherRefreshReadings` (integer, default 60)
- `charging.lowConfidenceThreshold` (number 0..1, default 0.5)
- `charging.maxSessionHours` (integer, default 24)

### Pattern 5 — ASCII bar attachment for anomaly Pushover (FPD-01)

`charge-monitor.ts:fireAnomalyNotification` lines 504-551 is the exact call site. Key elements to copy:
- Read pushover creds from `config` rows (lines 505-507), bail early if missing.
- Pull `socMin`, `socMax` from per-plug Maps, machine for `socBest`/`targetSoc`.
- Render bar with `renderSocBandAscii({ ..., mode: 'pushover' })` — the `'pushover'` mode uses ASCII glyphs (`#=.`), NOT Unicode (`▓▒░`), because lock-screen rendering mangles Unicode (line 517 comment is load-bearing).
- Set `body.monospace = '1'` ONLY when the bar is appended (lines 524, 544).
- Bare `fetch(...)` POST to `https://api.pushover.net/1/messages.json` with `URLSearchParams`.

**For FPD-01:** introduce a private method `fireStalePowerNotification(plugId, profileName, secondsAtZero)` that copies this pattern verbatim, only changing the title (`'Watchdog: Akku voll?'`) and the message body (`'Plug seit X min auf 0 W — Session abgebrochen.'`). The notification fires synchronously from inside the new `'aborted'`/`'stale_power'` transition handler, similar to how `checkAnomaly` fires synchronously from `handlePowerReading` line 443.

### Pattern 6 — SSE event payload extension (FPD-05)

`types.ts:ChargeStateEvent` lines 54-96 already grew through Phase 11 with band fields. Same pattern works for the watchdog payload. Either:
- **Inline fields** (simpler): `watchdogState?: 'none' | 'warning' | 'fired'; stalePowerSeconds?: number; stalePowerFiresAt?: number`. Mirrors the `socMin?/socMax?/socBandConfidence?` flat shape (lines 92-95).
- **Nested object** (matches CONTEXT.md proposal): `watchdog?: { kind, secondsAtZero, willFireAt }`. Cleaner if the watchdog grows fields later.

CONTEXT.md proposes the nested shape. Either works; the inline shape mirrors the existing band convention more closely. Recommendation: nested, because it isolates the watchdog from the band fields and the SSE on-connect snapshot at `/api/sse/power/route.ts` lines 55-77 doesn't need to populate it (watchdog state is ephemeral — first live reading post-reconnect will refresh it).

**Producer:** `emitChargeEvent` lines 1068-1125. Pass through from `captureEventContext` (lines 1012-1066) — which means `captureEventContext` needs the watchdog fields too. The existing snapshot pattern (lines 1030-1064) is the template: read the per-plug Map values, derive a render-time value, return on the context object.

### Pattern 7 — CSS-animated banner (FPD-05)

`soc-band-indicator.tsx` lines 78-109 is the exact template:
- `type CSSVarStyle = CSSProperties & Record<\`--${string}\`, string>` (line 22) — required because React's CSS typings reject unknown vars.
- Container `style={{ '--soc-min': '${band.min}%', ... }}` (lines 78-83).
- Inner `<div>` uses `style={{ left: 'var(--soc-min)', width: 'calc(var(--soc-max) - var(--soc-min))' }}` (lines 95-98).
- Class `transition-all duration-700 ease-out` for the smooth narrowing animation (line 94).
- `useChargeStream(plugId, callback)` subscribes to live events (line 35).

**For watchdog warning indicator:**
- CSS variable `--watchdog-fraction` mapped from `secondsAtZero / stalePowerWindowSec`.
- Yellow `<div>` with `style={{ width: 'calc(var(--watchdog-fraction) * 100%)' }}`.
- `transition-all duration-1000 ease-linear` for the countdown sweep (linear, not ease-out — it's a timer, not a band collapse).
- Wrapper that conditionally renders based on `watchdog?.kind === 'warning'` and switches to a red fixed-banner with the "Acknowledge" button on `'fired'`.

### Pattern 8 — Settings advanced inputs (FPD config exposure)

`charging-settings.tsx` (entire file) is the template. The Advanced section at lines 121-148 shows the exact layout: number input with `useAutoSave`, validation gate (lines 54-57 pattern: parse → check bounds → use validated string for the save), save-status indicator (lines 141-146). Repeat five times.

**Pitfall (already documented in the existing file at line 11-12):** the duplicated `useAutoSave` hook is a known backlog item. Phase 12 does NOT need to fix it — keep duplicating the pattern. Folding into a shared hook is a separate refactor.

### Pattern 9 — Vitest integration test driving a session through the monitor (FPD-01, FPD-04)

`charge-monitor.test.ts` lines 649-727 (the B2 test) is the closest analog and it is **NOT** using `vi.useFakeTimers()`. It instead:
- Manually increments a `let t = 1_000_000` variable.
- Drives `handlePowerReading` in a `while (t - collapseTime < budgetMs)` loop.
- Each iteration calls `handlePowerReading(makePowerReading('plug-1', 40, ..., t))`.
- Asserts `switchRelayOffMock.mock.calls.length > 0` after the loop.
- Re-pins the band state on every loop iteration (lines 716-721) — explicit production-mismatch acknowledged in the comments.

**For FPD-01 5-min @ 0W:**
- Use `injectActiveSession` to seed a `state='charging'` session.
- Loop 60 readings (or whatever the configured threshold * sampling-interval implies).
- Each reading: `handlePowerReading(makePowerReading('plug-1', 0.0, totalEnergy, t))` — apower=0, timestamp advanced by 5000.
- Assert `switchRelayOffMock.mock.calls.length === 1` AND last DB write set `stopReason: 'stale_power'`.

**For FPD-04 24h timeout:**
- `vi.useFakeTimers()` IS appropriate here because the watchdog compares `Date.now() - startedAt`. Use `vi.setSystemTime(...)` to jump 23:59:59 (no fire) then 24:00:01 (fires).

The B2 test deliberately avoids `vi.useFakeTimers()` because the production stop fires on a reading, not on a timer. Use the right tool: timestamp-driven loop for FPD-01 (reading-based), fake timers for FPD-04 (wall-clock-based).

### Pattern 10 — Resume after restart (FPD ephemeral state)

`charge-monitor.ts:resumeActiveSessions` lines 1161-1272 hydrates band fields from DB rows (lines 1199-1234) and accepts NULL legacy rows with degraded zero-width fallback (lines 1208-1213). For Phase 12:
- `stalePowerSeconds` (or count) — **DO NOT persist**. Reset to 0 on resume. Restart counts as "fresh reading" — even if the watchdog was about to fire, the next polling cycle re-evaluates within seconds.
- `readingsSinceLastMatch` (FPD-02) — **DO NOT persist**. Reset to 0 on resume. A restart causes one extra matcher run after `matcherRefreshReadings` more readings — acceptable.
- The active query buffer for FPD-02 — **DO NOT persist** in v1.4. Rebuild from `session_readings` table on resume if needed (Open Question 4).

**No DB schema changes required for Phase 12.** This matches CONTEXT.md "Affected modules: src/db/schema.ts — no new columns required."

### Pattern 11 — `stop_reason` text values

Existing `stop_reason` values seen in code (from grep above):
- `'user_abort'` (`charge-monitor.ts:301`)
- `'learn_complete'` (`charge-monitor.ts:639`)
- `'target_soc_reached'` (`charge-monitor.ts:976`)
- `'relay_switch_failed'` (`charge-monitor.ts:996`)
- `'stale_on_restart'` (`charge-monitor.ts:1174`)
- `'manual'` (`api/charging/sessions/[id]/abort/route.ts:44`, `api/charging/learn/stop/route.ts:83`)

The schema has `stopReason: text('stop_reason')` (line 187) — free-text, no enum. Phase 12 adds:
- `'stale_power'` (FPD-01)
- `'timeout'` (FPD-04)
- `'low_confidence_energy_fallback'` (FPD-03, only if the fallback STOP fires — otherwise the existing `'target_soc_reached'` is correct)

No DB migration; just new string constants. History UI (`api/history/route.ts:56`) already projects `stopReason`, so the new values surface automatically.

## Patterns to avoid

### Anti-pattern A — Hot path DB queries

`updateSocTracking` at `charge-monitor.ts:877-879` queries `referenceCurves` on every reading (5s cadence). This is fine for SQLite + WAL but is a latent hot spot. **Phase 12 must NOT add new per-reading DB reads** for FPD-02 (the matcher refresh). The active-session query buffer should live in memory (a Map of arrays), not be re-read from `power_readings` on every refresh.

### Anti-pattern B — Recycling-gate-driven cleanup

The state machine's recycle gate at `charge-state-machine.ts:76-85` resets terminal/transient states (`complete`/`aborted`/`error`/`stopping`/`learn_complete`) to `idle` on the NEXT reading. This is a clever fix for the "machine never re-arms" bug, but it has a footgun: if Phase 12 introduces a `'stale_power'` state in the union (`types.ts:5-16`), it must also be added to the recycle list at line 76-82. Otherwise the same bug recurs: machine stuck in `'stale_power'`, next reading no-ops in the default branch.

**Recommendation:** do NOT add `'stale_power'` as a new ChargeState. Instead, transition directly to `'aborted'` (an existing terminal state) and set `stopReason='stale_power'`. This avoids the union-extension and recycle-gate footgun entirely.

### Anti-pattern C — `'use client'` files that import from `@/db/...`

Settings page server-loads config (lines 38-41 of `settings/page.tsx`), passes through props. Charging-settings component is `'use client'`. **Phase 12 must NOT** read FPD config rows from inside the `'use client'` watchdog component — the values must arrive via the SSE event (`ChargeStateEvent.watchdog`) or a hardcoded server prop. The `useChargeStream` subscription is the right channel; the watchdog component just renders whatever the event says.

### Anti-pattern D — Synchronous awaits in the state-machine path

`charge-state-machine.feedReading` is synchronous. `charge-monitor.handlePowerReading` is synchronous up to the `handleStopping` async dispatch (line 629). Any new watchdog logic must remain synchronous in `feedReading`/`handleCharging` — the async work (Pushover notification, relay-off) happens in the monitor's transition handler. **Do not** `await` inside the state machine.

### Anti-pattern E — Reading `Date.now()` inside state-machine handlers without passing timestamp

The state machine handlers all take `timestamp` as a parameter (line 67 signature, used at line 188, 226, 233, 234, 239, 260). FPD-04's `maxSessionHours` check needs `session.startedAt` AND a "now" value. The cleanest fit is to add a `session.startedAt` field to the state machine (currently stored only in `charge-monitor.sessionStartedAt` Map line 70) and pass the `timestamp` argument through to `handleCharging`/`handleCountdown` for the comparison. **Do not** call `Date.now()` from inside the state machine — it breaks the existing fake-timer-free test pattern.

## Open questions for the planner

### OQ-1 — How does the state machine convey `stop_reason` to the monitor?

Today, `stop_reason` is only set by the monitor (`charge-monitor.ts` line 301, 976, 996, etc.) — the state machine has no notion of "why" a transition fired. For FPD-01/04 the state machine knows the reason (watchdog vs. timeout) but the monitor writes the DB row.

**Options:**
1. New field on the state machine: `lastStopReason: string | null` — set in the transition handler, read by the monitor in `handleTransition`.
2. Pass the reason through the `onTransition` callback's `data` parameter (already exists at line 50, currently `unknown` and unused).
3. Have the state machine fire two different transitions (e.g., `'aborted_stale_power'`, `'aborted_timeout'`) — but this multiplies the recycle-gate footgun.

**Recommendation:** option 2 (callback data). It's already typed `unknown`, no new fields, no new transitions. Monitor sets `stopReason` based on what the callback `data` carries.

### OQ-2 — Where does the active-session query buffer live?

FPD-02 needs ~600 readings (~50 min at 5s sampling) of apower history for the matcher to re-run with a useful window. Three options:

1. **In-memory `chargingBuffers` Map** (new, mirrors `detectionBuffers`). Lost on restart. Plan 11-02's resume code already handles "first reading after resume = baseline" — we'd just lose the FPD-02 refresh until the buffer fills again.
2. **Query `session_readings` on every refresh** (`schema.ts:203-211` already stores them). DB round-trip per 60 readings = once per 5 min = acceptable. Saves memory.
3. **Hybrid:** rebuild buffer from `session_readings` on resume, then keep in memory.

Recommendation: **option 1** for simplicity. Restart-during-charging is rare; losing 5 min of buffer is acceptable degradation. Document the choice in the plan.

### OQ-3 — Should FPD-03's energy-fallback stop emit `stopReason='target_soc_reached'` or `'low_confidence_energy_fallback'`?

The energy fallback IS a stop-at-target — just via a different decision rule. Two conventions:
- **a:** Same `stopReason='target_soc_reached'`, but extend `ChargeStateEvent.stopMode` to surface the fallback (`'aggressive' | 'conservative' | 'energy_fallback'`). History UI sees a normal completion.
- **b:** Distinct `stopReason='low_confidence_energy_fallback'`. History UI shows the user that band was untrustworthy.

CONTEXT.md leans toward (a) implicitly ("Der Fallback ist sichtbar in `ChargeStateEvent.stopMode='energy_fallback'`"). Phase 12 planner should lock this — affects history UI and Pushover messaging.

### OQ-4 — Should FPD-05's "Acknowledge" button write anything to the DB?

CONTEXT.md decision 7: "client-side only (no DB write)." But: the watchdog warning state is derived from `ChargeStateEvent.watchdog.kind === 'fired'`. The SSE event for a `'fired'` watchdog only fires once (at transition); subsequent events emit `kind: 'none'` because the session is aborted and `cleanupSession` clears the maps. So the banner only stays visible if the client retains the last "fired" event in local state and the user dismisses it.

Recommendation: lock the CONTEXT.md decision (client-side only). The component holds `lastFiredAt` in `useState`, dismisses on Acknowledge. Re-mount (page reload) shows nothing because the SSE on-connect snapshot doesn't carry watchdog state. This matches the existing `setSession(null)` auto-dismiss for `COMPLETE_STATES` at `charge-banner.tsx` line 154-156.

### OQ-5 — Does the matcher refresh re-emit a charge event?

`tryMatch` ends with `this.emitChargeEvent(plugId, 'matched')` (line 762). The adaptive-refresh version is firing from inside `state=charging`, so the natural emit is `emitChargeEvent(plugId, 'charging')` — but the dashboard would see the same state with updated band fields. Is that the desired UX, or should there be a new event-tag (`'rematch'`) so the UI can flash a "matcher refined band" indicator?

Recommendation: emit `'charging'` (existing state). The band fields on the event update via the existing `socMin/socMax/socBandConfidence` plumbing — SocBandIndicator's `transition-all duration-700` (line 94) animates the narrowing smoothly. No new event type needed.
