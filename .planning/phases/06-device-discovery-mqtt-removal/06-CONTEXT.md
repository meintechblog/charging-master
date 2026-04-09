# Phase 6: Device Discovery & MQTT Removal - Context

**Gathered:** 2026-04-10
**Status:** Ready for planning

<domain>
## Phase Boundary

Replace MQTT-based device discovery with HTTP subnet scanning, enable one-click device registration from scan results, and completely remove all MQTT code/dependencies/UI from the codebase. After this phase, the app has zero MQTT dependency and communicates with Shelly devices exclusively via HTTP.

</domain>

<decisions>
## Implementation Decisions

### Discovery Mechanism
- **D-01:** HTTP subnet scan — scan the local /24 subnet by calling `/rpc/Shelly.GetDeviceInfo` on each IP (1-254). No mDNS, no extra dependencies.
- **D-02:** Auto-detect subnet from server IP using `os.networkInterfaces()`. Zero configuration required from user.
- **D-03:** Parallel HTTP requests with short timeout (1-2s) per IP for fast scanning (~5-15 seconds total).

### Discovery UX Flow
- **D-04:** Manual scan trigger — "Geraete suchen" button on the device manager page. No auto-scan on page load.
- **D-05:** Scan results show: device ID, IP address, model name, and current power reading (matches DISC-02).
- **D-06:** One-click "Hinzufuegen" button per discovered device to register it. IP address is auto-filled from scan result.
- **D-07:** Show scan progress indicator while scanning (progress bar or spinner with count of IPs scanned).

### MQTT Removal Scope
- **D-08:** Delete MQTT config rows (mqtt.host, mqtt.port, mqtt.username, mqtt.password) from config table.
- **D-09:** Remove MQTT section from settings page (delete mqtt-settings.tsx component). Keep settings page for other settings (Pushover etc.).
- **D-10:** Delete entire `src/modules/mqtt/` directory (mqtt-service.ts, discovery.ts, shelly-parser.ts).
- **D-11:** Remove `mqtt` package from package.json dependencies.
- **D-12:** Remove MQTT API routes (`/api/mqtt/test`, `/api/mqtt/status`).
- **D-13:** Clean server.ts: remove MqttService import/instantiation, `__mqttService` global, MQTT broker connection logic.
- **D-14:** Clean global.d.ts: remove `__mqttService` and `__discoveredDevices` (Map<string, DiscoveredDevice>) type declarations.

### IP Address Handling
- **D-15:** Existing devices without IP address get a warning banner — polling disabled until user adds IP manually.
- **D-16:** ipAddress becomes required field in device registration form (add-device-form.tsx). Discovery auto-fills it.
- **D-17:** API validation: POST /api/devices rejects registration without ipAddress.

### Claude's Discretion
- Scan concurrency level (how many parallel HTTP requests)
- Error handling UX during scan (individual IP timeouts are silent, only show found devices)
- Whether to add a "Alle hinzufuegen" bulk-register button for multiple discovered devices
- Database migration approach for making ipAddress NOT NULL (if needed vs application-level enforcement)

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Shelly Gen3 HTTP API
- `CLAUDE.md` §Shelly S3 Plug Gen3 -- API Reference — HTTP endpoints for Switch.GetStatus and Switch.Set
- Shelly.GetDeviceInfo endpoint: `http://{ip}/rpc/Shelly.GetDeviceInfo` — returns device ID, model, firmware version

### Existing Code (to modify/delete)
- `src/modules/mqtt/discovery.ts` — current MQTT discovery logic (to be replaced)
- `src/modules/mqtt/mqtt-service.ts` — MqttService class (to be deleted)
- `src/modules/mqtt/shelly-parser.ts` — MQTT payload parser (to be deleted)
- `src/app/api/devices/discover/route.ts` — current discovery API (to be rewritten for HTTP scan)
- `src/components/devices/discovery-list.tsx` — existing discovery UI component (to be updated)
- `src/components/devices/add-device-form.tsx` — device registration form (ipAddress to become required)
- `src/components/settings/mqtt-settings.tsx` — MQTT settings UI (to be deleted)
- `server.ts` — MQTT initialization code (lines 3, 9, 28-46, 61, 107 to be removed)
- `src/types/global.d.ts` — `__mqttService` and `__discoveredDevices` globals (to be removed)

### Phase 5 Foundation
- `src/modules/shelly/http-polling-service.ts` — HttpPollingService (already handles all polling)
- `src/modules/shelly/relay-http.ts` — HTTP relay control (already handles all relay switching)

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/components/devices/discovery-list.tsx` — existing discovery list UI, needs update from MQTT to HTTP scan results
- `src/components/devices/add-device-form.tsx` — device registration form, needs ipAddress required
- `src/app/devices/device-manager.tsx` — device management page, scan button goes here
- HttpPollingService — auto-start polling after device registration (already wired in Phase 5)

### Established Patterns
- API routes return `Response.json()` with error objects and HTTP status codes
- Device CRUD in `/api/devices/route.ts` already manages HTTP polling lifecycle via `__httpPollingService`
- Dark theme UI with neutral-800/700 color scheme (consistent across settings and device pages)

### Integration Points
- `POST /api/devices` — needs ipAddress validation (required field)
- `GET /api/devices/discover` — complete rewrite from MQTT map lookup to HTTP subnet scan
- `server.ts` — remove MQTT init, keep HttpPollingService init (already done in Phase 5)
- `src/app/settings/page.tsx` — remove MQTT settings section

</code_context>

<specifics>
## Specific Ideas

No specific requirements — standard approaches for subnet scanning and MQTT cleanup.

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>

---

*Phase: 06-device-discovery-mqtt-removal*
*Context gathered: 2026-04-10*
