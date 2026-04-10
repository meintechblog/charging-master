# Roadmap: Charging-Master

## Milestones

- v1.0 MVP - Phases 1-4 (shipped 2026-04-09)
- v1.1 MQTT raus, HTTP rein - Phases 5-6 (complete)
- v1.2 Self-Update - Phases 7-10 (planning)

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

<details>
<summary>v1.0 MVP (Phases 1-4) - SHIPPED 2026-04-09</summary>

- [x] **Phase 1: Foundation** - MQTT connectivity, Shelly plug management, SQLite database, and app settings
- [x] **Phase 2: Real-Time Visualization** - Live power charts, dashboard with plug overview, and manual relay control UI
- [x] **Phase 3: Charge Intelligence** - Device profiles, reference curve learning, automatic device detection, SOC estimation, and auto-stop
- [x] **Phase 4: Notifications & History** - Pushover alerts for charge events and per-device session history

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
- [x] 03-05-PLAN.md — Active charging UI (detection banner, SOC countdown, unknown device dialog, dashboard/detail wiring)

### Phase 4: Notifications & History
**Goal**: Users are notified about charge events and can review past charging sessions
**Depends on**: Phase 3
**Requirements**: NOTF-01, NOTF-02, NOTF-03, NOTF-04, HIST-01, HIST-02, HIST-03
**Success Criteria** (what must be TRUE):
  1. User receives Pushover notifications when charging starts, a device is recognized, target SOC is reached, or an error occurs
  2. User can view a per-device charge history showing session details (start, end, energy consumed, final SOC)
  3. User can view the power curve from any past charge session
**Plans:** 3 plans
**UI hint**: yes

Plans:
- [x] 04-01-PLAN.md — NotificationService with Pushover dispatch, SessionRecorder for readings/events persistence, sessionEvents schema
- [x] 04-02-PLAN.md — History list page with table/filters, history API route, sidebar Verlauf link activation
- [x] 04-03-PLAN.md — Session detail page with power curve replay, reference overlay, event timeline, profile sessions section

</details>

### v1.1 MQTT raus, HTTP rein (Complete)

**Milestone Goal:** MQTT komplett entfernen und durch direkte HTTP-Kommunikation mit Shelly Plugs ersetzen -- einfacher, zuverlaessiger, kein Broker noetig.

- [x] **Phase 5: HTTP Communication** - HTTP polling service for power data, HTTP relay control, replacing the MQTT data path
- [x] **Phase 6: Device Discovery & MQTT Removal** - Network scan for Shelly discovery, complete removal of all MQTT code and dependencies

### v1.2 Self-Update (Planning)

**Milestone Goal:** In-App-Update-Mechanismus, der neue Versionen aus dem GitHub-Repo automatisch erkennt und auf Knopfdruck einspielt -- mit sauberem Restart und Auto-Rollback bei Fehler.

- [x] **Phase 7: Version Foundation & State Persistence** - Build-time SHA generation, /api/version endpoint, update_runs table, state.json, Settings version display
- [x] **Phase 8: GitHub Polling & Detection** - ETag-aware GitHub client, 6h background checker, manual check endpoint, update-available badge and banner
- [x] **Phase 9: Updater Pipeline & systemd Unit** - run-update.sh with rollback trap, pre-shutdown drain, oneshot systemd unit, tarball snapshot, two-stage rollback, post-restart health gate
- [ ] **Phase 10: UI Integration & Restart Handoff** - Install button, SSE log stream, stage-stepper, live log panel, reconnect overlay, auto-reload, rollback-happened banner

## Phase Details

### Phase 5: HTTP Communication
**Goal**: App communicates with Shelly Plugs entirely over HTTP -- polling for power data and controlling relays without any MQTT dependency
**Depends on**: Phase 4
**Requirements**: POLL-01, POLL-02, POLL-03, POLL-04, RELAY-01, RELAY-02
**Success Criteria** (what must be TRUE):
  1. Power readings from all registered Shelly Plugs arrive continuously via HTTP polling and appear in the live chart and dashboard identically to the old MQTT path
  2. User can configure the polling interval per device and the app respects that interval
  3. Device online/offline status updates correctly based on HTTP reachability (device shows offline when unreachable, online when responding)
  4. User can toggle relay on/off from the dashboard and it executes via Shelly HTTP API (/rpc/Switch.Set), with relay state read from the polling response
**Plans:** 2 plans

Plans:
- [x] 05-01-PLAN.md — HttpPollingService and relay-http standalone modules with unit tests
- [x] 05-02-PLAN.md — Wire HTTP modules into server.ts, ChargeMonitor, relay-controller, and API routes

### Phase 6: Device Discovery & MQTT Removal
**Goal**: Users can discover Shelly Plugs on the network without MQTT, and all MQTT code is completely removed from the codebase
**Depends on**: Phase 5
**Requirements**: DISC-01, DISC-02, DISC-03, CLEAN-01, CLEAN-02, CLEAN-03, CLEAN-04, CLEAN-05
**Success Criteria** (what must be TRUE):
  1. User can trigger a network scan that finds Shelly Plugs in the local subnet and displays their ID, IP, model, and current power reading
  2. User can register a discovered device with one click, and IP address is required for device registration
  3. The mqtt.js package is gone from package.json, MqttService and src/modules/mqtt/ are deleted, and the app starts and runs without any MQTT broker
  4. Settings page no longer shows MQTT configuration, and no MQTT references remain in server.ts, global.d.ts, or ChargeMonitor
**UI hint**: yes
**Plans:** 2 plans

Plans:
- [x] 06-01-PLAN.md — HTTP subnet scanner, discovery API rewrite, discovery UI with scan button, IP required for registration
- [x] 06-02-PLAN.md — Complete MQTT removal: delete module/routes/settings/globals/package dependency

### Phase 7: Version Foundation & State Persistence
**Goal**: The running app knows exactly which commit it is, exposes that over HTTP for health checks, and has durable cross-process state plumbing ready for the updater pipeline -- all without touching systemd yet
**Depends on**: Phase 6
**Requirements**: VERS-01, VERS-02, VERS-03, VERS-04, INFR-03, INFR-04
**Success Criteria** (what must be TRUE):
  1. `pnpm build` (and `pnpm dev`) regenerates `src/lib/version.ts` with the current short SHA, full SHA, and ISO build timestamp -- and that file is git-ignored
  2. `GET /api/version` returns `{ sha, shaShort, buildTime, rollbackSha, dbHealthy }` in under 50ms, with `dbHealthy` reflecting a live SQLite probe
  3. The Settings page shows the short SHA prominently; hovering reveals the full SHA and copies to clipboard on click
  4. A fresh `.update-state/state.json` is created on first boot and can be read/written atomically via `UpdateStateStore` (tmp-file + rename), and Drizzle migrations create the `update_runs` table
**Plans:** 2 plans
**UI hint**: yes

Plans:
- [x] 07-01-PLAN.md — Version generation script, Drizzle update_runs migration, self-update module (types + UpdateStateStore with atomic writes)
- [x] 07-02-PLAN.md — GET /api/version with DB health probe, UpdateStateStore.init() boot wiring, VersionBadge on Settings page

### Phase 8: GitHub Polling & Detection
**Goal**: The app autonomously knows when a new commit lands on `main`, surfaces that awareness in the UI, and lets the user force an immediate check -- all without consuming GitHub's rate limit budget
**Depends on**: Phase 7
**Requirements**: DETE-01, DETE-02, DETE-03, DETE-04, DETE-05, DETE-06
**Success Criteria** (what must be TRUE):
  1. An `UpdateChecker` singleton booted from `server.ts main()` polls `GET /repos/meintechblog/charging-master/commits/main` every 6 hours and persists the returned ETag in `state.json`; subsequent polls send `If-None-Match` and correctly handle 304 (no rate-limit consumption)
  2. When the remote SHA differs from the baked-in `CURRENT_SHA`, an update-available badge appears on the Settings nav entry and a banner on `/settings/updates` shows the new SHA, commit message, author, and commit date
  3. A "Jetzt prüfen" button in Settings triggers an immediate check and is rate-limited server-side to at most once every 5 minutes
  4. The Settings page displays the timestamp of the last check and its outcome (up-to-date, update available, error)
**Plans:** 2 plans
**UI hint**: yes

Plans:
- [x] 08-01-PLAN.md — Self-update types, ETag-aware GitHubClient, UpdateChecker singleton, /api/update/status and /api/update/check routes, server.ts boot wiring
- [x] 08-02-PLAN.md — UpdateBanner client component with 5 render states, server-side initial fetch, sidebar red dot via useUpdateAvailable() hook

### Phase 9: Updater Pipeline & systemd Unit
**Goal**: A single `systemctl start --no-block charging-master-updater.service` safely fetches, installs, builds, restarts and verifies the new version -- and auto-rolls-back to a working state on any failure, with every step observable via `journalctl`
**Depends on**: Phase 7 (can develop in parallel with Phase 8; must deploy before Phase 10)
**Requirements**: EXEC-01, EXEC-02, EXEC-03, EXEC-04, EXEC-05, EXEC-06, ROLL-01, ROLL-02, ROLL-03, ROLL-04, ROLL-05, ROLL-06, ROLL-07, INFR-01, INFR-02
**Success Criteria** (what must be TRUE):
  1. `install.sh` installs `/etc/systemd/system/charging-master-updater.service` as a `Type=oneshot` sibling unit, and `systemctl start --no-block charging-master-updater.service` returns instantly (verified by the triggering API route not blocking)
  2. `scripts/update/run-update.sh` runs the full pipeline in order (pre-flight checks → tarball snapshot → `POST /api/internal/prepare-for-shutdown` → `systemctl stop` → `git fetch` + `git reset --hard` → `pnpm install --frozen-lockfile` → `rm -rf .next` + `pnpm build` → `systemctl start` → health-probe) with `flock` preventing concurrent runs, and pre-flight fails fast if <500MB disk, wrong pnpm/Node, or dirty git tree
  3. `POST /api/internal/prepare-for-shutdown` completes a `PRAGMA wal_checkpoint(TRUNCATE)` and gracefully stops `HttpPollingService` before the script proceeds to `systemctl stop` -- verified by no new writes hitting the DB between checkpoint and stop
  4. `trap ERR` triggers a two-stage rollback on any failure: Stage 1 does `git reset --hard <rollback-sha>` **followed by** `pnpm install --frozen-lockfile` and a full `rm -rf .next` + `pnpm build` before restart; if Stage 1 fails, Stage 2 extracts the pre-update tarball from `.update-state/snapshots/<old-sha>.tar.gz` and restarts
  5. After `systemctl start`, the script polls `http://localhost:3000/api/version` for up to 60s and only declares success if HTTP 200 returns with `sha === target-sha` AND `dbHealthy === true`; any other result triggers rollback and writes `rollback_happened=true` to `state.json`
  6. Pushover notification is sent from the shell script on both successful update (old SHA → new SHA) and failed update (which rollback stage ran, error message), and every run writes a row to `update_runs` with `start_at`, `end_at`, `from_sha`, `to_sha`, `status`, and `error`
**Plans:** 3 plans

Plans:
- [x] 09-01-PLAN.md — Drain endpoint (POST /api/internal/prepare-for-shutdown) + HttpPollingService.stopPolling() no-arg overload
- [x] 09-02-PLAN.md — run-update.sh pipeline + charging-master-updater.service + install.sh deployment updates
- [x] 09-03-PLAN.md — dry-run-helpers.sh dev harness + human verification of preflight/snapshot/drain/health_probe

### Phase 10: UI Integration & Restart Handoff
**Goal**: A single click in the Settings UI carries the user through the entire update experience -- confirmation, live log, restart blackout, reconnect, success banner -- with rollback failures made loud and unmistakable on the next page load
**Depends on**: Phase 7, Phase 8, Phase 9
**Requirements**: LIVE-01, LIVE-02, LIVE-03, LIVE-04, LIVE-05, LIVE-06, LIVE-07, LIVE-08, ROLL-06
**Success Criteria** (what must be TRUE):
  1. The Install button opens a confirmation modal; on confirm it POSTs to the trigger endpoint, stores the expected target SHA in localStorage, and the UI immediately switches to the stage-stepper + live-log view
  2. `GET /api/update/log` streams `journalctl -fu charging-master-updater` live via SSE, and its `journalctl` child process is reliably killed on **both** `request.signal.abort` AND the ReadableStream `cancel()` callback (verified by no orphan `journalctl` processes after the user closes the tab)
  3. The stage-stepper advances through Snapshot → Drain → Stop → Fetch → Install → Build → Start → Verify as the updater emits `::STAGE::` sentinel lines, and the live-log panel auto-scrolls with monospace terminal styling
  4. When the SSE connection drops during restart, a reconnect overlay appears and polls `/api/version` every 2s; on SHA-change the page auto-reloads and shows a green success banner with old-SHA → new-SHA; after 90s without SHA change it shows an error with an SSH hint to run `journalctl -u charging-master-updater`
  5. If `state.json` has `rollback_happened=true` on the next page load, a persistent red banner appears saying "Update fehlgeschlagen, auf Version X zurückgerollt" with a link to the run log, and the banner can be dismissed (which clears the flag)
**Plans:** 2 plans
**UI hint**: yes

Plans:
- [ ] 10-01-PLAN.md — Type extensions + trigger/log/ack-rollback backend routes with dev-mode fallbacks
- [ ] 10-02-PLAN.md — InstallModal, UpdateStageStepper, UpdateLogPanel, ReconnectOverlay + UpdateBanner state machine + rollback banner

## Progress

**Execution Order:**
Phases execute in numeric order: 1 -> 2 -> 3 -> 4 -> 5 -> 6 -> 7 -> 8 -> 9 -> 10

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 1. Foundation | v1.0 | 3/3 | Complete | 2026-04-09 |
| 2. Real-Time Visualization | v1.0 | 3/3 | Complete | 2026-04-09 |
| 3. Charge Intelligence | v1.0 | 5/5 | Complete | 2026-04-09 |
| 4. Notifications & History | v1.0 | 3/3 | Complete | 2026-04-09 |
| 5. HTTP Communication | v1.1 | 2/2 | Complete | - |
| 6. Device Discovery & MQTT Removal | v1.1 | 2/2 | Complete | - |
| 7. Version Foundation & State Persistence | v1.2 | 2/2 | Complete | 2026-04-10 |
| 8. GitHub Polling & Detection | v1.2 | 2/2 | Complete | 2026-04-10 |
| 9. Updater Pipeline & systemd Unit | v1.2 | 3/3 | Complete | 2026-04-10 |
| 10. UI Integration & Restart Handoff | v1.2 | 0/0 | Not started | - |
