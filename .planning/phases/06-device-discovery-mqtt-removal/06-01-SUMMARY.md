---
phase: 06-device-discovery-mqtt-removal
plan: 01
subsystem: devices
tags: [shelly, http, network-scan, discovery, device-registration]

requires:
  - phase: 05-http-communication
    provides: HTTP polling service and relay control patterns
provides:
  - HTTP subnet scanner for Shelly device discovery
  - Rewritten discover API route (MQTT-free)
  - Discovery UI with manual scan trigger and progress
  - IP address required for device registration
affects: [06-02-mqtt-cleanup]

tech-stack:
  added: []
  patterns: [HTTP subnet scanning with batched concurrency, os.networkInterfaces for auto-subnet detection]

key-files:
  created:
    - src/modules/shelly/discovery-scanner.ts
  modified:
    - src/app/api/devices/discover/route.ts
    - src/components/devices/discovery-list.tsx
    - src/components/devices/add-device-form.tsx
    - src/app/devices/device-manager.tsx
    - src/app/api/devices/route.ts

key-decisions:
  - "Concurrency set to 20 parallel probes with 1.5s timeout per IP for ~15s total scan"
  - "Switch status fetch is optional -- device info alone is sufficient for discovery"

patterns-established:
  - "Subnet scanner pattern: batched Promise.all with configurable concurrency and progress callback"

requirements-completed: [DISC-01, DISC-02, DISC-03, CLEAN-05]

duration: 2min
completed: 2026-04-09
---

# Phase 6 Plan 01: Device Discovery & IP Requirement Summary

**HTTP subnet scanner probes /24 network for Shelly devices with one-click registration and mandatory IP address**

## Performance

- **Duration:** 2 min
- **Started:** 2026-04-09T23:06:28Z
- **Completed:** 2026-04-09T23:08:37Z
- **Tasks:** 2
- **Files modified:** 6

## Accomplishments
- HTTP subnet scanner that probes all 254 IPs via Shelly.GetDeviceInfo and Switch.GetStatus
- Discovery UI replaced from auto-polling MQTT map to manual "Geraete suchen" button with progress
- Scan results display device ID, IP, model, and current power reading
- One-click registration passes IP address from scan result
- IP address is now required for both manual and discovery-based device registration
- API validates ipAddress presence and rejects with 400 if missing

## Task Commits

Each task was committed atomically:

1. **Task 1: Create HTTP subnet scanner and rewrite discover API route** - `e1b706d` (feat)
2. **Task 2: Update discovery UI with scan button and progress, make IP required** - `50c3ec4` (feat)

## Files Created/Modified
- `src/modules/shelly/discovery-scanner.ts` - HTTP subnet scanner with scanSubnet, probeDevice, getLocalSubnet
- `src/app/api/devices/discover/route.ts` - Rewritten from MQTT map lookup to HTTP subnet scan
- `src/components/devices/discovery-list.tsx` - Manual scan button, progress indicator, device detail cards
- `src/components/devices/add-device-form.tsx` - IP address required, mqttTopicPrefix removed
- `src/app/devices/device-manager.tsx` - handleAddFromDiscovery passes IP, mqttTopicPrefix removed
- `src/app/api/devices/route.ts` - POST validates ipAddress presence (400 if missing)

## Decisions Made
- Set scan concurrency to 20 with 1.5s timeout -- balances speed (~15s worst case) vs network load
- Made Switch.GetStatus fetch optional in probeDevice -- device info alone is enough for discovery, power reading is a bonus

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Discovery scanner and UI complete, ready for Plan 02 MQTT cleanup
- mqttTopicPrefix still exists in DB schema (cleaned up in Plan 02)
- All MQTT references removed from discovery-related files

---
*Phase: 06-device-discovery-mqtt-removal*
*Completed: 2026-04-09*
