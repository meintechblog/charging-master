---
phase: 01-foundation
plan: 03
subsystem: ui
tags: [next.js, react, sidebar, dashboard, mqtt-discovery, dark-theme, tailwind]

# Dependency graph
requires:
  - phase: 01-foundation-01
    provides: "DB schema (plugs table), MQTT service, discovery module, global types, server.ts with __discoveredDevices"
provides:
  - "App shell with sidebar navigation (Dashboard, Geraete, Einstellungen)"
  - "Dashboard page with plug cards in responsive grid"
  - "Device management page with MQTT auto-discovery and manual add"
  - "Device CRUD API (GET/POST/DELETE /api/devices)"
  - "Discovery API (GET /api/devices/discover)"
affects: [01-foundation-02, 02-visualization, 03-intelligence]

# Tech tracking
tech-stack:
  added: []
  patterns: [client-component-wrapper-for-server-page, polling-discovery, dark-theme-neutral-palette]

key-files:
  created:
    - src/components/layout/sidebar.tsx
    - src/components/layout/app-shell.tsx
    - src/app/api/devices/route.ts
    - src/app/api/devices/discover/route.ts
    - src/components/devices/plug-card.tsx
    - src/components/devices/discovery-list.tsx
    - src/components/devices/add-device-form.tsx
    - src/app/devices/page.tsx
    - src/app/devices/device-manager.tsx
  modified:
    - src/app/layout.tsx
    - src/app/page.tsx

key-decisions:
  - "Client wrapper pattern for devices page: server component loads data, passes to client DeviceManager for interactivity"
  - "Discovery polling every 5s for real-time device detection"
  - "Collapsible manual add section to keep discovery as primary flow"

patterns-established:
  - "Dark theme: bg-neutral-900 cards, bg-neutral-800 inputs, border-neutral-800/700, text-neutral-100/400/500"
  - "Client wrapper pattern: server page queries DB, client wrapper handles fetch/mutations + router.refresh()"
  - "API routes: validate input, check existence, return typed JSON with status codes"

requirements-completed: [SHLY-01, SHLY-06]

# Metrics
duration: 2min
completed: 2026-03-25
---

# Phase 01 Plan 03: Dashboard & Device Management Summary

**App shell with sidebar navigation, plug card dashboard, and device management with MQTT auto-discovery and manual add fallback**

## Performance

- **Duration:** 2 min
- **Started:** 2026-03-25T21:40:08Z
- **Completed:** 2026-03-25T21:42:34Z
- **Tasks:** 2
- **Files modified:** 11

## Accomplishments
- Sidebar navigation with Dashboard/Geraete/Einstellungen links, active state highlighting, and MQTT connection status indicator
- Dashboard page showing registered Shelly Plugs as cards with online/offline status, power placeholder, and relative timestamps in responsive grid
- Device management page with MQTT auto-discovery list (5s polling), manual add form, and registered device list with delete
- Device CRUD API with MQTT subscribe/unsubscribe on add/remove

## Task Commits

Each task was committed atomically:

1. **Task 1: App shell and device API routes** - `68c3b20` (feat)
2. **Task 2: Dashboard plug cards and device management page** - `e3d5c81` (feat)

## Files Created/Modified
- `src/components/layout/sidebar.tsx` - Navigation sidebar with active link highlighting and MQTT status
- `src/components/layout/app-shell.tsx` - Sidebar + content area wrapper
- `src/app/layout.tsx` - Updated to wrap children with AppShell
- `src/app/api/devices/route.ts` - Device CRUD (GET/POST/DELETE) with MQTT integration
- `src/app/api/devices/discover/route.ts` - Discovery endpoint reading globalThis.__discoveredDevices
- `src/components/devices/plug-card.tsx` - Individual plug status card with online/offline indicator
- `src/components/devices/discovery-list.tsx` - Auto-polling discovery list with add button
- `src/components/devices/add-device-form.tsx` - Manual device entry form
- `src/app/devices/page.tsx` - Device management server page
- `src/app/devices/device-manager.tsx` - Client wrapper handling add/delete flows
- `src/app/page.tsx` - Dashboard with plug card grid and empty state

## Decisions Made
- Used a client wrapper pattern (DeviceManager) for the devices page to handle interactive add/delete with router.refresh() while keeping the page server-rendered
- Discovery list polls every 5 seconds for near-real-time device detection
- Manual add is collapsible (secondary to auto-discovery per D-07/D-08 priority)
- MQTT status indicator in sidebar is prop-based (static for now, will be wired to real status)

## Deviations from Plan

### Auto-added

**1. [Rule 2 - Missing Critical] Added DeviceManager client wrapper component**
- **Found during:** Task 2 (Devices page)
- **Issue:** Plan specified both server-rendered page and interactive discovery/add/delete, requiring a client boundary wrapper
- **Fix:** Created `src/app/devices/device-manager.tsx` as client component orchestrating DiscoveryList, AddDeviceForm, and registered device list
- **Files modified:** src/app/devices/device-manager.tsx
- **Committed in:** e3d5c81

---

**Total deviations:** 1 auto-added (Rule 2 - structural necessity for Next.js server/client boundary)
**Impact on plan:** Essential for correct Next.js architecture. No scope creep.

## Issues Encountered
None

## Known Stubs
- `PlugCard` shows "--" W as power placeholder (real-time power via SSE comes in Phase 2)
- `Sidebar` MQTT status is a static prop (will be wired to real connection state)

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- App shell and navigation established for all future pages
- Device management complete, users can add/remove Shelly Plugs
- Ready for Phase 2 real-time visualization (SSE streaming to plug cards)
- Settings page route exists in sidebar, implementation in Plan 01-02

---
*Phase: 01-foundation*
*Completed: 2026-03-25*
