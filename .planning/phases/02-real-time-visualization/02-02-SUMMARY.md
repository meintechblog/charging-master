---
phase: 02-real-time-visualization
plan: 02
subsystem: ui, charts
tags: [echarts, sparkline, relay-toggle, plug-card, real-time, sse, dark-theme]

# Dependency graph
requires:
  - phase: 02-real-time-visualization
    plan: 01
    provides: SSE endpoint, usePowerStream hook, useSlidingWindow hook, relay API route
provides:
  - ECharts PowerChart component with time window selector, zoom/pan, fullscreen
  - Sparkline component for plug card embedding
  - RelayToggle component with optimistic update and error rollback
  - Enhanced PlugCard with live watts, sparkline, relay toggle, Link to detail
  - Dashboard page wired to pass initial relay state from latest power_reading
affects: [02-real-time-visualization, 03-intelligence]

# Tech tracking
tech-stack:
  added: [echarts 6.0.0, echarts-for-react 3.0.6]
  patterns: [ECharts setOption for incremental updates, optimistic toggle with rollback, SSE relay debounce]

key-files:
  created:
    - src/components/charts/power-chart.tsx
    - src/components/charts/sparkline.tsx
    - src/components/devices/relay-toggle.tsx
  modified:
    - src/components/devices/plug-card.tsx
    - src/app/page.tsx

key-decisions:
  - "Blue-500 (#3b82f6) as primary chart accent color for readability on dark backgrounds"
  - "4-second SSE debounce after relay toggle to prevent visual flickering from stale Shelly status"
  - "Sparkline data kept in PlugCard state (last 90 points) rather than module-level cache"

patterns-established:
  - "ECharts pattern: build option once, use setOption for incremental data updates via ref"
  - "Optimistic toggle: flip immediately, POST in background, rollback on error with red flash"
  - "Card-to-detail: Link wrapper with stopPropagation on interactive elements"

requirements-completed: [VIZL-01, VIZL-02, VIZL-04, SHLY-04]

# Metrics
duration: 3min
completed: 2026-03-25
---

# Phase 02 Plan 02: Real-Time UI Components Summary

**ECharts PowerChart with zoom/pan/fullscreen, Sparkline for plug cards, RelayToggle with optimistic update, and live dashboard plug cards via SSE**

## Performance

- **Duration:** 3 min
- **Started:** 2026-03-25T22:35:56Z
- **Completed:** 2026-03-25T22:39:00Z
- **Tasks:** 2
- **Files modified:** 7

## Accomplishments
- PowerChart component with smooth area chart, gradient fill, time window buttons (5m/15m/30m/1h), dataZoom for zoom/pan, fullscreen toggle, tooltip with de-DE locale formatting
- Sparkline component with minimal ECharts config (no axes, no animation) at 120x40 default size for plug card embedding
- RelayToggle with optimistic update pattern: immediate UI flip, spinner during pending, error rollback with red flash, AbortController for race conditions
- Enhanced PlugCard with live watt display (tabular-nums), sparkline, relay toggle with 4s SSE debounce, Link wrapper to detail view
- Dashboard passes initial relay state from latest power_reading query per plug

## Task Commits

Each task was committed atomically:

1. **Task 1: Install ECharts + create PowerChart + Sparkline** - `7c0cefa` (feat)
2. **Task 2: Relay toggle + enhanced plug cards + dashboard wiring** - `7991fcc` (feat)

## Files Created/Modified
- `src/components/charts/power-chart.tsx` - Full ECharts area chart with time window selector, zoom/pan, fullscreen
- `src/components/charts/sparkline.tsx` - Minimal ECharts sparkline for plug card embedding
- `src/components/devices/relay-toggle.tsx` - Toggle switch with optimistic update, spinner, error rollback
- `src/components/devices/plug-card.tsx` - Enhanced with live watts, sparkline, relay toggle, Link to detail
- `src/app/page.tsx` - Dashboard queries latest power_reading for initial relay state
- `package.json` - Added echarts and echarts-for-react dependencies
- `pnpm-lock.yaml` - Updated lockfile

## Decisions Made
- Blue-500 (#3b82f6) as primary chart accent color -- good contrast on dark backgrounds, consistent with Tailwind palette
- 4-second SSE debounce after relay toggle prevents visual flickering from stale Shelly status messages (Pitfall 6)
- Sparkline data kept in PlugCard state (last 90 points ~3 min) rather than module-level cache -- simpler and sufficient for card display
- RelayToggle communicates to PlugCard via onToggle callback rather than static refs -- supports multiple card instances

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- All Phase 2 UI components are built and wired
- Plan 02-03 (plug detail page with full-size chart) can use PowerChart component directly
- Chart components, relay toggle, and live plug cards are ready for production use

---
*Phase: 02-real-time-visualization*
*Completed: 2026-03-25*
