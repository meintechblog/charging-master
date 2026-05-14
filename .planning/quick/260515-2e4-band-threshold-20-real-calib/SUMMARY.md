---
phase: quick
plan: 260515-2e4
slug: band-threshold-20-real-calib
subsystem: charging
tags: [dtw, soc-band, calibration, ipad, sqlite, vitest]
milestone: v1.3.1

# Dependency graph
requires:
  - phase: 11-soc-confidence-band-ascii-visualization
    provides: "DEFAULT_BAND_THRESHOLD_PCT (synthetic-only calibration), deriveBand(), subsequenceDtw()"
provides:
  - "DEFAULT_BAND_THRESHOLD_PCT pinned at 0.20 via dual-criterion calibration"
  - "Real Session 14 fixture (ipad-session-14-readings.json) anchoring flat-region honest-uncertainty assertion"
  - "scripts/calibration/sweep-real.ts diagnostic for future re-calibration when new device profiles land"
affects: [charging, soc-band, charge-monitor, future-device-profiles]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Dual-criterion calibration test (precision + honest-uncertainty) instead of single-criterion smallest-passing"
    - "Test consumes exported constant rather than hardcoding — future moves don't require touching the test if both criteria still hold"
    - "Real-data fixture committed alongside synthetic one — each anchors a different criterion against the same reference shape"

key-files:
  created:
    - "src/modules/charging/fixtures/ipad-session-14-readings.json — 830-sample real iPad fixture, profile_id=4"
    - "scripts/calibration/sweep-real.ts — CLI sweep diagnostic, defaults profile=4 sessions=16,14,17"
  modified:
    - "src/modules/charging/curve-matcher.ts — DEFAULT_BAND_THRESHOLD_PCT 0.05 → 0.20 + rewritten JSDoc"
    - "src/modules/charging/curve-matcher.test.ts — calibration sweep block rewritten as dual-criterion"
    - "src/components/settings/charging-settings.test.tsx — stale '(0.05)' comment fix"

key-decisions:
  - "Raise DEFAULT_BAND_THRESHOLD_PCT from 0.05 → 0.20 to satisfy honest-uncertainty on real flat-region data without losing taper precision"
  - "Calibration test asserts the property at the exported constant (not a hardcoded literal) so future calibration moves don't churn the test"
  - "Use the synthetic iPad reference for BOTH criteria — only the query varies (synthetic taper vs. real flat) — keeps the test reproducible without DB dependency"
  - "Keep UI input clamp [0.05, 0.50] in charging-settings.tsx as-is — users can still type 0.05 manually if they really want to"
  - "Defer the socBest-stuck-at-31% flat-region wrong-anchor finding to v1.4 (separate DTW-flat-power limitation requiring a stale-power watchdog)"

patterns-established:
  - "Dual-criterion calibration: any threshold/sensitivity constant should be defended by a precision test AND an uncertainty-floor test, both consuming the exported value"
  - "Diagnostic CLI for empirical re-calibration: scripts/calibration/sweep-real.ts is the template for future per-knob diagnostics"

requirements-completed: [v1.3.1-CALIB-01]

# Metrics
duration: ~25min
completed: 2026-05-15
---

# Quick 260515-2e4: Band-Threshold 0.20 Real-Data Calibration

**DEFAULT_BAND_THRESHOLD_PCT raised to 0.20 and defended by a dual-criterion test that pairs synthetic-taper precision (≤ 5) with real Session 14 flat-region honest-uncertainty (≥ 10), preventing the false-confidence band collapse that synthetic-only calibration missed.**

## Performance

- **Duration:** ~25 min
- **Started:** 2026-05-15T01:48Z (worktree spawn)
- **Completed:** 2026-05-15T01:55Z (final source commit)
- **Tasks:** 5
- **Files modified:** 5 (2 created, 3 modified)
- **Net change:** +3589 / −26 lines

## Accomplishments

- **Real-data fixture committed** — 830 power readings from production Session 14 (192.168.3.185, profile_id=4, 2026-04-29, ~69 min, ~40.02 Wh), wrapped in a `_meta` envelope describing source, profile, plug, and purpose.
- **Constant moved** — `DEFAULT_BAND_THRESHOLD_PCT` 0.05 → 0.20 with a JSDoc rewrite that documents both criteria and the deferred v1.4 stale-power-watchdog work.
- **Calibration test rewritten** — single-criterion "smallest threshold that passes synthetic taper" replaced with dual-criterion "current constant satisfies BOTH synthetic taper Δ ≤ 5 AND real flat Δ ≥ 10". The diagnostic sweep `console.log` is preserved for failure debugging. Test consumes `DEFAULT_BAND_THRESHOLD_PCT` directly (no hardcoded 0.20).
- **Diagnostic CLI** — `scripts/calibration/sweep-real.ts` runs the full threshold-vs-window sweep against the local SQLite DB. Default args resolve to profile=4 sessions=16,14,17, matching the sweep that motivated this quick. Documented as the "re-run me when adding a new device profile" tool.
- **Gates green** — `pnpm exec tsc --noEmit` exit 0, `pnpm exec vitest run` 171/171 pass, `pnpm lint` net-neutral vs. baseline (38 problems, all pre-existing; one transient new finding from re-introducing an `eslint-disable-next-line no-console` directive was removed).

## Task Commits

Each task committed atomically on `worktree-agent-ae0828deb6b5c6c1d`:

1. **Task 1: Pull real Session 14 readings → fixture** — `ac6886b` (chore)
2. **Task 2: Raise DEFAULT_BAND_THRESHOLD_PCT to 0.20 + JSDoc rewrite** — `fa63566` (fix)
3. **Task 3: Rewrite calibration sweep as dual-criterion test** — `b242679` (test)
4. **Task 4: Add scripts/calibration/sweep-real.ts diagnostic** — `17afcd2` (chore)
5. **Task 5: Verify gates green pre-deploy** — `65ec60e` (chore)

Plus the SUMMARY.md commit below.

## Files Created/Modified

- `src/modules/charging/fixtures/ipad-session-14-readings.json` (created) — 830-sample iPad Pro 12.9" charge readings, profile_id=4, pulled from 192.168.3.185 production DB.
- `scripts/calibration/sweep-real.ts` (created) — CLI sweep over thresholds × window-minutes × sessions, prints a markdown table per session with bandwidth and socBest at each threshold.
- `src/modules/charging/curve-matcher.ts` (modified) — constant 0.05 → 0.20; JSDoc rewritten to document Criteria A+B, the false-confidence anti-pattern, and the v1.4 deferred socBest-stuck issue.
- `src/modules/charging/curve-matcher.test.ts` (modified) — calibration sweep `describe` block replaced; new `it` asserts both criteria at the exported constant; imports the real-data fixture; diagnostic sweep `console.log` preserved.
- `src/components/settings/charging-settings.test.tsx` (modified) — one-line comment fix dropping the stale "(0.05)" annotation on a placeholder assertion that already references the symbolic constant.

## Decisions Made

- **Use the synthetic reference for both criteria** (per plan). The real-data sweep on 185 used the device's own real reference curve from the DB, but the committed unit test uses the shipped synthetic fixture for both queries to stay DB-free. The threshold still moves the right direction; consequently the test catches Criterion A regressions strictly (taper width sensitive to threshold against synthetic curve) and Criterion B regressions by encoding the contract (width ≥ 10 must hold) — even though the synthetic reference shape gives more margin on Criterion B than the real reference does.
- **Keep the UI input clamp ≥ 0.05** in `charging-settings.tsx`. The plan called this out explicitly: it's a user-input boundary, not a system default. A power user who wants to experiment can still type 0.05.
- **One-line comment fix in `charging-settings.test.tsx`** classified as Rule 1 inline (direct downstream of the constant change) — the assertion already used the symbolic `DEFAULT_BAND_THRESHOLD_PCT`, only the human-readable annotation was stale.
- **Lint-directive removal** (Task 5) — the rewritten test re-introduced a `// eslint-disable-next-line no-console` directive that the current eslint config flags as unused. Removed to keep the change net-neutral vs. baseline.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Doc bug] Stale `(0.05)` parenthetical in `charging-settings.test.tsx`**
- **Found during:** Task 2 (constant change + sanity grep)
- **Issue:** Comment baked the old default into a human-readable annotation. The actual assertion already uses the symbolic constant, so behavior was fine — only the comment was misleading.
- **Fix:** Drop the `(0.05)` parenthetical.
- **Files modified:** `src/components/settings/charging-settings.test.tsx`
- **Verification:** Tests still pass; no other `0.05` references in `src/` masquerade as a band-threshold default.
- **Committed in:** `fa63566` (Task 2 commit)

**2. [Rule 1 - Lint regression] Unused `eslint-disable-next-line no-console` in rewritten test**
- **Found during:** Task 5 (lint gate)
- **Issue:** Rewriting the calibration `describe` block re-introduced the baseline's `// eslint-disable-next-line no-console` directive before `console.log('[calibration-sweep]', sweep)`. Current eslint config permits console.log in tests, so the directive is now unused and flagged as a new warning vs. baseline.
- **Fix:** Remove the directive line.
- **Files modified:** `src/modules/charging/curve-matcher.test.ts`
- **Verification:** `pnpm lint` problem count dropped from 39 → 38 (back to baseline); tsc + vitest still green.
- **Committed in:** `65ec60e` (Task 5 marker commit)

---

**Total deviations:** 2 auto-fixed (both Rule 1 — bug/regression-class)
**Impact on plan:** Neither is scope creep. Both are direct consequences of the in-scope changes (constant value moved; calibration block rewritten).

## Issues Encountered

- **`node_modules` not present in worktree on first run.** First `pnpm exec tsx` call returned `ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL` because the worktree was freshly spawned without a dependency install. Resolved by running `pnpm install` (no-op for the lockfile — no new deps were added by this quick).
- **`src/lib/version.ts` missing on first tsc run.** Generated by `scripts/build/generate-version.mjs` and gitignored. `pnpm run gen:version` produced the file; tsc went clean after. Documented build-step behavior, not a regression.

## Known Stubs

None. No placeholder UI, no empty data sources, no "coming soon" strings — this quick is purely a constant + test + fixture + script change with downstream code untouched.

## Threat Flags

None. No new network endpoints, no auth paths, no file-access patterns, no schema changes at trust boundaries. Pure in-process calibration of a numerical default.

## User Setup Required

None — no environment variables, no external services. The diagnostic script reads the existing local SQLite DB.

## Self-Check: PASSED

- `src/modules/charging/fixtures/ipad-session-14-readings.json` exists (830 readings, valid `_meta`)
- `scripts/calibration/sweep-real.ts` exists (typechecks, argv parses, missing-DB surfaces a clear error)
- `DEFAULT_BAND_THRESHOLD_PCT = 0.20` in `src/modules/charging/curve-matcher.ts`
- Calibration test consumes the exported constant (no `expect(...).toBe(0.20)`), imports `./fixtures/ipad-session-14-readings.json`
- `pnpm exec tsc --noEmit` → exit 0
- `pnpm exec vitest run` → 171/171 pass
- All 5 task commits exist on `worktree-agent-ae0828deb6b5c6c1d`: `ac6886b`, `fa63566`, `b242679`, `17afcd2`, `65ec60e`

## Handoff

**Worktree stops here.** The orchestrator owns push + deploy after merging this branch back into `main`.

### Commits to merge into main

```
ac6886b chore(quick-260515-2e4): pull real Session 14 power readings for band-threshold calibration (v1.3.1)
fa63566 fix(quick-260515-2e4): raise DEFAULT_BAND_THRESHOLD_PCT to 0.20 (v1.3.1)
b242679 test(quick-260515-2e4): rewrite band-threshold calibration as dual-criterion test (v1.3.1)
17afcd2 chore(quick-260515-2e4): add scripts/calibration/sweep-real.ts diagnostic (v1.3.1)
65ec60e chore(quick-260515-2e4): verify gates green pre-deploy (v1.3.1)
```

Plus the SUMMARY.md commit (`docs(quick-260515-2e4): SUMMARY.md`).

### Orchestrator steps (after merge)

```bash
# Push to GitHub origin
git push origin main

# Capture the merged SHA for verification
NEW_SHA=$(git rev-parse origin/main)
SHORT=${NEW_SHA:0:7}

# Trigger self-update on 185 (direct, Host-header required)
curl -fsS -X POST -H 'Content-Type: application/json' -H 'Host: charging-master.local' -d '{}' http://192.168.3.185/api/update/trigger

# Trigger self-update on 117 (via Proxmox CT 100)
ssh root@192.168.2.2 "pct exec 100 -- curl -fsS -X POST -H 'Content-Type: application/json' -d '{}' http://localhost/api/update/trigger"

# Poll 185 until SHA matches
timeout 300 bash -c "until curl -fsS http://192.168.3.185/api/version 2>/dev/null | grep -q \"$SHORT\"; do sleep 8; done"

# Poll 117 until SHA matches
timeout 300 bash -c "until ssh root@192.168.2.2 \"pct exec 100 -- curl -fsS http://localhost/api/version 2>/dev/null\" | grep -q \"$SHORT\"; do sleep 8; done"

# Final health probes
curl -fsS http://192.168.3.185/api/version | grep -q '"dbHealthy":true'
curl -fsS http://192.168.3.185/api/update/status | grep -q '"rollbackHappened":false'
ssh root@192.168.2.2 "pct exec 100 -- curl -fsS http://localhost/api/version" | grep -q '"dbHealthy":true'
ssh root@192.168.2.2 "pct exec 100 -- curl -fsS http://localhost/api/update/status" | grep -q '"rollbackHappened":false'
```

If `rollbackHappened` returns `true` on either host: read `/api/update/status` for `rollbackReason` and `rollbackStage`, surface the failure, and revert via the next quick. The committed change is data-shape-compatible (no schema migration, no new env vars, no new deps) so rollback should be uneventful.

### Future re-calibration trigger

Whenever a new device profile lands (different battery chemistry / charge curve shape), the diagnostic sweep should be re-run before assuming `DEFAULT_BAND_THRESHOLD_PCT = 0.20` still satisfies both criteria for the new profile:

```bash
pnpm exec tsx scripts/calibration/sweep-real.ts --profile-id <NEW_PROFILE_ID> --sessions <ID1,ID2,...>
```

If a new profile demands a different value, plan a follow-up quick that adds a second fixture from a representative session of the new profile and broadens the calibration test to assert both criteria across both profiles.

### Deferred to v1.4

`socBest` anchors to a wrong offset (~31% start-SOC) on real flat-region data **regardless** of threshold. This is a fundamental DTW-flat-power ambiguity (every flat-region offset looks equally good to the matcher), not something a band threshold can fix. The right mitigation is a **stale-power watchdog** that demotes confidence when the live curve has been flat for more than N minutes — that is v1.4 scope and explicitly NOT addressed here.

---
*Phase: quick (v1.3.1)*
*Completed: 2026-05-15*
