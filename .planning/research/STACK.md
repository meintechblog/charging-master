# Technology Stack

**Project:** Charging-Master (Smart Charging Management)
**Researched:** 2026-03-25

## Recommended Stack

### Core Framework

| Technology | Version | Purpose | Why | Confidence |
|------------|---------|---------|-----|------------|
| Next.js | 15.2+ | Full-stack framework | Already decided. Server Components for dashboard, API Routes for SSE endpoints, App Router | HIGH |
| React | 19.x | UI library | Peer dependency of Next.js 15 | HIGH |
| TypeScript | 5.9+ | Type safety | Already in use in sibling project, strict mode essential for IoT data types | HIGH |

### Database

| Technology | Version | Purpose | Why | Confidence |
|------------|---------|---------|-----|------------|
| better-sqlite3 | 12.8.0 | SQLite driver | Synchronous, fastest SQLite driver for Node.js. Single-user app, no DB server needed on LXC. Native bindings = best performance for time-series data | HIGH |
| drizzle-orm | 0.45.1 | Type-safe ORM | Already known from netzbetreiber-master. SQLite support via `drizzle-orm/better-sqlite3`. Type-safe queries, zero runtime overhead | HIGH |
| drizzle-kit | 0.31.10 | Migrations | Schema push and migration generation. `drizzle-kit push:sqlite` for dev, `drizzle-kit generate` for production migrations | HIGH |

**Why NOT libsql/Turso:** Overkill for single-user local app. better-sqlite3 is simpler, faster, and has zero network overhead.

**Why NOT PostgreSQL:** Requires running a DB server. SQLite is perfect for single-user, embedded, local-network apps. Zero setup on fresh LXC.

### MQTT Communication

| Technology | Version | Purpose | Why | Confidence |
|------------|---------|---------|-----|------------|
| mqtt | 5.15.1 | MQTT client | The standard Node.js MQTT client. TypeScript rewrite (v5), supports MQTT 3.1.1 and 5.0, works in Node.js and browser. 3300+ dependents on npm | HIGH |

**Why NOT aedes/mosca:** We connect to an existing broker (mqtt-master.local), not running our own. Client library only.

**Why NOT native WebSocket MQTT:** mqtt.js handles TCP connections natively in Node.js, which is more reliable than WebSocket for server-side MQTT.

### Real-Time Data Streaming (Server to Browser)

| Technology | Version | Purpose | Why | Confidence |
|------------|---------|---------|-----|------------|
| Server-Sent Events (SSE) | Native | Server-to-browser push | Unidirectional (server pushes MQTT data to browser). Built into browsers via EventSource API. Works with Next.js Route Handlers via ReadableStream. No extra library needed | HIGH |

**Decision: SSE over WebSocket because:**

1. **Unidirectional fits perfectly** -- MQTT data flows server-to-browser only. Browser sends commands via regular POST/fetch to API routes, not through the stream
2. **Native Next.js support** -- Route Handlers + ReadableStream = SSE endpoint with zero dependencies. WebSocket requires a custom server or socket.io, breaking Next.js conventions
3. **Auto-reconnect** -- EventSource reconnects automatically on connection drop. WebSocket needs manual reconnect logic
4. **Simpler architecture** -- No WebSocket server, no socket.io, no protocol upgrade handling. Just HTTP

**Pattern:** Next.js API Route subscribes to MQTT topics via mqtt.js, forwards messages to browser clients via SSE ReadableStream. Multiple browser tabs share the same MQTT subscription on the server.

**Critical implementation detail:** In the Route Handler, set `export const runtime = 'nodejs'` and `export const dynamic = 'force-dynamic'` to prevent Next.js from buffering the stream.

### Charts

| Technology | Version | Purpose | Why | Confidence |
|------------|---------|---------|-----|------------|
| echarts | 6.0.0 | Charting library | Best real-time capability. Streaming data support since v4. Smooth animations, dark theme built-in, overlay support for reference curves. v6 adds intelligent dark mode switching | HIGH |
| echarts-for-react | 3.0.6 | React wrapper | Thin wrapper, provides `<ReactECharts>` component. Handles lifecycle and resize. Peer-depends on echarts | HIGH |

**Why NOT recharts:** No streaming/real-time support. Designed for static data. Re-renders entire chart on update.

**Why NOT Chart.js:** Weaker real-time performance. ECharts streaming pipeline is purpose-built for continuous data feeds.

**Why NOT D3:** Too low-level for this use case. Would require building chart primitives from scratch.

**Real-time update pattern:** Use ECharts `setOption()` with `appendData` or partial option merge. The chart instance can be accessed via ref on the React wrapper. For live charging curves, use `setOption({ series: [{ data: newPoints }] }, { replaceMerge: ['series'] })` for efficient incremental updates.

### Notifications

| Technology | Version | Purpose | Why | Confidence |
|------------|---------|---------|-----|------------|
| Native fetch | Built-in | Pushover API calls | Pushover API is a single POST endpoint. No library needed -- `fetch()` to `https://api.pushover.net/1/messages.json` with form data. Adding a library for one HTTP call is unnecessary | HIGH |

**Pushover API essentials:**
- Endpoint: `POST https://api.pushover.net/1/messages.json`
- Required: `token` (app API token), `user` (user key), `message` (text)
- Optional: `title`, `priority` (-2 to 2), `sound`, `url`, `html` (1 for HTML formatting)
- Response: HTTP 200 with `{"status": 1, "request": "..."}` on success
- Rate limit: 10,000 messages/month per application

**Why NOT pushover-notifications npm package:** Adds dependency for wrapping a single HTTP POST. A 10-line utility function does the same thing with zero dependencies.

### Infrastructure

| Technology | Version | Purpose | Why | Confidence |
|------------|---------|---------|-----|------------|
| Node.js | 22 LTS | Runtime | LTS version, compatible with Next.js 15, better-sqlite3, mqtt.js | HIGH |
| pnpm | 10.x | Package manager | Already used in sibling project. Fast, disk-efficient | HIGH |
| systemd | System | Process management | Already on Debian LXC. `systemctl` for auto-start on boot. No need for PM2 | MEDIUM |

### Supporting Libraries

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| zod | 3.x | Schema validation | Validate MQTT payloads, API inputs, config. Already known from sibling project |
| server-only | 0.0.1 | Import guard | Prevent MQTT client code from leaking to browser bundle |
| @types/better-sqlite3 | latest | Type definitions | Dev dependency for better-sqlite3 types |

## Alternatives Considered

| Category | Recommended | Alternative | Why Not |
|----------|-------------|-------------|---------|
| Database | SQLite (better-sqlite3) | PostgreSQL | Overkill -- requires running a DB server for single-user app |
| Database | SQLite (better-sqlite3) | libsql (Turso) | Network-oriented SQLite fork. Unnecessary for local-only app |
| ORM | Drizzle ORM | Prisma | Heavier runtime, slower cold starts, less control over queries |
| ORM | Drizzle ORM | Knex | No type-safe schema, manual type mapping |
| MQTT | mqtt.js | MQTT over WebSocket | TCP is more reliable for server-side persistent connections |
| Real-time | SSE | WebSocket (socket.io) | Requires custom server, bidirectional not needed, breaks Next.js conventions |
| Real-time | SSE | Polling | Wasteful, high latency. MQTT data arrives every 1-2 seconds |
| Charts | ECharts 6 | Recharts | No streaming support, re-renders entire chart |
| Charts | ECharts 6 | Chart.js | Weaker real-time, less sophisticated animations |
| Notifications | Native fetch | pushover-notifications npm | One HTTP POST doesn't justify a dependency |
| Process mgmt | systemd | PM2 | Already have systemd on Debian, PM2 adds unnecessary layer |

## Shelly S3 Plug Gen3 -- API Reference

This section documents the Shelly Gen3 MQTT and HTTP API specifics needed for implementation.

### MQTT Topic Structure

The Shelly Plug S Gen3 uses Gen2+ API with these MQTT topics:

| Topic Pattern | Direction | Purpose |
|---------------|-----------|---------|
| `<device_id>/status/switch:0` | Subscribe | Power measurement + switch state |
| `<device_id>/events/rpc` | Subscribe | RPC notifications and events |
| `<device_id>/online` | Subscribe | Connection status (`true`/`false` via LWT) |
| `<device_id>/command/switch:0` | Publish | Control switch (`on`, `off`, `toggle`) |

**Device ID format:** `shellyplugsg3-<MAC>` (e.g., `shellyplugsg3-AABBCCDDEEFF`)

### Switch Status Payload (from `status/switch:0`)

```json
{
  "id": 0,
  "source": "switch",
  "output": true,
  "apower": 45.2,
  "voltage": 230.5,
  "current": 0.196,
  "freq": 50.0,
  "pf": 0.98,
  "aenergy": {
    "total": 1234.56,
    "by_minute": [12.34, 11.98, 12.01],
    "minute_ts": 1711324800
  }
}
```

Key fields for charging management:
- `apower` -- Active power in Watts (the primary measurement for charge curve tracking)
- `output` -- Relay state (true = charging, false = stopped)
- `aenergy.total` -- Total energy in Wh (for session tracking)

### Switch Control via MQTT

Publish to `<device_id>/command/switch:0`:
- `on` -- Turn relay on (start charging)
- `off` -- Turn relay off (stop charging)
- `on,3600` -- Turn on with auto-off after 3600 seconds
- `toggle` -- Toggle current state
- `status_update` -- Request current status

### HTTP API Fallback

For reliable switch control (MQTT QoS 0 = fire-and-forget):
- `http://<device_ip>/rpc/Switch.Set?id=0&on=true`
- `http://<device_ip>/rpc/Switch.Set?id=0&on=false`
- `http://<device_ip>/rpc/Switch.GetStatus?id=0`

### MQTT Configuration on Device

Enable via Shelly web UI or API:
- MQTT must be explicitly enabled (disabled by default)
- Set broker: `mqtt-master.local:1883`
- Enable "Generic status update over MQTT" for periodic status pushes
- Enable "RPC status notifications over MQTT" for event-driven updates

### Data Sampling Rate

Shelly publishes status updates when values change significantly (not at fixed intervals). For consistent sampling during charge curve recording, combine MQTT notifications with periodic HTTP polling (`Switch.GetStatus`) every 5-10 seconds as backup.

## Installation

```bash
# Core dependencies
pnpm add next@15 react@19 react-dom@19 mqtt@5 echarts@6 echarts-for-react@3 drizzle-orm better-sqlite3 zod server-only

# Dev dependencies
pnpm add -D typescript@5.9 @types/node @types/react @types/react-dom @types/better-sqlite3 drizzle-kit eslint eslint-config-next tsx
```

## Project Structure

```
src/
  app/
    page.tsx                          # Dashboard
    api/
      stream/route.ts                 # SSE endpoint (MQTT -> browser)
      devices/route.ts                # Device CRUD
      profiles/route.ts               # Charge profiles CRUD
      sessions/route.ts               # Charging sessions
  components/
    charge-chart.tsx                   # ECharts real-time chart
    device-card.tsx                    # Active device card
    dashboard.tsx                      # Main dashboard layout
  lib/
    mqtt/
      client.ts                       # Singleton MQTT client (server-only)
      shelly.ts                       # Shelly-specific topic parsing
    db/
      client.ts                       # Drizzle + better-sqlite3
      schema.ts                       # Drizzle schema
    notifications/
      pushover.ts                     # Pushover utility (native fetch)
    charging/
      curve-matching.ts               # Charge curve comparison
      soc-estimator.ts                # SOC estimation from power data
  db/
    migrations/                       # Drizzle migrations
```

## Sources

- [mqtt.js npm package](https://www.npmjs.com/package/mqtt) -- v5.15.1, verified March 2026
- [mqtt.js GitHub](https://github.com/mqttjs/MQTT.js) -- TypeScript rewrite, MQTT 5.0 support
- [Shelly Plug S Gen3 API docs](https://shelly-api-docs.shelly.cloud/gen2/Devices/Gen3/ShellyPlugSG3/)
- [Shelly MQTT Component docs](https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/Mqtt)
- [Shelly Switch Component docs](https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/Switch/)
- [Drizzle ORM SQLite docs](https://orm.drizzle.team/docs/get-started-sqlite) -- v0.45.1
- [better-sqlite3 npm](https://www.npmjs.com/package/better-sqlite3) -- v12.8.0
- [Apache ECharts 6.0 release](https://echarts.apache.org/handbook/en/basics/release-note/v6-feature/)
- [echarts-for-react npm](https://www.npmjs.com/package/echarts-for-react) -- v3.0.6
- [Pushover API documentation](https://pushover.net/api)
- [Next.js SSE discussion](https://github.com/vercel/next.js/discussions/48427)
- [SSE streaming in Next.js 15](https://hackernoon.com/streaming-in-nextjs-15-websockets-vs-server-sent-events)
