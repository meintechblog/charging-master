---
phase: quick
plan: 260515-2e4
slug: band-threshold-20-real-calib
type: execute
wave: 1
depends_on: []
autonomous: true
milestone: v1.3.1
requirements: [v1.3.1-CALIB-01]
files_modified:
  - src/modules/charging/curve-matcher.ts
  - src/modules/charging/curve-matcher.test.ts
  - src/modules/charging/fixtures/ipad-session-14-readings.json
  - scripts/calibration/sweep-real.ts

must_haves:
  truths:
    - "DEFAULT_BAND_THRESHOLD_PCT exported from src/modules/charging/curve-matcher.ts equals 0.20 (not 0.05)"
    - "Calibration test asserts Criterion A (synthetic taper bandwidth ≤ 5) AND Criterion B (real Session 14 first-120 bandwidth ≥ 10) at the current value of DEFAULT_BAND_THRESHOLD_PCT, and consumes the exported constant rather than hardcoding 0.20"
    - "src/modules/charging/fixtures/ipad-session-14-readings.json exists with a `_meta` header + an array of ~830 {apower,timestamp} entries pulled from production Session 14 on 192.168.3.185"
    - "scripts/calibration/sweep-real.ts runs end-to-end against the LXC DB and prints the threshold-vs-window sweep table; default CLI args resolve to profile=4 sessions=16,14,17"
    - "pnpm exec tsc --noEmit exits 0 AND pnpm exec vitest run reports all tests pass (≥ 171)"
    - "Both LXCs (192.168.3.185 and 192.168.2.117 via Proxmox CT 100) report the new commit SHA on /api/version with dbHealthy=true AND /api/update/status with rollbackHappened=false after self-update"

  artifacts:
    - path: src/modules/charging/curve-matcher.ts
      provides: "DEFAULT_BAND_THRESHOLD_PCT = 0.20 (line ~33), JSDoc updated to reference the dual-criterion calibration (synthetic taper + real Session 14 flat region) instead of the smallest-passing-threshold rationale"
    - path: src/modules/charging/curve-matcher.test.ts
      provides: "Rewritten 'DEFAULT_BAND_THRESHOLD_PCT empirical calibration sweep' test enforcing both Criterion A and Criterion B at the exported constant; sweep table console.log preserved for diagnostic value"
    - path: src/modules/charging/fixtures/ipad-session-14-readings.json
      provides: "Real iPad Pro 12.9 power readings from production Session 14 (profile_id=4, 2026-04-29, ~69 min, ~40.02 Wh, ~830 samples)"
    - path: scripts/calibration/sweep-real.ts
      provides: "One-off diagnostic that loads a profile's reference curve + slices of N real session(s) from the local SQLite DB and runs subsequenceDtw + deriveBand across thresholds [0.05, 0.10, 0.20, 0.30] against query windows (10/20/40/70 min). Reproduces the table that motivated this quick."

  key_links:
    - from: "src/modules/charging/curve-matcher.test.ts"
      to: "src/modules/charging/curve-matcher.ts (DEFAULT_BAND_THRESHOLD_PCT)"
      via: "named import; assertion uses `DEFAULT_BAND_THRESHOLD_PCT` directly (no hardcoded 0.20)"
      pattern: "DEFAULT_BAND_THRESHOLD_PCT"
    - from: "src/modules/charging/curve-matcher.test.ts"
      to: "src/modules/charging/fixtures/ipad-session-14-readings.json"
      via: "JSON import (`import session14 from './fixtures/ipad-session-14-readings.json'`); test slices `session14.readings.slice(0, 120)` for Criterion B"
      pattern: "ipad-session-14-readings"

success_gates:
  - gate: typecheck
    command: "pnpm exec tsc --noEmit"
    expect: "exit 0 (no type errors)"
  - gate: tests
    command: "pnpm exec vitest run"
    expect: "all tests pass; calibration sweep test passes at 0.20 satisfying BOTH criteria; total test count ≥ 171"
  - gate: lint
    command: "pnpm lint"
    expect: "no NEW findings beyond the pre-existing documented backlog (compare against pre-change baseline if needed)"
  - gate: deploy-185
    command: "curl -fsS -X POST -H 'Content-Type: application/json' -H 'Host: charging-master.local' -d '{}' http://192.168.3.185/api/update/trigger && (until curl -fsS http://192.168.3.185/api/version | grep -q \"${NEW_SHA:0:7}\"; do sleep 8; done) && curl -fsS http://192.168.3.185/api/version | grep -q '\"dbHealthy\":true' && curl -fsS http://192.168.3.185/api/update/status | grep -q '\"rollbackHappened\":false'"
    expect: "trigger returns 202; /api/version eventually reports new SHA with dbHealthy=true; /api/update/status shows rollbackHappened=false"
  - gate: deploy-117
    command: "ssh root@192.168.2.2 \"pct exec 100 -- curl -fsS -X POST -H 'Content-Type: application/json' -d '{}' http://localhost/api/update/trigger\" && (until ssh root@192.168.2.2 \"pct exec 100 -- curl -fsS http://localhost/api/version\" | grep -q \"${NEW_SHA:0:7}\"; do sleep 8; done) && ssh root@192.168.2.2 \"pct exec 100 -- curl -fsS http://localhost/api/version\" | grep -q '\"dbHealthy\":true' && ssh root@192.168.2.2 \"pct exec 100 -- curl -fsS http://localhost/api/update/status\" | grep -q '\"rollbackHappened\":false'"
    expect: "trigger returns 202 inside CT 100; /api/version eventually reports new SHA with dbHealthy=true; /api/update/status shows rollbackHappened=false"
---

<objective>
Quick patch (v1.3.1) replacing the synthetic-only band-threshold calibration with a dual-criterion calibration anchored on a real iPad session.

**Problem.** Plan 11-01 pinned `DEFAULT_BAND_THRESHOLD_PCT = 0.05` by picking the *smallest* threshold that satisfied a single criterion (synthetic-iPad taper bandwidth ≤ 5). A sweep against production Session 14 today shows 0.05 is too tight on real flat-region data — band collapses to Δ=0 after only ~10 min, exactly the false-confidence anti-pattern v1.3 was supposed to prevent.

**Fix.** Raise the constant to 0.20 (keeps Δ=17 in flat region, still collapses to Δ=5 in taper), commit a real Session 14 fixture, replace the "smallest" criterion with an honest two-sided test (precision in taper + uncertainty in flat region), and save the diagnostic script for future re-calibration when new device profiles land.

Purpose: prevent false-confidence band collapse on real flat-power chargers without sacrificing taper-region precision.
Output: 1 constant change, 1 test rewrite, 1 new fixture, 1 new diagnostic script, deployed to both LXCs.

Out of scope (flagged for v1.4 in commit message of Task 1): the `socBest`-stuck-at-31% finding on flat-region matching is a separate DTW-flat-power limitation requiring a stale-power-watchdog — NOT touched here.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/STATE.md
@./CLAUDE.md
@.planning/phases/11-soc-confidence-band-ascii-visualization/11-01-SUMMARY.md
@src/modules/charging/curve-matcher.ts
@src/modules/charging/curve-matcher.test.ts
@src/modules/charging/fixtures/ipad-reference-curve.json

<interfaces>
<!-- Key types and contracts the executor will use. Already exists in tree. -->

From src/modules/charging/curve-matcher.ts:
- export const DEFAULT_BAND_THRESHOLD_PCT = 0.05;  // → change to 0.20
- export function deriveBand(distances: Float64Array, windowStep: number, curvePoints, totalDurationSeconds: number, thresholdPct: number): { socMin, socMax, socBest, bandConfidence }

From src/modules/charging/dtw.ts:
- export function subsequenceDtw(query: number[], reference: number[]): { offset, distance, distances: Float64Array, windowStep }

Fixture shape (existing synthetic at src/modules/charging/fixtures/ipad-reference-curve.json):
- { _comment: string, profileId: number, durationSeconds: number, totalEnergyWh: number, pointCount: number, points: Array<{ offsetSeconds, apower, cumulativeWh }> }

New fixture shape (real Session 14 power readings — different schema, raw plug readings not a reference curve):
- { _meta: { source: string, profileId: number, sessionId: number, capturedAt: string, durationMinutes: number, totalEnergyWh: number, plugId: string, sampleCount: number }, readings: Array<{ apower: number, timestamp: number }> }

Other consumers of DEFAULT_BAND_THRESHOLD_PCT (must NOT break):
- src/modules/charging/stop-mode.ts (uses constant as fallback when `charging.bandThreshold` config row absent)
- src/modules/charging/stop-mode.test.ts (asserts `readBandThreshold() === DEFAULT_BAND_THRESHOLD_PCT` for several scenarios — passes regardless of the literal value because both sides reference the same export)
- src/components/settings/charging-settings.tsx (uses constant as input placeholder and as default for `initialThreshold`); validation accepts `>= 0.05 && <= 0.5` — 0.20 still in range
- src/components/settings/charging-settings.test.tsx (asserts `input.placeholder === String(DEFAULT_BAND_THRESHOLD_PCT)` — passes regardless of literal value)
</interfaces>

<deploy_targets>
LXC topology (from MEMORY.md reference_lxc_topology):
- 192.168.3.185 — direct SSH (`ssh root@charging-master.local`), self-update via `curl -X POST http://192.168.3.185/api/update/trigger` (Host header `charging-master.local` required per host-guard)
- 192.168.2.117 — via Proxmox host `root@192.168.2.2`, container 100 (`pct exec 100 -- curl http://localhost/api/update/trigger`)

DB extraction command (from task description, copy verbatim):
```
ssh root@charging-master.local "sqlite3 /opt/charging-master/data/charging-master.db \"SELECT json_group_array(json_object('apower',apower,'timestamp',timestamp)) FROM power_readings WHERE plug_id='shellyplugsg3-d885ac15b828' AND timestamp BETWEEN (SELECT started_at FROM charge_sessions WHERE id=14) AND (SELECT stopped_at FROM charge_sessions WHERE id=14) ORDER BY timestamp ASC\""
```

Reference: original diagnostic script lives on 185 at `/opt/charging-master/scripts/calibration-sweep-real.ts` — pull via `scp` or rewrite cleanly.
</deploy_targets>
</context>

<tasks>

<task type="auto">
  <name>Task 1: Pull real Session 14 readings → new fixture file</name>
  <files>src/modules/charging/fixtures/ipad-session-14-readings.json</files>
  <action>
    Pull the 830 raw power readings of production Session 14 from the 185 LXC SQLite DB via SSH and commit them as a new fixture file. This is a NEW fixture — it does NOT replace `ipad-reference-curve.json` (which stays as the synthetic reference curve used by other tests); the two coexist.

    Steps:
    1. Run the extraction command verbatim from `<deploy_targets>` above. Capture stdout to a temp file (e.g. `/tmp/sess14-readings.json`).
    2. Validate: `jq 'length' /tmp/sess14-readings.json` should print roughly 830 (any number in 800–900 is acceptable; if it returns 0 or null, abort and surface the error).
    3. Also pull session metadata for the `_meta` block: `ssh root@charging-master.local "sqlite3 -json /opt/charging-master/data/charging-master.db \"SELECT plug_id, started_at, stopped_at, started_at AS captured_at_unix, (stopped_at - started_at) / 60 AS duration_minutes, profile_id FROM charge_sessions WHERE id=14\""` — extract `plug_id` (will be `shellyplugsg3-d885ac15b828`), `profile_id` (expected 4), `started_at` epoch, and total Wh by `SELECT total_energy_wh FROM charge_sessions WHERE id=14` (expected ~40.02).
    4. Wrap the readings array into the final JSON shape:
       ```
       {
         "_meta": {
           "source": "production DB on 192.168.3.185 (/opt/charging-master/data/charging-master.db), table=power_readings",
           "profileId": 4,
           "profileName": "iPad Pro 12.9\"",
           "sessionId": 14,
           "capturedAt": "2026-04-29T...",   // ISO string from started_at epoch
           "durationMinutes": 69,
           "totalEnergyWh": 40.02,
           "plugId": "shellyplugsg3-d885ac15b828",
           "sampleCount": <actual length>,
           "purpose": "Anchors the dual-criterion calibration in curve-matcher.test.ts (Criterion B: first 120 samples ≈ 10 min flat region must yield bandwidth >= 10 at DEFAULT_BAND_THRESHOLD_PCT)."
         },
         "readings": [ { "apower": ..., "timestamp": ... }, ... ]
       }
       ```
    5. Write to `src/modules/charging/fixtures/ipad-session-14-readings.json`. Pretty-print is acceptable but not required (a single-line JSON is fine — the synthetic fixture is pretty-printed but it's only for diff-readability; this fixture is rarely diffed).
    6. Sanity check the first 5 readings: power values should be in the rough range 30–55 W (iPad flat-region charge); if everything is 0 or all `null`, the extraction failed and the fixture is invalid.

    Atomic commit message: `chore(fixtures): pull real Session 14 power readings for band-threshold calibration (v1.3.1)`.
  </action>
  <verify>
    <automated>test -f src/modules/charging/fixtures/ipad-session-14-readings.json && node -e "const f = require('./src/modules/charging/fixtures/ipad-session-14-readings.json'); if (!f._meta || !Array.isArray(f.readings) || f.readings.length < 700 || f.readings.length > 950) { console.error('bad fixture shape or size', f.readings?.length); process.exit(1); } if (f._meta.sessionId !== 14 || f._meta.profileId !== 4) { console.error('bad metadata'); process.exit(1); } const first = f.readings[0]; if (typeof first.apower !== 'number' || typeof first.timestamp !== 'number') { console.error('bad reading shape', first); process.exit(1); } console.log('OK', f.readings.length, 'readings, first apower=', first.apower);"</automated>
  </verify>
  <done>Fixture committed at the target path. `_meta.sessionId === 14`, `_meta.profileId === 4`, `readings.length` between 700 and 950, every reading has numeric `apower` + `timestamp`.</done>
</task>

<task type="auto">
  <name>Task 2: Raise DEFAULT_BAND_THRESHOLD_PCT to 0.20 + update JSDoc</name>
  <files>src/modules/charging/curve-matcher.ts</files>
  <action>
    Single-line constant change plus a JSDoc rewrite that documents the new dual-criterion rationale.

    1. Change `export const DEFAULT_BAND_THRESHOLD_PCT = 0.05;` → `export const DEFAULT_BAND_THRESHOLD_PCT = 0.20;` (line ~33).
    2. Rewrite the JSDoc block immediately preceding the constant (currently lines ~20–32). Replace the "smallest threshold from [0.05, 0.10, 0.15, 0.20, 0.30] that collapses the band to ≤ 5 % during the taper region" rationale with a description of the dual-criterion calibration:
       - Criterion A (taper precision): synthetic-iPad-shaped fixture taper region — bandwidth must collapse to ≤ 5.
       - Criterion B (flat honest-uncertainty): real Session 14 first ~10 min flat region — bandwidth must remain ≥ 10 to avoid the false-confidence anti-pattern (Plan 11-01 originally pinned 0.05, but real-data sweep showed it gave Δ=0 on the same slice — a false-confidence collapse).
       - State that `curve-matcher.test.ts` enforces BOTH criteria at this value; lowering the constant will fail the test.
       - Keep the audiolabs-erlangen MIR C7S2 reference; it's still the underlying technique.
    3. **Sanity grep**: run `grep -rn "0\.05" src/modules/charging` and confirm no remaining literal `0.05` is masquerading as a band-threshold default (the `stop-mode.test.ts` and `charging-settings.tsx` references to `DEFAULT_BAND_THRESHOLD_PCT` are symbolic, not literal — those are fine). The `charging-settings.tsx` validation lower bound (`>= 0.05`) is a UI input clamp, NOT a default — leave it; users can still type 0.05 in the advanced field if they really want to.

    Atomic commit message:
    ```
    fix(charging): raise DEFAULT_BAND_THRESHOLD_PCT to 0.20 (v1.3.1)

    Real-data sweep against production Session 14 (192.168.3.185) showed thr=0.05
    collapses the band to Δ=0 in the first 10 min of flat-power readings — exactly
    the false-confidence anti-pattern v1.3 wanted to prevent. thr=0.20 keeps the
    band realistic-wide in flat region (Δ=17-29) and still collapses to Δ=5 in
    taper. Synthetic-fixture taper test still passes at 0.20 (Δ=4).

    Out of scope (v1.4): socBest gets stuck around 31% throughout flat-region
    matching regardless of threshold — DTW-flat-power limitation requiring a
    stale-power-watchdog. Not addressed here.
    ```
  </action>
  <verify>
    <automated>grep -q "DEFAULT_BAND_THRESHOLD_PCT = 0.20" src/modules/charging/curve-matcher.ts && ! grep -q "DEFAULT_BAND_THRESHOLD_PCT = 0.05" src/modules/charging/curve-matcher.ts</automated>
  </verify>
  <done>Constant is 0.20; JSDoc no longer references "smallest threshold"; no other production code path defaults band threshold to 0.05.</done>
</task>

<task type="auto">
  <name>Task 3: Rewrite calibration sweep test (dual criterion, consumes exported constant)</name>
  <files>src/modules/charging/curve-matcher.test.ts</files>
  <action>
    Replace the existing `describe('DEFAULT_BAND_THRESHOLD_PCT empirical calibration sweep ...')` block (currently lines ~176–210) with a rewritten version that enforces two criteria simultaneously. Keep every other test in the file unchanged.

    New test structure:
    1. Import the new fixture at the top of the file (next to existing `import ipadFixture from './fixtures/ipad-reference-curve.json';`):
       ```ts
       import session14 from './fixtures/ipad-session-14-readings.json';
       ```
    2. The new describe block enforces three things at the **exported** `DEFAULT_BAND_THRESHOLD_PCT` (do NOT hardcode 0.20 in any assertion):
       - **Diagnostic sweep**: still iterate thresholds `[0.05, 0.10, 0.15, 0.20, 0.30]` against the synthetic-iPad taper query (existing query: `Array.from({ length: 60 }, (_, i) => 10 - i * (5 / 60))`) and `console.log('[calibration-sweep]', sweep)`. This is purely diagnostic value for failure debugging.
       - **Criterion A (taper precision)**: at `DEFAULT_BAND_THRESHOLD_PCT`, the band derived from the synthetic-iPad taper query has `socMax - socMin <= 5`. Run `subsequenceDtw(taperQuery, referencePowers)` then `deriveBand(..., DEFAULT_BAND_THRESHOLD_PCT)`, assert `bandWidth <= 5`.
       - **Criterion B (flat honest-uncertainty)**: at `DEFAULT_BAND_THRESHOLD_PCT`, using the FIRST 120 readings of Session 14 (≈ 10 min at 5 s polling) as the query against the **synthetic-iPad reference curve** (`ipadFixture.points.map(p => p.apower)`), the derived band has `socMax - socMin >= 10`.
         - Build the query as `session14.readings.slice(0, 120).map(r => r.apower)`.
         - Use the same synthetic `ipadFixture` reference curve that Criterion A uses — both criteria are calibrated against the same reference profile because that's the only iPad reference curve we ship; only the query changes (synthetic taper vs. real flat readings).
         - Assert `bandWidth >= 10`.
    3. Test name: `'enforces both taper-precision (Criterion A) and flat-region honest-uncertainty (Criterion B) at DEFAULT_BAND_THRESHOLD_PCT'`.
    4. Add a brief comment block above the test describing the failure modes:
       - If Criterion A fails → threshold is too loose, taper region no longer uniquely localizes → consumers see falsely wide bands in the precision phase.
       - If Criterion B fails → threshold is too tight, flat region collapses to a point → false-confidence anti-pattern (the v1.3.1 regression this test exists to prevent).
       - Lowering `DEFAULT_BAND_THRESHOLD_PCT` back to 0.10 or 0.05 will fail Criterion B; raising it past ~0.30 risks failing Criterion A.

    Constraint: **never write `expect(...).toBe(0.20)`** anywhere. The constant value is intentionally not hardcoded in assertions — the test should remain valid if a future calibration moves the constant up to e.g. 0.25.
  </action>
  <verify>
    <automated>pnpm exec vitest run src/modules/charging/curve-matcher.test.ts 2>&1 | tee /tmp/cm.log; grep -q 'Criterion A\|Criterion B\|enforces both' /tmp/cm.log && grep -Eq '[0-9]+ passed' /tmp/cm.log && ! grep -q 'expect.*toBe(0\.20)' src/modules/charging/curve-matcher.test.ts && grep -q "import session14 from './fixtures/ipad-session-14-readings.json'" src/modules/charging/curve-matcher.test.ts</automated>
  </verify>
  <done>Calibration test rewritten with both criteria, passes at the current value of `DEFAULT_BAND_THRESHOLD_PCT` (0.20), consumes the exported constant (no hardcoded 0.20), imports the new real-data fixture, preserves the diagnostic sweep `console.log`. No other tests in the file are touched.</done>
</task>

<task type="auto">
  <name>Task 4: Add scripts/calibration/sweep-real.ts diagnostic script</name>
  <files>scripts/calibration/sweep-real.ts</files>
  <action>
    Create the diagnostic CLI that reproduces today's table. The original lives on 185 at `/opt/charging-master/scripts/calibration-sweep-real.ts` — preferred path is to pull it down with `scp root@charging-master.local:/opt/charging-master/scripts/calibration-sweep-real.ts /tmp/sweep-real.ts` and adapt it to the project conventions. If the file is not retrievable, write it from scratch following the spec below.

    Required behaviour:
    1. CLI args parsed from `process.argv.slice(2)`:
       - `--profile-id <N>` (default: `4`)
       - `--sessions <id1,id2,...>` (default: `16,14,17`)
       - `--thresholds <a,b,c>` (default: `0.05,0.10,0.20,0.30`)
       - `--windows <minutes,...>` (default: `10,20,40,70`)
       - `--db <path>` (default: env `DATABASE_FILE` or `./data/charging-master.db`)
    2. Load the reference curve for `--profile-id` from `device_profiles` + `curve_points` (consult `src/db/schema.ts` for the exact column names; reuse Drizzle if it makes the script trivially smaller, or use better-sqlite3 directly — either is acceptable, the script is one-off).
    3. For each session id: load all `power_readings` between the session's `started_at` and `stopped_at`. For each `--windows` minute slice (`N`), take the first `N * 12` readings (assuming 5 s polling; if the dataset is sparser, take all readings whose timestamp is within N minutes of `started_at`).
    4. For each (session, window, threshold) tuple, run `subsequenceDtw(querySlice, referencePowers)` then `deriveBand(..., threshold)`. Print a table to stdout with columns: `session | window(min) | thr | socMin | socMax | bandWidth | socBest`. Mirror the format from today's sweep output (where Δ=0 was rendered as `⚠`).
    5. Header comment at the top of the file:
       ```ts
       /**
        * One-off diagnostic. Run after exporting a new device profile to confirm
        * DEFAULT_BAND_THRESHOLD_PCT still produces sensible bands against real data.
        *
        *   pnpm tsx scripts/calibration/sweep-real.ts
        *   pnpm tsx scripts/calibration/sweep-real.ts --profile-id 7 --sessions 42,43
        *
        * Reads the local SQLite DB (./data/charging-master.db by default).
        * NOT covered by tests — empirical sanity check only.
        */
       ```
    6. No tests required for this file. No new dependencies (use what's already in `package.json`: better-sqlite3 or drizzle-orm + the existing `subsequenceDtw` / `deriveBand` modules via `@/modules/charging/*` imports).
    7. The `scripts/calibration/` directory does not exist yet — `mkdir -p scripts/calibration` before writing.

    Atomic commit message: `chore(scripts): add calibration/sweep-real.ts diagnostic (v1.3.1)`.
  </action>
  <verify>
    <automated>test -f scripts/calibration/sweep-real.ts && pnpm exec tsc --noEmit scripts/calibration/sweep-real.ts 2>&1 | tee /tmp/sweep-tsc.log; ! grep -E '^(error|.*\.ts.*error TS)' /tmp/sweep-tsc.log | grep -q .</automated>
  </verify>
  <done>Script committed at the target path, typechecks cleanly, has the header comment block, parses the documented CLI args with the documented defaults. (Running against a live DB is not part of automated verification — but a quick manual smoke is encouraged: `pnpm tsx scripts/calibration/sweep-real.ts --db /tmp/test.db || true` should at least parse args before exiting on missing DB.)</done>
</task>

<task type="auto">
  <name>Task 5: Full gate sweep + push + deploy to both LXCs + post-deploy verify</name>
  <files>(no source changes — gate run + deploy automation)</files>
  <action>
    Run all gates locally, then deploy + verify on both LXCs.

    Steps:
    1. Capture commit SHA: `NEW_SHA=$(git rev-parse HEAD)` (run after Tasks 1–4 are committed). Export for the deploy step below.
    2. Local gates:
       - `pnpm exec tsc --noEmit` → exit 0
       - `pnpm exec vitest run` → all tests pass (calibration test passes at 0.20 satisfying both criteria; total ≥ 171)
       - `pnpm lint` → no NEW findings vs. pre-change baseline (the project has a documented backlog of pre-existing findings — if `pnpm lint` exits non-zero, diff the output against `git stash && pnpm lint` to confirm no NEW lines were added by this quick)
    3. If any gate fails, fix the underlying issue and create a NEW commit (do not amend). Re-run gates.
    4. Push: `git push origin main` (single push, all four task commits).
    5. Trigger update on 185:
       ```
       curl -fsS -X POST -H 'Content-Type: application/json' -H 'Host: charging-master.local' -d '{}' http://192.168.3.185/api/update/trigger
       ```
       Expected response: HTTP 202 with `{"status":"triggered"}` or similar.
    6. Trigger update on 117 (via Proxmox CT 100):
       ```
       ssh root@192.168.2.2 "pct exec 100 -- curl -fsS -X POST -H 'Content-Type: application/json' -d '{}' http://localhost/api/update/trigger"
       ```
    7. Poll both LXCs until they report the new SHA. Run these two background loops in parallel (each with a 5-min timeout):
       ```bash
       # 185
       SHORT=${NEW_SHA:0:7}
       timeout 300 bash -c "until curl -fsS http://192.168.3.185/api/version 2>/dev/null | grep -q \"$SHORT\"; do sleep 8; done"
       # 117
       timeout 300 bash -c "until ssh root@192.168.2.2 \"pct exec 100 -- curl -fsS http://localhost/api/version 2>/dev/null\" | grep -q \"$SHORT\"; do sleep 8; done"
       ```
    8. Post-deploy verification on BOTH LXCs:
       - `curl -fsS http://192.168.3.185/api/version` → JSON has `"sha":"<NEW_SHA>..."`, `"dbHealthy":true`
       - `curl -fsS http://192.168.3.185/api/update/status` → JSON has `"rollbackHappened":false`
       - Same two probes via `ssh root@192.168.2.2 "pct exec 100 -- curl ..."` for 117.
       - If `rollbackHappened` is `true` on either host: STOP — read `/api/update/status` for `rollbackReason` and `rollbackStage`, surface the failure to the user, do NOT mark this task done.
    9. Atomic commit for any gate-fix touch-ups (if needed). The deploy itself is not a commit — it's a side effect of `git push`.
  </action>
  <verify>
    <automated>NEW_SHA=$(git rev-parse HEAD); SHORT=${NEW_SHA:0:7}; pnpm exec tsc --noEmit && pnpm exec vitest run && curl -fsS http://192.168.3.185/api/version | grep -q "$SHORT" && curl -fsS http://192.168.3.185/api/version | grep -q '"dbHealthy":true' && curl -fsS http://192.168.3.185/api/update/status | grep -q '"rollbackHappened":false' && ssh root@192.168.2.2 "pct exec 100 -- curl -fsS http://localhost/api/version" | grep -q "$SHORT" && ssh root@192.168.2.2 "pct exec 100 -- curl -fsS http://localhost/api/version" | grep -q '"dbHealthy":true' && ssh root@192.168.2.2 "pct exec 100 -- curl -fsS http://localhost/api/update/status" | grep -q '"rollbackHappened":false'</automated>
  </verify>
  <done>tsc + vitest + lint all green locally. `git push origin main` succeeded. Both LXCs report `/api/version` with new SHA + `dbHealthy:true`, and `/api/update/status` with `rollbackHappened:false`. v1.3.1 is live on both 192.168.3.185 and 192.168.2.117.</done>
</task>

</tasks>

<verification>
End-to-end checks (run after all five tasks complete):

1. `grep -n "DEFAULT_BAND_THRESHOLD_PCT = " src/modules/charging/curve-matcher.ts` → exactly `0.20`
2. `pnpm exec vitest run src/modules/charging/curve-matcher.test.ts` → calibration test passes; `[calibration-sweep]` table printed; no `expect(...).toBe(0.20)` in the test file
3. `pnpm exec vitest run` → ≥ 171 tests pass, 0 failed
4. `pnpm exec tsc --noEmit` → exit 0
5. `node -e "const f=require('./src/modules/charging/fixtures/ipad-session-14-readings.json'); console.log(f._meta.sessionId, f._meta.profileId, f.readings.length);"` → `14 4 <700–950>`
6. `test -f scripts/calibration/sweep-real.ts && head -1 scripts/calibration/sweep-real.ts` → file present, starts with `/**`
7. Both LXCs respond on `/api/version` with the new SHA + `dbHealthy:true`; `/api/update/status` shows `rollbackHappened:false`.
</verification>

<success_criteria>
- `DEFAULT_BAND_THRESHOLD_PCT === 0.20` in `src/modules/charging/curve-matcher.ts`.
- Calibration test enforces Criterion A (synthetic taper Δ ≤ 5) AND Criterion B (real Session 14 first-120 Δ ≥ 10) using the exported constant (no hardcoded 0.20).
- Real Session 14 fixture committed with `_meta` header and ~800 readings.
- Diagnostic script committed at `scripts/calibration/sweep-real.ts` and typechecks cleanly.
- Local gates green: tsc, vitest (≥ 171 pass), lint (no new findings).
- v1.3.1 deployed to both LXCs (185 + 117) without rollback; both `/api/version` healthy.
</success_criteria>

<output>
After completion, create `.planning/quick/260515-2e4-band-threshold-20-real-calib/SUMMARY.md` per `@$HOME/.claude/get-shit-done/templates/summary.md`.

Highlights to include in SUMMARY.md:
- The dual-criterion calibration insight (real data exposed false-confidence collapse at 0.05; 0.20 satisfies both criteria).
- The deferred v1.4 finding: socBest stuck at ~31% in flat-region matching is a separate DTW-flat-power limitation that wants a stale-power-watchdog. NOT addressed in v1.3.1.
- Diagnostic script location + intended trigger (`pnpm tsx scripts/calibration/sweep-real.ts` after exporting a new device profile).
- Final commit SHA + confirmation both LXCs are healthy on it.
</output>
