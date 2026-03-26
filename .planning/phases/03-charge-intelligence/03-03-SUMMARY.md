---
phase: 03-charge-intelligence
plan: 03
subsystem: api
tags: [next.js, api-routes, learn-mode, charge-sessions, soc-boundaries, reference-curves]

requires:
  - phase: 03-01
    provides: "DB schema (chargeSessions, sessionReadings, referenceCurves, referenceCurvePoints, socBoundaries, deviceProfiles), SOC estimator, ChargeStateMachine, types"
provides:
  - "Learn mode API: start, stop/save (with downsampling + reference curve + SOC boundaries), status"
  - "Session management API: list active, detail with readings, override profile/SOC, abort"
  - "ChargeMonitorLike global type declaration for __chargeMonitor singleton"
affects: [03-04, 03-05]

tech-stack:
  added: []
  patterns: ["globalThis.__chargeMonitor pattern for singleton access from API routes", "downsample-then-process pipeline for learn mode save"]

key-files:
  created:
    - src/app/api/charging/learn/start/route.ts
    - src/app/api/charging/learn/stop/route.ts
    - src/app/api/charging/learn/status/route.ts
    - src/app/api/charging/sessions/route.ts
    - src/app/api/charging/sessions/[id]/route.ts
    - src/app/api/charging/sessions/[id]/abort/route.ts
  modified:
    - src/types/global.d.ts

key-decisions:
  - "ChargeMonitorLike interface in global.d.ts decouples API routes from ChargeMonitor implementation (parallel plan 03-02)"
  - "Learn save downsample: 1 reading per second using last-wins bucket strategy"
  - "Re-learn overwrites: existing reference curve deleted before saving new one (per D-32)"

patterns-established:
  - "globalThis.__chargeMonitor optional access: routes check existence before calling methods"
  - "Downsample pipeline: raw readings -> second buckets -> cumulative Wh -> metadata -> DB insert"

requirements-completed: [PROF-02, PROF-03, CHRG-02, CHRG-04]

duration: 2min
completed: 2026-03-26
---

# Phase 03 Plan 03: Learn Mode & Session Management API Summary

**6 API routes for learn mode lifecycle (start/stop-save/status) and charge session management (list/detail/override/abort) with reference curve downsampling and SOC boundary computation**

## Performance

- **Duration:** 2 min
- **Started:** 2026-03-26T06:23:41Z
- **Completed:** 2026-03-26T06:25:44Z
- **Tasks:** 2
- **Files modified:** 7

## Accomplishments
- Learn mode start creates DB session and activates server-side recording via ChargeMonitor
- Learn mode stop/save processes raw readings into downsampled reference curve (1 reading/sec) with cumulative Wh computation and SOC boundaries
- Learn mode status endpoint supports browser-close resilience (D-28) by reporting active learning sessions
- Session list, detail (with last 60 readings for mini-chart), override (profile/targetSoc), and abort endpoints
- ChargeMonitorLike interface added to global.d.ts for type-safe singleton access

## Task Commits

Each task was committed atomically:

1. **Task 1: Learn mode API routes (start, stop/save, status)** - `dba7d1e` (feat)
2. **Task 2: Charge session management API routes** - `dd353b0` (feat)

## Files Created/Modified
- `src/app/api/charging/learn/start/route.ts` - POST start learn mode, creates session, activates recording
- `src/app/api/charging/learn/stop/route.ts` - POST stop/save, downsample + reference curve + SOC boundaries
- `src/app/api/charging/learn/status/route.ts` - GET active learning sessions with reading stats
- `src/app/api/charging/sessions/route.ts` - GET active sessions with plug/profile joins
- `src/app/api/charging/sessions/[id]/route.ts` - GET detail with recent readings, PUT override profile/SOC
- `src/app/api/charging/sessions/[id]/abort/route.ts` - POST abort active session
- `src/types/global.d.ts` - Added ChargeMonitorLike interface and __chargeMonitor global

## Decisions Made
- ChargeMonitorLike interface in global.d.ts decouples API routes from ChargeMonitor implementation (plan 03-02 runs in parallel)
- Learn save uses last-wins bucket strategy for downsampling to 1 reading per second
- Re-learn overwrites existing reference curve for profile (per D-32 design decision)
- Target SOC validation: 10-100 in steps of 10 (per D-34)

## Deviations from Plan

None - plan executed exactly as written.

## Known Stubs

None - all routes fully implemented with real DB queries and ChargeMonitor integration.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- API layer complete for learn mode and session management
- Routes will fully activate when ChargeMonitor singleton (plan 03-02) is running
- Ready for UI integration in plan 03-04/03-05

## Self-Check: PASSED

All 7 created/modified files verified on disk. Both task commits (dba7d1e, dd353b0) verified in git log. TypeScript compilation passes.

---
*Phase: 03-charge-intelligence*
*Completed: 2026-03-26*
