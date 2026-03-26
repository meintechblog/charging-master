# Roadmap: Charging-Master

## Overview

Charging-Master delivers smart charging management in four phases, ordered by dependency: first establish the MQTT/database backbone that everything depends on, then add real-time visualization to validate the data pipeline visually, then build the core intelligence (device learning, SOC estimation, auto-stop), and finally layer on notifications and history as polish. Each phase delivers an independently verifiable capability.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [ ] **Phase 1: Foundation** - MQTT connectivity, Shelly plug management, SQLite database, and app settings
- [ ] **Phase 2: Real-Time Visualization** - Live power charts, dashboard with plug overview, and manual relay control UI
- [ ] **Phase 3: Charge Intelligence** - Device profiles, reference curve learning, automatic device detection, SOC estimation, and auto-stop
- [ ] **Phase 4: Notifications & History** - Pushover alerts for charge events and per-device session history

## Phase Details

### Phase 1: Foundation
**Goal**: Users can connect Shelly S3 Plugs via MQTT and the app reliably receives and persists power data
**Depends on**: Nothing (first phase)
**Requirements**: SHLY-01, SHLY-02, SHLY-03, SHLY-05, SHLY-06, SETT-01, SETT-02, SETT-03
**Success Criteria** (what must be TRUE):
  1. User can add a Shelly S3 Plug and see it appear in the app with online/offline status
  2. App maintains a persistent MQTT connection that auto-reconnects after broker restarts
  3. Power readings from connected Shelly Plugs are stored in the database continuously
  4. User can configure MQTT broker and Pushover settings through a settings page, and settings persist across app restarts
**Plans:** 3 plans

Plans:
- [x] 01-01-PLAN.md — Project scaffolding, database schema, MQTT service, EventBus, custom server
- [x] 01-02-PLAN.md — Settings page with MQTT broker config, Pushover credentials, auto-save, connection test
- [x] 01-03-PLAN.md — App shell sidebar, dashboard plug cards, device management with MQTT auto-discovery

### Phase 2: Real-Time Visualization
**Goal**: Users can see live power consumption and manually control their Shelly Plugs from a dashboard
**Depends on**: Phase 1
**Requirements**: VIZL-01, VIZL-02, VIZL-04, SHLY-04
**Success Criteria** (what must be TRUE):
  1. User sees a live-updating power chart (ECharts) that streams data in real-time via SSE
  2. Dashboard shows all connected Shelly Plugs with current wattage and relay state at a glance
  3. User can toggle any Shelly relay on/off from the dashboard and see the state change reflected immediately
  4. Chart runs for hours without degrading browser performance (sliding window prevents memory leaks)
**Plans:** 3 plans

Plans:
- [x] 02-01-PLAN.md — SSE endpoint, power stream hook, sliding window hook, MQTT publishCommand, relay API route
- [x] 02-02-PLAN.md — ECharts power chart, sparkline, relay toggle, enhanced plug cards with live data
- [x] 02-03-PLAN.md — Plug detail page with full interactive chart and historical data loading

### Phase 3: Charge Intelligence
**Goal**: Users can teach the app their devices and have charging automatically stop at the desired SOC level
**Depends on**: Phase 2
**Requirements**: PROF-01, PROF-02, PROF-03, PROF-04, PROF-05, PROF-06, PROF-07, CHRG-01, CHRG-02, CHRG-03, CHRG-04, CHRG-05, CHRG-06, CHRG-07, VIZL-03
**Success Criteria** (what must be TRUE):
  1. User can record a full reference charge cycle for a new device and the app stores the characteristic power curve
  2. When a device starts charging, the app identifies which device it is within 1-2 minutes based on curve matching
  3. User can see current estimated SOC and the live curve overlaid on the reference curve
  4. Charging stops automatically when the target SOC is reached, with HTTP API fallback if MQTT fails
  5. User can manually override the detected profile and adjust target SOC at any time
**Plans:** 5 plans

Plans:
- [x] 03-01-PLAN.md — DB schema extension (6 tables), shared types, core algorithms (DTW, SOC estimator, state machine, relay controller)
- [x] 03-02-PLAN.md — ChargeMonitor singleton, curve matcher, profile CRUD API, SSE charge state events
- [x] 03-03-PLAN.md — Learn mode API routes (start/stop/save/status), charge session management API
- [x] 03-04-PLAN.md — Profile UI pages, learn mode wizard, SOC buttons, PowerChart reference overlay, charge stream hook
- [ ] 03-05-PLAN.md — Active charging UI (detection banner, SOC countdown, unknown device dialog, dashboard/detail wiring)

### Phase 4: Notifications & History
**Goal**: Users are notified about charge events and can review past charging sessions
**Depends on**: Phase 3
**Requirements**: NOTF-01, NOTF-02, NOTF-03, NOTF-04, HIST-01, HIST-02, HIST-03
**Success Criteria** (what must be TRUE):
  1. User receives Pushover notifications when charging starts, a device is recognized, target SOC is reached, or an error occurs
  2. User can view a per-device charge history showing session details (start, end, energy consumed, final SOC)
  3. User can view the power curve from any past charge session
**Plans**: TBD
**UI hint**: yes

## Progress

**Execution Order:**
Phases execute in numeric order: 1 -> 2 -> 3 -> 4

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Foundation | 3/3 | Planning complete | - |
| 2. Real-Time Visualization | 0/3 | Planning complete | - |
| 3. Charge Intelligence | 0/5 | Planning complete | - |
| 4. Notifications & History | 0/? | Not started | - |
