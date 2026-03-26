# Requirements: Charging-Master

**Defined:** 2026-03-25
**Core Value:** Der Akku wird automatisch beim gewuenschten SOC-Level gestoppt — kein manuelles Nachschauen, kein Ueberladen, laengere Akku-Lebensdauer.

## v1 Requirements

Requirements for initial release. Each maps to roadmap phases.

### Shelly Integration

- [x] **SHLY-01**: User can add a Shelly S3 Plug by entering its MQTT topic prefix
- [x] **SHLY-02**: App connects to configurable MQTT broker (host, port, optional credentials)
- [x] **SHLY-03**: App receives real-time power data (watts) from Shelly via MQTT
- [x] **SHLY-04**: User can manually toggle Shelly relay on/off from the UI
- [x] **SHLY-05**: MQTT connection auto-reconnects on disconnect with watchdog
- [x] **SHLY-06**: App supports multiple Shelly Plugs simultaneously

### Real-Time Visualization

- [x] **VIZL-01**: User sees live power consumption chart updating in real-time (ECharts + SSE)
- [x] **VIZL-02**: Chart uses sliding window to prevent memory leaks on long sessions
- [x] **VIZL-03**: Current charge curve overlaid on reference curve in same chart
- [x] **VIZL-04**: Dashboard shows all active Shelly Plugs with current power and status

### Device Profiles

- [x] **PROF-01**: User can create a new device profile (name, description)
- [x] **PROF-02**: User can start "learn mode" to record a full reference charge cycle
- [x] **PROF-03**: Reference charge curve is stored with timestamped power data points
- [x] **PROF-04**: App automatically detects charge-complete (power drops to ~0W)
- [x] **PROF-05**: App derives SOC boundaries (10% steps) from reference curve (energy-based)
- [x] **PROF-06**: User can set target SOC per device profile (e.g., 80%)
- [x] **PROF-07**: User can view and manage all device profiles (list, edit, delete)

### Charge Intelligence

- [x] **CHRG-01**: App auto-detects which device is charging via curve matching (first 1-2 min)
- [x] **CHRG-02**: User can manually override the detected profile at any time
- [x] **CHRG-03**: App estimates current SOC based on position on reference curve
- [x] **CHRG-04**: App handles partial charges (device not at 0% when plugged in)
- [x] **CHRG-05**: App automatically stops charging at target SOC by switching Shelly relay off
- [x] **CHRG-06**: Auto-stop uses HTTP API fallback if MQTT switch command fails
- [x] **CHRG-07**: Relay switching includes hysteresis to prevent rapid on/off cycling

### Notifications

- [ ] **NOTF-01**: User can configure Pushover credentials (user key, API token)
- [ ] **NOTF-02**: Notification sent when charging starts and device is recognized
- [ ] **NOTF-03**: Notification sent when target SOC reached and charging stopped
- [ ] **NOTF-04**: Notification sent when charging aborted or error occurs

### Session History

- [ ] **HIST-01**: Each charge session is logged (device, start, end, energy consumed, final SOC)
- [ ] **HIST-02**: User can view charge history per device with session details
- [ ] **HIST-03**: User can view past charge curves from session history

### Settings

- [x] **SETT-01**: MQTT broker settings configurable (host, port, credentials)
- [x] **SETT-02**: Pushover notification settings configurable
- [x] **SETT-03**: All settings persisted in database

## v2 Requirements

Deferred to future release. Tracked but not in current roadmap.

### Extended Plug Support

- **EXT-01**: Support for Tasmota-based smart plugs
- **EXT-02**: Support for TP-Link / other MQTT-compatible plugs
- **EXT-03**: Auto-discovery of Shelly plugs on the network

### Analytics

- **ANLT-01**: Energy cost tracking with configurable tariff rates
- **ANLT-02**: Weekly/monthly energy consumption reports
- **ANLT-03**: Battery health trend analysis over time

### Scheduling

- **SCHD-01**: Schedule charging windows (e.g., charge between 2-6am)
- **SCHD-02**: Delay charging start until off-peak hours

## Out of Scope

| Feature | Reason |
|---------|--------|
| Multi-user / Authentication | Single-user app on local LAN, no auth needed |
| Cloud sync / Remote access | Local-only deployment on LXC |
| Mobile native app | Responsive web app sufficient |
| DC-side measurement | Only AC power available via Shelly |
| ML-based SOC prediction | Overengineered for v1, simple curve mapping works |
| Automatic Shelly firmware updates | Risky, could break MQTT integration |
| Non-Shelly plugs in v1 | Fragments integration, abstract interface for v2 |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| SHLY-01 | Phase 1 | Complete |
| SHLY-02 | Phase 1 | Complete |
| SHLY-03 | Phase 1 | Complete |
| SHLY-04 | Phase 2 | Complete |
| SHLY-05 | Phase 1 | Complete |
| SHLY-06 | Phase 1 | Complete |
| VIZL-01 | Phase 2 | Complete |
| VIZL-02 | Phase 2 | Complete |
| VIZL-03 | Phase 3 | Complete |
| VIZL-04 | Phase 2 | Complete |
| PROF-01 | Phase 3 | Complete |
| PROF-02 | Phase 3 | Complete |
| PROF-03 | Phase 3 | Complete |
| PROF-04 | Phase 3 | Complete |
| PROF-05 | Phase 3 | Complete |
| PROF-06 | Phase 3 | Complete |
| PROF-07 | Phase 3 | Complete |
| CHRG-01 | Phase 3 | Complete |
| CHRG-02 | Phase 3 | Complete |
| CHRG-03 | Phase 3 | Complete |
| CHRG-04 | Phase 3 | Complete |
| CHRG-05 | Phase 3 | Complete |
| CHRG-06 | Phase 3 | Complete |
| CHRG-07 | Phase 3 | Complete |
| NOTF-01 | Phase 4 | Pending |
| NOTF-02 | Phase 4 | Pending |
| NOTF-03 | Phase 4 | Pending |
| NOTF-04 | Phase 4 | Pending |
| HIST-01 | Phase 4 | Pending |
| HIST-02 | Phase 4 | Pending |
| HIST-03 | Phase 4 | Pending |
| SETT-01 | Phase 1 | Complete |
| SETT-02 | Phase 1 | Complete |
| SETT-03 | Phase 1 | Complete |

**Coverage:**
- v1 requirements: 34 total
- Mapped to phases: 34
- Unmapped: 0

---
*Requirements defined: 2026-03-25*
*Last updated: 2026-03-25 after roadmap creation*
