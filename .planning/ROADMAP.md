# Roadmap: Charging-Master

## Milestones

- v1.0 MVP - Phases 1-4 (shipped 2026-04-09)
- v1.1 MQTT raus, HTTP rein - Phases 5-6 (complete)
- v1.2 Self-Update - Phases 7-10 (complete)
- v1.3 SOC Intelligence - Phase 11 (deployed 2026-05-15; on-device Pushover render verify pending) + v1.3.1 patch (real-iPad threshold calibration, 0.05→0.20)
- v1.4 Flat-Power Defense + Pipeline Hardening - Phases 12-13 (active 2026-05-15)

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
- [x] **Phase 10: UI Integration & Restart Handoff** - Install button, SSE log stream, stage-stepper, live log panel, reconnect overlay, auto-reload, rollback-happened banner

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
**Plans:** 2/2 plans executed
**UI hint**: yes

Plans:
- [x] 10-01-PLAN.md — Type extensions + trigger/log/ack-rollback backend routes with dev-mode fallbacks
- [x] 10-02-PLAN.md — InstallModal, UpdateStageStepper, UpdateLogPanel, ReconnectOverlay + UpdateBanner state machine + rollback banner

### Phase 11: SOC Confidence Band + ASCII Visualization
**Goal**: Replace the single-point `estimatedStartSoc` with a confidence band `{socMin, socMax, socBest}` that visually narrows as the live charge curve disambiguates against the reference — surfaced as an ASCII bar in Pushover notifications, server logs, and the dashboard — so user-visible SOC mis-estimations on flat-power phases (root cause of the 2026-05-13 iPad mis-stop at 47 % → "80 %") become impossible.
**Depends on**: Phase 3 (Charge Intelligence — curve-matcher, charge-monitor, state-machine, soc-estimator), Phase 4 (Notifications — Pushover client)
**Requirements**: SOCB-01, SOCB-02, SOCB-03, SOCB-04, SOCB-05, SOCB-06
**Success Criteria** (what must be TRUE):
  1. `curve-matcher.findBestCandidate` returns `{ socMin, socMax, socBest, bandConfidence }` in addition to the existing `estimatedStartSoc` (= socBest), derived from all DTW offsets whose score is within the configured threshold (initial 15 %) of the best score; verified by a property test on synthetic flat-power-then-taper reference curves.
  2. `charge-monitor.updateSocTracking` forwards `socMin` and `socMax` alongside `socBest` so the band is available on every emitted `ChargeStateEvent`; the band narrows only when a new matcher run reduces the plausible-offset set, not on Wh accumulation alone.
  3. Stop logic in `charge-state-machine.handleCharging`/`handleCountdown` supports both modes via a `config.stopMode` setting: **conservative** (`socMin >= targetSoc`) and **aggressive** (`socBest >= targetSoc` AND `socMax - socMin <= 5`); default is aggressive; toggle exposed in `/settings`.
  4. Pure function `renderSocBandAscii({ socMin, socMax, socBest, targetSoc, width = 40 })` produces a deterministic 0-100 % monospace bar using `▓` (best ± 5 %), `▒` (band), `░` (outside band), `↑` (best), `▲` (target); ≥ 6 snapshot tests cover representative inputs including full-uncertainty band (0-100), narrow band, exact-target, band crossing target.
  5. `NotificationService.buildCompleteMessage`, `buildMatchedMessage`, and the `fireAnomalyNotification` path attach the ASCII bar and send Pushover with `monospace=1`; verified in unit tests by asserting the message body contains the rendered bar.
  6. `ChargeStateEvent` (`types.ts`) carries `socMin`, `socMax`, `socBandConfidence`, `socAsciiBar`; SSE payloads on `/api/sse/charge` expose them; the dashboard renders a live band component with CSS-animated narrowing that falls back to the inline ASCII bar without JS.
  7. Existing override path (`PUT /api/charging/sessions/[id]` with `estimatedSoc`) continues to work, collapses the band to a zero-width point, and logs a `soc_corrections` row exactly as before — no regression in the calibration learning loop.
**Plans:** 4/4 plans complete

Plans:
- [x] 11-01-PLAN.md — DTW distances vector + deriveBand + MatchResult band fields + iPad fixture (wave 1)
- [x] 11-02-PLAN.md — Drizzle migration + stop-mode module + state-machine band-aware stop + charge-monitor band propagation, captureEventContext, resume, override (wave 2)
- [x] 11-03-PLAN.md — Pure renderSocBandAscii + Pushover monospace flag + NotificationService matched/complete bar + anomaly bar (wave 2)
- [x] 11-04-PLAN.md — SocBandIndicator component (CSS-animated, ASCII fallback) + ChargingSettings stop-mode + bandThreshold + SSE active-replay band hydration (wave 3)

### Phase 12: Flat-Power Defense
**Goal**: The state machine cannot hang on a finished charge: power-flow watchdog catches 0W stalls, the matcher refreshes during `state=charging` to escape false flat-region anchoring, and the stop logic falls back to band-confidence-aware safe behavior. Eliminates the "16h plug-on at 0W" class observed on 2026-05-14 (117 Session 4) AND closes the v1.3 deferral that `socBest` can stick to a wrong offset in the flat region (real iPad data exposes this regardless of band threshold).
**Depends on**: Phase 11 (SOC Confidence Band — band fields + stop-mode infrastructure), Phase 4 (Notifications — Pushover anomaly path)
**Requirements**: FPD-01, FPD-02, FPD-03, FPD-04, FPD-05
**Success Criteria** (what must be TRUE):
  1. A new stale-power watchdog fires when `apower < 1.0 W` for ≥ 5 consecutive minutes during `state ∈ {charging, countdown}` — the state machine transitions to `aborted` with `stop_reason='stale_power'`, the relay is switched off, and a Pushover anomaly notification (with the current band's ASCII bar) is sent. Verified by an integration test that drives the monitor end-to-end with fake timers.
  2. In `state=charging`, the matcher re-runs every N readings (default N=60 ≈ 5 min at 5s sampling) against the growing query window. Each re-run updates the band fields; the band is allowed to *narrow* monotonically (never widen) so user-visible band confidence only ever improves. When `socBest` crosses `targetSoc` AND `width ≤ 5` (aggressive) OR `socMin ≥ targetSoc` (conservative), the existing stop-mode logic fires — closing the original v1.3 design gap (matcher previously ran only once at `state=matching` and never re-evaluated). Verified by a property test on the iPad Session-14 fixture that proves the band sharpens AFTER 40+ min of readings as taper data arrives.
  3. A band-confidence-aware fallback prevents premature aggressive stops on low-confidence bands: if `socBandConfidence < 0.5` (= band width > 50% SOC), the state machine refuses BOTH aggressive and conservative band-mode stops and falls back to the legacy energy-based stop (`(target - estimatedStartSoc) × totalEnergyWh`). The fallback is observable in `ChargeStateEvent.stopMode='energy_fallback'` for the UI/Pushover. Unit-tested for ordering and threshold edges.
  4. A session-max-duration watchdog aborts any session that runs longer than `config.charging.maxSessionHours` (default 24h) with `stop_reason='timeout'`. Configurable via Settings page. Prevents runaway sessions when no other defense fires (e.g., matcher never re-detects taper because the device disconnects and reconnects partial). Unit-tested for boundary.
  5. The dashboard charge banner surfaces watchdog state: when `apower=0 W` for > 60s during `state=charging`, the banner shows a yellow "Watchdog: 0W seit Xs" indicator (CSS-animated). When the watchdog actually fires at 5min, the banner transitions to red "Session abgebrochen — Battery full?" with a manual "Acknowledge"-button that clears it. RTL tests cover both warning and fired states.
**Plans:** 4 plans

Plans:
- [ ] 12-01-PLAN.md — Stale-Power Watchdog (FPD-01): counter on state machine, abort path through ChargeMonitor, Pushover anomaly, config rows, ChargeStateEvent watchdog fields (wave 1)
- [ ] 12-02-PLAN.md — Adaptive Matcher Refresh + Energy-Fallback (FPD-02 + FPD-03): chargingBuffers map, monotonic-narrowing refresh, shouldStopEnergyFallback predicate, stopMode='energy_fallback' event field (wave 2)
- [ ] 12-03-PLAN.md — Session Max-Duration Watchdog (FPD-04): wall-clock check, reason-routing in handleTransition('aborted'), fireTimeoutNotification (wave 2)
- [ ] 12-04-PLAN.md — UI Watchdog Indicators + Settings exposure (FPD-05): yellow countdown, red fired banner with localStorage ack, 5 new Settings inputs (wave 3)

### Phase 13: Update Pipeline Hardening
**Goal**: The self-updater survives operational mess on production LXCs (untracked diagnostics, partial commits, stale state.json after early failure). No more "one wrong scp + the whole pipeline is bricked until manual SSH recovery" like 2026-05-15.
**Depends on**: Phase 9 (Updater Pipeline + systemd unit), Phase 10 (UI integration + ack-rollback)
**Requirements**: PIPE-01, PIPE-02, PIPE-03, PIPE-04
**Success Criteria** (what must be TRUE):
  1. `scripts/update/run-update.sh` `stage=preflight_git`: when the working tree contains untracked files (no modified-tracked files), the preflight moves them to `.update-state/quarantine-<timestamp>/<orig-path>/` (preserving directory structure) and continues. The quarantine is reported in the journal and surfaced via `/api/update/status` as `lastQuarantine`. Modified-tracked files still fatal-fail (those carry real risk). Verified by a dry-run-helpers test.
  2. The updater's `trap on_error ERR` ALWAYS resets `state.json:updateStatus` from `installing` → `idle` before exiting non-zero, regardless of which stage failed. The reset is verified atomically (tmp + rename). A failed preflight no longer leaves the pipeline stuck on 409 "already in progress". Verified by a unit test on the bash script (using `set -e; false` injected into preflight stage).
  3. The UpdateBanner UI surfaces a new "preflight quarantined N file(s)" info state with a "Show details" link to `/settings/update-state` (new minimal admin page) listing quarantined files. Files can be inspected (read-only) or deleted from the UI. Acceptance: clicking "delete all" empties the quarantine dir.
  4. A localhost-guarded recovery endpoint `POST /api/internal/reset-update-state` exists for emergencies: forces `state.json:updateStatus='idle'`, clears `inProgressUpdate`, and writes a `recovery_event` row to `update_runs`. Host-guarded same as `/api/internal/prepare-for-shutdown` (per src/lib/host-guard.ts). Not exposed in UI — last-resort SSH-from-LXC fix.
**Plans:** 4 plans

Plans:
- [ ] 13-01-PLAN.md — preflight_git quarantine + on_error idle reset + state.json lastQuarantine field + dry-run tests (PIPE-01 + PIPE-02, wave 1)
- [ ] 13-02-PLAN.md — POST /api/internal/reset-update-state recovery endpoint + updateRuns enum widening + UpdateHistory union update (PIPE-04, wave 2)
- [ ] 13-03-PLAN.md — DELETE /api/admin/update-state/quarantine backend endpoint with path-safety guard (PIPE-03 backend, wave 2)
- [ ] 13-04-PLAN.md — UpdateBanner stacked quarantine info + /settings/update-state admin page + QuarantineList client component (PIPE-03 UI, wave 3)

## Progress

**Execution Order:**
Phases execute in numeric order: 1 -> 2 -> 3 -> 4 -> 5 -> 6 -> 7 -> 8 -> 9 -> 10 -> 11 -> 12 -> 13

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
| 10. UI Integration & Restart Handoff | v1.2 | 2/2 | Complete | 2026-04-10 |
| 11. SOC Confidence Band + ASCII Visualization | v1.3 | 4/4 | Complete   | 2026-05-14 |
| 12. Flat-Power Defense | v1.4 | 4/4 | Complete | 2026-05-15 |
| 13. Update Pipeline Hardening | v1.4 | 4/4 | Complete | 2026-05-15 |

## Backlog

### Phase 999.1: Multi-Channel Shelly Support (Schema + Code Refactor) (BACKLOG)

**Goal:** [Captured for future planning] Drop the `?id=0` hardcoding that permeates the codebase so that multi-channel Shelly devices (Pro 2PM / 4PM, 2PM Gen3) are enumerated, addressed, and charged per-channel — with the user-defined Switch names (`Switch.GetConfig.name`) surfaced throughout the UI.

**Requirements:** TBD
**Plans:** 0 plans

**Problem:**
Every relay/polling/discovery path assumes one switch per device at id=0:
- `src/modules/shelly/relay-http.ts` — `switchRelayOnHttp/Off` hardcode `?id=0`
- `src/modules/shelly/http-polling-service.ts` — polls only `Switch.GetStatus?id=0`
- `src/modules/shelly/discovery-scanner.ts` — one ScanResult per IP (not per channel)
- `src/app/api/devices/[id]/relay/route.ts` and `src/app/api/devices/relay-by-ip/route.ts` — call `switchRelay*` without a channel parameter
- MQTT topics documented in CLAUDE.md: `<device_id>/status/switch:0`, `<device_id>/command/switch:0`
- DB schema `plugs`: one row per device, no channel column. `charge_sessions.plug_id` and `power_readings.plug_id` reference the device, not a channel.

Works fine on the current Shelly Plug S Gen3 (physically single-channel). A Pro 2PM or 4PM would silently lose channels 1..N. Separately, the `Switch.GetConfig.name` the user set in the Shelly admin UI (e.g. "Schuppen") is ignored today.

**Scope of the refactor:**
- Schema migration: `plugs` gets `channel_id INTEGER NOT NULL DEFAULT 0`; PK becomes `(id, channel_id)` — or normalize by splitting into `devices` + `plug_channels`. `charge_sessions` and `power_readings` both need `channel_id`.
- `relay-http.ts`: `switchRelayOnHttp(ip, channelId = 0)`.
- `http-polling-service.ts`: iterate every channel per device, poll `Switch.GetStatus?id=N` each.
- `discovery-scanner.ts`: `Shelly.GetComponents?include=["status","config"]&dynamic_only=false`, enumerate all `switch:N`, one ScanResult per channel, include `Switch.GetConfig.name`.
- All relay endpoints accept `channelId` (path / body).
- `ChargeMonitor`/`ChargeStateMachine`: instance keyed by `(plugId, channelId)`.
- EventBus / SSE: events carry `channelId`; UI filters by it.
- UI: DiscoveryList renders one row per channel (channel name = primary label). `RegisteredDeviceRow` shows all channels of a device with per-channel toggle + watts. Plug-detail routes become `/devices/[deviceId]/[channelId]` (or virtual-plug abstraction stays and URL remains).

**Migration strategy:**
- Existing rows (`shellyplugsg3-charging-master-1`, `-2`) get `channel_id = 0` via migration — no data loss.
- Re-discovery run after migration backfills `Switch.GetConfig.name` into the DB.

**Acceptance:**
- Plugging in a Shelly Pro 2PM/4PM exposes all channels, each addressable and chargeable individually.
- Shelly-defined Switch names are used throughout the UI.
- Single-channel devices keep working unchanged.
- Zero `?id=0` hardcodes left in the code.

**Why this lives in the backlog, not a quick task:**
Schema migration + ~8 touchpoints in code + UI structural change + state-machine lifecycle rework. This is a Phase with research / discuss / plan / execute, not a 1–3 task patch.

Plans:
- [ ] TBD (promote with /gsd-review-backlog when ready)

### Phase 14: Catalog Auto-Sync v2 — GitHub App + PR-Flow

**Goal:** Re-enable catalog auto-sync (parked 2026-05-20 in `1556520` after user raised concern about LXC needing long-lived GitHub write rights) with state-of-the-art auth: replace direct-push-with-PAT with a GitHub App that mints short-lived (~1h) installation tokens via JWT, push to `submissions/<profileId>-<ts>` branches, open PRs, and let Branch Protection on `main` enforce review. CI workflow on PRs validates schema + path allowlist + size. UI re-enabled, setup docs added.

**Depends on:** Phase 13 (Update Pipeline Hardening — quarantine + state.json recovery model)

**Success Criteria** (what must be TRUE):
  1. `src/modules/catalog/github-publish.ts` mints short-lived installation tokens via JWT signed with the GitHub App's RSA private key; tokens are never persisted; each publish cycle starts with a fresh mint; the JWT path uses RS256 with `iat`, `exp` (≤10min), `iss=appId` per the GitHub spec, then exchanges JWT for an installation token at `POST /app/installations/{installationId}/access_tokens`.
  2. Publish flow creates a new branch `submissions/<profileSlug>-<unix-ts>` from `main`'s tip, commits the changed catalog files to that branch (Data API: create tree → create commit → update ref), and opens a PR titled `catalog: auto-sync <reason> (<profile name>)` with body containing the sync log entry id + trigger reason. PRs are auto-labelled `auto-sync`. Direct pushes to `main` are NEVER attempted — branch protection would reject them anyway, but the code must not even try.
  3. Five env vars are added and zod-validated in `src/lib/env.ts`: `GITHUB_APP_ID` (string), `GITHUB_APP_PRIVATE_KEY_PATH` (path to PEM file on LXC, **OR** `GITHUB_APP_PRIVATE_KEY` PEM-literal — exactly one required), `GITHUB_APP_INSTALLATION_ID` (string), `CATALOG_REPO_OWNER`, `CATALOG_REPO_NAME`. Missing/invalid → app boots fine but `isAutoSyncEnabled()` returns false with a structured error reason surfaced on `GET /api/catalog/sync-status`.
  4. New `.github/workflows/validate-catalog-submission.yml` in the **catalog repo** (not this repo) runs on `pull_request` against `submissions/**` branches: parses each changed file as JSON (catalog entries) or accepts only as image/jpeg|png (≤2 MB), enforces path allowlist (`catalog/profiles/**`, `catalog/INDEX.json`), validates JSON entries against the published catalog zod schema, fails the PR check with a comment listing offenses on violation. Workflow file shipped from this repo as a setup artifact users copy into their catalog repo (since we can't push into the catalog repo via CI from here).
  5. `isAutoSyncEnabled()` default flipped back to `true` (the gate added in 1556520 is removed). Catalog-settings UI restores the "Letzte Synchronisation" widget + active toggle + active "Jetzt synchronisieren" button — recover the JSX deleted in 1556520 from commit `700e6eb`. `GET /api/catalog/sync-status` now exposes `lastPr` (`{ number, url, branch, state }`) alongside existing fields.
  6. `docs/CATALOG_AUTOSYNC.md` exists with: (a) GitHub App registration walk-through (permissions: Contents R/W, Pull Requests R/W; scope: one specific repo), (b) private key generation + LXC placement under `/opt/charging-master/secrets/github-app.pem` (chmod 600), (c) installation ID retrieval, (d) Branch Protection setup on `main` (require PR + 1 review + no force-push), (e) env-var wiring, (f) end-to-end smoke test via Bosch PowerTube 625 photo upload, (g) rollback recipe (disable sync via env-var removal).
  7. Smoke test passes manually: upload a fresh product photo on the Bosch PowerTube 625 profile (per parked-memory notes — current catalog/INDEX.json shows `hasPhoto=false` for that profile, so it's the natural test target). Within 15s a PR appears on the catalog repo with branch `submissions/bosch-powertube-625-<ts>` containing the new `.photo.jpg`, the CI workflow passes, manual merge promotes it to `main`, and public consumers see the photo on next snapshot fetch.
  8. Backward-compat: existing `catalog_sync_log` table (migration `0013_demonic_charles_xavier`) continues to work; rows gain a new `pr_url` text column (migration `0014_*` adds it). All trigger sites already wired in `700e6eb` keep working (no changes to call sites).

**Out of scope** (parked or excluded):
- Submission-Broker variant (central-instance-only model) — fallback option if GitHub App proves operationally annoying.
- Webhook listener for merged-PR events — we only publish, never consume GitHub events back.
- Multi-catalog-repo support — single catalog repo only.
- PAT fallback path — explicitly **NOT** shipped, even as a feature flag. Anti-goal: ensure no long-lived secret remains a tempting shortcut.

**Plans:** 0 plans

Plans:
- [ ] TBD (run /gsd-plan-phase 14 to break down)
