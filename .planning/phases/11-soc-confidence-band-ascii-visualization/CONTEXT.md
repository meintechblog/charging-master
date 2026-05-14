# Phase 11 Context: SOC Confidence Band + ASCII Visualization

**Created:** 2026-05-14 (post-iPad Session 16 mis-stop incident)
**Author:** Captured from debug-conversation rationale (no separate discuss-phase run — context is rich enough from incident analysis).

## Motivation: What broke

On 2026-05-13, charge session 16 (iPad Pro 12.9", profile_id=4) stopped at the app's reported `estimated_soc=80`, but the iPad's actual SOC was ~47 %. Investigation showed:

- The DTW curve-matcher (`src/modules/charging/curve-matcher.ts`) called `subsequenceDtw` on a ~5-min query window against the iPad reference curve (8271 s long, ~40 W flat for the first ~50 min, then taper).
- Because the query subsequence (~5 min of constant 40 W) is itself flat, DTW's offset is **structurally ambiguous** — it matched at `offsetSeconds=3225` of an 8271 s curve → `estimatedStartSoc = 39 %`. Plus the calibration bias (+3 from prior corrections) → committed start-SOC of 42 %.
- With reference `totalEnergyWh=61.95`, the app computed `(80 - 42) % * 61.95 Wh = 23.5 Wh AC` and stopped — at which point the real iPad battery was at ~47 %.

The same flat-power ambiguity will reproduce on:
- iPad (any generation) — long flat-power phase before taper
- E-bike batteries (Bosch PowerTube) — multi-stage flat phases
- Most lithium charging where the bulk-charge stage dominates

## Solution: SOC Confidence Band

Replace `estimatedStartSoc: number` with `{ socMin, socMax, socBest, bandConfidence }`. The matcher exposes ALL plausible offsets (whose DTW score is within X % of the best score), and the band is `[min(SOC at plausible offsets), max(SOC at plausible offsets)]`. As more readings come in and the curve enters the taper phase, the plausible set shrinks → band narrows.

**Reference visualization** (40-char ASCII bar; `▓` = best±5 %, `▒` = band, `░` = outside; `↑` = best, `▲` = target):

```
  0   10  20  30  40  50  60  70  80  90 100
  ├───┼───┼───┼───┼───┼───┼───┼───┼───┼───┤
              ░░░▒▒▒▒▓▓▓▒▒▒▒░░░       │
                      ↑                ▲
```

## Affected modules (concrete file list)

**Backend:**
- `src/modules/charging/curve-matcher.ts` — return band instead of single estimate
- `src/modules/charging/charge-monitor.ts` — `updateSocTracking` forwards band; `captureEventContext` includes band fields
- `src/modules/charging/charge-state-machine.ts` — `handleCharging`/`handleCountdown` consume stop-mode setting (conservative vs aggressive)
- `src/modules/charging/soc-estimator.ts` — extend to estimate band edges (or add new pure function)
- `src/modules/charging/types.ts` — `MatchResult` + `ChargeStateEvent` get new fields
- `src/modules/charging/ascii-bar.ts` (new) — pure `renderSocBandAscii({...})` function
- `src/modules/notifications/notification-service.ts` — embed ASCII bar; set monospace flag
- `src/modules/notifications/pushover-client.ts` — pass through `monospace` form field

**Frontend:**
- `src/app/api/sse/charge/route.ts` — pass new event fields through SSE
- `src/components/dashboard/` (existing charge card or new `BandIndicator`) — render live band
- `src/components/settings/charging-settings.tsx` (or extend existing) — stop-mode toggle

**Tests:**
- `src/modules/charging/curve-matcher.test.ts` (new or extend) — property tests for band on synthetic curves
- `src/modules/charging/ascii-bar.test.ts` (new) — snapshot tests for renderer
- `src/modules/charging/charge-monitor.test.ts` (new) — integration test for band-collapse-in-taper

## Design decisions to be locked during planning

1. **Band threshold** — initially "scores within 15 % of best". May need empirical tuning; plan should include a calibration step using the existing iPad + Bosch reference curves to find a threshold that gives sensible band widths.
2. **Stop mode default** — recommend **aggressive** (`socBest >= target` and `width <= 5 %`) for snappy UX; conservative as opt-in for users who never want undershoot.
3. **Pushover frequency** — to avoid spam, attach ASCII bar only on `matched`, `complete`, `anomalie`. NOT on every Wh update.
4. **UI band component scope** — extend the existing dashboard charge card (cheaper); a separate `BandIndicator` component if reuse is needed later.
5. **ASCII width** — 40 chars works in Pushover (no wrap) and on mobile. Settle in renderer's default.
6. **Backwards compatibility** — keep `estimatedStartSoc` as alias for `socBest` so existing API consumers (`PUT /api/charging/sessions/[id]`, calibration log, resume code) continue to work unchanged. New fields are additive.

## Constraints from prior phases

- Override path `PUT /api/charging/sessions/[id]` (Phase 3) must still work; an explicit `estimatedSoc` override should collapse the band to zero-width at that value, and the next matcher run is allowed to widen it again only if confidence drops.
- Calibration logging into `soc_corrections` table (Phase 3) continues to fire on override — needed for the bias learning loop.
- Pushover-message bug-fix from commit 2640873 (today) — the event-context snapshot in `handleStopping` must include the new band fields too.
- SSE stream (Phase 2) — adding fields is additive; existing clients ignore unknown fields.

## Non-goals (explicit)

- Replacing DTW with a different matching algorithm. The band is a representation change, not an algorithmic redesign.
- Dynamic band threshold based on session count or profile maturity. Static threshold (configurable) for v1.3; learning can come later.
- Per-profile band-threshold overrides. Single global threshold.
- Pushing ASCII bars via additional channels (email, Slack). Pushover only.
- Anomaly detection rewrite — the existing power-vs-reference check stays as-is; band-aware anomaly is v1.4+.

## Definition of Done

- All 6 SOCB requirements ticked.
- iPad-style session (synthetic test fixture with the actual iPad reference curve from `reference_curves.id=4` exported as fixture) goes from initial wide band (20-80 % when starting cold) to a < 5 % band by the time the matcher sees taper data.
- Aggressive stop mode actually stops in `< 30 s` after band collapses below width threshold AND `socBest >= target`.
- Pushover notification on `matched` and `complete` visually shows the bar on the user's phone — manually verified once on the LXC after deploy.
- No regressions: all existing charging tests (35) still pass; resume after restart still works; override API still collapses band correctly.
