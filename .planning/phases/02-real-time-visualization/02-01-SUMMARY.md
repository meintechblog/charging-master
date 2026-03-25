---
phase: 02-real-time-visualization
plan: 01
subsystem: api, hooks
tags: [sse, eventsource, mqtt, real-time, echarts, react-hooks]

# Dependency graph
requires:
  - phase: 01-foundation
    provides: MqttService, EventBus, custom server with globalThis, SQLite schema
provides:
  - SSE endpoint streaming power readings and online events to browser
  - Singleton EventSource hook with per-plug filtering
  - Sliding window hook for chart data memory management
  - MqttService publishCommand for relay control
  - Relay API route POST /api/devices/[id]/relay
affects: [02-real-time-visualization, 03-intelligence]

# Tech tracking
tech-stack:
  added: []
  patterns: [SSE via ReadableStream in Next.js route handler, singleton EventSource pattern, module-level state for cross-component sharing]

key-files:
  created:
    - src/app/api/sse/power/route.ts
    - src/hooks/use-power-stream.ts
    - src/hooks/use-sliding-window.ts
    - src/app/api/devices/[id]/relay/route.ts
  modified:
    - src/modules/mqtt/mqtt-service.ts
    - next.config.ts

key-decisions:
  - "Singleton EventSource at module level (not React state) to survive re-renders and share across components"
  - "latestReadings Map caches last reading per plug for data retention across navigation"

patterns-established:
  - "SSE pattern: force-dynamic + runtime nodejs + ReadableStream with EventBus listeners"
  - "Hook singleton pattern: module-level variables with refCount for shared EventSource lifecycle"
  - "Sliding window: useRef-based array with configurable max points per time window"

requirements-completed: [VIZL-01, VIZL-02, SHLY-04]

# Metrics
duration: 3min
completed: 2026-03-25
---

# Phase 02 Plan 01: Real-Time Data Plumbing Summary

**SSE endpoint bridging EventBus to browser, singleton power stream hooks, sliding window memory management, and relay control API**

## Performance

- **Duration:** 3 min
- **Started:** 2026-03-25T22:32:48Z
- **Completed:** 2026-03-25T22:36:00Z
- **Tasks:** 2
- **Files modified:** 6

## Accomplishments
- SSE endpoint at /api/sse/power streams all power readings and online/offline events from EventBus to browser via ReadableStream
- Client-side singleton EventSource hook with per-plug filtering and wildcard support, plus online event stream hook
- Sliding window hook with 4 configurable time windows (5m/15m/30m/1h) using useRef for performance
- MqttService.publishCommand sends on/off/toggle to Shelly plugs via MQTT
- Relay API route at POST /api/devices/[id]/relay with full validation (400/404/503/200)
- next.config.ts prepared for ECharts with transpilePackages

## Task Commits

Each task was committed atomically:

1. **Task 1: SSE endpoint + power stream hook + sliding window hook** - `0ccd70f` (feat)
2. **Task 2: MqttService publishCommand + relay API route** - `3defc78` (feat)

## Files Created/Modified
- `src/app/api/sse/power/route.ts` - Global SSE endpoint streaming power and online events
- `src/hooks/use-power-stream.ts` - Singleton EventSource hook with per-plug filtering
- `src/hooks/use-sliding-window.ts` - Fixed-size sliding window for chart data
- `src/app/api/devices/[id]/relay/route.ts` - POST relay control endpoint
- `src/modules/mqtt/mqtt-service.ts` - Added publishCommand method
- `next.config.ts` - Added transpilePackages for echarts/zrender

## Decisions Made
- Singleton EventSource at module level (not React state) to survive re-renders and share across components
- latestReadings Map caches last reading per plug for data retention across navigation

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- All real-time data plumbing is in place for Phase 2 UI plans
- Plan 02-02 (live dashboard cards) and 02-03 (charts) can consume SSE hooks and sliding window
- Relay API ready for manual plug control UI

---
*Phase: 02-real-time-visualization*
*Completed: 2026-03-25*
