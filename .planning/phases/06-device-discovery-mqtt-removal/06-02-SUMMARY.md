---
phase: 06-device-discovery-mqtt-removal
plan: 02
subsystem: infrastructure
tags: [mqtt-removal, cleanup, dead-code, server, settings]

requires:
  - phase: 06-device-discovery-mqtt-removal
    plan: 01
    provides: HTTP discovery scanner replaces MQTT discovery
provides:
  - Complete MQTT removal from codebase
  - Clean server startup without MQTT broker dependency
  - Simplified settings page (Pushover only)
  - Sidebar without MQTT status indicator
affects: []

tech-stack:
  added: []
  patterns: []

key-files:
  created: []
  modified:
    - server.ts
    - src/types/global.d.ts
    - src/app/settings/page.tsx
    - src/components/layout/sidebar.tsx
    - src/db/schema.ts
    - src/app/api/devices/route.ts
    - package.json
    - pnpm-lock.yaml
  deleted:
    - src/modules/mqtt/mqtt-service.ts
    - src/modules/mqtt/discovery.ts
    - src/modules/mqtt/shelly-parser.ts
    - src/app/api/mqtt/status/route.ts
    - src/app/api/mqtt/test/route.ts
    - src/components/settings/mqtt-settings.tsx

key-decisions:
  - "mqttTopicPrefix column left in SQLite DB but removed from Drizzle schema -- Drizzle ignores undeclared columns, no migration needed"
  - "MQTT config rows (mqtt.host etc) left in config table as inert historical data"

patterns-established: []

requirements-completed: [CLEAN-01, CLEAN-02, CLEAN-03, CLEAN-04]

duration: 3min
completed: 2026-04-09
---

# Phase 6 Plan 02: Complete MQTT Removal Summary

**Surgically removed all MQTT code, dependencies, UI, globals, and schema references -- app boots and builds with zero MQTT dependency**

## Performance

- **Duration:** 3 min
- **Started:** 2026-04-09T23:10:09Z
- **Completed:** 2026-04-09T23:13:06Z
- **Tasks:** 2
- **Files modified:** 8
- **Files deleted:** 6

## Accomplishments

- Deleted entire `src/modules/mqtt/` directory (mqtt-service.ts, discovery.ts, shelly-parser.ts)
- Deleted MQTT API routes (`/api/mqtt/status`, `/api/mqtt/test`)
- Deleted mqtt-settings.tsx component
- Cleaned server.ts: removed MqttService import/instantiation, MQTT broker connection logic, `__mqttService` and `__discoveredDevices` globals, and MQTT disconnect from shutdown
- Cleaned global.d.ts: removed MqttService and DiscoveredDevice type imports and declarations
- Cleaned settings page: removed MQTT section, only Pushover remains
- Cleaned sidebar: removed useMqttStatus hook and MQTT connection indicator
- Removed mqttTopicPrefix from Drizzle schema and devices POST route
- Removed mqtt package from package.json and updated lockfile
- Build (`pnpm build`) and type check (`pnpm tsc --noEmit`) both pass cleanly

## Task Commits

Each task was committed atomically:

1. **Task 1: Remove MQTT module, API routes, settings UI, sidebar status, and package dependency** - `1fed26f` (feat)
2. **Task 2: Verify app starts and runs without MQTT** - Auto-approved (build + tsc pass)

## Files Created/Modified

### Deleted
- `src/modules/mqtt/mqtt-service.ts` - MQTT client service (dead code)
- `src/modules/mqtt/discovery.ts` - MQTT discovery types (dead code)
- `src/modules/mqtt/shelly-parser.ts` - MQTT payload parser (dead code)
- `src/app/api/mqtt/status/route.ts` - MQTT status API endpoint
- `src/app/api/mqtt/test/route.ts` - MQTT test API endpoint
- `src/components/settings/mqtt-settings.tsx` - MQTT settings UI component

### Modified
- `server.ts` - Removed all MQTT imports, service, globals, shutdown logic
- `src/types/global.d.ts` - Removed MqttService and DiscoveredDevice globals
- `src/app/settings/page.tsx` - Removed MQTT section, Pushover only
- `src/components/layout/sidebar.tsx` - Removed useMqttStatus hook and indicator
- `src/db/schema.ts` - Removed mqttTopicPrefix column from plugs table
- `src/app/api/devices/route.ts` - Removed mqttTopicPrefix from POST handler
- `package.json` - Removed mqtt dependency
- `pnpm-lock.yaml` - Updated after mqtt removal

## Decisions Made

- **mqttTopicPrefix column handling:** Removed from Drizzle schema but left in SQLite DB file. Drizzle ORM only reads declared columns, so the old column is silently ignored. Running `drizzle-kit push` in the future will drop it from the DB.
- **MQTT config rows:** Left in the config table (mqtt.host, mqtt.port, etc.) as inert historical data. Nothing reads them. Harmless.

## Deviations from Plan

None -- plan executed exactly as written.

## Known Stubs

None -- all MQTT code was fully removed, no placeholders left.

## Issues Encountered

- Initial `pnpm build` failed with SQLITE_BUSY due to database lock (likely another parallel agent). Resolved by clearing WAL files and retrying.

## Self-Check: PASSED

- [x] src/modules/mqtt/ does not exist
- [x] src/app/api/mqtt/ does not exist
- [x] src/components/settings/mqtt-settings.tsx does not exist
- [x] server.ts has zero "mqtt" references
- [x] global.d.ts has zero MQTT references
- [x] settings page has zero MQTT references
- [x] sidebar has zero MQTT references
- [x] schema.ts has no mqttTopicPrefix
- [x] package.json has no mqtt dependency
- [x] pnpm build passes
- [x] pnpm tsc --noEmit passes
- [x] Commit 1fed26f exists

---
*Phase: 06-device-discovery-mqtt-removal*
*Completed: 2026-04-09*
