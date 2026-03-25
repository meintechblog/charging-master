# Domain Pitfalls

**Domain:** Smart Charging Management / IoT Monitoring
**Researched:** 2026-03-25

## Critical Pitfalls

Mistakes that cause rewrites or major issues.

### Pitfall 1: MQTT Client Per Request

**What goes wrong:** Creating a new MQTT connection inside each Next.js API route handler. Each request opens a new TCP connection, subscribes to topics, and misses messages that arrived before subscription.
**Why it happens:** Treating MQTT like HTTP -- stateless per request.
**Consequences:** Lost messages, connection storms on broker, massive latency, broken real-time experience.
**Prevention:** Singleton MQTT client at module level with `server-only` guard. Initialize once, share across all handlers via import.
**Detection:** Multiple connections visible in MQTT broker logs. Missing data points in charts.

### Pitfall 2: SSE Buffering in Next.js

**What goes wrong:** SSE stream appears to buffer all data and deliver it as one blob when the connection closes, instead of streaming incrementally.
**Why it happens:** Next.js may statically optimize or cache Route Handler responses. Missing runtime/dynamic configuration.
**Consequences:** Real-time charts don't update. Appears broken. User sees nothing until stream ends.
**Prevention:** Set `export const runtime = 'nodejs'` and `export const dynamic = 'force-dynamic'` on the SSE route. Also set response header `X-Accel-Buffering: no` for nginx reverse proxies.
**Detection:** Open SSE endpoint in browser DevTools Network tab -- if data arrives in bursts instead of incrementally, buffering is active.

### Pitfall 3: SQLite WAL Mode Not Enabled

**What goes wrong:** Concurrent reads and writes to SQLite block each other. MQTT data writes block dashboard reads.
**Why it happens:** SQLite defaults to journal mode (exclusive locking), not WAL mode.
**Consequences:** Dashboard freezes during write bursts. "database is locked" errors.
**Prevention:** Enable WAL mode on database initialization: `db.pragma('journal_mode = WAL')`. Also set `busy_timeout` to prevent immediate failures: `db.pragma('busy_timeout = 5000')`.
**Detection:** SQLITE_BUSY errors in logs.

### Pitfall 4: Shelly MQTT Not Enabled by Default

**What goes wrong:** Fresh Shelly device doesn't publish MQTT messages. App shows no data. Developer thinks MQTT code is broken and wastes hours debugging.
**Why it happens:** MQTT is disabled by default on Shelly devices. Must be explicitly enabled via web UI or API.
**Consequences:** Wasted debugging time. Frustrating first-run experience.
**Prevention:** Document setup clearly. Add connection health check that detects "device online but no MQTT data" state. Show setup instructions in UI when no devices are publishing.
**Detection:** `shellyplugsg3-<MAC>/online` topic shows `true` but no status updates arrive.

### Pitfall 5: Relying on MQTT QoS 0 for Switch Control

**What goes wrong:** Switch command sent via MQTT is lost (no delivery guarantee at QoS 0). Charging continues past target SOC.
**Why it happens:** MQTT QoS 0 is fire-and-forget. Network hiccup = lost command.
**Consequences:** Overcharged battery -- defeats the entire purpose of the app.
**Prevention:** Use HTTP API as fallback for switch control. After sending MQTT `off`, verify via HTTP `Switch.GetStatus`. Retry with HTTP if MQTT doesn't confirm within 2-3 seconds.
**Detection:** Monitor `output` field in status updates. If still `true` after sending `off`, trigger HTTP fallback.

## Moderate Pitfalls

### Pitfall 6: ECharts Memory Leak with Continuous Data

**What goes wrong:** Chart accumulates data points forever. Browser memory grows until tab crashes.
**Prevention:** Implement sliding window. Keep only last N minutes of data in the chart (e.g., 30 min = ~1800 points). Use `shift()` on data array when adding new points beyond window size.

### Pitfall 7: SSE Connection Limit

**What goes wrong:** Browser limits concurrent EventSource connections (6 per domain in HTTP/1.1). Multiple tabs or components each opening their own SSE connection exhaust the limit.
**Prevention:** Single SSE connection per browser tab. Multiplex all device data through one `/api/stream` endpoint. Client-side routing of messages by device ID.

### Pitfall 8: better-sqlite3 Native Binding Build Failures

**What goes wrong:** `pnpm install` fails on Debian LXC because better-sqlite3 needs compilation (node-gyp, python3, make, gcc).
**Prevention:** Install build tools before `pnpm install`: `apt install build-essential python3`. Alternatively, use prebuilt binaries if available for the platform.

### Pitfall 9: Shelly Status Updates Are Event-Driven, Not Periodic

**What goes wrong:** Expecting power readings at fixed intervals (e.g., every second). Shelly only publishes when values change significantly. During constant-power phases, updates may be sparse.
**Prevention:** Supplement MQTT with periodic HTTP polling (`Switch.GetStatus`) every 5-10 seconds during active sessions to ensure continuous data for curve recording.

### Pitfall 10: Timezone Handling for Timestamps

**What goes wrong:** Mixing JavaScript Date objects, Unix timestamps, and SQLite integer timestamps leads to incorrect session durations and chart axes.
**Prevention:** Use Unix timestamps (seconds) everywhere. Store as `integer` in SQLite. Convert to display format only in the UI layer. Use `Date.now() / 1000 | 0` for current timestamp.

## Minor Pitfalls

### Pitfall 11: ECharts Dark Theme Configuration

**What goes wrong:** Default ECharts theme is light. Charts look jarring against dark app background.
**Prevention:** ECharts 6 has built-in intelligent dark mode. Use `theme: 'dark'` when initializing or use the new auto-detection. Customize colors to match app palette.

### Pitfall 12: MQTT Topic Wildcard Performance

**What goes wrong:** Subscribing to `#` (all topics) floods the client with irrelevant messages from other devices on the broker.
**Prevention:** Subscribe only to `shellyplugsg3-+/status/switch:0` and `shellyplugsg3-+/online`. The `+` wildcard matches exactly one level (device ID).

### Pitfall 13: Pushover Rate Limits

**What goes wrong:** Sending too many notifications during rapid charge start/stop cycles. Pushover rate-limits and user gets annoyed.
**Prevention:** Debounce notifications. Don't send "charge started" if power fluctuates briefly. Wait 30 seconds of sustained power before confirming charge start. Batch rapid events.

## Phase-Specific Warnings

| Phase Topic | Likely Pitfall | Mitigation |
|-------------|---------------|------------|
| MQTT Integration | MQTT not enabled on Shelly (Pitfall 4) | Setup checklist in docs and UI |
| Real-time Display | SSE buffering (Pitfall 2) | Test with `curl` before building UI |
| Charge Session Recording | SQLite WAL mode (Pitfall 3) | Enable in DB init, test concurrent access |
| Auto-Stop | QoS 0 unreliable (Pitfall 5) | HTTP fallback with verification loop |
| Curve Matching | Sparse data during constant phases (Pitfall 9) | HTTP polling supplement |
| Dashboard Polish | ECharts memory leak (Pitfall 6) | Sliding window from day one |
| Production Deployment | better-sqlite3 build (Pitfall 8) | Install build-essential first |

## Sources

- [Next.js SSE buffering issues](https://github.com/vercel/next.js/discussions/48427) -- community reports
- [Shelly MQTT docs](https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/Mqtt) -- default disabled, QoS behavior
- [better-sqlite3 installation](https://github.com/WiseLibs/better-sqlite3) -- native build requirements
- [ECharts streaming docs](https://deepwiki.com/apache/echarts/2.4-streaming-and-scheduling) -- memory management
- [Pushover API](https://pushover.net/api) -- rate limits
