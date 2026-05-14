---
phase: 11-soc-confidence-band-ascii-visualization
plan: 02
subsystem: charging
tags: [drizzle, migration, charge-monitor, state-machine, stop-mode, override, resume, integration-test]

requires:
  - phase: 11-soc-confidence-band-ascii-visualization
    plan: 01
    provides: deriveBand, DEFAULT_BAND_THRESHOLD_PCT, MatchResult band fields (optional)

provides:
  - Drizzle migration 0009 — soc_min / soc_max / band_confidence columns on charge_sessions
  - stop-mode pure module with conservative (socMin >= target) and aggressive (width <= 5 AND socBest >= target) predicates
  - Band-aware ChargeStateMachine — caches stopMode at setMatch time, evaluates band on every onSocUpdate tick
  - ChargeMonitor band wiring — forward-propagation in updateSocTracking (monotonic, never widens from Wh alone), captureEventContext snapshots band BEFORE relay-off await (2640873-class fix), emits band on ChargeStateEvent
  - MatchResult band fields tightened from OPTIONAL → REQUIRED (Task 3a — B3 closed)
  - Resume-after-restart path reads soc_min/soc_max/band_confidence from DB, NULL → zero-width fallback
  - Override API (PUT /api/charging/sessions/[id]) collapses band to zero-width at estimatedSoc both in memory and DB
  - B2 integration test PROVES aggressive stop fires within <30 simulated seconds of band collapse + socBest >= target (CONTEXT DoD bullet 3)

affects:
  - 11-03 ASCII renderer + Pushover wiring (consumes band fields from ChargeStateEvent + captureEventContext)
  - 11-04 UI band indicator + ChargingSettings (reads stopMode + bandThreshold config rows)

tech-stack:
  added:
    - "drizzle-kit 0.31.10 — used for migration generation only; runtime via scripts/db/migrate.ts"
  patterns:
    - "Monotonic forward-propagation of band anchors — width never grows from Wh accumulation, only collapses on new matcher runs"
    - "Snapshot-before-await: captureEventContext freezes band fields before the relay-off race window (regression guard for handleStopping)"
    - "Aggressive-mode ordering trap locked by dedicated unit test: socBest >= target alone is NEVER sufficient — width <= 5 must gate first"
    - "Override collapses band to zero-width (socMin = socMax = socBest = estimatedSoc), persisted to DB; matcher may re-widen on next run"

verification:
  - "pnpm exec vitest run → 121/121 passed across 11 files (was 92 baseline; +29 new tests)"
  - "pnpm exec tsc --noEmit → exit 0 (after MatchResult tightening)"
  - "drizzle-kit generate → 0009_add_soc_band_columns.sql + meta/0009_snapshot.json"
  - "Re-run drizzle-kit generate after apply → empty diff (B4 schema-roundtrip closed)"
  - "Unit test asserts aggressive ordering trap (wide band with socBest on target → no stop)"
  - "Override route test: 200 on valid estimatedSoc + monitor.overrideSession invoked; 400 on out-of-range payload"
  - "B2 integration test: starts iPad-Session-16 scenario (socMin=20 socMax=80 socBest=80 target=80) — aggressive mode does NOT trip during wide band; collapses to width=4 → switchRelayOff invoked within 30 simulated seconds"
---

# Plan 11-02 SUMMARY — SOC Confidence Band Runtime Integration

## Outcomes

- **DB persistence end-to-end**: `chargeSessions` schema gains `soc_min`, `soc_max`, `band_confidence` columns via migration 0009. `updateSocTracking` writes them on every Wh increment without narrowing (only matcher runs narrow). Resume-after-restart restores them; legacy NULL rows degrade to zero-width band at `estimatedSoc`.
- **Stop-mode runtime**: New `stop-mode.ts` exposes `shouldStop` with conservative (`socMin >= target`) and aggressive (`socMax - socMin <= 5 AND socBest >= target`) predicates. `ChargeStateMachine` caches the mode at `setMatch` time and re-evaluates on every onSocUpdate. The aggressive ordering trap (wide-band socBest hitting target must NOT trigger) is locked in by a unit test.
- **Event-context snapshot**: `captureEventContext` now snapshots band fields BEFORE the relay-off await, closing the 2640873 bug-class for the bar emitted with the `complete` event.
- **Override path**: `PUT /api/charging/sessions/[id]` with `estimatedSoc` collapses band to zero-width in memory AND DB. New route test covers both happy-path and 400 out-of-range.
- **B2 integration test**: drives ChargeMonitor end-to-end from the iPad-Session-16 wide-band scenario (socMin=20, socMax=80, socBest=80, target=80) — aggressive mode correctly waits while the band is wide, then `switchRelayOff` is invoked within 30 simulated seconds of band collapse. CONTEXT DoD bullet 3 closed.
- **Type tightening**: MatchResult band fields lifted from OPTIONAL → REQUIRED in `src/modules/charging/types.ts` (Task 3a). Every producer was wired in 11-01+11-02; no caller relies on the optional form anymore.

## Commits

- `7530d9a` feat(11-02): drizzle migration 0009 — add soc_min/soc_max/band_confidence to charge_sessions
- `e246f5e` feat(11-02): stop-mode module + band-aware state machine (SOCB-03)
- `a1e5587` feat(11-02): wire SOC band through ChargeMonitor — propagate/capture/emit + tighten MatchResult (Task 3a)
- `49624c6` test(11-02): update state-machine test fixtures for tightened MatchResult (Task 3a follow-up)
- `a724230` feat(11-02): DB persistence + resume + override band + <30s integration test (Task 3b — B2 closed)

## Files touched

- `drizzle/0009_add_soc_band_columns.sql` (new)
- `drizzle/meta/0009_snapshot.json` (new)
- `drizzle/meta/_journal.json` (extended)
- `src/db/schema.ts` (+6 lines — 3 nullable real columns)
- `src/modules/charging/stop-mode.ts` (new)
- `src/modules/charging/stop-mode.test.ts` (new)
- `src/modules/charging/charge-state-machine.ts` (band-aware, caches stopMode)
- `src/modules/charging/charge-state-machine.test.ts` (extended for both modes + ordering trap)
- `src/modules/charging/charge-monitor.ts` (forward-propagation + captureEventContext snapshot + override path)
- `src/modules/charging/charge-monitor.test.ts` (new — 9 tests covering propagation, override, resume, B2 integration)
- `src/modules/charging/types.ts` (MatchResult band fields tightened to required)
- `src/app/api/charging/sessions/[id]/route.ts` (PUT route delegates to monitor.overrideSession)
- `src/app/api/charging/sessions/[id]/route.test.ts` (new — 2 tests for override + validation)

## Open items / handoffs

- 11-03 must read band fields from ChargeStateEvent + captureEventContext to render the ASCII bar. The required-field tightening means a missing producer is now a compile error — safer for downstream consumers.
- 11-04 must persist `charging.stopMode` and `charging.bandThreshold` to the config row via the existing `useAutoSave` pattern. The state machine reads `charging.stopMode` at setMatch time (cached), so a UI toggle takes effect on the NEXT session start.
- DB migration journal entry 0009 is final; do not regenerate in 11-03 / 11-04.

## Note on SUMMARY commit

Original executor wrote SUMMARY.md inside the worktree but it did not survive the worktree teardown (#2070-class loss — narration emitted between Write and commit). Reconstructed by the orchestrator from the executor's structured report and commit diffs; technical content is faithful to what the executor delivered.
