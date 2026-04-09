# Requirements: Charging-Master

**Defined:** 2026-03-25
**Core Value:** Der Akku wird automatisch beim gewuenschten SOC-Level gestoppt — kein manuelles Nachschauen, kein Ueberladen, laengere Akku-Lebensdauer.

## v1.0 Requirements (Complete)

All 34 requirements shipped. See traceability below.

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

- [x] **NOTF-01**: User can configure Pushover credentials (user key, API token)
- [x] **NOTF-02**: Notification sent when charging starts and device is recognized
- [x] **NOTF-03**: Notification sent when target SOC reached and charging stopped
- [x] **NOTF-04**: Notification sent when charging aborted or error occurs

### Session History

- [x] **HIST-01**: Each charge session is logged (device, start, end, energy consumed, final SOC)
- [x] **HIST-02**: User can view charge history per device with session details
- [x] **HIST-03**: User can view past charge curves from session history

### Settings

- [x] **SETT-01**: MQTT broker settings configurable (host, port, credentials)
- [x] **SETT-02**: Pushover notification settings configurable
- [x] **SETT-03**: All settings persisted in database

## v1.1 Requirements — MQTT raus, HTTP rein

### HTTP Polling (POLL)

- [ ] **POLL-01**: HttpPollingService pollt registrierte Shelly Plugs via HTTP API für Power-Readings
- [ ] **POLL-02**: Polling-Intervall pro Device konfigurierbar (Standard: 1s)
- [ ] **POLL-03**: Power-Readings werden über EventBus emittiert (gleiche Events wie bisher)
- [ ] **POLL-04**: Device Online/Offline-Status wird per HTTP-Erreichbarkeit erkannt

### Relay Control (RELAY)

- [ ] **RELAY-01**: Relay ein/aus per Shelly HTTP API (/rpc/Switch.Set)
- [ ] **RELAY-02**: Relay-Status wird aus HTTP-Polling-Response gelesen (output-Feld)

### Device Discovery (DISC)

- [ ] **DISC-01**: Netzwerk-Scan findet Shelly Plugs im lokalen Subnetz per HTTP
- [ ] **DISC-02**: Gefundene Devices zeigen ID, IP, Model und aktuellen Power-Status
- [ ] **DISC-03**: User kann gefundenes Device mit einem Klick registrieren

### MQTT Cleanup (CLEAN)

- [ ] **CLEAN-01**: mqtt.js Package aus dependencies entfernt
- [ ] **CLEAN-02**: MqttService und src/modules/mqtt/ komplett gelöscht
- [ ] **CLEAN-03**: MQTT-Settings UI und API-Endpunkte entfernt
- [ ] **CLEAN-04**: MQTT-Referenzen in server.ts, global.d.ts, ChargeMonitor entfernt
- [ ] **CLEAN-05**: ipAddress wird Pflichtfeld bei Device-Registrierung

## v2 Requirements (Deferred)

### Extended Plug Support

- **EXT-01**: Support for Tasmota-based smart plugs
- **EXT-02**: Support for TP-Link / other MQTT-compatible plugs

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
| ML-based SOC prediction | Overengineered, simple curve mapping works |
| MQTT als optionaler Fallback | Komplett raus, nicht beibehalten — HTTP ist einfacher und zuverlässiger |
| WebSocket für Echtzeit | SSE via EventBus reicht |
| mDNS/Bonjour Discovery | HTTP-Scan ist einfacher |

## Traceability

### v1.0 (Complete)

| Requirement | Phase | Status |
|-------------|-------|--------|
| SHLY-01..06 | Phase 1 | Complete |
| VIZL-01..04 | Phase 2 | Complete |
| PROF-01..07 | Phase 3 | Complete |
| CHRG-01..07 | Phase 3 | Complete |
| NOTF-01..04 | Phase 4 | Complete |
| HIST-01..03 | Phase 4 | Complete |
| SETT-01..03 | Phase 1 | Complete |

### v1.1 (Active)

| Requirement | Phase | Status |
|-------------|-------|--------|
| POLL-01 | Phase 5 | Pending |
| POLL-02 | Phase 5 | Pending |
| POLL-03 | Phase 5 | Pending |
| POLL-04 | Phase 5 | Pending |
| RELAY-01 | Phase 5 | Pending |
| RELAY-02 | Phase 5 | Pending |
| DISC-01 | Phase 6 | Pending |
| DISC-02 | Phase 6 | Pending |
| DISC-03 | Phase 6 | Pending |
| CLEAN-01 | Phase 6 | Pending |
| CLEAN-02 | Phase 6 | Pending |
| CLEAN-03 | Phase 6 | Pending |
| CLEAN-04 | Phase 6 | Pending |
| CLEAN-05 | Phase 6 | Pending |

**Coverage:**
- v1.0 requirements: 34 total, 34 complete
- v1.1 requirements: 14 total, 14 mapped

---
*Requirements defined: 2026-03-25*
*Last updated: 2026-04-09 — v1.1 traceability added*
