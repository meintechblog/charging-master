---
phase: 05-http-communication
plan: 02
subsystem: iot
tags: [shelly, http, polling, relay, wiring, integration]

requires:
  - phase: 05-http-communication
    plan: 01
    provides: HttpPollingService, switchRelayOnHttp, switchRelayOffHttp
provides:
  - HTTP-based polling and relay control wired into server.ts, ChargeMonitor, and API routes
  - ChargeMonitor independent of MqttService
  - Device CRUD manages HTTP polling lifecycle
affects: [06-cleanup]

tech-stack:
  added: []
  patterns: [globalThis-service-exposure, http-only-relay-control]

key-files:
  created: []
  modified:
    - server.ts
    - src/types/global.d.ts
    - src/modules/charging/relay-controller.ts
    - src/modules/charging/charge-monitor.ts
    - src/app/api/devices/[id]/relay/route.ts
    - src/app/api/devices/route.ts
    - src/app/api/charging/learn/start/route.ts
    - src/app/api/charging/learn/stop/route.ts

key-decisions:
  - "Kept MqttService in server.ts for Phase 6 removal -- only polling and relay switched to HTTP"
  - "Removed toggle command from relay route -- only on/off supported via HTTP (toggle requires state read)"
  - "pollingInterval stored in seconds in DB, multiplied by 1000 for HttpPollingService millisecond API"

patterns-established:
  - "HTTP polling lifecycle managed at service level, not per-session in ChargeMonitor"
  - "Device CRUD routes manage polling start/stop via globalThis.__httpPollingService"

requirements-completed: [RELAY-02, POLL-01, POLL-02, POLL-03, POLL-04, RELAY-01]

duration: 4min
completed: 2026-04-09
---

# Phase 05 Plan 02: Wire HTTP Polling and Relay into App Summary

**HttpPollingService and relay-http wired into server.ts, ChargeMonitor, and all API routes replacing MQTT-based polling and relay control**

## Performance

- **Duration:** 4 min
- **Started:** 2026-04-09T11:42:30Z
- **Completed:** 2026-04-09T11:46:40Z
- **Tasks:** 2
- **Files modified:** 8

## Accomplishments

- relay-controller.ts uses switchRelayOffHttp/switchRelayOnHttp exclusively, no MqttService parameter
- ChargeMonitor constructor drops mqttService, removes startStatusPolling/stopStatusPolling methods and pollingTimers/plugTopics maps
- server.ts creates HttpPollingService, polls all enabled plugs with IP on startup, exposes as global
- Relay API route returns 502 on device unreachable instead of silently succeeding via MQTT
- Device CRUD routes manage HTTP polling lifecycle (start on POST, stop on DELETE, restart on PATCH)
- Learn start/stop routes updated to use new relay function signatures

## Task Commits

Each task was committed atomically:

1. **Task 1: Update relay-controller and charge-monitor to HTTP-only** - `d3f537d` (feat) - Remove MqttService from relay-controller and charge-monitor, fix all callers
2. **Task 2: Update server.ts, global.d.ts, and API routes** - `3a1a586` (feat) - Wire HttpPollingService into server and API routes

## Files Created/Modified

- `src/modules/charging/relay-controller.ts` - HTTP-only relay switching via switchRelayOffHttp/switchRelayOnHttp
- `src/modules/charging/charge-monitor.ts` - No MqttService dependency, no status polling methods
- `src/app/api/charging/learn/start/route.ts` - switchRelayOn uses new HTTP-only signature
- `src/app/api/charging/learn/stop/route.ts` - switchRelayOff uses new HTTP-only signature
- `server.ts` - HttpPollingService created, polls registered plugs, ChargeMonitor without mqttService
- `src/types/global.d.ts` - Added __httpPollingService global type
- `src/app/api/devices/[id]/relay/route.ts` - Complete rewrite using switchRelayOnHttp/switchRelayOffHttp with 502 error handling
- `src/app/api/devices/route.ts` - POST/PATCH/DELETE manage HTTP polling lifecycle

## Decisions Made

- Kept MqttService import and setup in server.ts for Phase 6 removal (incremental migration)
- Removed toggle command from relay route (toggle requires reading current state, which comes from polling)
- pollingInterval stored in seconds in DB, multiplied by 1000 for HttpPollingService ms API

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Fixed callers of changed relay function signatures**
- **Found during:** Task 1
- **Issue:** learn/start/route.ts and learn/stop/route.ts called switchRelayOn/switchRelayOff with old MQTT-based signatures, causing TypeScript errors
- **Fix:** Updated both routes to use new HTTP-only signatures with ipAddress guards
- **Files modified:** src/app/api/charging/learn/start/route.ts, src/app/api/charging/learn/stop/route.ts
- **Commit:** d3f537d

## Issues Encountered
None

## User Setup Required
None

## Next Phase Readiness
- All polling and relay control now uses HTTP exclusively
- MqttService remains in server.ts but is no longer used for polling or relay -- Phase 6 removes it entirely
- EventBus data flow unchanged -- SSE and ChargeMonitor receive data from HttpPollingService identically

---
*Phase: 05-http-communication*
*Completed: 2026-04-09*
