---
phase: 11-soc-confidence-band-ascii-visualization
verified: 2026-05-14T22:06:18Z
status: passed
score: 6/6 SOCB requirements verified
verdict: PASS-WITH-DEFERRALS
overrides_applied: 0
deferred:
  - truth: "Pushover on iPhone/Android lock-screen visually shows the rendered ASCII bar"
    addressed_in: "Post-deploy manual check on LXC"
    evidence: "CONTEXT.md DoD bullet 4 explicitly defers: 'manually verified once on the LXC after deploy'. No automated path can prove lock-screen rendering."
---

# Phase 11 Verification — SOC Confidence Band + ASCII Visualization

**Phase Goal (from ROADMAP.md):** Replace the single-point `estimatedStartSoc` with a confidence band `{socMin, socMax, socBest}` that visually narrows as the live charge curve disambiguates against the reference — surfaced as an ASCII bar in Pushover notifications, server logs, and the dashboard — so user-visible SOC mis-estimations on flat-power phases (root cause of the 2026-05-13 iPad mis-stop at 47 % → "80 %") become impossible.

**Verified:** 2026-05-14T22:06:18Z
**Status:** passed
**Verdict:** PASS-WITH-DEFERRALS (one DoD item deferred by CONTEXT itself — manual on-device Pushover render)
**Re-verification:** No — initial verification

## Verdict

**PASS-WITH-DEFERRALS.** All 6 SOCB requirements are covered with file-level evidence and passing automated tests; the iPad-Session-16 flat-power offset-ambiguity is structurally prevented by the new DTW distances-vector + `deriveBand` path; the runtime persists, propagates, and emits the band end-to-end; the renderer is pure and snapshot-locked; Pushover monospace forwarding works; the dashboard renders a CSS-animated band with ASCII fallback. The only remaining DoD item (visual on-device Pushover lock-screen render) was already documented in CONTEXT.md as a post-deploy manual step, not a build gate.

## Goal achievement

The CONTEXT.md goal decomposes into four observable truths. Every one is verified in the codebase:

### Truth 1: DTW offset-ambiguity is no longer collapsed to a single point

- `src/modules/charging/dtw.ts:50-55` — `SubsequenceDtwResult` now exposes `distances: Float64Array` and `windowStep`, indexed by step.
- `src/modules/charging/dtw.ts:80-99` — the existing subsequence loop populates `distances[idx++]` on every offset evaluation; no algorithmic change, just no longer discarding the per-offset score.
- `src/modules/charging/curve-matcher.ts:67-113` — `deriveBand` scans the distances vector, maps every plausible offset to a start-SOC via `(offsetSeconds / totalDuration) * 100`, and returns `{ socMin, socMax, socBest, bandConfidence }`. Cutoff is `best * (1 + thresholdPct)`. `bandConfidence = max(0, 1 - width/100)` (never divides by width).
- `src/modules/charging/curve-matcher.ts:33` — `DEFAULT_BAND_THRESHOLD_PCT = 0.05` is pinned by the empirical-calibration sweep test in `curve-matcher.test.ts:176-209`, which asserts `DEFAULT_BAND_THRESHOLD_PCT === winningThreshold` (the smallest of `[0.05, 0.10, 0.15, 0.20, 0.30]` that collapses the band to ≤ 5 %).

### Truth 2: The band propagates through the entire runtime including the relay-off race window

- `src/modules/charging/charge-monitor.ts:884-901` — `updateSocTracking` forward-propagates `socMin`/`socMax`/`socBest` in lock-step with the Wh accumulation (each anchor passes through `estimateSoc` separately); the band only narrows on a new matcher run (`tryMatch`), never on Wh alone.
- `src/modules/charging/charge-monitor.ts:715-739` — `tryMatch` enforces monotonic narrowing via `Math.max(prior, new.socMin)` / `Math.min(prior, new.socMax)`; Pitfall 1 closed.
- `src/modules/charging/charge-monitor.ts:962, 1012-1066` — `captureEventContext` snapshots band fields AND a rendered `socAsciiBar` (unicode mode) BEFORE the relay-off await in `handleStopping`. This is the same shape as the 2640873 estimatedSoc fix, extended to the band — see comment block at 1033-1042. Without this, the post-await `complete` event would emit empty band fields.

### Truth 3: Aggressive stop-mode is gated correctly (Pitfall 5 ordering closed)

- `src/modules/charging/stop-mode.ts:41-55` — `shouldStop` evaluates the **width gate first** (`width <= DEFAULT_BAND_WIDTH_LIMIT && opts.socBest >= opts.targetSoc`), exactly as RESEARCH.md Pitfall 5 demands; comment at 51-52 explicitly forbids re-ordering. Conservative branch returns `opts.socMin >= opts.targetSoc`.
- `src/modules/charging/stop-mode.test.ts` — unit test asserts `{socMin:20, socMax:80, socBest:80, target:80}` returns `false` (the iPad-Session-16 trap case), and `{socMin:78, socMax:82, socBest:80, target:80}` returns `true`.
- `src/modules/charging/charge-state-machine.ts:194-223` — both `handleCharging` and `handleCountdown` delegate to `shouldStop({mode: this.stopMode, ...})`; the old `this.estimatedSoc >= this.targetSoc` heuristic is fully replaced.
- `src/modules/charging/charge-monitor.test.ts:649-725` — B2 integration test (`vi.useFakeTimers()`) drives the iPad-style wide-band scenario (socMin=20, socMax=80, socBest=80, target=80), confirms aggressive mode does NOT trip during the wide phase, then narrows to {78,82}, and asserts `switchRelayOff` is invoked within 30 simulated seconds (per CONTEXT DoD bullet 3).

### Truth 4: The band reaches the user — Pushover, dashboard, and settings

- `src/modules/charging/soc-band-ascii.ts:80-141` — `renderSocBandAscii` is pure (no `Math.random`, no `Date.now`, no I/O), produces exactly 3 lines (scale/bar/markers), dual-mode dispatch (`pushover` ASCII-only, `unicode` rich box-drawing).
- `src/modules/charging/soc-band-ascii.test.ts:21-138` — 7 inline snapshots cover the CONTEXT.md representative inputs (full uncertainty, narrow band, exact-target overlap, band crossing target, collapsed point, target at edge, Unicode parity); plus per-line glyph invariants (B5), determinism (3 repeats byte-identical), width/clamping/degenerate-width-1 cases.
- `src/modules/notifications/notification-service.ts:181-220, 271-343` — `buildMatchedMessage` and `buildCompleteMessage` append the pushover-mode ASCII bar AND set `monospace: 1` in the `BuiltMessage` return. `handleEvent` at line 157 forwards `monospace: msg.monospace` to `sendPushover` — single locked path (W4 closed), no OR-fork.
- `src/modules/notifications/pushover-client.ts:5-44` — `PushoverMessage.monospace?: 0 | 1`; `sendPushover` includes the field only when truthy, so legacy callers send byte-identical bodies.
- `src/modules/charging/charge-monitor.ts:504-551` — `fireAnomalyNotification` appends the pushover-mode bar AND sets `monospace=1` in the URLSearchParams body.
- `src/components/charging/soc-band-indicator.tsx:78-110` — CSS variables `--soc-min`/`--soc-max`/`--soc-best`/`--soc-target` drive a band-fill with `transition-all duration-700 ease-out`; `<pre data-testid="soc-band-ascii">` fallback when no live event; `<noscript>` carries initial ASCII for JS-disabled browsers.
- `src/components/settings/charging-settings.tsx` — radio toggle for `charging.stopMode` (default `aggressive`), advanced collapsed input for `charging.bandThreshold` defaulted from `DEFAULT_BAND_THRESHOLD_PCT`. Persisted via `useAutoSave` to the `config` table; state machine reads on next session start.

### Observable Truths Summary

| #   | Truth                                                                                                  | Status     | Evidence                                                                                                                       |
| --- | ------------------------------------------------------------------------------------------------------ | ---------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 1   | DTW exposes full distances vector; deriveBand maps plausible offsets to a SOC band                     | ✓ VERIFIED | `dtw.ts:50-99`, `curve-matcher.ts:67-113`                                                                                       |
| 2   | DEFAULT_BAND_THRESHOLD_PCT is empirically pinned, not guessed                                          | ✓ VERIFIED | `curve-matcher.ts:33`, calibration sweep test `curve-matcher.test.ts:176-209`                                                  |
| 3   | Band propagates forward in lock-step with Wh; narrows only on new matcher runs (monotonic)             | ✓ VERIFIED | `charge-monitor.ts:884-901, 715-739`                                                                                            |
| 4   | captureEventContext snapshots band+socAsciiBar BEFORE relay-off await (2640873 bug-class regression)   | ✓ VERIFIED | `charge-monitor.ts:962, 1012-1066`                                                                                              |
| 5   | Aggressive stop-mode width check gates FIRST (Pitfall 5)                                               | ✓ VERIFIED | `stop-mode.ts:41-55`, `stop-mode.test.ts`                                                                                       |
| 6   | <30s aggressive-stop integration test PASSES (CONTEXT DoD #3)                                          | ✓ VERIFIED | `charge-monitor.test.ts:649-725` (B2)                                                                                            |
| 7   | renderSocBandAscii is pure, dual-mode, 3-line locked, ≥6 snapshots                                     | ✓ VERIFIED | `soc-band-ascii.ts:80-141`, `soc-band-ascii.test.ts:21-323`                                                                     |
| 8   | NotificationService attaches the bar to matched + complete with monospace=1; anomaly path too         | ✓ VERIFIED | `notification-service.ts:181-220, 271-343`, `charge-monitor.ts:504-551`                                                          |
| 9   | Dashboard SocBandIndicator drives CSS vars from SSE; ASCII + noscript fallback                          | ✓ VERIFIED | `soc-band-indicator.tsx`, wired in `charge-banner.tsx:423`                                                                       |
| 10  | Settings page exposes stopMode + bandThreshold via useAutoSave; UI default = DEFAULT_BAND_THRESHOLD_PCT | ✓ VERIFIED | `charging-settings.tsx`, settings page `page.tsx:6, 74`                                                                          |
| 11  | DB migration 0009 adds soc_min/soc_max/band_confidence; resume reads them; override collapses to point | ✓ VERIFIED | `drizzle/0009_add_soc_band_columns.sql`, `schema.ts:196-199`, `charge-monitor.ts:228-265, 1208-1234`                            |
| 12  | SSE active-replay hydrates band on mid-session reconnect                                                | ✓ VERIFIED | `api/sse/power/route.ts:46-68`                                                                                                  |

**Score:** 12/12 supporting truths verified → all 6 SOCB requirements covered.

## Requirements coverage

| Requirement | Description                                                       | Status     | Evidence                                                                                                  |
| ----------- | ----------------------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------- |
| SOCB-01     | `findBestCandidate` returns `{socMin, socMax, socBest, bandConfidence}` from DTW offset scores; `estimatedStartSoc` preserved as alias for `socBest` | ✓ COVERED  | `curve-matcher.ts:67-113, 122-174`; `types.ts:18-33` (band fields now REQUIRED); `dtw.ts:50-99` (distances vector). Property tests in `curve-matcher.test.ts:154-209` pass against synthetic-iPad-shaped fixture. |
| SOCB-02     | `updateSocTracking` propagates `socMin`/`socMax` forward; band narrows ONLY on new matcher runs | ✓ COVERED  | `charge-monitor.ts:884-901` propagation; `:715-739` monotonic-narrowing enforcement; `charge-monitor.test.ts` propagation tests pass. |
| SOCB-03     | Stop logic configurable: conservative (`socMin ≥ target`) / aggressive (`socMax−socMin ≤ 5 AND socBest ≥ target`); default aggressive; settings toggle | ✓ COVERED  | `stop-mode.ts:41-55` (width-first ordering); `charge-state-machine.ts:194-223` (handleCharging + handleCountdown use `shouldStop`); `charging-settings.tsx` toggle wired to `charging.stopMode` config row. |
| SOCB-04     | Pure-function ASCII renderer with ≥6 snapshot tests                | ✓ COVERED  | `soc-band-ascii.ts` (124 lines, pure); `soc-band-ascii.test.ts` (25 tests, 7 inline snapshots — covers full uncertainty, narrow, exact-target, band-crossing-target, collapsed, target-at-edge, Unicode parity); CONTEXT.md describes Unicode glyphs `▓ ▒ ░ ↑ ▲` and they exist in `GLYPHS_UNICODE` (lines 61-71). |
| SOCB-05     | NotificationService attaches the bar to matched/complete/anomalie with `monospace=1`; not on every Wh tick | ✓ COVERED  | `notification-service.ts:181-220` (matched + monospace), `:271-343` (complete + monospace); `pushover-client.ts:5-44` (opt-in monospace forwarding); `charge-monitor.ts:504-551` (anomaly path); detecting/error/aborted/learn_complete remain bar-less by design. |
| SOCB-06     | Dashboard live band with CSS animation + no-JS ASCII fallback; ChargeStateEvent carries `socMin/socMax/socBandConfidence/socAsciiBar` | ✓ COVERED  | `types.ts:54-96` (4 new optional fields); `soc-band-indicator.tsx` (CSS-var driven, `<pre>` fallback, `<noscript>` wrapper); wired in `charge-banner.tsx:8, 423`; SSE passthrough in `api/sse/power/route.ts:46-68` (live event already opaque, active-replay branch hydrates from DB). |

**No orphaned requirements.** All 6 SOCB IDs appear in plan frontmatter and are claimed by plans 11-01..11-04.

## DoD bullets (from CONTEXT.md)

| #   | DoD requirement                                                                                | Verdict      | Evidence                                                                                                                                                                                                              |
| --- | ---------------------------------------------------------------------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | All 6 SOCB requirements ticked                                                                  | ✓ MET        | See requirements coverage table above — all 6 COVERED.                                                                                                                                                                  |
| 2   | iPad-style synthetic session: initial wide band (20-80) → <5 % band by taper                    | ✓ MET        | `curve-matcher.test.ts` property test "synthetic-iPad-shaped fixture flat → wide, taper → narrow" + empirical calibration sweep pinning `DEFAULT_BAND_THRESHOLD_PCT=0.05` against the same fixture; both pass.        |
| 3   | Aggressive mode stops in <30s after band collapses + socBest ≥ target                          | ✓ MET        | `charge-monitor.test.ts:649-725` B2 integration test — `vi.useFakeTimers()`, wide-band setup, narrowing injection, `switchRelayOff` invoked within 30 simulated seconds. Test is non-skipped and passes.            |
| 4   | Pushover notifications on `matched` and `complete` visually show the bar on device              | ⚠ DEFERRED   | CONTEXT explicitly says "manually verified once on the LXC after deploy" — outside automated verification scope. Code path is COVERED: `notification-service.ts:181-220, 271-343` builds the bar; `sendPushover` includes `monospace=1`; ASCII-only glyphs are guaranteed by pushover-mode snapshot tests (no non-ASCII bytes in any pushover-mode snapshot). |
| 5   | No regressions: existing charging tests pass; resume works; override collapses band            | ✓ MET        | `pnpm exec vitest run` → 171/171 passed (was 51 pre-phase-11; +120 new tests, 0 regressions). Resume regression: `charge-monitor.test.ts` resume-NULL-band test passes (legacy rows degrade to zero-width at estimatedSoc). Override: `app/api/charging/sessions/[id]/route.ts:167-205` + `charge-monitor.ts:228-265` collapse band to zero-width in memory AND DB. |

## Test gates

```
$ pnpm exec tsc --noEmit
(exit 0, no output)

$ pnpm exec vitest run
 Test Files  15 passed (15)
      Tests  171 passed (171)
   Duration  1.72s

$ pnpm exec vitest run src/modules/charging/charge-monitor.test.ts -t "B2"
 Tests  5 passed | 10 skipped (15)
(skip count is vitest's -t filter behaviour; actual `.skip`/`.todo` markers: 0)
```

- **TypeScript strict mode:** exit 0. MatchResult band fields are REQUIRED (no `?`) — every producer (`tryMatch`, `overrideSession`, `resumeActiveSessions`, in-place mutation site) supplies them.
- **Vitest full suite:** 171 passing across 15 test files. Baseline before Phase 11 was 51 tests. Net delta: +120 (15 new in 11-01, 29 in 11-02, 42 in 11-03, 8 in 11-04 — matches each plan's SUMMARY claim).
- **Skip/todo audit:** `grep -rnE "\.skip\(|\.todo\(" src/modules/charging/charge-monitor.test.ts src/modules/charging/stop-mode.test.ts src/modules/charging/curve-matcher.test.ts src/modules/charging/soc-band-ascii.test.ts src/components/settings/charging-settings.test.tsx src/components/charging/soc-band-indicator.test.tsx` → 0 matches.
- **Phase-11-scoped run:** `pnpm exec vitest run src/modules/charging/{charge-monitor,stop-mode,curve-matcher,soc-band-ascii}.test.ts` → 62/62 pass in 724 ms.

## Regressions checked

| Concern                                          | Status     | Evidence                                                                                                                                                |
| ------------------------------------------------ | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Existing charging tests (pre-phase-11 = 35)      | ✓ NO REG   | Full-suite count grew 51 → 171, all green. State-machine and soc-estimator suites unchanged.                                                            |
| Resume after restart with legacy NULL columns    | ✓ NO REG   | `charge-monitor.ts:1208-1234` falls back to `session.socMin ?? fallbackSoc` (= `estimatedSoc`), `bandConfidence ?? 1` → zero-width band at the saved SOC. |
| Override path `PUT /api/charging/sessions/[id]`  | ✓ NO REG   | `route.ts:167-205` validates `estimatedSoc`, delegates to `monitor.overrideSession`; that path (`charge-monitor.ts:228-265`) collapses memory + DB band to `{min:value, max:value, conf:1}`. Calibration `soc_corrections` write path (`calibration.ts`) is unchanged — it reads `socBest` which equals `estimatedStartSoc`, preserving the bias-learning loop. |
| Pushover bodies for legacy notification states   | ✓ NO REG   | `pushover-client.ts:32` `if (msg.monospace) body.monospace = 1;` — falsy / undefined / 0 omits the key. Detecting/error/aborted/learn_complete don't set `monospace`, so their wire bodies are byte-identical to pre-phase-11. |
| SSE wire format additive                         | ✓ NO REG   | `types.ts:87-95` band fields are all OPTIONAL on `ChargeStateEvent`; `use-charge-stream.ts` does plain `JSON.parse` and destructures only what consumers need — unknown fields are silently ignored. |
| Drizzle migration applied cleanly                 | ✓ VERIFIED | `drizzle/0009_add_soc_band_columns.sql` (3 ADD COLUMN, all nullable); `.data.test/` ignored in `.gitignore`. Plan 11-02 verify ran `tsx scripts/db/migrate.ts` against a scratch sqlite and confirmed `.schema charge_sessions` lists the 3 new columns. |
| Anti-patterns in modified files                   | ✓ CLEAN    | `grep -rnE "TBD\|FIXME\|XXX\|TODO\|HACK\|PLACEHOLDER"` against all phase-11 modified files in `src/modules/charging/`, `src/modules/notifications/`, the new components, and the SSE route → 0 matches.                  |

## Deferred / non-blocking items

| Item                                                         | Reason                                                                                                                                              |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Manual Pushover on-device render verification                | CONTEXT.md DoD bullet 4 explicitly defers to "manually verified once on the LXC after deploy". No automated path can prove iOS/Android lock-screen rendering. The defensive ASCII-only glyph set + `monospace=1` flag is the mitigation. |
| Real iPad reference-curve fixture (vs synthetic)             | Plan 11-01 W2/A4: synthetic-iPad-shaped fixture is the committed default; `scripts/fixtures/export-reference-curve.ts --profile-id 4` can export the real curve from the LXC DB when access is available. Math validity proven on the synthetic shape. |
| useAutoSave hook duplication (electricity-settings + charging-settings) | Plan 11-04 N2: explicit v1.3 backlog item; not a regression. 25-line copy is acceptable. Folding into a shared hook (`@/hooks/use-autosave-config`) is a future quick task. |

## Behavioral spot-checks

| Behavior                                                                       | Command                                                                       | Result                                                  | Status |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- | ------------------------------------------------------- | ------ |
| Fixture file shape (≥8000 points, ≥8000s duration)                              | `node -e "const j=require('.../ipad-reference-curve.json'); ..."`              | points=8400, duration=8399, totalEnergyWh=67.083        | ✓ PASS |
| Migration SQL contains the 3 new columns                                       | `grep -E "ADD .*soc_min\|soc_max\|band_confidence" drizzle/0009_*.sql`         | 3 matches                                              | ✓ PASS |
| MatchResult band fields are REQUIRED (B3 closed)                                | `grep -nE "socMin\?: number\|socMax\?: number" types.ts` inside MatchResult    | 0 matches (only on ChargeStateEvent, which stays optional) | ✓ PASS |
| Old single-point stop heuristic fully replaced                                 | `grep -nE "this\.estimatedSoc\s*>=\s*this\.targetSoc" charge-state-machine.ts` | 0 matches                                              | ✓ PASS |
| Renderer is pure (no I/O, no time, no random)                                  | `grep -nE "import.*db\|fs\|fetch\|Date\.now\|Math\.random" soc-band-ascii.ts`  | 0 matches                                              | ✓ PASS |

## Probe Execution

Not applicable. Phase 11 is not a migration/tooling phase; CONTEXT/PLAN/SUMMARY do not reference probes or `scripts/*/tests/probe-*.sh`. The Vitest suite is the canonical executable proof; it passes 171/171.

## Gaps Summary

None. All goal-backward truths verify in the codebase. The single deferred item (manual on-device Pushover render) was already a documented post-deploy step in CONTEXT.md and is not a build-time gate.

## Recommendation

**SHIP.** Phase 11 closes the iPad-Session-16 failure mode by structural change (DTW now exposes the full plausible-offset distribution; aggressive stop is gated by the empirically-pinned width threshold), the new path is locked by 120 new tests including the B2 <30s integration test, no regressions surfaced, and the user-facing surfaces (dashboard band, settings toggle, Pushover bar) all wire end-to-end. The only follow-up that remains is the post-deploy lock-screen render check on a real iPhone — that was always intended to be a manual step.

---

_Verified: 2026-05-14T22:06:18Z_
_Verifier: Claude (gsd-verifier)_
