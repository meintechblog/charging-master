# Architecture Patterns

**Domain:** IoT Smart Charging Management (Shelly S3 Plug + Next.js)
**Researched:** 2026-03-25

## Recommended Architecture

### High-Level Overview

```
+---------------------+       +---------------------+       +-----------------+
|   MQTT Broker       |       |  Unified Node.js    |       |    Browser      |
|  (mqtt-master.local)|<----->|  Process             |<----->|   (Next.js UI)  |
|                     |       |                     |       |                 |
|  Shelly S3 Plugs    |       |  +---------------+  |       |  ECharts        |
|  publish status     |       |  | MQTT Service  |  |  SSE  |  Real-time      |
|  receive commands   |       |  | (persistent)  |-------->|  Dashboard      |
|                     |       |  +-------+-------+  |       |                 |
|                     |       |          |          |       |  Device Mgmt    |
|                     |       |          v          |       |  Charge History |
|                     |       |  +---------------+  |       +-----------------+
|                     |       |  | SQLite (WAL)  |  |
|                     |       |  | via Drizzle   |  |
|                     |       |  +---------------+  |
|                     |       |                     |
|                     |       |  +---------------+  |
|                     |       |  | Next.js App   |  |
|                     |       |  | Router (UI)   |  |
|                     |       |  +---------------+  |
|                     |       +---------------------+
```

### Why a Single Process, Not Microservices

For a single-user local-network app on a Debian LXC, splitting into separate services adds operational complexity with zero benefit. The recommended approach: **one Node.js process** that boots both the MQTT service and the Next.js server. This is achievable via a custom server entry point (`server.ts`) that:

1. Initializes the MQTT client (persistent connection)
2. Starts the Next.js request handler
3. Exposes an in-process event bus connecting MQTT data to SSE endpoints

This avoids IPC overhead, shared-nothing complexity, and the need for process managers. The MQTT client reconnects automatically (mqtt.js built-in), and the entire app restarts as one unit via systemd.

**Confidence: HIGH** -- This pattern is well-documented in Next.js community discussions and confirmed by real-world MQTT+Next.js projects.

## Component Boundaries

| Component | Responsibility | Communicates With | Build Phase |
|-----------|---------------|-------------------|-------------|
| **Custom Server** (`server.ts`) | Process entry point, boots MQTT + Next.js | All components | Phase 1 |
| **MQTT Service** | Subscribe to Shelly topics, publish relay commands, maintain connection state | Event Bus, SQLite | Phase 1 |
| **Event Bus** (in-process) | Decouple MQTT ingestion from consumers (SSE, charge logic) | MQTT Service, SSE Handler, Charge Monitor | Phase 1 |
| **SQLite Database** | Persist devices, profiles, sessions, readings, config | All server-side components | Phase 1 |
| **Next.js App Router** | UI pages, API routes, SSE endpoints | SQLite, Event Bus | Phase 2 |
| **SSE Handler** | Stream real-time power data to browser | Event Bus, Browser | Phase 2 |
| **Charge Monitor** | Background logic: detect charging, match device, auto-stop | Event Bus, MQTT Service, SQLite | Phase 3 |
| **Curve Matcher** | Compare incoming power curve against reference profiles | Charge Monitor, SQLite | Phase 3 |
| **Notification Service** | Send Pushover alerts on charge events | Charge Monitor | Phase 4 |

## Data Flow

### 1. MQTT Ingestion (Continuous)

```
Shelly S3 Plug
  |
  | publishes to: <device_id>/status/switch:0
  | payload: { id, output, apower, voltage, current, aenergy, temperature }
  |
  v
MQTT Service (mqtt.js client)
  |
  | 1. Parse status payload
  | 2. Store reading in SQLite (session_readings table)
  | 3. Emit to Event Bus: { plugId, apower, voltage, current, timestamp }
  |
  v
Event Bus (EventEmitter)
  |
  +---> SSE Handler ---> Browser (real-time chart update)
  |
  +---> Charge Monitor ---> evaluates charging state
```

### 2. Relay Control (On-Demand)

```
Charge Monitor (auto-stop) OR User (manual toggle)
  |
  | MQTT publish to: <device_id>/command/switch:0
  | payload: "off" (or "on")
  |
  v
Shelly S3 Plug toggles relay
  |
  | Fallback: HTTP GET to http://<device_ip>/rpc/Switch.Set?id=0&on=false
```

### 3. Real-Time to Browser (SSE)

```
Browser
  |
  | GET /api/live/[plugId]  (EventSource)
  |
  v
Next.js Route Handler
  |
  | Creates ReadableStream
  | Subscribes to Event Bus for plugId events
  | Writes SSE frames: data: { apower, voltage, current, timestamp }
  |
  v
Browser EventSource
  |
  | Updates ECharts dataset in real-time
```

**Why SSE over WebSocket:** SSE is unidirectional (server-to-client), which is exactly what live power streaming needs. It works over standard HTTP, is natively supported by browsers via `EventSource`, and integrates cleanly with Next.js App Router route handlers using `ReadableStream`. The browser never needs to send real-time data back -- relay commands go through normal API routes. WebSocket would add complexity (upgrade handling, reconnection logic, no automatic reconnect) for zero benefit here.

**Confidence: HIGH** -- SSE with Next.js App Router is well-documented and used widely for streaming scenarios.

### 4. Charge Session Lifecycle

```
State Machine per Plug:

  IDLE ──(apower > threshold)──> DETECTING
    ^                               |
    |                      (match found or timeout)
    |                               |
    |                               v
  COMPLETE <──(apower < idle)── CHARGING
    |                               |
    |                      (SOC target reached)
    |                               |
    |                               v
    +────────────────────── STOPPING (relay off)
```

Each plug runs an independent state machine in the Charge Monitor. State transitions trigger:
- Database writes (session start/end, detection result)
- Pushover notifications
- SSE events to browser

## Shelly S3 MQTT Integration Detail

### Topic Structure (Gen2/Gen3)

The Shelly S3 Plug uses the Gen2+ MQTT API. Key topics:

| Direction | Topic | Purpose |
|-----------|-------|---------|
| Subscribe | `<prefix>/status/switch:0` | Power readings (apower, voltage, current, aenergy) |
| Subscribe | `<device_id>/online` | Connection state (LWT: "true"/"false") |
| Publish | `<prefix>/command/switch:0` | Relay control ("on", "off", "toggle") |
| Publish | `<device_id>/rpc` | RPC calls (Switch.Set, Switch.GetStatus) |

### Status Payload Structure

```typescript
interface ShellySwitchStatus {
  id: number;          // 0 for single-switch devices
  source: string;      // "init", "mqtt", "http"
  output: boolean;     // relay state
  apower: number;      // active power in Watts (key metric)
  voltage: number;     // in Volts
  current: number;     // in Amperes
  pf: number;          // power factor
  freq: number;        // grid frequency Hz
  aenergy: {
    total: number;     // cumulative Wh
    by_minute: number[]; // last 3 minutes of energy
    minute_ts: number; // Unix timestamp
  };
  temperature: {
    tC: number;        // Celsius
    tF: number;        // Fahrenheit
  };
}
```

**Polling interval:** Shelly publishes status on significant changes. For continuous monitoring during charging, the MQTT Service should also periodically request status via the command topic (`status_update`) at a configurable interval (default: every 2 seconds) to ensure consistent data density.

**Confidence: HIGH** -- Verified against official Shelly Gen2 API documentation.

## Data Model

### Core Tables

```sql
-- Shelly plugs known to the system
CREATE TABLE plugs (
  id TEXT PRIMARY KEY,           -- Shelly device ID (MAC-based)
  name TEXT NOT NULL,            -- User-assigned name ("Werkstatt", "Buero")
  mqtt_topic_prefix TEXT NOT NULL, -- e.g. "shellyplugs3-aabbcc"
  ip_address TEXT,               -- For HTTP API fallback
  created_at INTEGER NOT NULL,   -- Unix ms
  updated_at INTEGER NOT NULL
);

-- Device profiles (E-Bike charger, iPad, etc.)
CREATE TABLE device_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,            -- "E-Bike Bosch Charger"
  description TEXT,
  target_soc INTEGER NOT NULL DEFAULT 80,  -- Default charge target %
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Reference charge curves (recorded during learn mode)
CREATE TABLE reference_curves (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER NOT NULL REFERENCES device_profiles(id),
  start_power REAL NOT NULL,     -- Initial power for quick-match
  peak_power REAL NOT NULL,      -- Max power during charge
  idle_power REAL NOT NULL,      -- Power when charge complete (~0W)
  duration_seconds INTEGER NOT NULL, -- Full charge duration
  created_at INTEGER NOT NULL
);

-- Downsampled curve data points for reference curves
CREATE TABLE reference_curve_points (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  curve_id INTEGER NOT NULL REFERENCES reference_curves(id),
  offset_seconds INTEGER NOT NULL, -- Time offset from charge start
  apower REAL NOT NULL,           -- Power in Watts
  voltage REAL,
  current REAL
);

-- Charge sessions (one per charging event)
CREATE TABLE charge_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plug_id TEXT NOT NULL REFERENCES plugs(id),
  profile_id INTEGER REFERENCES device_profiles(id), -- NULL if unrecognized
  state TEXT NOT NULL DEFAULT 'detecting',
  -- states: detecting, charging, stopping, complete, aborted
  detection_confidence REAL,      -- 0.0-1.0 curve match score
  target_soc INTEGER,             -- Charge target for this session
  estimated_soc INTEGER,          -- Current estimated SOC %
  started_at INTEGER NOT NULL,
  stopped_at INTEGER,
  stop_reason TEXT,               -- target_reached, manual, error, idle_detected
  energy_wh REAL,                 -- Total energy consumed
  created_at INTEGER NOT NULL
);

-- Raw power readings during active sessions (high frequency)
CREATE TABLE session_readings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES charge_sessions(id),
  offset_ms INTEGER NOT NULL,    -- Milliseconds from session start
  apower REAL NOT NULL,
  voltage REAL,
  current REAL,
  timestamp INTEGER NOT NULL     -- Unix ms
);

-- System configuration (MQTT broker, Pushover keys, etc.)
CREATE TABLE config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

### Data Volume Estimation

At 1 reading every 2 seconds for a 4-hour charge session:
- 7,200 readings per session
- ~50 bytes per reading = ~360 KB per session
- 10 sessions/day for 365 days = ~1.3 GB/year

This is well within SQLite capabilities. **Mitigation:** Implement periodic archival -- move completed sessions older than N months to a separate archive table or export to JSON. Index `session_readings` on `(session_id, offset_ms)` for efficient curve queries.

### SQLite Configuration

```typescript
// Required pragmas for IoT workload
PRAGMA journal_mode = WAL;        // Concurrent reads during writes
PRAGMA synchronous = NORMAL;      // Safe with WAL, much faster
PRAGMA busy_timeout = 5000;       // Wait up to 5s on lock
PRAGMA cache_size = -20000;       // 20MB cache
PRAGMA foreign_keys = ON;
```

WAL mode is critical: the MQTT Service writes readings continuously while Next.js reads for the UI. Without WAL, readers would block writers.

**Confidence: HIGH** -- SQLite WAL mode for IoT workloads is extensively documented.

### Drizzle ORM + better-sqlite3

Use `better-sqlite3` as the driver (not libSQL/Turso). Rationale:
- Synchronous API = simpler mental model for a single-process app
- No network overhead (local file)
- Mature, battle-tested, fastest Node.js SQLite driver
- Drizzle ORM has first-class support

**Confidence: HIGH** -- Verified in Drizzle ORM documentation.

## Curve Matching Algorithm

### Approach: Sliding Window DTW (Dynamic Time Warping)

The core challenge: when a device is plugged in at an unknown SOC, the observed power curve is a **sub-sequence** of the full reference curve. The algorithm must find where on the reference curve the current charge starts.

**Phase 1: Quick Rejection (first 10 seconds)**
- Compare initial `apower` against all profile `start_power` ranges (with tolerance)
- Reject profiles where initial power differs by more than 20%
- Reduces candidate set from N profiles to typically 1-3

**Phase 2: Subsequence DTW (first 60-120 seconds)**
- Downsample incoming readings to 1 per second (60-120 points)
- For each candidate profile, slide a window along the reference curve
- Compute DTW distance at each window position
- Best match = (profile_id, curve_offset) with lowest DTW distance

```typescript
interface MatchResult {
  profileId: number;
  confidence: number;       // 0.0-1.0 (1 - normalized DTW distance)
  curveOffset: number;      // Estimated position on reference curve (seconds)
  estimatedSoc: number;     // Derived from curve offset / total duration
}
```

**Why DTW over Euclidean distance:** Charging curves can stretch/compress slightly due to temperature, grid voltage fluctuations, and aging. DTW handles these temporal distortions naturally. It is the standard algorithm for time-series matching in Non-Intrusive Load Monitoring (NILM) research.

**Implementation:** DTW is simple enough to implement from scratch (~50 lines of TypeScript). No external library needed. For the expected data sizes (120 points vs. 7200 reference points with window), computation completes in under 10ms.

**Confidence: MEDIUM** -- DTW for power curve matching is well-established in academic NILM research. The specific application to partial-charge subsequence matching on AC-side power will need empirical tuning of thresholds and window sizes.

### SOC Estimation from Curve Position

Once the curve offset is determined:

```
estimated_soc = (curve_offset / total_reference_duration) * 100
```

This is approximate -- the relationship between time and SOC is non-linear (CC-CV charging). For better accuracy, store SOC checkpoints in the reference curve (derived from energy integration during the learning phase). The reference curve effectively becomes a lookup table: `offset_seconds -> estimated_soc_percent`.

### SOC Target Boundaries

For each reference curve, pre-compute power levels at 10% SOC increments:

```typescript
interface SocBoundary {
  soc: number;           // 10, 20, 30 ... 100
  offsetSeconds: number; // Time position on reference curve
  expectedPower: number; // Power level at this SOC
  energyWh: number;      // Cumulative energy to this point
}
```

The charge monitor uses both curve position tracking AND energy integration as cross-checks for SOC estimation.

## Custom Server Bootstrap Pattern

### server.ts (Entry Point)

```typescript
// server.ts -- single entry point for the entire application
import { createServer } from 'http';
import { parse } from 'url';
import next from 'next';
import { MqttService } from './src/modules/mqtt/mqtt-service';
import { EventBus } from './src/modules/events/event-bus';
import { ChargeMonitor } from './src/modules/charging/charge-monitor';
import { db } from './src/db/client';

const dev = process.env.NODE_ENV !== 'production';
const app = next({ dev });
const handle = app.getRequestHandler();

async function main() {
  await app.prepare();

  // Initialize shared event bus
  const eventBus = new EventBus();

  // Start persistent MQTT connection
  const mqttService = new MqttService(eventBus, db);
  await mqttService.connect();

  // Start charge monitoring (subscribes to eventBus)
  const chargeMonitor = new ChargeMonitor(eventBus, mqttService, db);
  chargeMonitor.start();

  // Expose eventBus for SSE route handlers
  globalThis.__eventBus = eventBus;
  globalThis.__mqttService = mqttService;

  const server = createServer((req, res) => {
    const parsedUrl = parse(req.url!, true);
    handle(req, res, parsedUrl);
  });

  server.listen(3000, () => {
    console.log('Charging Master ready on http://localhost:3000');
  });
}

main().catch(console.error);
```

### Running in Development

```json
{
  "scripts": {
    "dev": "tsx watch server.ts",
    "build": "next build",
    "start": "NODE_ENV=production node server.js"
  }
}
```

In production, compile `server.ts` to JavaScript (via `tsc` or bundle step) and run with `node`. The `tsx watch` command handles TypeScript execution and hot-reload in development.

### systemd Service (Production)

```ini
[Unit]
Description=Charging Master
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/charging-master
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

**Confidence: HIGH** -- Custom server pattern is documented by Next.js and used in production by MQTT+Next.js projects.

## SSE Implementation Pattern

### Route Handler

```typescript
// src/app/api/live/[plugId]/route.ts
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(
  request: Request,
  context: { params: Promise<{ plugId: string }> }
) {
  const { plugId } = await context.params;
  const eventBus = globalThis.__eventBus;

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();

      const handler = (data: PowerReading) => {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(data)}\n\n`)
        );
      };

      eventBus.on(`power:${plugId}`, handler);

      // Cleanup on client disconnect
      request.signal.addEventListener('abort', () => {
        eventBus.off(`power:${plugId}`, handler);
        controller.close();
      });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}
```

## Patterns to Follow

### Pattern 1: Event-Driven Decoupling

**What:** Use an in-process EventEmitter as a message bus between MQTT ingestion, charge logic, and SSE streaming.
**When:** Always. This is the core architectural pattern.
**Why:** Decouples producers (MQTT) from consumers (UI, charge logic) without introducing external message queues. Adding new consumers (e.g., logging, analytics) requires zero changes to producers.

### Pattern 2: State Machine for Charge Sessions

**What:** Model each plug's charging state as an explicit finite state machine (IDLE -> DETECTING -> CHARGING -> STOPPING -> COMPLETE).
**When:** Managing charge session lifecycle.
**Why:** Makes state transitions explicit, testable, and debuggable. Prevents impossible state combinations. Each transition can trigger side effects (DB writes, notifications, relay commands).

### Pattern 3: Downsample Before Store

**What:** Store raw readings at full frequency during active sessions, but downsample reference curves to 1 reading per second.
**When:** Recording reference curves and performing curve matching.
**Why:** Full-resolution readings (every 500ms) are needed for accurate real-time charts but wasteful for stored references. A 4-hour reference curve at 1/sec = 14,400 points; at 2/sec = 28,800. The extra resolution adds nothing to curve matching accuracy.

## Anti-Patterns to Avoid

### Anti-Pattern 1: MQTT Client in API Routes

**What:** Creating a new MQTT connection per API request.
**Why bad:** MQTT connections are expensive to establish. Serverless-style one-connection-per-request would overwhelm the broker and lose subscription state between requests. You also miss messages between requests.
**Instead:** Single persistent MQTT client in the custom server, shared via global reference.

### Anti-Pattern 2: Polling Instead of SSE

**What:** Using `setInterval` + `fetch` to poll for power readings.
**Why bad:** At 2-second update intervals, polling adds unnecessary HTTP overhead, increased latency (up to 2x the interval), and server load. With 4 plugs, that is 8 requests/second doing nothing but checking for new data.
**Instead:** SSE provides instant push with a single long-lived connection per plug.

### Anti-Pattern 3: Storing All Readings Forever

**What:** Never archiving or pruning session_readings.
**Why bad:** At 1.3 GB/year growth, the database will become slow for backups and migrations within 2-3 years on a resource-constrained LXC.
**Instead:** Archive completed sessions older than 6 months. Keep aggregated summaries (energy, duration, peak power) permanently.

### Anti-Pattern 4: Tight Coupling Between Curve Matching and MQTT

**What:** Running DTW matching directly inside the MQTT message handler.
**Why bad:** DTW computation (even if fast) blocks the event loop during message processing. If matching takes longer than expected, you miss MQTT messages.
**Instead:** Buffer readings in the Charge Monitor, run matching asynchronously on accumulated windows.

## Suggested Build Order

Dependencies dictate this sequence:

```
Phase 1: Foundation
  +-- Custom server.ts (boots MQTT + Next.js)
  +-- SQLite schema + Drizzle setup (WAL mode)
  +-- MQTT Service (connect, subscribe, parse Shelly status)
  +-- Event Bus (EventEmitter)
  +-- Plug management (add/remove/configure Shelly plugs)

Phase 2: Real-Time Visualization
  +-- SSE endpoint for live power data
  +-- Dashboard page with ECharts
  +-- Live power chart (real-time streaming)
  +-- Plug status overview (online/offline, relay state)
  +-- Manual relay control (on/off buttons)

Phase 3: Charge Intelligence
  +-- Reference curve recording (learn mode)
  +-- Charge session state machine
  +-- Curve matching (DTW subsequence)
  +-- SOC estimation
  +-- Auto-stop logic (relay control)
  +-- Manual override controls

Phase 4: Polish
  +-- Pushover notifications
  +-- Charge history + statistics
  +-- Data archival/cleanup
  +-- Multi-plug dashboard
```

**Phase ordering rationale:**
- Phase 1 must come first: everything depends on MQTT connectivity and data persistence
- Phase 2 before Phase 3: you need visual feedback to validate that MQTT data is correct before building charge logic on top of it
- Phase 3 is the core value: this is where device learning and auto-stop live
- Phase 4 is polish: notifications and history are valuable but not blocking

## Scalability Considerations

| Concern | 1 Plug | 4 Plugs | 10 Plugs |
|---------|--------|---------|----------|
| MQTT messages/sec | 0.5 | 2 | 5 |
| SSE connections | 1 | 4 | 10 |
| SQLite writes/sec | 0.5 | 2 | 5 |
| Memory (readings buffer) | ~1 MB | ~4 MB | ~10 MB |
| DTW computations/min | 0-1 | 0-4 | 0-10 |

All well within single-process Node.js capacity on a Debian LXC. SQLite WAL handles this write throughput easily. The architecture does not need to change for up to ~50 plugs.

## Sources

- [Shelly Gen2 MQTT Documentation](https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/Mqtt/) -- HIGH confidence
- [Shelly Switch Component Documentation](https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/Switch/) -- HIGH confidence
- [Next.js Worker Alongside Server](https://dev.to/noclat/run-a-worker-alongside-next-js-server-using-a-single-command-5a44) -- MEDIUM confidence
- [MQTT + Next.js Architecture (Medium)](https://jowwii.medium.com/building-real-time-mqtt-visualizations-with-next-js-why-i-went-with-a-7-vps-instead-of-serverless-94e3ad889bb8) -- MEDIUM confidence
- [SSE in Next.js App Router](https://www.pedroalonso.net/blog/sse-nextjs-real-time-notifications/) -- HIGH confidence
- [Next.js SSE Discussion #48427](https://github.com/vercel/next.js/discussions/48427) -- MEDIUM confidence
- [SQLite WAL Mode](https://www.sqlite.org/wal.html) -- HIGH confidence
- [DTW for Non-Intrusive Load Monitoring](https://www.sciencedirect.com/science/article/abs/pii/S0306261917302209) -- MEDIUM confidence
- [Drizzle ORM SQLite Getting Started](https://orm.drizzle.team/docs/get-started-sqlite) -- HIGH confidence
- [MQTT.js on npm](https://www.npmjs.com/package/mqtt) -- HIGH confidence
