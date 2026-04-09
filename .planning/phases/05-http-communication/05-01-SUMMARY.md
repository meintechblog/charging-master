---
phase: 05-http-communication
plan: 01
subsystem: iot
tags: [shelly, http, polling, relay, fetch, abort-signal]

requires:
  - phase: 01-foundation
    provides: database schema (plugs, powerReadings), EventBus
provides:
  - HttpPollingService class for HTTP-based Shelly power data polling
  - switchRelayOnHttp and switchRelayOffHttp functions for HTTP relay control
affects: [05-02, 06-cleanup]

tech-stack:
  added: []
  patterns: [standalone-http-service, abort-signal-timeout]

key-files:
  created:
    - src/modules/shelly/http-polling-service.ts
    - src/modules/shelly/http-polling-service.test.ts
    - src/modules/shelly/relay-http.ts
    - src/modules/shelly/relay-http.test.ts
  modified: []

key-decisions:
  - "Used AbortSignal.timeout(3000) instead of manual AbortController for cleaner timeout handling"
  - "Extracted persistIfDue logic identically from MqttService to maintain same active/idle persistence intervals"

patterns-established:
  - "Shelly HTTP module pattern: standalone modules in src/modules/shelly/ with no MQTT imports"
  - "TDD with vi.useFakeTimers and vi.stubGlobal for fetch mocking"

requirements-completed: [POLL-01, POLL-02, POLL-03, POLL-04, RELAY-01]

duration: 2min
completed: 2026-04-09
---

# Phase 05 Plan 01: HTTP Polling and Relay Control Summary

**Standalone HttpPollingService and relay-http module for direct Shelly HTTP communication with zero MQTT dependency**

## Performance

- **Duration:** 2 min
- **Started:** 2026-04-09T11:38:42Z
- **Completed:** 2026-04-09T11:40:41Z
- **Tasks:** 2
- **Files created:** 4

## Accomplishments
- HttpPollingService polls Shelly devices via HTTP, emits PowerReading events, persists readings with active/idle interval logic, tracks online/offline
- relay-http.ts provides switchRelayOnHttp and switchRelayOffHttp with 3s timeout, returns boolean success
- 13 unit tests covering all specified behaviors (8 polling + 5 relay)
- Zero MQTT references in src/modules/shelly/

## Task Commits

Each task was committed atomically:

1. **Task 1: Create HttpPollingService** - `f770780` (feat) - TDD with 8 tests
2. **Task 2: Create relay-http module** - `998f5bb` (feat) - TDD with 5 tests

## Files Created/Modified
- `src/modules/shelly/http-polling-service.ts` - Standalone HTTP polling service with EventBus integration and DB persistence
- `src/modules/shelly/http-polling-service.test.ts` - 8 unit tests for polling, persistence, online/offline tracking
- `src/modules/shelly/relay-http.ts` - Pure HTTP relay control (on/off) with AbortSignal timeout
- `src/modules/shelly/relay-http.test.ts` - 5 unit tests for relay control

## Decisions Made
- Used AbortSignal.timeout(3000) for cleaner timeout handling (matches existing pattern in relay-controller.ts)
- Kept persistIfDue logic identical to MqttService to ensure consistent data collection behavior during migration

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- HttpPollingService and relay-http are ready for Plan 02 to wire into the application
- EventBus integration tested -- SSE and charge-monitor can receive data from HTTP polling
- relay-controller.ts can be updated to use switchRelayOnHttp/switchRelayOffHttp instead of MQTT+HTTP fallback

---
*Phase: 05-http-communication*
*Completed: 2026-04-09*
