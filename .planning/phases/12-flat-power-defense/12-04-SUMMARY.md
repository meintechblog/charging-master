---
phase: 12-flat-power-defense
plan: 04
subsystem: ui
tags: [ui, watchdog, react, sse, localstorage, settings, autosave, fpd]

# Dependency graph
requires:
  - phase: 12-flat-power-defense
    provides: ChargeStateEvent watchdog fields (watchdogKind, stalePowerSeconds, stalePowerFiresAt, stopMode), backend abort flow (12-01), adaptive matcher refresh + energy fallback (12-02), session-timeout watchdog (12-03)
provides:
  - "ChargeBanner watchdog UI — yellow warning bar (kind=warning) + red fired banner (kind=fired) with Acknowledge button"
  - "deriveWatchdogFraction(kind, secondsAtZero, firesAtMs, now) — named export, NaN/edge-guarded fraction helper, returns 0 outside kind='warning'"
  - "localStorage ack key shape: charging-watchdog-ack-${sessionId}, set on click, read via useState initializer + useEffect on firedSessionId change (M3 re-arm)"
  - "ChargingSettings Advanced subsection 'Flat-Power Defense (Phase 12)' with 5 useAutoSave inputs for stalePowerThresholdW, stalePowerWindowSec, matcherRefreshReadings, lowConfidenceThreshold, maxSessionHours"
  - "Constant-parity test (charging-settings.test.ts) — reads inlined client-bundle defaults from disk and asserts equality with server-side stop-mode.ts exports"
affects: []

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Inlined client-bundle constants + textual parity test — keep server-only modules (better-sqlite3, db/client) out of 'use client' components without sacrificing single-source-of-truth"
    - "Top-level overlay fragment for state-orthogonal UI — render the fired banner above every state-branch return so it survives the post-abort 'none'-kind event flicker without coupling to specific state strings"
    - "useEffect re-read on prop-change (M3 pattern) — useState initializer covers initial render + SSR; useEffect on [keyProp] covers prop-change after mount, so a reload mid-session that delivers a new sessionId via SSE-snapshot correctly re-checks localStorage"

key-files:
  created:
    - src/components/charging/charge-banner.test.tsx
    - src/components/settings/charging-settings.test.ts
  modified:
    - src/components/charging/charge-banner.tsx
    - src/components/settings/charging-settings.tsx

key-decisions:
  - "Extended ChargeBanner instead of creating a sibling WatchdogBanner — keeps banner state machine + plug-identity rendering + abort UI in one place; firedOverlay is a fragment that wraps every state-branch return so it's orthogonal to the active state."
  - "Inlined the five DEFAULT_* constants in charging-settings.tsx instead of importing from stop-mode.ts — server module's transitive imports (db/client → better-sqlite3 → bindings → fs) cannot enter the client bundle. Parity test guards against drift."
  - "deriveWatchdogFraction is a NAMED EXPORT, not a closure — unit-testable independently of the rendered tree, covers all NaN/div-by-zero edges in pure-function space."
  - "useEffect on [firedSessionId] (not [sessionId]) re-reads localStorage — the trigger is 'a fired event arrived for a new session', not 'the active session changed'. firedSessionId === undefined → ack cleared, preventing a stale ack from blocking the next fire."
  - "Warning sub-render gated on state ∈ {charging, countdown} — backend can leak watchdogKind='warning' in detecting/matched/aborted under buggy conditions; UI defense-in-depth never paints the bar outside the active branches."

patterns-established:
  - "Constant-parity test via source-file regex read — for cases where DRY-via-import would drag server-only dependencies into the client bundle, duplicate the literal and pin the duplicate with a textual test."

requirements-completed: [FPD-05]

# Metrics
duration: 10min
completed: 2026-05-15
---

# Phase 12 Plan 04: FPD-05 UI Watchdog Indicators + Settings Summary

**ChargeBanner now surfaces the Phase-12 watchdog: a yellow 'Watchdog: 0 W seit Xs' bar (kind=warning) inside the active session view and a red 'Session abgebrochen — Battery full?' banner with Acknowledge (kind=fired) that persists dismissal in localStorage keyed by sessionId. ChargingSettings exposes all five Phase-12 config rows in an 'Flat-Power Defense' subsection under Advanced.**

## Performance

- **Duration:** ~10 min
- **Started:** 2026-05-15T02:20:00Z (approx)
- **Completed:** 2026-05-15T02:30:00Z (approx)
- **Tasks:** 3 (4 commits — RED + GREEN for Task 1, single commit each for Tasks 2 and the Rule-3 fix; Task 3 is the verification gate, no separate commit)
- **Files modified:** 4 (2 created, 2 modified)

## Accomplishments

- **ChargeBanner watchdog sub-renders (Task 1, RED+GREEN):**
  - `deriveWatchdogFraction(kind, secondsAtZero, firesAtMs, now)` is a named export, NaN-guarded across all edges (firesAt < now → 1, both 0 → 0, firesAt undefined in warning → 0 or 1 based on secondsAtZero). Returns 0 for any non-warning kind so the caller can hide the bar unconditionally.
  - Yellow warning sub-render lives INSIDE the active-states branch, gated on `watchdogKind === 'warning' && state ∈ {charging, countdown}`. Bar width derived via the fraction helper; mirrors detection-progress bar styling (amber-400 fill, h-1.5 track, transition-[width] duration-500). Label: `Watchdog: 0 W seit Xs · Akku evtl. voll — bricht automatisch ab`.
  - Red fired banner is a TOP-LEVEL OVERLAY fragment rendered above every state-branch return — survives the post-abort flicker when SSE emits subsequent 'none'-kind events. Contains plug identity, profile name (if known), and an Acknowledge button. Click writes `localStorage.setItem('charging-watchdog-ack-${sessionId}', '1')` and hides the banner.
  - `firedSnapshot` local state captures the last fired event so the banner survives subsequent 'none'-kind events on the same SSE stream. Cleared naturally when a new sessionId fires.
  - **M3 useEffect:** `useEffect(() => { ... }, [firedSessionId])` re-reads localStorage on sessionId change. A reload mid-session that delivers a new sessionId via SSE-snapshot re-checks ack state; a new session that fires uses a different storage key, so the banner re-arms naturally.

- **ChargingSettings — 5 new advanced inputs (Task 2):**
  - New 'Flat-Power Defense (Phase 12)' subsection under the Advanced toggle, visually separated by a top border + h3 heading.
  - Each input replicates the bandThreshold pattern verbatim: useState editing buffer + validated-value gate + useAutoSave with 500ms debounce + status indicator ('Speichere…' / 'Gespeichert ✓').
  - Validation predicates match the server-side parsers in stop-mode.ts so the UI never PUTs a value the server would reject:

    | Config key                        | Default | Step | Range          | Parser          |
    |-----------------------------------|---------|------|----------------|-----------------|
    | charging.stalePowerThresholdW     | 1.0     | 0.1  | (0, 50)        | parseFloat      |
    | charging.stalePowerWindowSec      | 300     | 60   | (0, 3600]      | parseInt        |
    | charging.matcherRefreshReadings   | 60      | 10   | (0, 3600]      | parseInt        |
    | charging.lowConfidenceThreshold   | 0.5     | 0.05 | (0, 1]         | parseFloat      |
    | charging.maxSessionHours          | 24      | 1    | (0, 168]       | parseInt (1w)   |

  - German title tooltips on each input.

- **Auto-verify (Task 3, programmatic substitute for the human-verify checkpoint):**
  - `pnpm build` succeeds; /settings page weighs 10.6 kB; total first-load JS unchanged at 102 kB shared.
  - Dev server boots cleanly on :4099 with `DATABASE_PATH=/tmp/cm-12-04-verify.db` after `drizzle-kit push`.
  - `GET /` → 200, `GET /settings` → 200, `GET /api/sse/power` → 200 (5s stream).
  - `/settings` client-bundle JS (`/_next/static/chunks/app/settings/page.js`, 575 kB unminified dev build) contains all expected literals: 'Flat-Power Defense' (1), 'Stale-Power Schwellwert' (1), 'Stale-Power Fenster' (1), 'Matcher-Refresh' (1), 'Confidence-Schwellwert' (1), 'Max Session-Dauer' (1), 'charging.stalePowerThresholdW' (1), 'charging.maxSessionHours' (1).
  - Server-rendered HTML for /settings contains the 'Erweitert anzeigen' toggle (Advanced section gated until the user clicks it).
  - Dev log clean — no compile errors, no console errors, no exceptions during page renders.

## Task Commits

1. **Task 1 RED** — `0e57a20` test(12-04): add failing tests for FPD-05 ChargeBanner watchdog UI
2. **Task 1 GREEN** — `3943e54` feat(12-04): implement FPD-05 ChargeBanner watchdog warning + fired banner
3. **Task 2** — `a2b3e4e` feat(12-04): expose 5 Phase-12 FPD config rows in ChargingSettings Advanced
4. **Rule-3 fix** — `daa20f6` fix(12-04): inline FPD defaults to keep client bundle off better-sqlite3

## Files Created/Modified

- **Created** `src/components/charging/charge-banner.test.tsx` (192 lines) — RTL test suite. 9 tests total: 2 unit tests for `deriveWatchdogFraction` (kind-gating + NaN/edge guards), 7 integration tests for ChargeBanner watchdog rendering (none kind, warning kind, warning-not-in-detecting, fired kind, ack flow, ack persistence across mount, useEffect re-arm on sessionId change). Uses the `vi.mock('@/hooks/use-charge-stream')` + captured-callback pattern from soc-band-indicator.test.tsx.
- **Modified** `src/components/charging/charge-banner.tsx` (+169/-10) — Added `deriveWatchdogFraction` named export, extended SessionState type with watchdog fields, added `firedSnapshot` + `ackedSessionId` state, added useEffect on `[firedSessionId]` for M3 re-arm, added `handleAckWatchdog` callback, added `firedOverlay` JSX wrapped around all four return branches (detecting/complete/aborted-idle/active), added yellow warning bar sub-render inside the active-states branch.
- **Created** `src/components/settings/charging-settings.test.ts` (37 lines) — Constant-parity test. Reads the inlined `const DEFAULT_* = N;` literals from `charging-settings.tsx` via `readFileSync` + regex and asserts equality with the canonical server-side exports from `@/modules/charging/stop-mode`.
- **Modified** `src/components/settings/charging-settings.tsx` (+239/-7) — Added 5 inlined DEFAULT_* constants (with comment pointing at the parity test), added 5 useState + useAutoSave wirings with validation gates, added 'Flat-Power Defense (Phase 12)' subsection inside the Advanced render branch.

## Decisions Made

- **Sub-render vs. separate component.** Extended `ChargeBanner` instead of creating a new `watchdog-banner.tsx`. Reason: keeps the banner state machine + plug-identity rendering + abort UI in one place; avoids two banners stacking visually; the `firedOverlay` fragment wraps every state-branch return so it's orthogonal to the active state without needing a parent coordinator. The plan called this out explicitly as the chosen approach.
- **Inlined client-bundle constants + parity test (Rule 3 auto-fix).** The Task 2 commit imported `DEFAULT_*` from `@/modules/charging/stop-mode`, which dragged `better-sqlite3` (via the module's `db/client` import) into the client bundle and broke `pnpm build` with `Module not found: Can't resolve 'fs'`. Fixed by duplicating the five constants as `const`s in the client file and adding a text-based parity test that fails if drift occurs. The alternative (extracting a shared `constants.ts`) would have required a larger refactor; the pinned literal is more local + the test guarantees consistency.
- **firedOverlay rendered as top-level fragment, not inside the 'aborted' branch.** The 'aborted' branch returns `null` (the existing convention — aborted sessions don't show a banner). Coupling firedOverlay to the 'aborted' state would have made it disappear on the very next 'none'-kind event from the same plug. Instead, the overlay is a top-level fragment that survives every state-branch return.
- **`deriveWatchdogFraction` as a NAMED EXPORT.** Lets the unit test cover every NaN/div-by-zero edge in pure-function space without rendering the component. Independently of the rendered tree, the helper returns 0 for any non-warning kind — caller hides the bar unconditionally outside warning state.
- **useEffect dependency `[firedSessionId]`, not `[sessionId]`.** The trigger for re-reading localStorage is 'a new fired event arrived for a new sessionId', not 'the active session changed'. Using `firedSessionId` (which is `undefined` when no fire has been captured) means we don't run the effect on every active-session prop transition.
- **Warning sub-render gated on state ∈ {charging, countdown}.** Backend could leak `watchdogKind='warning'` in other states under buggy conditions; UI defense-in-depth never paints the bar outside the active branches.

## Deviations from Plan

**Rule 3 — Blocking issue auto-fixed:** The initial Task 2 implementation imported `DEFAULT_STALE_POWER_THRESHOLD_W` etc. from `@/modules/charging/stop-mode`, which broke `pnpm build` because the stop-mode module imports `db/client` (server-only). Fixed by inlining the constants and adding a parity test (`charging-settings.test.ts`). Committed separately as `daa20f6` for clean attribution.

No other deviations. Plan executed as written, with the PLAN-CHECK fixes (H5 fraction gating + NaN guards, M3 useEffect on sessionId) implemented as specified.

## Issues Encountered

- **Initial build failure** — `Module not found: Can't resolve 'fs'` after importing the five DEFAULT_* constants. Root cause: `'use client'` components cannot transitively import server modules. Fixed via inline + parity test. Caught immediately by `pnpm build` after Task 2; no tests would have surfaced this since vitest runs in node + does not enforce the client/server module boundary.
- **Dev server port reuse** — A stale `tsx watch` process from a previous boot held :4099 across restarts; required a manual `kill -9` before the SSE smoke test could proceed. Not a code issue.

## Verification Gates (from PLAN `<verification>`)

| Gate                                                                                         | Threshold | Actual | Pass |
|----------------------------------------------------------------------------------------------|-----------|--------|------|
| `pnpm exec tsc --noEmit`                                                                     | exit 0    | exit 0 | ✓    |
| `pnpm exec vitest run src/components/charging/charge-banner.test.tsx`                        | all pass  | 9/9    | ✓    |
| `pnpm exec vitest run` (full suite, 230 baseline + 10 new)                                   | all pass  | 240/240 | ✓   |
| `grep -n "watchdogKind\|charging-watchdog-ack" src/components/charging/charge-banner.tsx`    | ≥ 3       | 9      | ✓    |
| `grep -n "deriveWatchdogFraction" src/components/charging/charge-banner.tsx`                 | ≥ 2       | 3      | ✓    |
| `grep -nE "useEffect.*sessionId\|\[sessionId\]\|\[firedSessionId\]" charge-banner.tsx`        | ≥ 1       | 2      | ✓    |
| FPD config-key references in charging-settings.tsx (5 distinct keys, ≥1 each)                | ≥ 5       | 10     | ✓    |
| `pnpm build` (production)                                                                    | success   | success | ✓   |
| `GET /settings` (dev server)                                                                 | 200       | 200    | ✓    |
| /settings client-bundle contains 'Flat-Power Defense' + all 5 input labels                   | yes       | yes    | ✓    |

## Task 3 — Human-verify checkpoint (auto-approved per orchestrator directive)

The user is asleep and the orchestrator explicitly authorized auto-approval of the human-verify checkpoint. All programmatically-testable parts of the checkpoint were executed:

1. ✓ `pnpm dev` boots cleanly on :4099 (clean log: no compile errors, no exceptions during page renders).
2. ✓ `GET /settings` → 200; client bundle contains all 5 new input labels + the 'Flat-Power Defense' subsection heading + all 5 config keys.
3. ✓ `GET /api/sse/power` → 200 stream (no live events because no plugs are registered in the verify DB — expected; the chargeHandler path JSON-stringifies the full ChargeStateEvent, so the new watchdog fields flow through without any explicit copy, per the documented snapshot/live split in route.ts).
4. ✓ Dev log shows no console errors during page renders.

### Deferred to manual verification (requires hardware)

The following items in the plan's `<how-to-verify>` block fundamentally require a live charge session against a real Shelly plug. They cannot be executed in a CI/agent environment:

- **Step 6** — Inducing 'warning' state by turning the relay off manually and waiting ≥60s, then visually confirming the yellow watchdog bar appears.
- **Step 7** — Waiting 5 minutes for the watchdog to fire and visually confirming the red 'Session abgebrochen — Battery full?' banner + Acknowledge button.
- **Step 8** — Reloading the page after Acknowledge and confirming the banner stays dismissed (this part IS unit-tested via the `'honors pre-set localStorage ack'` and `'new sessionId re-arms banner via useEffect'` tests, but the end-to-end visual confirmation across an actual page reload is hardware-gated).
- **Animation smoothness** — The `transition-[width] duration-500` CSS animation on the warning bar fill cannot be unit-tested; visual smoothness on a real screen needs eyeballs.
- **Lock-screen render on actual device** — The Phase-12 dashboard banner stack on a real iOS lock-screen / Android quick-glance widget.

These are documented as known carryovers for the next on-device test session.

## User Setup Required

None for the code surface itself. To verify the new inputs render in the UI on an active deployment:

1. Visit `/settings` → scroll to 'Charging' → click 'Erweitert anzeigen'.
2. The 'Flat-Power Defense (Phase 12)' subsection appears with all 5 new inputs.
3. Editing any input triggers the auto-save indicator after a 500ms debounce.

## Next Phase Readiness

- **Phase 12 implementation complete.** All five FPD requirements (FPD-01..05) are implemented across plans 12-01..04.
- **End-to-end on-device test gate** — the only remaining work is a real charge session against a Shelly plug to confirm the watchdog bar paints + the abort flow renders the red banner. This is hardware-gated and tracked as a known carryover.

## Self-Check: PASSED

- Created files exist:
  - `src/components/charging/charge-banner.test.tsx` — FOUND
  - `src/components/settings/charging-settings.test.ts` — FOUND
- Modified files contain the new symbols:
  - `src/components/charging/charge-banner.tsx` — contains `deriveWatchdogFraction`, `watchdogKind`, `charging-watchdog-ack-`, `firedSessionId`
  - `src/components/settings/charging-settings.tsx` — contains 'Flat-Power Defense', all five `charging.*` config keys, all five `useAutoSave` call sites
- Commits exist (verified via `git log --oneline`):
  - `0e57a20` test(12-04): add failing tests for FPD-05 ChargeBanner watchdog UI — FOUND
  - `3943e54` feat(12-04): implement FPD-05 ChargeBanner watchdog warning + fired banner — FOUND
  - `a2b3e4e` feat(12-04): expose 5 Phase-12 FPD config rows in ChargingSettings Advanced — FOUND
  - `daa20f6` fix(12-04): inline FPD defaults to keep client bundle off better-sqlite3 — FOUND

---
*Phase: 12-flat-power-defense*
*Completed: 2026-05-15*
