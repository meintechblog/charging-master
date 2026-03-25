# Phase 1: Foundation - Research

**Researched:** 2026-03-25
**Domain:** IoT MQTT integration, Next.js custom server, SQLite persistence, Shelly S3 Plug Gen3 API
**Confidence:** HIGH

## Summary

Phase 1 establishes the entire infrastructure backbone for the Charging-Master app: a Next.js custom server with a persistent MQTT client, SQLite database with WAL mode via Drizzle ORM, Shelly S3 Plug discovery and management, and a settings page. This is a greenfield project -- only README.md exists.

The architecture is a single Node.js process running both Next.js (App Router) and a persistent MQTT client connected to mqtt-master.local. An in-process EventEmitter bus decouples MQTT message ingestion from consumers (SSE endpoints, charge logic in later phases). SQLite with better-sqlite3 provides zero-setup persistence with WAL mode for concurrent reads/writes.

**Primary recommendation:** Build the custom server entry point (`server.ts`) first, then database schema, then MQTT service, then UI. Each layer depends on the previous one. Use `tsx watch server.ts` for development.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- **D-01:** Sidebar + Content layout. Left sidebar with navigation (Dashboard, Devices, Settings, History), content area right.
- **D-02:** Dashboard shows Plug-Uebersicht as Cards -- each Shelly Plug as a card with status, current watt value, relay state.
- **D-03:** Dark theme in "Sleek Minimal" style -- dark surfaces, minimal borders, subtle shadows, a la Vercel/Linear.
- **D-04:** Dedicated /settings page with sections (MQTT, Pushover, Allgemein). Fits well with sidebar navigation.
- **D-05:** Auto-Save -- every change saves immediately, no explicit save button needed.
- **D-06:** MQTT connection test button in settings -- tests broker connectivity and shows result inline.
- **D-07:** MQTT Auto-Discovery as primary method. App subscribes to broker, finds Shelly devices by their topic patterns, presents selection list with device names and switches. User picks from list to add.
- **D-08:** Manual IP/Topic entry as fallback (advanced option) if auto-discovery fails.
- **D-09:** Per-Plug configuration: Name/Alias (custom label), Polling interval, Enabled/Disabled toggle, Default charging profile (prepared for Phase 3).
- **D-10:** Dynamic sampling rate: 5s interval during active charging, 1-2 min interval during idle/standby. Transition triggered by power threshold.
- **D-11:** Data aggregation after 30 days: raw readings compressed to minute-averages. Session metadata and aggregated data kept indefinitely.
- **D-12:** SQLite with WAL mode, write queue to prevent SQLITE_BUSY from concurrent MQTT writes and UI reads.

### Claude's Discretion
- Settings page organization and section layout (D-04)
- CSS framework choice (Tailwind assumed, but flexible)
- Exact power threshold for idle vs. active sampling transition
- MQTT discovery topic pattern strategy

### Deferred Ideas (OUT OF SCOPE)
None -- discussion stayed within phase scope
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| SHLY-01 | User can add a Shelly S3 Plug by entering its MQTT topic prefix | MQTT discovery pattern + manual fallback UI (D-07, D-08). Shelly device_id format: `shellyplugsg3-<MAC>` |
| SHLY-02 | App connects to configurable MQTT broker (host, port, optional credentials) | mqtt.js v5 connect options, config table in SQLite, settings UI with test button (D-06) |
| SHLY-03 | App receives real-time power data (watts) from Shelly via MQTT | Subscribe to `<device_id>/status/switch:0`, parse `apower` field from JSON payload |
| SHLY-05 | MQTT connection auto-reconnects on disconnect with watchdog | mqtt.js built-in `reconnectPeriod` (default 1000ms), plus custom health check watchdog |
| SHLY-06 | App supports multiple Shelly Plugs simultaneously | Multi-device subscriptions via wildcard topics, per-plug event routing on EventBus |
| SETT-01 | MQTT broker settings configurable (host, port, credentials) | Config table in SQLite, /settings page with MQTT section, auto-save (D-05) |
| SETT-02 | Pushover notification settings configurable | Config table in SQLite, /settings page with Pushover section |
| SETT-03 | All settings persisted in database | SQLite `config` table with key-value pairs, loaded on server startup |
</phase_requirements>

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| Next.js | 15.5.14 | Full-stack framework with App Router | Locked decision. Custom server for persistent MQTT. Latest 15.x stable |
| React | 19.x | UI library | Peer dependency of Next.js 15 |
| TypeScript | 5.9+ | Type safety | Strict mode, essential for MQTT payload types |
| better-sqlite3 | 12.8.0 | SQLite driver | Synchronous, fastest Node.js SQLite driver. Single-user, no DB server |
| drizzle-orm | 0.45.1 | Type-safe ORM | SQLite support via `drizzle-orm/better-sqlite3`. Zero runtime overhead |
| drizzle-kit | 0.31.10 | Migrations | `drizzle-kit push` for dev, `drizzle-kit generate` for production |
| mqtt | 5.15.1 | MQTT client | Standard Node.js MQTT client, TypeScript v5 rewrite, built-in reconnect |
| Tailwind CSS | 4.2.2 | Utility-first CSS | Dark-only theme, no config file needed in v4 |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| zod | 3.x | Schema validation | Validate MQTT payloads, API inputs, settings forms |
| server-only | 0.0.1 | Import guard | Prevent MQTT/DB code from leaking to browser bundle |
| @types/better-sqlite3 | latest | Type definitions | Dev dependency |
| tsx | 4.x | TypeScript execution | Dev: `tsx watch server.ts` for hot-reload |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Tailwind CSS | Plain CSS / CSS Modules | Tailwind faster for dark-theme utility classes, consistent with Vercel/Linear aesthetic |
| next-themes | Hardcoded dark | Since app is dark-only (no toggle), skip next-themes entirely. Set `<html class="dark">` in layout |

**Installation:**
```bash
# Core dependencies
pnpm add next@15 react@19 react-dom@19 mqtt@5 drizzle-orm better-sqlite3 zod server-only

# CSS
pnpm add tailwindcss@4 @tailwindcss/postcss postcss

# Dev dependencies
pnpm add -D typescript@5.9 @types/node @types/react @types/react-dom @types/better-sqlite3 drizzle-kit eslint eslint-config-next tsx
```

**Version verification:** All versions checked against npm registry on 2026-03-25. Next.js latest is 16.2.1 but we use 15.x per project decision. better-sqlite3 12.8.0, drizzle-orm 0.45.1, mqtt 5.15.1 are all current.

## Architecture Patterns

### Recommended Project Structure
```
server.ts                          # Custom server entry point (MQTT + Next.js)
src/
  app/
    layout.tsx                     # Root layout (dark theme, sidebar)
    page.tsx                       # Dashboard (plug cards)
    devices/
      page.tsx                     # Device management / discovery
    settings/
      page.tsx                     # Settings (MQTT, Pushover, Allgemein)
    api/
      devices/route.ts             # Device CRUD
      settings/route.ts            # Settings CRUD
      mqtt/test/route.ts           # MQTT connection test endpoint
      stream/route.ts              # SSE endpoint (Phase 2, stub for now)
  components/
    layout/
      sidebar.tsx                  # Navigation sidebar
      app-shell.tsx                # Sidebar + content wrapper
    devices/
      plug-card.tsx                # Individual plug status card
      discovery-list.tsx           # MQTT auto-discovery results
      add-device-form.tsx          # Manual device entry fallback
    settings/
      mqtt-settings.tsx            # MQTT broker configuration
      pushover-settings.tsx        # Pushover credentials
      settings-section.tsx         # Reusable settings section wrapper
  modules/
    mqtt/
      mqtt-service.ts              # Singleton MQTT client (server-only)
      shelly-parser.ts             # Parse Shelly Gen3 MQTT payloads
      discovery.ts                 # Auto-discovery logic
    events/
      event-bus.ts                 # In-process EventEmitter
  db/
    client.ts                      # Drizzle + better-sqlite3 (WAL mode)
    schema.ts                      # Drizzle schema definitions
    migrations/                    # Drizzle generated migrations
  lib/
    env.ts                         # Environment variable validation
    utils.ts                       # Shared utilities (cn, etc.)
data/
  charging-master.db               # SQLite database file (gitignored)
drizzle.config.ts                  # Drizzle Kit configuration
```

### Pattern 1: Custom Server with MQTT Singleton

**What:** Single Node.js process boots MQTT client + Next.js. MQTT client is a long-lived singleton exposed via `globalThis`.
**When to use:** Always -- this is the core architecture.
**Example:**
```typescript
// server.ts
import { createServer } from 'http';
import next from 'next';
import { MqttService } from './src/modules/mqtt/mqtt-service';
import { EventBus } from './src/modules/events/event-bus';
import { db } from './src/db/client';

const dev = process.env.NODE_ENV !== 'production';
const app = next({ dev });
const handle = app.getRequestHandler();

async function main() {
  await app.prepare();

  const eventBus = new EventBus();
  const mqttService = new MqttService(eventBus, db);
  await mqttService.connect();

  // Expose for SSE route handlers and API routes
  globalThis.__eventBus = eventBus;
  globalThis.__mqttService = mqttService;

  const server = createServer((req, res) => {
    handle(req, res);
  });

  server.listen(3000, () => {
    console.log('Charging Master ready on http://localhost:3000');
  });
}

main().catch(console.error);
```
Source: [Next.js Custom Server docs](https://nextjs.org/docs/pages/guides/custom-server), [MQTT+Next.js real-world pattern](https://jowwii.medium.com/building-real-time-mqtt-visualizations-with-next-js-why-i-went-with-a-7-vps-instead-of-serverless-94e3ad889bb8)

### Pattern 2: SQLite WAL Mode Initialization

**What:** Enable WAL mode and pragmas on the raw better-sqlite3 instance BEFORE passing to Drizzle.
**When to use:** Always -- required for concurrent MQTT writes + UI reads.
**Example:**
```typescript
// src/db/client.ts
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';
import 'server-only';

const DB_PATH = process.env.DATABASE_PATH || 'data/charging-master.db';

const sqlite = new Database(DB_PATH);

// CRITICAL: Set pragmas BEFORE Drizzle initialization
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('synchronous = NORMAL');
sqlite.pragma('busy_timeout = 5000');
sqlite.pragma('cache_size = -20000'); // 20MB
sqlite.pragma('foreign_keys = ON');

export const db = drizzle(sqlite, { schema });
```
Source: [Drizzle ORM WAL issue #4968](https://github.com/drizzle-team/drizzle-orm/issues/4968)

### Pattern 3: EventEmitter Bus for Decoupling

**What:** In-process Node.js EventEmitter as message bus between MQTT and consumers.
**When to use:** Connecting MQTT ingestion to SSE, charge logic, logging.
**Example:**
```typescript
// src/modules/events/event-bus.ts
import { EventEmitter } from 'events';

export interface PowerReading {
  plugId: string;
  apower: number;
  voltage: number;
  current: number;
  output: boolean;
  totalEnergy: number;
  timestamp: number;
}

export class EventBus extends EventEmitter {
  emitPowerReading(reading: PowerReading) {
    this.emit(`power:${reading.plugId}`, reading);
    this.emit('power:*', reading); // wildcard for dashboard
  }

  emitPlugOnline(plugId: string, online: boolean) {
    this.emit(`online:${plugId}`, online);
    this.emit('online:*', { plugId, online });
  }
}
```

### Pattern 4: Auto-Save Settings with Debounce

**What:** Settings changes save immediately via API call, debounced to prevent spam.
**When to use:** Settings page (D-05).
**Example:**
```typescript
// Client-side: debounce saves
function useAutoSave(key: string, value: string, delay = 500) {
  useEffect(() => {
    const timer = setTimeout(() => {
      fetch('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({ key, value }),
      });
    }, delay);
    return () => clearTimeout(timer);
  }, [key, value, delay]);
}
```

### Pattern 5: MQTT Auto-Discovery

**What:** Subscribe to wildcard topics to find Shelly devices on the broker, present as selectable list.
**When to use:** Device management page (D-07).
**Example:**
```typescript
// Discovery pattern: subscribe to Shelly announce/status topics
// shellyplugsg3-+/online -> catches all Shelly Plug S Gen3 devices
// The '+' wildcard matches one topic level (the device MAC)

const DISCOVERY_TOPICS = [
  'shellyplugsg3-+/online',        // Online status (LWT)
  'shellyplugsg3-+/status/switch:0' // Power readings
];

// Parse device ID from topic: "shellyplugsg3-AABBCC/online" -> "shellyplugsg3-AABBCC"
function parseDeviceId(topic: string): string {
  return topic.split('/')[0];
}
```

### Anti-Patterns to Avoid
- **MQTT client per request:** Never create MQTT connections in API route handlers. Use the singleton from `globalThis.__mqttService`.
- **WAL mode in migrations:** Do not put `PRAGMA journal_mode = WAL` in Drizzle migration files. Set it on the Database instance before Drizzle init.
- **Polling for real-time data:** Do not use `setInterval` + `fetch` for live power readings. Use SSE (Phase 2).
- **Storing config in .env files:** Settings that users change at runtime (MQTT broker, Pushover keys) go in the SQLite `config` table, not environment variables. Only truly static config (DB path, port) belongs in env.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| MQTT reconnection | Custom reconnect loop | mqtt.js `reconnectPeriod` option | Built-in exponential backoff, handles edge cases (partial connect, CONNACK errors) |
| SQLite concurrent access | Custom locking/queueing | WAL mode + `busy_timeout` pragma | SQLite's WAL mode handles reader/writer concurrency natively |
| TypeScript execution in dev | Custom build pipeline | `tsx watch server.ts` | Hot-reload, sourcemaps, zero config |
| CSS dark theme system | Custom CSS variables | Tailwind CSS dark variant + utility classes | Consistent, composable, matches Vercel/Linear aesthetic |
| Schema migrations | Manual SQL files | Drizzle Kit `push` / `generate` | Type-safe, tracks schema drift, generates SQL |
| MQTT payload parsing | Manual JSON.parse | Zod schemas | Runtime validation, type inference, error messages |

**Key insight:** The entire IoT data pipeline (MQTT -> parse -> store -> emit) should be composed from proven primitives (mqtt.js, better-sqlite3, EventEmitter), not custom protocol handlers.

## Common Pitfalls

### Pitfall 1: MQTT Not Enabled on Shelly Device
**What goes wrong:** Fresh Shelly S3 Plug does not publish MQTT messages. App shows no data. Developer wastes hours debugging code.
**Why it happens:** MQTT is disabled by default on all Shelly devices. Must be explicitly enabled via the Shelly web UI at `http://192.168.3.167`.
**How to avoid:** Show clear setup instructions in the UI when no devices are discovered. Add a health indicator that distinguishes "no broker connection" from "broker connected but no devices publishing."
**Warning signs:** `<device_id>/online` topic never appears. No messages on any `shellyplugsg3-*` topics.

### Pitfall 2: SSE Buffering in Next.js
**What goes wrong:** SSE responses buffer and deliver as one blob instead of streaming incrementally.
**Why it happens:** Missing `export const dynamic = 'force-dynamic'` and `export const runtime = 'nodejs'` on the SSE route handler.
**How to avoid:** Always set both exports on SSE routes. Test with `curl -N http://localhost:3000/api/stream` before building UI.
**Warning signs:** Data arrives in bursts in browser DevTools Network tab.

### Pitfall 3: WAL Mode Not Set Before Drizzle
**What goes wrong:** `SQLITE_BUSY` errors under concurrent MQTT writes + UI reads.
**Why it happens:** WAL pragma must be set on the raw better-sqlite3 instance before Drizzle wraps it. Setting it in migrations is too late.
**How to avoid:** Follow Pattern 2 above exactly.
**Warning signs:** "database is locked" errors in server logs.

### Pitfall 4: better-sqlite3 Build Failure on Deployment
**What goes wrong:** `pnpm install` fails on the Debian LXC because better-sqlite3 requires native compilation.
**Why it happens:** Missing build tools (gcc, make, python3, node-gyp).
**How to avoid:** Install prerequisites first: `apt install build-essential python3`.
**Warning signs:** `node-gyp` errors during `pnpm install`.

### Pitfall 5: globalThis Type Safety
**What goes wrong:** TypeScript errors when accessing `globalThis.__mqttService` or `globalThis.__eventBus` in route handlers.
**Why it happens:** `globalThis` has no type declarations for custom properties.
**How to avoid:** Declare a global type augmentation:
```typescript
// src/types/global.d.ts
import type { MqttService } from '@/modules/mqtt/mqtt-service';
import type { EventBus } from '@/modules/events/event-bus';

declare global {
  var __mqttService: MqttService;
  var __eventBus: EventBus;
}
```
**Warning signs:** TypeScript `Property does not exist on type` errors.

### Pitfall 6: Shelly Status Updates Are Event-Driven, Not Periodic
**What goes wrong:** Expecting power readings at fixed intervals. Shelly only publishes when values change significantly. During constant-power phases, updates are sparse.
**Why it happens:** Gen2/Gen3 API optimizes bandwidth by only publishing on significant change.
**How to avoid:** Supplement with periodic `status_update` command via MQTT to request fresh status on a timer (every 5s active, every 60s idle per D-10).
**Warning signs:** Gaps in power data during steady-state charging.

## Code Examples

### Drizzle Schema for Phase 1

```typescript
// src/db/schema.ts
import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';

// Registered Shelly plugs
export const plugs = sqliteTable('plugs', {
  id: text('id').primaryKey(),              // shellyplugsg3-AABBCC
  name: text('name').notNull(),             // User-assigned label
  mqttTopicPrefix: text('mqtt_topic_prefix').notNull(),
  ipAddress: text('ip_address'),            // For HTTP fallback
  pollingInterval: integer('polling_interval').notNull().default(5), // seconds
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  online: integer('online', { mode: 'boolean' }).notNull().default(false),
  lastSeen: integer('last_seen'),           // Unix ms
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

// Power readings (continuous, high-frequency during active)
export const powerReadings = sqliteTable('power_readings', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  plugId: text('plug_id').notNull().references(() => plugs.id),
  apower: real('apower').notNull(),         // Watts
  voltage: real('voltage'),
  current: real('current'),
  output: integer('output', { mode: 'boolean' }),
  totalEnergy: real('total_energy'),        // Wh cumulative
  timestamp: integer('timestamp').notNull(), // Unix ms
});

// Key-value config store
export const config = sqliteTable('config', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: integer('updated_at').notNull(),
});
```

### MQTT Service Skeleton

```typescript
// src/modules/mqtt/mqtt-service.ts
import mqtt, { MqttClient, IClientOptions } from 'mqtt';
import type { EventBus } from '../events/event-bus';
import { parseShellyStatus } from './shelly-parser';
import 'server-only';

export class MqttService {
  private client: MqttClient | null = null;
  private eventBus: EventBus;

  constructor(eventBus: EventBus) {
    this.eventBus = eventBus;
  }

  async connect(brokerUrl: string, options?: IClientOptions): Promise<void> {
    this.client = mqtt.connect(brokerUrl, {
      reconnectPeriod: 1000,        // Auto-reconnect after 1s
      connectTimeout: 5000,
      ...options,
    });

    this.client.on('connect', () => {
      console.log('MQTT connected to', brokerUrl);
      this.subscribeToDevices();
    });

    this.client.on('message', (topic, payload) => {
      this.handleMessage(topic, payload.toString());
    });

    this.client.on('reconnect', () => {
      console.log('MQTT reconnecting...');
    });

    this.client.on('error', (err) => {
      console.error('MQTT error:', err.message);
    });
  }

  private subscribeToDevices() {
    // Discovery: listen for all Shelly Plug S Gen3 devices
    this.client?.subscribe('shellyplugsg3-+/status/switch:0');
    this.client?.subscribe('shellyplugsg3-+/online');
  }

  private handleMessage(topic: string, payload: string) {
    const deviceId = topic.split('/')[0];

    if (topic.endsWith('/online')) {
      this.eventBus.emitPlugOnline(deviceId, payload === 'true');
      return;
    }

    if (topic.endsWith('/status/switch:0')) {
      const status = parseShellyStatus(payload);
      if (status) {
        this.eventBus.emitPowerReading({
          plugId: deviceId,
          apower: status.apower,
          voltage: status.voltage,
          current: status.current,
          output: status.output,
          totalEnergy: status.aenergy.total,
          timestamp: Date.now(),
        });
      }
    }
  }

  async testConnection(brokerUrl: string): Promise<boolean> {
    return new Promise((resolve) => {
      const testClient = mqtt.connect(brokerUrl, {
        connectTimeout: 5000,
        reconnectPeriod: 0, // Don't reconnect for test
      });
      testClient.on('connect', () => {
        testClient.end();
        resolve(true);
      });
      testClient.on('error', () => {
        testClient.end();
        resolve(false);
      });
      setTimeout(() => {
        testClient.end();
        resolve(false);
      }, 5000);
    });
  }
}
```

### Shelly Payload Parser with Zod

```typescript
// src/modules/mqtt/shelly-parser.ts
import { z } from 'zod';

const ShellyEnergySchema = z.object({
  total: z.number(),
  by_minute: z.array(z.number()).optional(),
  minute_ts: z.number().optional(),
});

const ShellySwitchStatusSchema = z.object({
  id: z.number(),
  source: z.string().optional(),
  output: z.boolean(),
  apower: z.number(),
  voltage: z.number(),
  current: z.number(),
  pf: z.number().optional(),
  freq: z.number().optional(),
  aenergy: ShellyEnergySchema,
  temperature: z.object({
    tC: z.number(),
    tF: z.number(),
  }).optional(),
});

export type ShellySwitchStatus = z.infer<typeof ShellySwitchStatusSchema>;

export function parseShellyStatus(payload: string): ShellySwitchStatus | null {
  try {
    const parsed = JSON.parse(payload);
    const result = ShellySwitchStatusSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
```

### Settings API Route (Auto-Save Pattern)

```typescript
// src/app/api/settings/route.ts
import { db } from '@/db/client';
import { config } from '@/db/schema';
import { eq } from 'drizzle-orm';

export async function GET() {
  const rows = db.select().from(config).all();
  const settings = Object.fromEntries(rows.map(r => [r.key, r.value]));
  return Response.json(settings);
}

export async function PUT(request: Request) {
  const { key, value } = await request.json();
  db.insert(config)
    .values({ key, value, updatedAt: Date.now() })
    .onConflictDoUpdate({
      target: config.key,
      set: { value, updatedAt: Date.now() },
    })
    .run();
  return Response.json({ ok: true });
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Tailwind v3 config file | Tailwind v4 CSS-only config | Jan 2025 | No `tailwind.config.ts`, use `@import "tailwindcss"` in CSS |
| mqtt.js v4 (JavaScript) | mqtt.js v5 (TypeScript rewrite) | 2024 | Native TypeScript types, MQTT 5.0 support |
| `drizzle-kit push:sqlite` | `drizzle-kit push` | Drizzle Kit 0.31+ | Unified push command, no dialect suffix needed |
| Next.js Pages Router custom server | Works with App Router too | Confirmed 2026 | Same `createServer` + `getRequestHandler` pattern |

**Deprecated/outdated:**
- `tailwind.config.js` / `tailwind.config.ts` -- replaced by CSS-only config in v4
- `darkMode: "class"` in Tailwind config -- replaced by `@custom-variant dark` in CSS
- `drizzle-kit push:sqlite` command -- use `drizzle-kit push` (auto-detects dialect)

## Project Constraints (from CLAUDE.md)

- **Tech stack:** Next.js 15, React 19, TypeScript 5.9+, Drizzle ORM, pnpm
- **Naming:** PascalCase components, kebab-case utilities, camelCase functions
- **Imports:** Use `@/*` path alias mapped to `./src/*`
- **Error handling:** Explicit error type guards, API routes return Response.json with status codes
- **Module design:** Named exports for functions/components, default exports for page components
- **Next.js:** Async Server Components preferred, App Router with `src/app/` structure
- **Architecture:** Server-first, domain modules in `/modules`, functional programming patterns
- **Testing:** Vitest for unit tests, Playwright for E2E (not in Phase 1 scope, but set up config)
- **GSD workflow:** All edits through GSD commands

## Open Questions

1. **MQTT broker authentication**
   - What we know: mqtt-master.local is on local LAN, CONTEXT says "optional credentials"
   - What's unclear: Whether the broker currently requires auth
   - Recommendation: Support optional username/password in settings, default to no auth

2. **Shelly device ID stability**
   - What we know: Device ID is `shellyplugsg3-<MAC>`, MAC-based so should be stable
   - What's unclear: Whether custom topic prefixes have been set on the device
   - Recommendation: Use device_id from topic as primary key, allow custom prefix override

3. **Power threshold for idle vs. active sampling (D-10)**
   - What we know: E-bike chargers typically draw 50-150W active, <1W idle
   - What's unclear: Exact threshold for this specific use case
   - Recommendation: Default to 5W threshold, make configurable per-plug in Phase 3. For Phase 1, use fixed 5W.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | Runtime | Yes | v22.22.0 | -- |
| pnpm | Package manager | Yes | 10.30.3 | -- |
| tsx | Dev server | No | -- | Install as dev dependency: `pnpm add -D tsx` |
| gcc/make | better-sqlite3 build | Yes (macOS) | Apple clang 17.0 | Need `build-essential` on Debian LXC |
| MQTT broker | MQTT connection | Remote (mqtt-master.local) | -- | Verify connectivity from dev machine |

**Missing dependencies with no fallback:**
- None blocking on dev machine

**Missing dependencies with fallback:**
- `tsx` not globally installed -- will be installed as project dev dependency
- Debian LXC deployment needs `build-essential python3` for better-sqlite3 native build

## Sources

### Primary (HIGH confidence)
- [Shelly Gen2 MQTT Component docs](https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/Mqtt/) -- Topic structure, LWT, device ID format
- [Shelly Switch Component docs](https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/Switch/) -- Status payload, control commands
- [Next.js Custom Server docs](https://nextjs.org/docs/pages/guides/custom-server) -- createServer pattern, confirmed working with App Router
- [Drizzle ORM SQLite docs](https://orm.drizzle.team/docs/get-started-sqlite) -- better-sqlite3 setup
- [Drizzle WAL mode issue #4968](https://github.com/drizzle-team/drizzle-orm/issues/4968) -- Set pragma before Drizzle init
- [mqtt.js npm](https://www.npmjs.com/package/mqtt) -- v5.15.1, connect options, reconnect
- npm registry version checks (2026-03-25) -- all package versions verified current

### Secondary (MEDIUM confidence)
- [MQTT+Next.js real-world architecture](https://jowwii.medium.com/building-real-time-mqtt-visualizations-with-next-js-why-i-went-with-a-7-vps-instead-of-serverless-94e3ad889bb8) -- Single process pattern validation
- [Next.js SSE discussion #48427](https://github.com/vercel/next.js/discussions/48427) -- SSE buffering issues and fixes
- [Tailwind CSS v4 dark mode setup](https://www.sujalvanjare.com/blog/dark-mode-nextjs15-tailwind-v4) -- CSS-only config, @custom-variant

### Tertiary (LOW confidence)
- None -- all findings verified with primary or secondary sources

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- all libraries verified against npm registry, well-documented, used in production
- Architecture: HIGH -- custom server + MQTT singleton pattern confirmed by multiple sources and Next.js docs
- Pitfalls: HIGH -- MQTT defaults, SQLite WAL, SSE buffering all documented with solutions
- Shelly API: HIGH -- verified against official Shelly Gen2 documentation

**Research date:** 2026-03-25
**Valid until:** 2026-04-25 (stable ecosystem, 30-day validity)
