# Project Research Summary

**Project:** Charging-Master (Smart Charging Management)
**Domain:** IoT Real-Time Monitoring and Control
**Researched:** 2026-03-25
**Confidence:** HIGH

## Executive Summary

Charging-Master is a single-user, local-network IoT application that monitors Shelly S3 Plug Gen3 smart plugs via MQTT, records power curves of connected devices (e-bikes, iPads, etc.), and automatically stops charging when a target SOC is reached. The expert pattern for this type of app is a single-process architecture: one Node.js process running both a persistent MQTT client and a Next.js server, connected by an in-process EventEmitter bus. Data flows from Shelly plugs through MQTT to SQLite (WAL mode) for persistence and through SSE to the browser for real-time visualization. This is well-trodden ground -- MQTT-to-web bridges with Next.js custom servers are documented in multiple production implementations.

The recommended stack is deliberately lightweight: Next.js 15 with a custom server entry point, SQLite via better-sqlite3 and Drizzle ORM (no database server needed), mqtt.js for MQTT connectivity, ECharts 6 for real-time charting, and SSE for server-to-browser streaming. Every choice optimizes for simplicity on a single Debian LXC container. The most novel technical challenge is the curve matching algorithm (subsequence DTW) for device identification and partial-charge SOC estimation. This is well-established in academic NILM research but will require empirical tuning with real device data.

The primary risks are: (1) MQTT switch commands lost at QoS 0, causing overcharging -- mitigated by HTTP API fallback with verification; (2) SSE buffering in Next.js silently breaking real-time display -- mitigated by explicit runtime/dynamic configuration; (3) curve matching accuracy depending heavily on reference data quality -- mitigated by recording multiple reference curves per device and tuning detection windows empirically.

## Key Findings

### Recommended Stack

The stack is fully decided with HIGH confidence across all core technologies. SQLite over PostgreSQL is the right call for a single-user embedded app -- zero operational overhead. The mqtt.js v5 TypeScript rewrite provides type-safe MQTT 5.0 support. ECharts 6 is the only charting library with proper streaming/real-time support. SSE beats WebSocket because the data flow is strictly unidirectional (server pushes MQTT data to browser; commands go via regular POST routes).

**Core technologies:**
- **Next.js 15 + Custom Server**: Full-stack framework with persistent MQTT client in single process
- **SQLite (better-sqlite3) + Drizzle ORM**: Zero-config embedded database, WAL mode for concurrent reads/writes
- **mqtt.js 5**: TypeScript MQTT client connecting to existing broker at mqtt-master.local
- **ECharts 6**: Real-time charting with streaming data support and built-in dark theme
- **SSE (native ReadableStream)**: Server-to-browser push with zero dependencies, auto-reconnect via EventSource
- **Pushover (native fetch)**: Single HTTP POST for notifications, no library needed

### Expected Features

**Must have (table stakes):**
- Shelly Plug discovery and MQTT connection -- nothing works without this
- Live power display with real-time chart -- the "wow" moment that validates the system works
- Manual relay on/off control -- always needed as override
- Reference curve recording (learn mode) -- core of device learning
- Device profile management with target SOC
- Automatic device detection via DTW curve matching -- the hardest feature
- SOC estimation from curve position
- Auto-stop at target SOC -- the primary value proposition
- Charge session tracking with state machine

**Should have (differentiators):**
- Partial charge detection (subsequence DTW) -- the key innovation
- Reference curve overlay on live chart
- Pushover notifications for charge events
- Multi-plug dashboard
- Charge history with statistics

**Defer (v2+):**
- Cloud sync / remote access -- local-only by design
- Multi-user auth -- single-user app
- ML-based SOC prediction -- needs training data that does not exist
- Calendar/scheduling -- not core value
- Energy cost tracking -- needs tariff data
- Non-Shelly plug support -- abstract the interface now, implement later

### Architecture Approach

Single-process architecture with a custom `server.ts` entry point that boots both the MQTT service and Next.js. An in-process EventEmitter acts as the message bus, decoupling MQTT ingestion from SSE streaming and charge monitoring logic. Each plug runs an independent state machine (IDLE -> DETECTING -> CHARGING -> STOPPING -> COMPLETE) managed by the Charge Monitor component. SQLite WAL mode handles concurrent writes from MQTT and reads from Next.js without locking.

**Major components:**
1. **Custom Server** (`server.ts`) -- boots MQTT client + Next.js, single entry point for systemd
2. **MQTT Service** -- persistent connection to broker, subscribes to Shelly topics, publishes relay commands
3. **Event Bus** (EventEmitter) -- decouples producers (MQTT) from consumers (SSE, charge logic)
4. **SQLite Database** (WAL mode) -- persists plugs, profiles, reference curves, sessions, readings
5. **SSE Handler** -- streams real-time power data per plug to browser via ReadableStream
6. **Charge Monitor** -- state machine per plug, triggers DTW matching, SOC estimation, auto-stop
7. **Curve Matcher** -- subsequence DTW algorithm for device identification and curve position

### Critical Pitfalls

1. **MQTT QoS 0 unreliable for switch control** -- auto-stop command can be lost. Always use HTTP API fallback with verification: after MQTT `off`, check via HTTP `Switch.GetStatus` and retry if relay still on
2. **SSE buffering in Next.js** -- stream appears dead without `export const runtime = 'nodejs'` and `export const dynamic = 'force-dynamic'`. Test with `curl` before building UI
3. **SQLite WAL mode not enabled by default** -- concurrent reads/writes will deadlock. Enable WAL + busy_timeout on DB initialization
4. **MQTT disabled by default on Shelly** -- fresh devices publish nothing. Show setup instructions in UI, detect "online but no data" state
5. **ECharts memory leak with continuous data** -- implement sliding window (last 30 min) from day one, never accumulate unbounded data

## Implications for Roadmap

Based on research, suggested phase structure:

### Phase 1: Foundation (MQTT + Database + Server)
**Rationale:** Everything depends on MQTT connectivity and data persistence. The custom server pattern is the backbone -- without it, no other feature works.
**Delivers:** Working server process that connects to MQTT broker, receives Shelly data, stores readings in SQLite, and exposes Next.js routes. Plug management CRUD.
**Addresses:** Shelly Plug discovery/config, device registration
**Avoids:** Pitfall 1 (MQTT client per request), Pitfall 3 (WAL mode), Pitfall 4 (MQTT not enabled), Pitfall 8 (native build deps)
**Stack:** Custom server.ts, mqtt.js, better-sqlite3, Drizzle ORM, systemd service

### Phase 2: Real-Time Visualization
**Rationale:** You need visual feedback to validate MQTT data is correct before building charge intelligence on top of it. This phase makes the app usable as a power monitor.
**Delivers:** Dashboard with live power chart per plug, plug status overview (online/offline/relay state), manual relay control buttons.
**Addresses:** Live power display, relay on/off control, plug status
**Avoids:** Pitfall 2 (SSE buffering), Pitfall 6 (ECharts memory leak), Pitfall 7 (SSE connection limit)
**Stack:** SSE endpoints, ECharts 6 with dark theme, EventSource client

### Phase 3: Charge Intelligence
**Rationale:** This is the core value. Depends on Phases 1-2 being solid -- reference curve recording needs validated data flow, and DTW matching needs visual debugging via the chart overlay.
**Delivers:** Reference curve recording (learn mode), charge session state machine, DTW device detection, SOC estimation, auto-stop at target SOC, manual profile override.
**Addresses:** Reference curve recording, device profile management, automatic device detection, SOC estimation, auto-stop logic, partial charge detection
**Avoids:** Pitfall 5 (QoS 0 unreliable switch control -- HTTP fallback), Pitfall 9 (sparse Shelly data -- HTTP polling supplement)
**Stack:** DTW algorithm (custom ~50 line implementation), charge state machine, HTTP API fallback for relay control

### Phase 4: Notifications and History
**Rationale:** Polish features that enhance usability but do not block core value. Pushover is trivial to add once charge events exist. History needs session data to accumulate.
**Delivers:** Pushover notifications for charge events, charge history with stats/charts, data archival for old sessions, multi-plug dashboard layout.
**Addresses:** Pushover notifications, charge history, multi-plug dashboard
**Avoids:** Pitfall 13 (Pushover rate limits -- debounce notifications)
**Stack:** Native fetch for Pushover API, aggregation queries

### Phase Ordering Rationale

- Phase 1 validates the entire IoT pipeline (MQTT -> Server -> DB) before any UI work
- Phase 2 provides visual feedback needed to validate data quality before building algorithms on it
- Phase 3 is the core value delivery -- only possible with correct MQTT data and visual debugging of curves
- Phase 4 is polish that improves a working system, can be delivered incrementally

### Research Flags

Phases likely needing deeper research during planning:
- **Phase 3 (Charge Intelligence):** DTW subsequence matching thresholds, SOC estimation accuracy, state machine edge cases, and noise filtering all need empirical tuning with real Shelly data. Plan for an experimentation/calibration sub-phase.

Phases with standard patterns (skip research-phase):
- **Phase 1 (Foundation):** Custom server + MQTT + SQLite is thoroughly documented with concrete code examples in ARCHITECTURE.md
- **Phase 2 (Real-Time Visualization):** SSE + ECharts is a standard pattern. Implementation details fully specified in research
- **Phase 4 (Notifications and History):** Pushover is a single HTTP POST. History is standard CRUD + aggregation

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | All libraries verified current against npm/official docs. Versions confirmed March 2026 |
| Features | HIGH | Feature set derived from clear stakeholder requirements. Dependency chain is logical and complete |
| Architecture | HIGH | Custom server + MQTT singleton confirmed by multiple production implementations. Data model concrete with volume estimates |
| Pitfalls | HIGH | Sourced from official docs (Shelly MQTT defaults, SQLite WAL), Next.js community issues (SSE buffering), established IoT patterns |

**Overall confidence:** HIGH

### Gaps to Address

- **DTW tuning parameters:** Confidence threshold for auto-detection (currently 20% power tolerance for quick rejection), DTW distance normalization, smoothing window size -- all need validation with real Shelly data during Phase 3
- **Partial charge accuracy:** Subsequence DTW for partial charge detection (plugging in at 40%) is theoretically sound but has no off-the-shelf reference implementation for AC-side power monitoring. Plan for Phase 3 to include calibration time
- **Shelly status update frequency:** Exact conditions under which Shelly publishes vs. stays silent during constant-power phases -- needs hands-on testing in Phase 1. HTTP polling supplement documented as mitigation
- **Shelly firmware variations:** Different firmware versions may change MQTT payload structure or timing. Document and pin the tested firmware version
- **better-sqlite3 native build on Debian 13:** Should work with build-essential, but verify on fresh LXC during Phase 1 setup

## Sources

### Primary (HIGH confidence)
- [Shelly Gen2 MQTT Documentation](https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/Mqtt/) -- topic structure, payload format, QoS behavior
- [Shelly Switch Component](https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/Switch/) -- relay control, status fields
- [Shelly Plug S Gen3 API](https://shelly-api-docs.shelly.cloud/gen2/Devices/Gen3/ShellyPlugSG3/) -- device-specific capabilities
- [Drizzle ORM SQLite](https://orm.drizzle.team/docs/get-started-sqlite) -- better-sqlite3 integration, v0.45.1
- [SQLite WAL Mode](https://www.sqlite.org/wal.html) -- concurrent access pattern
- [mqtt.js npm](https://www.npmjs.com/package/mqtt) -- v5.15.1, TypeScript MQTT client
- [better-sqlite3 npm](https://www.npmjs.com/package/better-sqlite3) -- v12.8.0, native bindings
- [ECharts 6.0 Release](https://echarts.apache.org/handbook/en/basics/release-note/v6-feature/) -- streaming, intelligent dark mode
- [Pushover API](https://pushover.net/api) -- endpoint, rate limits

### Secondary (MEDIUM confidence)
- [Next.js SSE Discussion #48427](https://github.com/vercel/next.js/discussions/48427) -- SSE buffering workarounds, community reports
- [MQTT + Next.js Architecture](https://jowwii.medium.com/building-real-time-mqtt-visualizations-with-next-js-why-i-went-with-a-7-vps-instead-of-serverless-94e3ad889bb8) -- custom server pattern validation
- [Next.js Worker Alongside Server](https://dev.to/noclat/run-a-worker-alongside-next-js-server-using-a-single-command-5a44) -- single-process pattern
- [SSE in Next.js App Router](https://www.pedroalonso.net/blog/sse-nextjs-real-time-notifications/) -- implementation pattern
- [DTW for NILM](https://www.sciencedirect.com/science/article/abs/pii/S0306261917302209) -- academic validation of curve matching approach
- [SSE streaming in Next.js 15](https://hackernoon.com/streaming-in-nextjs-15-websockets-vs-server-sent-events) -- SSE vs WebSocket comparison
- [echarts-for-react npm](https://www.npmjs.com/package/echarts-for-react) -- v3.0.6, React wrapper
- [ECharts streaming docs](https://deepwiki.com/apache/echarts/2.4-streaming-and-scheduling) -- memory management

---
*Research completed: 2026-03-25*
*Ready for roadmap: yes*
