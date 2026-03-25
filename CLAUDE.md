<!-- GSD:project-start source:PROJECT.md -->
## Project

**Charging-Master**

Eine Web-App, die Ladevorgaenge von Akkus (E-Bike, iPad, etc.) ueber Shelly S3 Plugs intelligent steuert. Der User kann Geraete anlernen (Referenz-Ladekurve aufzeichnen), ein Lade-Ziel in Prozent festlegen, und die App stoppt den Ladevorgang automatisch beim gewuenschten SOC. Die App erkennt angeschlossene Geraete automatisch anhand ihrer charakteristischen Ladekurve und benachrichtigt den User via Pushover.

**Core Value:** Der Akku wird automatisch beim gewuenschten SOC-Level gestoppt — kein manuelles Nachschauen, kein Ueberladen, laengere Akku-Lebensdauer.

### Constraints

- **Deployment**: Debian LXC Container (charging-master.local), Root-Zugang via SSH
- **Smart Plug**: Shelly S3 Plug (Gen3 API, MQTT-faehig)
- **Kommunikation**: MQTT primaer (mqtt-master.local), HTTP-API als Backup fuer Switch-Steuerung
- **Datenbank**: SQLite (kein DB-Server, Single-User, Performance)
- **Design**: Modernes Dark Theme, sexy Echtzeit-Charts
- **Netzwerk**: Lokales Netz, kein Internet-Zugang noetig
- **Single-User**: Keine Authentifizierung
- **Charts**: Apache ECharts — Echtzeit-Streaming, Smooth Animations, Overlay-Support
<!-- GSD:project-end -->

<!-- GSD:stack-start source:research/STACK.md -->
## Technology Stack

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
### MQTT Communication
| Technology | Version | Purpose | Why | Confidence |
|------------|---------|---------|-----|------------|
| mqtt | 5.15.1 | MQTT client | The standard Node.js MQTT client. TypeScript rewrite (v5), supports MQTT 3.1.1 and 5.0, works in Node.js and browser. 3300+ dependents on npm | HIGH |
### Real-Time Data Streaming (Server to Browser)
| Technology | Version | Purpose | Why | Confidence |
|------------|---------|---------|-----|------------|
| Server-Sent Events (SSE) | Native | Server-to-browser push | Unidirectional (server pushes MQTT data to browser). Built into browsers via EventSource API. Works with Next.js Route Handlers via ReadableStream. No extra library needed | HIGH |
### Charts
| Technology | Version | Purpose | Why | Confidence |
|------------|---------|---------|-----|------------|
| echarts | 6.0.0 | Charting library | Best real-time capability. Streaming data support since v4. Smooth animations, dark theme built-in, overlay support for reference curves. v6 adds intelligent dark mode switching | HIGH |
| echarts-for-react | 3.0.6 | React wrapper | Thin wrapper, provides `<ReactECharts>` component. Handles lifecycle and resize. Peer-depends on echarts | HIGH |
### Notifications
| Technology | Version | Purpose | Why | Confidence |
|------------|---------|---------|-----|------------|
| Native fetch | Built-in | Pushover API calls | Pushover API is a single POST endpoint. No library needed -- `fetch()` to `https://api.pushover.net/1/messages.json` with form data. Adding a library for one HTTP call is unnecessary | HIGH |
- Endpoint: `POST https://api.pushover.net/1/messages.json`
- Required: `token` (app API token), `user` (user key), `message` (text)
- Optional: `title`, `priority` (-2 to 2), `sound`, `url`, `html` (1 for HTML formatting)
- Response: HTTP 200 with `{"status": 1, "request": "..."}` on success
- Rate limit: 10,000 messages/month per application
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
### MQTT Topic Structure
| Topic Pattern | Direction | Purpose |
|---------------|-----------|---------|
| `<device_id>/status/switch:0` | Subscribe | Power measurement + switch state |
| `<device_id>/events/rpc` | Subscribe | RPC notifications and events |
| `<device_id>/online` | Subscribe | Connection status (`true`/`false` via LWT) |
| `<device_id>/command/switch:0` | Publish | Control switch (`on`, `off`, `toggle`) |
### Switch Status Payload (from `status/switch:0`)
- `apower` -- Active power in Watts (the primary measurement for charge curve tracking)
- `output` -- Relay state (true = charging, false = stopped)
- `aenergy.total` -- Total energy in Wh (for session tracking)
### Switch Control via MQTT
- `on` -- Turn relay on (start charging)
- `off` -- Turn relay off (stop charging)
- `on,3600` -- Turn on with auto-off after 3600 seconds
- `toggle` -- Toggle current state
- `status_update` -- Request current status
### HTTP API Fallback
- `http://<device_ip>/rpc/Switch.Set?id=0&on=true`
- `http://<device_ip>/rpc/Switch.Set?id=0&on=false`
- `http://<device_ip>/rpc/Switch.GetStatus?id=0`
### MQTT Configuration on Device
- MQTT must be explicitly enabled (disabled by default)
- Set broker: `mqtt-master.local:1883`
- Enable "Generic status update over MQTT" for periodic status pushes
- Enable "RPC status notifications over MQTT" for event-driven updates
### Data Sampling Rate
## Installation
# Core dependencies
# Dev dependencies
## Project Structure
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
<!-- GSD:stack-end -->

<!-- GSD:conventions-start source:CONVENTIONS.md -->
## Conventions

Conventions not yet established. Will populate as patterns emerge during development.
<!-- GSD:conventions-end -->

<!-- GSD:architecture-start source:ARCHITECTURE.md -->
## Architecture

Architecture not yet mapped. Follow existing patterns found in the codebase.
<!-- GSD:architecture-end -->

<!-- GSD:workflow-start source:GSD defaults -->
## GSD Workflow Enforcement

Before using Edit, Write, or other file-changing tools, start work through a GSD command so planning artifacts and execution context stay in sync.

Use these entry points:
- `/gsd:quick` for small fixes, doc updates, and ad-hoc tasks
- `/gsd:debug` for investigation and bug fixing
- `/gsd:execute-phase` for planned phase work

Do not make direct repo edits outside a GSD workflow unless the user explicitly asks to bypass it.
<!-- GSD:workflow-end -->



<!-- GSD:profile-start -->
## Developer Profile

> Profile not yet configured. Run `/gsd:profile-user` to generate your developer profile.
> This section is managed by `generate-claude-profile` -- do not edit manually.
<!-- GSD:profile-end -->
