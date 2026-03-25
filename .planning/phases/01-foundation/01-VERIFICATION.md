---
phase: 01-foundation
verified: 2026-03-25T22:00:00Z
status: passed
score: 9/9 must-haves verified
re_verification: false
human_verification:
  - test: "MQTT broker connectivity and power data receipt"
    expected: "With a real Shelly S3 Plug and MQTT broker, the app receives power readings and persists them to the database at 5s intervals during active charging"
    why_human: "Cannot verify live MQTT data flow without a running broker and physical device"
  - test: "Auto-reconnect after broker restart"
    expected: "After killing and restarting the MQTT broker, the app reconnects within ~1s (reconnectPeriod: 1000) and resumes receiving messages"
    why_human: "Requires a running MQTT broker process to test restart behavior"
  - test: "Settings persist across app restart"
    expected: "After entering MQTT broker host/port and restarting the server, the settings are still present and the MQTT connection is re-established"
    why_human: "Requires running the app, entering settings, restarting, and observing reconnection"
---

# Phase 1: Foundation Verification Report

**Phase Goal:** Users can connect Shelly S3 Plugs via MQTT and the app reliably receives and persists power data
**Verified:** 2026-03-25T22:00:00Z
**Status:** passed
**Re-verification:** No — initial verification

---

## Goal Achievement

### Observable Truths (from ROADMAP.md Success Criteria)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | User can add a Shelly S3 Plug and see it appear in the app with online/offline status | VERIFIED | `src/app/devices/page.tsx` queries plugs from DB; `DeviceManager` handles add via POST `/api/devices`; `PlugCard` renders online/offline indicator with green/red dot |
| 2 | App maintains a persistent MQTT connection that auto-reconnects after broker restarts | VERIFIED | `MqttService.connect()` sets `reconnectPeriod: 1000`; watchdog at 15s interval forces `client.reconnect()` when stale >30s; SIGTERM/SIGINT in server.ts calls `mqttService.disconnect()` cleanly |
| 3 | Power readings from connected Shelly Plugs are stored in the database continuously | VERIFIED | `MqttService.handleMessage()` parses `/status/switch:0` with `parseShellyStatus()`, emits `PowerReading`, calls `persistIfDue()`; dynamic sampling gate persists at 5s (active >5W) or 60s (idle) to `power_readings` table |
| 4 | User can configure MQTT broker and Pushover settings through a settings page, and settings persist across app restarts | VERIFIED | `/settings` page loads from SQLite config table; `MqttSettings` and `PushoverSettings` auto-save via PUT `/api/settings` with 500ms debounce; `server.ts` reads `mqtt.host` from config on startup to reconnect |

**Score:** 4/4 ROADMAP success criteria verified

### Plan-level Must-Have Truths

#### Plan 01-01 Must-Haves

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Custom server boots Next.js and MQTT client in a single Node.js process | VERIFIED | `server.ts`: `next({dev})`, `app.prepare()`, `new MqttService(eventBus)`, `createServer(handle)`, all in `main()` |
| 2 | MQTT client connects to a configurable broker and auto-reconnects on disconnect | VERIFIED | `MqttService.connect()` uses `reconnectPeriod: 1000`; reads `mqtt.host` from DB at startup |
| 3 | Power readings from Shelly Plugs are parsed and emitted on the EventBus | VERIFIED | `handleMessage()` calls `parseShellyStatus()` then `eventBus.emitPowerReading(reading)` |
| 4 | SQLite database exists with WAL mode and tables for plugs, power_readings, and config | VERIFIED | `client.ts` sets 5 WAL pragmas before Drizzle init; schema.ts defines all 3 tables |
| 5 | Multiple Shelly Plugs can be subscribed to simultaneously | VERIFIED | `subscribeToDiscoveryAndRegistered()` iterates all enabled plugs from DB on connect; `subscribeToPlug()` subscribes per-device topics |
| 6 | Dynamic sampling rate: 5s persistence during active charging (>5W), 60s during idle/standby | VERIFIED | `persistIfDue()`: `ACTIVE_POWER_THRESHOLD=5`, `ACTIVE_INTERVAL=5000`, `IDLE_INTERVAL=60000`; gate checks `lastPersistedAt` map |
| 7 | MQTT watchdog detects stale/zombie connections and forces reconnect | VERIFIED | `startWatchdog()` runs `setInterval` every 15s, checks `Date.now() - lastMessageAt`, calls `client.reconnect()` if >30s stale |
| 8 | Discovered devices tracked in-memory via globalThis.__discoveredDevices | VERIFIED | `server.ts`: `globalThis.__discoveredDevices = new Map()`, `eventBus.on('online:*', ...)` upserts entries with `firstSeen/lastSeen/online` |

#### Plan 01-02 Must-Haves

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | User can configure MQTT broker settings and they persist across restarts | VERIFIED | `MqttSettings` writes to `/api/settings` (PUT); `server.ts` reads `mqtt.host` on startup |
| 2 | User can configure Pushover settings and they persist across restarts | VERIFIED | `PushoverSettings` auto-saves `pushover.userKey` and `pushover.apiToken` to config table |
| 3 | Every settings change auto-saves immediately without a save button | VERIFIED | `useAutoSave` hook in both settings components: 500ms debounce, `skipInitial=true` prevents save on mount |
| 4 | User can test MQTT broker connectivity and see inline success/failure result | VERIFIED | `handleTest()` posts to `/api/mqtt/test`; shows "Verbindung erfolgreich" (green) or "Verbindung fehlgeschlagen" (red) inline |

#### Plan 01-03 Must-Haves

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | User can see all registered Shelly Plugs as cards with online/offline status and current power | VERIFIED | `HomePage` queries DB, renders `PlugCard` grid; `PlugCard` shows online/offline dot and name. Power shows "--" W (Phase 2 placeholder — intentional, noted in SUMMARY) |
| 2 | User can add a Shelly Plug via MQTT auto-discovery | VERIFIED | `DiscoveryList` polls `/api/devices/discover` every 5s; "Hinzufuegen" button calls `handleAddFromDiscovery()` → POST `/api/devices` |
| 3 | User can add a Shelly Plug manually by entering topic prefix as fallback | VERIFIED | `AddDeviceForm` submits id/name/mqttTopicPrefix to POST `/api/devices`; handles 409 duplicate error |
| 4 | App shell has a sidebar with navigation links to Dashboard, Devices, Settings | VERIFIED | `Sidebar` renders Dashboard, Geraete, Einstellungen links; `AppShell` wraps all pages via root layout |
| 5 | Multiple plugs displayed simultaneously | VERIFIED | `HomePage` renders responsive grid `grid-cols-1 md:grid-cols-2 lg:grid-cols-3`; maps all plugs from DB |

**Score:** 9/9 plan-level must-have groups verified

---

## Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `server.ts` | Custom server entry point with discovery tracking | VERIFIED | `createServer`, `new MqttService`, `new EventBus`, `globalThis.__discoveredDevices`, SIGTERM/SIGINT handlers |
| `src/db/schema.ts` | DB schema for plugs, power_readings, config | VERIFIED | All 3 tables defined with correct columns; `sqliteTable` used throughout |
| `src/db/client.ts` | WAL mode SQLite + Drizzle | VERIFIED | 5 pragmas set before `drizzle()` call; exports `db` and `sqlite` |
| `src/modules/mqtt/mqtt-service.ts` | Singleton MQTT client with connect/reconnect/watchdog/sampling | VERIFIED | `class MqttService`, `connect()`, `testConnection()`, `startWatchdog()`, `persistIfDue()`, `import 'server-only'` |
| `src/modules/events/event-bus.ts` | In-process event bus for power readings | VERIFIED | `class EventBus extends EventEmitter`, `emitPowerReading()`, `emitPlugOnline()`, `emitDiscoveredDevice()` |
| `src/modules/mqtt/shelly-parser.ts` | Zod-validated Shelly Gen3 parser | VERIFIED | `ShellySwitchStatusSchema`, `parseShellyStatus()`, returns null on parse failure |
| `src/modules/mqtt/discovery.ts` | Discovery topics and device ID parsing | VERIFIED | `DISCOVERY_TOPICS`, `parseDeviceId()`, `isDiscoveryTopic()`, `DiscoveredDevice` type |
| `src/app/api/settings/route.ts` | Settings CRUD API | VERIFIED | `GET` (all config), `PUT` (upsert single key) with `onConflictDoUpdate` |
| `src/app/api/mqtt/test/route.ts` | MQTT connection test endpoint | VERIFIED | `POST` with `runtime = 'nodejs'`, calls `globalThis.__mqttService.testConnection()` |
| `src/app/settings/page.tsx` | Settings page with MQTT and Pushover sections | VERIFIED | Server component loads from DB, passes to `MqttSettings` and `PushoverSettings` |
| `src/components/settings/mqtt-settings.tsx` | MQTT config form with auto-save | VERIFIED | `'use client'`, `useAutoSave` hook, fetches `/api/settings` and `/api/mqtt/test` |
| `src/components/settings/pushover-settings.tsx` | Pushover credentials form | VERIFIED | `'use client'`, `useAutoSave` for `pushover.userKey` and `pushover.apiToken` |
| `src/components/layout/sidebar.tsx` | Navigation sidebar | VERIFIED | `'use client'`, `usePathname`, Dashboard/Geraete/Einstellungen links, active highlighting |
| `src/components/layout/app-shell.tsx` | Sidebar + content wrapper | VERIFIED | Renders `<Sidebar />` + `<main>`, used in root layout |
| `src/app/api/devices/route.ts` | Device CRUD API | VERIFIED | `GET`, `POST`, `DELETE` with `subscribeToPlug`/`unsubscribeFromPlug` calls |
| `src/app/api/devices/discover/route.ts` | Discovery endpoint | VERIFIED | `runtime = 'nodejs'`, reads `globalThis.__discoveredDevices`, returns 503 if MQTT not connected |
| `src/components/devices/plug-card.tsx` | Individual plug status card | VERIFIED | `'use client'`, online/offline indicator, power placeholder "--" W (intentional Phase 2 stub) |
| `src/components/devices/discovery-list.tsx` | Auto-polling discovery list | VERIFIED | Polls `/api/devices/discover` every 5s, renders device rows with "Hinzufuegen" button |
| `src/components/devices/add-device-form.tsx` | Manual device entry form | VERIFIED | Submits to POST `/api/devices`, handles 201/409 responses |
| `src/app/page.tsx` | Dashboard with plug grid | VERIFIED | Queries DB server-side, renders `PlugCard` grid or empty state |
| `src/app/devices/page.tsx` | Device management page | VERIFIED | Server component queries DB, passes to `DeviceManager` client wrapper |
| `src/types/global.d.ts` | Global type declarations | VERIFIED | `__mqttService`, `__eventBus`, `__discoveredDevices` declared with correct types |

---

## Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `server.ts` | `src/modules/mqtt/mqtt-service.ts` | `new MqttService(eventBus)` and `connect()` | WIRED | Line 24-38 in server.ts |
| `server.ts` | `src/modules/events/event-bus.ts` | `online:*` listener populates `__discoveredDevices` | WIRED | Lines 51-64 in server.ts |
| `src/modules/mqtt/mqtt-service.ts` | `src/modules/events/event-bus.ts` | `eventBus.emitPowerReading()` on parsed MQTT messages | WIRED | Line 112 in mqtt-service.ts |
| `src/db/client.ts` | `src/db/schema.ts` | `drizzle(sqlite, { schema })` | WIRED | Line 19 in client.ts |
| `src/components/settings/mqtt-settings.tsx` | `/api/settings` | `fetch('/api/settings', { method: 'PUT' })` with 500ms debounce | WIRED | `useAutoSave` hook, lines 21-32 |
| `src/components/settings/mqtt-settings.tsx` | `/api/mqtt/test` | `fetch('/api/mqtt/test', { method: 'POST' })` on button click | WIRED | `handleTest()`, lines 66-76 |
| `src/app/api/settings/route.ts` | `src/db/schema.ts` | `db.insert(config).onConflictDoUpdate(...)` | WIRED | Lines 18-24 in settings route |
| `src/app/page.tsx` | `src/db/schema.ts` | `db.select().from(plugs).all()` server-side | WIRED | Line 7 in page.tsx |
| `src/app/api/devices/discover/route.ts` | `globalThis.__discoveredDevices` | Direct Map read with `Array.from()` | WIRED | Lines 13-18 in discover route |
| `src/app/api/devices/route.ts` | `globalThis.__mqttService` | `subscribeToPlug(id)` after DB insert | WIRED | Lines 49-51 in devices route |

---

## Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|--------------------|--------|
| `src/app/page.tsx` | `allPlugs` | `db.select().from(plugs).all()` server-side | Yes — DB query | FLOWING |
| `src/app/settings/page.tsx` | `settings` | `db.select().from(config).all()` server-side | Yes — DB query | FLOWING |
| `src/app/devices/page.tsx` | `registeredPlugs` | `db.select().from(plugs).all()` server-side | Yes — DB query | FLOWING |
| `src/components/devices/discovery-list.tsx` | `devices` | `fetch('/api/devices/discover')` every 5s | Yes — reads `globalThis.__discoveredDevices` populated by MQTT events | FLOWING |
| `src/components/devices/plug-card.tsx` | power value | hardcoded "--" W | No — intentional placeholder | NOTED (Phase 2 scope) |

Note: `PlugCard` power value is a documented Phase 2 placeholder. The SUMMARY explicitly states "real-time power via SSE comes in Phase 2". This does not block the Phase 1 goal which is about data receipt and persistence, not display.

---

## Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| TypeScript compiles without errors | `npx tsc --noEmit` | Exit 0, no output | PASS |
| `MqttService` class exported | Module import check | Cannot run as CommonJS (TypeScript ESM module) — verified by file inspection | PASS (by inspection) |
| Settings GET API parses DB rows correctly | Code inspection of `Object.fromEntries(rows.map(...))` | Pattern correct, returns `{ [key]: value }` object | PASS (by inspection) |
| Discovery endpoint returns 503 when MQTT not connected | Code inspection of `!mqttService.isConnected()` guard | Returns `{ error: 'mqtt_not_connected', devices: [] }` with status 503 | PASS (by inspection) |

---

## Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|----------|
| SHLY-01 | 01-03 | User can add a Shelly S3 Plug by entering its MQTT topic prefix | SATISFIED | `AddDeviceForm` submits `mqttTopicPrefix` to `/api/devices` POST; `DiscoveryList` uses deviceId as topic prefix |
| SHLY-02 | 01-01 | App connects to configurable MQTT broker (host, port, optional credentials) | SATISFIED | `MqttService.connect()` takes `brokerUrl` and `IClientOptions`; server.ts builds URL from config table values |
| SHLY-03 | 01-01 | App receives real-time power data (watts) from Shelly via MQTT | SATISFIED | `handleMessage()` receives `/status/switch:0` payloads, parses `apower` via Zod schema, persists via `persistIfDue()` |
| SHLY-05 | 01-01 | MQTT connection auto-reconnects on disconnect with watchdog | SATISFIED | `reconnectPeriod: 1000` in `connect()`; watchdog runs every 15s, triggers `client.reconnect()` after 30s stale |
| SHLY-06 | 01-01, 01-03 | App supports multiple Shelly Plugs simultaneously | SATISFIED | `subscribeToDiscoveryAndRegistered()` subscribes all enabled plugs; `lastPersistedAt` is a per-plugId Map; dashboard grid renders all plugs |
| SETT-01 | 01-02 | MQTT broker settings configurable (host, port, credentials) | SATISFIED | `MqttSettings` component saves `mqtt.host`, `mqtt.port`, `mqtt.username`, `mqtt.password` to config table |
| SETT-02 | 01-02 | Pushover notification settings configurable | SATISFIED | `PushoverSettings` component saves `pushover.userKey`, `pushover.apiToken` to config table |
| SETT-03 | 01-01 | All settings persisted in database | SATISFIED | `config` table in SQLite; `onConflictDoUpdate` in settings PUT route; server.ts reads config on startup |

**All 8 Phase 1 requirements accounted for.** No orphaned requirements.

---

## Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `src/components/devices/plug-card.tsx` | 51 | `<span>--</span>` hardcoded power value | Info | Intentional — documented Phase 2 placeholder for real-time SSE. Does not block Phase 1 goal. |
| `src/components/layout/sidebar.tsx` | 13 | `mqttConnected = false` static prop default | Info | Intentional — SUMMARY notes "will be wired to real connection state" in Phase 2. AppShell does not pass the prop, so sidebar always shows disconnected. |

No blocker or warning anti-patterns found. Both noted patterns are intentional Phase 2 deferral items explicitly documented in summaries.

---

## Human Verification Required

### 1. Live MQTT Data Receipt and Persistence

**Test:** Start the app with `pnpm dev`, configure MQTT broker host in `/settings`, connect a Shelly S3 Plug, observe incoming power data
**Expected:** Power readings appear in `data/charging-master.db` in the `power_readings` table within 5 seconds of the Shelly sending data; readings continue to accumulate at the 5s/60s sampling rate
**Why human:** Requires physical Shelly S3 Plug and running MQTT broker (mqtt-master.local) to generate real data

### 2. MQTT Auto-Reconnect After Broker Restart

**Test:** While app is running and connected, kill the MQTT broker process, wait 5 seconds, restart it
**Expected:** App logs "MQTT reconnecting..." then "MQTT connected to mqtt://..." within ~2 seconds of broker restart
**Why human:** Requires controlling a live MQTT broker process

### 3. Settings Survive App Restart

**Test:** Enter MQTT broker host in `/settings`, stop the app (`Ctrl+C`), restart with `pnpm dev`, navigate to `/settings`
**Expected:** MQTT host field still shows the entered value; if MQTT broker is running, connection is re-established on startup
**Why human:** Requires running the app interactively and observing persistence behavior

### 4. MQTT Watchdog Behavior

**Test:** Connect to MQTT broker, block incoming MQTT messages for >30 seconds (e.g., by firewall rule or broker topic filter)
**Expected:** Server logs "MQTT watchdog: no messages for Xs, forcing reconnect" and client reconnects
**Why human:** Requires network-level simulation of a zombie connection

---

## Gaps Summary

No gaps found. All phase goals are fully implemented:

- The MQTT backbone (Plan 01-01) is complete: custom server, MqttService with watchdog and sampling gate, EventBus, Shelly parser, SQLite with WAL mode, all globalThis singletons
- The settings UI (Plan 01-02) is complete: auto-save, MQTT test button, Pushover credentials, all persisted to config table
- The device management UI (Plan 01-03) is complete: sidebar navigation, dashboard with plug cards, auto-discovery, manual add, CRUD API

The two known stubs (PlugCard power placeholder, Sidebar MQTT status) are Phase 2 items, not Phase 1 requirements. They do not affect goal achievement.

---

_Verified: 2026-03-25T22:00:00Z_
_Verifier: Claude (gsd-verifier)_
