---
phase: 11-soc-confidence-band-ascii-visualization
plan: 01
subsystem: charging
tags: [dtw, subsequence-dtw, confidence-band, soc, vitest, typescript, fixture]

requires:
  - phase: 03-charge-intelligence
    provides: subsequenceDtw, MatchResult, findBestCandidate, ProfileWithCurve

provides:
  - SubsequenceDtwResult with full per-offset distances Float64Array
  - deriveBand pure helper exported from curve-matcher.ts
  - MatchResult band fields (OPTIONAL): socMin, socMax, socBest, bandConfidence
  - estimatedStartSoc preserved as back-compat alias for socBest
  - DEFAULT_BAND_THRESHOLD_PCT = 0.05 (empirically pinned via calibration sweep)
  - Synthetic-iPad-shaped reference curve fixture (8400 points, ~67 Wh)
  - One-shot exporter script supporting --synthetic and --profile-id <N>

affects:
  - 11-02 runtime integration (charge-monitor forward-propagation, state-machine stop-mode, Drizzle migration)
  - 11-03 notifications + Pushover ASCII bar rendering
  - 11-04 UI band indicator + stop-mode toggle

tech-stack:
  added: []
  patterns:
    - "Subsequence DTW distance-vector scan for offset-ambiguity quantification (audiolabs-erlangen MIR C7S2)"
    - "Additive-then-tighten type extension: OPTIONAL band fields in 11-01, required in 11-02"
    - "Empirical-calibration-as-test: DEFAULT_BAND_THRESHOLD_PCT pinned by a sweep test, not a hand-picked guess"

key-files:
  created:
    - src/modules/charging/curve-matcher.test.ts
    - src/modules/charging/fixtures/ipad-reference-curve.json
    - scripts/fixtures/export-reference-curve.ts
  modified:
    - src/modules/charging/dtw.ts
    - src/modules/charging/dtw.test.ts
    - src/modules/charging/curve-matcher.ts
    - src/modules/charging/types.ts

key-decisions:
  - "Float64Array (not number[]) for distances — dense numeric indexing, downstream sees a typed array"
  - "Cutoff formula: best * (1 + thresholdPct). Relative threshold, not absolute"
  - "bandConfidence = max(0, 1 - width/100). Never divide by width (collapsed band divides by zero)"
  - "DEFAULT_BAND_THRESHOLD_PCT = 0.05, pinned by calibration sweep on the synthetic-iPad-shaped fixture (smallest passing threshold)"
  - "Band fields on MatchResult are OPTIONAL in 11-01 (per B3). Plan 11-02 Task 3 tightens to required after all producers wire them"
  - "estimatedStartSoc preserved AS socBest for back-compat (charge-monitor / charge-state-machine compile unchanged)"
  - "Committed fixture is synthetic-iPad-shaped (per W2/A4); real-iPad DB export remains optional and deferred"

patterns-established:
  - "Pattern: DTW distance-vector scan + relative-threshold cutoff for confidence-band derivation"
  - "Pattern: empirical calibration is a test — the test computes the value, the constant matches the test output"
  - "Pattern: synthetic-fixture generator (deterministic, no DB) committed alongside an exporter script for the real curve"

requirements-completed: [SOCB-01]

duration: ~12min
completed: 2026-05-14
---

# Phase 11 Plan 01: SOC Confidence Band Math Foundation Summary

**Subsequence DTW now exposes the full per-offset distances vector; curve-matcher derives a SOC confidence band from it; the default cutoff (0.05) is empirically pinned by a sweep test on a synthetic-iPad-shaped fixture.**

## Performance

- **Duration:** ~12 min
- **Started:** 2026-05-14T21:04:00Z
- **Completed:** 2026-05-14T21:16:19Z
- **Tasks:** 3/3
- **Files modified:** 4 (+ 3 created)

## Accomplishments

- **DTW distance-vector refactor.** `subsequenceDtw` now returns `{ offset, distance, distances: Float64Array, windowStep }`. The existing for-loop already evaluated every offset and discarded the value; we now keep the vector. Legacy `{ offset, distance }` destructuring continues to work — no consumer changes required.
- **deriveBand pure helper.** Scans the distances vector for every offset within `best * (1 + thresholdPct)`, maps each plausible offset to a start-SOC via `(offsetSeconds / totalDuration) * 100`, and returns `{ socMin, socMax, socBest, bandConfidence }` where `bandConfidence = max(0, 1 - width/100)`.
- **findBestCandidate extension.** Same signature; now also runs `deriveBand` with `DEFAULT_BAND_THRESHOLD_PCT` and populates the band fields on `MatchResult`. `estimatedStartSoc = band.socBest` preserves the existing back-compat alias.
- **MatchResult type extended additively.** `socMin?`/`socMax?`/`socBest?`/`bandConfidence?` are OPTIONAL so every existing producer in `charge-monitor.ts` (overrideSession, tryMatch, resumeActiveSessions, in-place mutation site) and `charge-state-machine.ts` continues to compile without a tide-over patch. Plan 11-02 Task 3 will tighten these to required.
- **Empirical calibration closed (B1 / Pitfall 4).** A calibration sweep test runs `deriveBand` against the synthetic-iPad-shaped fixture for thresholds `[0.05, 0.10, 0.15, 0.20, 0.30]`. The test asserts a winning threshold exists AND that `DEFAULT_BAND_THRESHOLD_PCT === winningThreshold`. Output: every threshold collapses the band to ≤ 5 % on the chosen taper query, so 0.05 (the smallest) wins.
- **Synthetic-iPad-shaped fixture + exporter.** 8400 points (3000 s flat at 40 W, then 5400 s linear taper 40 → 5 W), ~67 Wh total. Committed JSON is generated deterministically by `scripts/fixtures/export-reference-curve.ts --synthetic`. The same script supports `--profile-id 4` against the LXC DB for the optional real-iPad export.

## Task Commits

Each task was committed atomically:

1. **Task 1: subsequenceDtw returns full per-offset distances vector** — `6b97cde` (feat) — TDD: 6 new failing tests added to `dtw.test.ts`, then `dtw.ts` implementation; all 16 tests pass.
2. **Task 3: synthetic-iPad-shaped reference curve fixture + exporter** — `f29f913` (feat) — Done before Task 2 because Task 2's tests import the committed JSON.
3. **Task 2: deriveBand + extended findBestCandidate + empirical calibration** — `e5ef26b` (feat) — TDD: 9 new tests written first (RED), then implementation; sweep result picks 0.05 as winner.

## Files Created/Modified

- `src/modules/charging/dtw.ts` — Added `SubsequenceDtwResult` interface, modified `subsequenceDtw` to allocate `Float64Array(numOffsets)` and populate every step; algorithm unchanged.
- `src/modules/charging/dtw.test.ts` — Added 6 tests for the distances vector (length, indexing, Float64Array shape, legacy destructure, degenerate cases, regression on best distance).
- `src/modules/charging/types.ts` — Added 4 optional band fields to `MatchResult`; `estimatedStartSoc` left alone.
- `src/modules/charging/curve-matcher.ts` — Added `DEFAULT_BAND_THRESHOLD_PCT = 0.05`, exported `deriveBand`, extended `findBestCandidate` to call it and populate band fields. JSDoc cites audiolabs-erlangen MIR reference.
- `src/modules/charging/curve-matcher.test.ts` (new) — 9 tests covering `deriveBand` edges, band-collapse property on small synthetic + full-scale fixture, back-compat alias, calibration sweep.
- `src/modules/charging/fixtures/ipad-reference-curve.json` (new) — Deterministic synthetic-iPad-shaped curve. `_comment` field marks it as synthetic and points to the exporter for the real curve.
- `scripts/fixtures/export-reference-curve.ts` (new) — CLI with `--synthetic`, `--profile-id`, `--out`. Lazy-imports the DB client so synthetic mode never touches the FS DB path. Exits 2 if the requested profile has no curve rows.

## Decisions Made

### Data shapes and formulas

- **`distances: Float64Array`** (not `number[]`). Plan-specified; gives downstream code typed dense indexing without boxing.
- **Cutoff formula: `best * (1 + thresholdPct)`.** Relative-threshold scan of the DTW matching function Δ_DTW(m) — textbook audiolabs-erlangen MIR C7S2.
- **`bandConfidence = max(0, 1 - width/100)`.** Per RESEARCH Pitfall 4 anti-pattern: never divide by width (collapsed band ⇒ division by zero). Width-from-100 keeps the invariant `bandConfidence ∈ [0, 1]` with a collapsed band reading as 1.0.

### Empirical calibration sweep — DEFAULT_BAND_THRESHOLD_PCT = 0.05

Calibration test runs the full fixture (8400 points) through subsequenceDtw with a 60-sample taper query (`apower = 10 - i * (5/60)`), then evaluates `deriveBand` at each candidate threshold:

| threshold | bandWidth (taper region) |
|-----------|--------------------------|
| 0.05      | 2                        |
| 0.10      | 2                        |
| 0.15      | 4                        |
| 0.20      | 4                        |
| 0.30      | 4                        |

Smallest threshold meeting `bandWidth ≤ 5` is **0.05** (bandWidth=2). All five thresholds happen to satisfy the ≤ 5 % criterion on this particular query/fixture pair — that's not a flaw, it confirms the synthetic taper is sharp enough to uniquely localize a 60-sample window. The test still pins 0.05 as the smallest winner; if the synthetic gets relaxed in a future revision and 0.05 stops winning, the test will surface the next winner automatically (and `DEFAULT_BAND_THRESHOLD_PCT` must be updated to match).

### Optional-then-required

Per B3 (closed in this plan): the four band fields are OPTIONAL on `MatchResult` in 11-01. Plan 11-02 Task 3 (per the plan's frontmatter `must_haves.truths` block) tightens them to required after wiring every producer (`overrideSession ~176`, `tryMatch ~543`, mutation site `~217`, `resumeActiveSessions ~1049`). No tide-over patches to `charge-monitor.ts` were needed in 11-01 — strict TypeScript still compiles end-to-end.

### Task execution order

Plan listed Task 1 → Task 2 → Task 3, but Task 2's tests import `./fixtures/ipad-reference-curve.json` produced by Task 3. Executed in dependency order: 1 → 3 → 2. Each task still satisfies its acceptance criteria atomically.

## Deviations from Plan

None of substance — the only ordering reshuffle is documented above and matches the literal data dependency (Task 2's tests cannot load a fixture that does not exist yet). No deviation rules were tripped:

- No Rule 1 bugs found in modified code.
- No Rule 2 missing critical functionality (the plan's `must_haves.truths` list was followed verbatim).
- No Rule 3 blockers (one note: this worktree had no `node_modules`; ran `pnpm install --frozen-lockfile` once at the start — standard workspace setup, not a "deviation").
- No Rule 4 architectural questions.

## Issues Encountered

- **`node_modules` absent in the worktree.** Ran `pnpm install --frozen-lockfile` at start — clean install, 0 errors. Not a code change; not a deviation.
- **`require('./dtw')` initially used in the calibration test** (carry-over from snippet style) — Vitest under ESM doesn't expose CommonJS `require`. Replaced with a regular `import { subsequenceDtw } from './dtw';` before the first run. Caught by the RED step.

## Verification Evidence

- `pnpm exec vitest run src/modules/charging` → **51 tests passed** (16 dtw + 9 curve-matcher + 16 charge-state-machine + 10 soc-estimator). Pre-existing 36 are unchanged; 15 new tests added by this plan.
- `pnpm exec vitest run` (full suite) → **92 tests passed**, no regressions.
- `pnpm exec tsc --noEmit` → exit 0, no consumer of `MatchResult` (charge-monitor, charge-state-machine) needed any change.
- Fixture self-test: `pnpm exec tsx scripts/fixtures/export-reference-curve.ts --synthetic --out /tmp/ipad-test.json` writes a valid 8400-point JSON; `_comment` starts with "Synthetic-iPad-shaped".
- Acceptance grep checks (all greens):
  - `grep -n "interface SubsequenceDtwResult" src/modules/charging/dtw.ts` → 1 match
  - `grep -n "distances: Float64Array" src/modules/charging/dtw.ts` → 1+ matches (in interface)
  - `grep -n "socMin?: number" src/modules/charging/types.ts` → 1 match (OPTIONAL)
  - `grep -n "estimatedStartSoc: number" src/modules/charging/types.ts` → 1 match (back-compat preserved)
  - `grep -n "export function deriveBand" src/modules/charging/curve-matcher.ts` → 1 match
  - `grep -cn "DEFAULT_BAND_THRESHOLD_PCT" src/modules/charging/curve-matcher.ts` → 3 occurrences (declaration + usage + JSDoc reference)

## Reference Data for Downstream Plans

Plans 11-02, 11-03, 11-04 can rely on these without re-deriving:

### MatchResult band shape (current, optional)

```ts
interface MatchResult {
  profileId: number;
  profileName: string;
  confidence: number;
  curveOffsetSeconds: number;
  estimatedStartSoc: number;     // alias for socBest, back-compat
  socMin?: number;               // OPTIONAL in 11-01; required in 11-02 Task 3
  socMax?: number;               // OPTIONAL in 11-01; required in 11-02 Task 3
  socBest?: number;              // OPTIONAL in 11-01; required in 11-02 Task 3
  bandConfidence?: number;       // OPTIONAL in 11-01; required in 11-02 Task 3
}
```

### SubsequenceDtwResult shape

```ts
interface SubsequenceDtwResult {
  offset: number;             // global best offset (legacy)
  distance: number;           // distance at global best (legacy)
  distances: Float64Array;    // length = floor((refLen - queryLen) / windowStep) + 1
  windowStep: number;         // default 5
}
```

### deriveBand signature

```ts
deriveBand(
  distances: Float64Array,
  windowStep: number,
  curvePoints: ProfileWithCurve['curvePoints'],
  totalDurationSeconds: number,
  thresholdPct: number,
): { socMin: number; socMax: number; socBest: number; bandConfidence: number }
```

### Constants

| Constant | Value | Source |
|----------|-------|--------|
| `DEFAULT_BAND_THRESHOLD_PCT` | `0.05` | Calibration sweep in `curve-matcher.test.ts` |
| `DEFAULT_CONFIDENCE_THRESHOLD` | `0.70` | Unchanged from prior phases |

### Synthetic-iPad-shaped fixture characteristics

- `profileId: 4`
- `durationSeconds: 8399`
- `totalEnergyWh: ~67.08` (analytical: `40 W * 3000 s / 3600 + (40+5)/2 * 5400 s / 3600`)
- `pointCount: 8400`
- Shape: 3000 s flat at 40 W, then 5400 s linear taper 40 W → 5 W
- `_comment`: starts with "Synthetic-iPad-shaped fixture"
- Generator: `scripts/fixtures/export-reference-curve.ts --synthetic`
- Real-curve export (deferred per W2/A4): same script with `--profile-id 4` against the LXC DB

## Next Phase Readiness

- **11-02 (runtime integration)** can start immediately. Three integration points:
  1. **Forward-propagation in `updateSocTracking`** — call `estimateSoc` three times with `match.socMin`, `match.socMax`, `match.socBest` (or fall back to `estimatedStartSoc` for legacy rows). Clamp each to `[0, 100]`.
  2. **`captureEventContext` snapshot** — must include `socMin/socMax/bandConfidence/socAsciiBar` to prevent the 2640873 bug class on the `complete` push.
  3. **Drizzle migration** — `chargeSessions` gains `soc_min INTEGER`, `soc_max INTEGER`, `band_confidence REAL` (all nullable; legacy rows degrade to a zero-width band at `estimatedSoc`).
  4. **Tighten band fields to required** on `MatchResult` after every producer in `charge-monitor.ts` is wired.
- **11-03 (notifications)** depends on 11-02's populated event-context fields; no direct dependency on 11-01 except for the `socAsciiBar` rendering input shape (numeric only — `socMin`, `socMax`, `socBest`, `targetSoc`).
- **11-04 (UI)** consumes `ChargeStateEvent` fields populated by 11-02; no direct dependency on 11-01.

## Self-Check: PASSED

- `src/modules/charging/dtw.ts` ✓ exists, contains `SubsequenceDtwResult`
- `src/modules/charging/curve-matcher.ts` ✓ exists, contains `deriveBand` + `DEFAULT_BAND_THRESHOLD_PCT = 0.05`
- `src/modules/charging/curve-matcher.test.ts` ✓ exists, 9 tests
- `src/modules/charging/types.ts` ✓ contains optional `socMin?`/`socMax?`/`socBest?`/`bandConfidence?`
- `src/modules/charging/fixtures/ipad-reference-curve.json` ✓ exists, 8400 points, synthetic comment
- `scripts/fixtures/export-reference-curve.ts` ✓ exists, supports `--synthetic` and `--profile-id`
- Commits in `git log`: `6b97cde` (Task 1), `f29f913` (Task 3), `e5ef26b` (Task 2) ✓ all present

---
*Phase: 11-soc-confidence-band-ascii-visualization*
*Completed: 2026-05-14*
