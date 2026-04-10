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

## v1.1 Requirements — MQTT raus, HTTP rein (Complete)

### HTTP Polling (POLL)

- [x] **POLL-01**: HttpPollingService pollt registrierte Shelly Plugs via HTTP API für Power-Readings
- [x] **POLL-02**: Polling-Intervall pro Device konfigurierbar (Standard: 1s)
- [x] **POLL-03**: Power-Readings werden über EventBus emittiert (gleiche Events wie bisher)
- [x] **POLL-04**: Device Online/Offline-Status wird per HTTP-Erreichbarkeit erkannt

### Relay Control (RELAY)

- [x] **RELAY-01**: Relay ein/aus per Shelly HTTP API (/rpc/Switch.Set)
- [x] **RELAY-02**: Relay-Status wird aus HTTP-Polling-Response gelesen (output-Feld)

### Device Discovery (DISC)

- [x] **DISC-01**: Netzwerk-Scan findet Shelly Plugs im lokalen Subnetz per HTTP
- [x] **DISC-02**: Gefundene Devices zeigen ID, IP, Model und aktuellen Power-Status
- [x] **DISC-03**: User kann gefundenes Device mit einem Klick registrieren

### MQTT Cleanup (CLEAN)

- [x] **CLEAN-01**: mqtt.js Package aus dependencies entfernt
- [x] **CLEAN-02**: MqttService und src/modules/mqtt/ komplett gelöscht
- [x] **CLEAN-03**: MQTT-Settings UI und API-Endpunkte entfernt
- [x] **CLEAN-04**: MQTT-Referenzen in server.ts, global.d.ts, ChargeMonitor entfernt
- [x] **CLEAN-05**: ipAddress wird Pflichtfeld bei Device-Registrierung

## v1.2 Requirements — Self-Update

### Version Awareness (VERS)

- [ ] **VERS-01**: App kennt ihren aktuellen Commit-SHA (aus `src/lib/version.ts`, generiert per Prebuild-Script)
- [ ] **VERS-02**: App kennt ihren Build-Zeitpunkt (ISO timestamp, in derselben generierten Datei)
- [ ] **VERS-03**: GET /api/version liefert SHA (short + full), Build-Time, Rollback-SHA und Health-Status (DB probe)
- [ ] **VERS-04**: Settings-Seite zeigt aktuelle Version prominent (short SHA sichtbar, full SHA auf Hover/Kopieren)

### Update Detection (DETE)

- [ ] **DETE-01**: Background-Check pollt alle 6h `GET /repos/meintechblog/charging-master/commits/main` über ETag-fähigen Client
- [ ] **DETE-02**: Check persistiert ETag in SQLite, nutzt `If-None-Match` für 304-Responses (kein Rate-Limit-Verbrauch)
- [ ] **DETE-03**: Update-Verfügbarkeit erscheint als Badge im Settings-Nav-Eintrag
- [ ] **DETE-04**: "Jetzt prüfen" Button in Settings triggert sofortigen Check (mit Mindest-Cooldown 5 Min)
- [ ] **DETE-05**: Settings zeigt Zeitpunkt des letzten Checks und Ergebnis
- [ ] **DETE-06**: Verfügbares Update zeigt neuen SHA, Commit-Message, Autor und Commit-Datum

### Update Execution (EXEC)

- [ ] **EXEC-01**: Install-Button startet Updater via `systemctl start --no-block charging-master-updater.service`
- [ ] **EXEC-02**: Updater-Pipeline läuft in dieser Reihenfolge: tarball-snapshot → POST /prepare-for-shutdown → systemctl stop → git fetch + reset → pnpm install --frozen-lockfile → pnpm build → systemctl start → health-probe
- [ ] **EXEC-03**: Pre-Update Tarball-Snapshot wird nach `.update-state/snapshots/<old-sha>.tar.gz` geschrieben
- [ ] **EXEC-04**: POST /api/internal/prepare-for-shutdown macht `PRAGMA wal_checkpoint(TRUNCATE)` und stoppt HttpPollingService graceful
- [ ] **EXEC-05**: flock verhindert parallele Update-Läufe (Button-Doppelklick, gleichzeitiger Auto-Check)
- [ ] **EXEC-06**: Pre-Flight-Check verifiziert Disk-Space (>500MB frei), pnpm-Version und Node-Version vor Start

### Live Feedback (LIVE)

- [ ] **LIVE-01**: GET /api/update/log streamt `journalctl -fu charging-master-updater` live per SSE
- [ ] **LIVE-02**: SSE-Endpoint killt journalctl-Child auf `request.signal.abort` UND ReadableStream `cancel()`
- [ ] **LIVE-03**: UI zeigt Stage-Stepper (Snapshot → Drain → Stop → Fetch → Install → Build → Start → Verify)
- [ ] **LIVE-04**: UI zeigt Live-Log-Panel (terminal-style, monospace, auto-scroll)
- [ ] **LIVE-05**: Reconnect-Overlay erscheint sobald SSE-Verbindung während des Restarts abbricht
- [ ] **LIVE-06**: UI pollt /api/version nach Restart alle 2s bis neue SHA antwortet, maximal 90s
- [ ] **LIVE-07**: Bei SHA-Change lädt UI die Seite automatisch neu und zeigt Erfolgs-Banner mit neuer Version
- [ ] **LIVE-08**: Bei 90s-Timeout zeigt UI Fehlermeldung mit Hinweis, per SSH den Service zu prüfen

### Rollback & Recovery (ROLL)

- [ ] **ROLL-01**: Updater-Script hat `trap ERR` das bei jedem fehlgeschlagenen Schritt Rollback auslöst
- [ ] **ROLL-02**: Rollback-Stufe 1: git reset --hard <rollback-sha> → pnpm install → pnpm build → systemctl start
- [ ] **ROLL-03**: Rollback-Stufe 2 (wenn Stufe 1 fehlschlägt): Tarball-Snapshot extrahieren, dann restart
- [ ] **ROLL-04**: Health-Probe nach Restart: bis zu 60s `/api/version` pollen; bei Fail Rollback triggern
- [ ] **ROLL-05**: Rollback-Status wird in `.update-state/state.json` persistiert (damit UI beim nächsten Laden informieren kann)
- [ ] **ROLL-06**: UI zeigt beim nächsten Seitenaufruf roten Banner "Update fehlgeschlagen, auf Version X zurückgerollt" wenn Rollback passiert ist
- [ ] **ROLL-07**: Pushover-Benachrichtigung wird vom Updater-Script bei erfolgreichem und fehlgeschlagenem Update gesendet

### Infrastructure (INFR)

- [ ] **INFR-01**: Neue systemd-Unit `charging-master-updater.service` (Type=oneshot) installiert von install.sh
- [ ] **INFR-02**: Shell-Script `scripts/update/run-update.sh` enthält die komplette Update-Pipeline mit Rollback-Logik
- [ ] **INFR-03**: Drizzle-Schema `update_runs` Tabelle loggt jeden Versuch (start_at, end_at, from_sha, to_sha, status, error)
- [ ] **INFR-04**: `.update-state/state.json` hält aktuellen SHA, Rollback-SHA, ETag, letzten Check, Update-Status

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
| Auto-Install ohne User-Klick (v1.2) | Gefährlich während aktiver Ladevorgänge — immer explizite Bestätigung |
| Auto-Apply von DB-Migrationen (v1.2) | In v1.2 gibt es keine Migrationen; Schema-Änderungen werden manuell gehandhabt bis Migrations-Strategie steht |
| Symlink-Swap Release Layout (v1.2) | In-Place + Tarball-Snapshot reicht für v1.2; Symlink-Swap ist v1.3-Kandidat wenn Rollback-Probleme auftauchen |
| Changelog-Preview mit Commit-Liste (v1.2) | Commit-Message des HEAD reicht; Full-Changelog zwischen SHAs deferred auf v1.3 |
| GitHub PAT / authentifizierte API-Calls | 60 req/h unauth reichen für 4 Checks/Tag bei weitem |
| Post-Restart Watchdog für "boot-loop crashes" | Rollback fängt Pipeline-Fehler; wenn neuer Commit beim Start crasht nach Health-Fail, per SSH eingreifen |
| Auto-Update-Kanal (stable/beta) | Single Branch (main) reicht, kein Release-Kanal-Konzept |

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

### v1.1 (Complete)

| Requirement | Phase | Status |
|-------------|-------|--------|
| POLL-01..04 | Phase 5 | Complete |
| RELAY-01..02 | Phase 5 | Complete |
| DISC-01..03 | Phase 6 | Complete |
| CLEAN-01..05 | Phase 6 | Complete |

### v1.2 (Active)

| Requirement | Phase | Status |
|-------------|-------|--------|
| VERS-01..04 | TBD | Pending |
| DETE-01..06 | TBD | Pending |
| EXEC-01..06 | TBD | Pending |
| LIVE-01..08 | TBD | Pending |
| ROLL-01..07 | TBD | Pending |
| INFR-01..04 | TBD | Pending |

**Coverage:**
- v1.0 requirements: 34 total, 34 complete
- v1.1 requirements: 14 total, 14 complete
- v1.2 requirements: 35 total, 0 mapped (awaiting roadmap)

---
*Requirements defined: 2026-03-25*
*Last updated: 2026-04-10 — v1.2 Self-Update requirements added*
