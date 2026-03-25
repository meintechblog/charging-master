# Phase 1: Foundation - Context

**Gathered:** 2026-03-25
**Status:** Ready for planning

<domain>
## Phase Boundary

Phase 1 delivers the infrastructure backbone: Next.js custom server with persistent MQTT client, SQLite database (Drizzle ORM, WAL mode), Shelly S3 Plug discovery and management, and a settings page for MQTT broker and Pushover configuration. No charging intelligence, no charts, no notifications — just reliable data flow from Shelly to database and a functional management UI.

Requirements: SHLY-01, SHLY-02, SHLY-03, SHLY-05, SHLY-06, SETT-01, SETT-02, SETT-03

</domain>

<decisions>
## Implementation Decisions

### App Layout / Navigation
- **D-01:** Sidebar + Content layout. Left sidebar with navigation (Dashboard, Devices, Settings, History), content area right.
- **D-02:** Dashboard shows Plug-Uebersicht as Cards — each Shelly Plug as a card with status, current watt value, relay state.
- **D-03:** Dark theme in "Sleek Minimal" style — dark surfaces, minimal borders, subtle shadows, a la Vercel/Linear.

### Settings UI
- **D-04:** Dedicated /settings page with sections (MQTT, Pushover, Allgemein). Fits well with sidebar navigation.
- **D-05:** Auto-Save — every change saves immediately, no explicit save button needed.
- **D-06:** MQTT connection test button in settings — tests broker connectivity and shows result inline.

### Plug Management
- **D-07:** MQTT Auto-Discovery as primary method. App subscribes to broker, finds Shelly devices by their topic patterns, presents selection list with device names and switches. User picks from list to add.
- **D-08:** Manual IP/Topic entry as fallback (advanced option) if auto-discovery fails.
- **D-09:** Per-Plug configuration: Name/Alias (custom label), Polling interval, Enabled/Disabled toggle, Default charging profile (prepared for Phase 3).

### Data Persistence
- **D-10:** Dynamic sampling rate: 5s interval during active charging, 1-2 min interval during idle/standby. Transition triggered by power threshold.
- **D-11:** Data aggregation after 30 days: raw readings compressed to minute-averages. Session metadata and aggregated data kept indefinitely. Full history preserved, just more compact.
- **D-12:** SQLite with WAL mode, write queue to prevent SQLITE_BUSY from concurrent MQTT writes and UI reads.

### Claude's Discretion
- Settings page organization and section layout (D-04 — user said "sag du wie es am coolsten ist")
- CSS framework choice (Tailwind assumed, but flexible)
- Exact power threshold for idle vs. active sampling transition
- MQTT discovery topic pattern strategy

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Shelly S3 Plug
- `.planning/research/STACK.md` — Shelly Gen3 MQTT API reference (topics, payloads, switch commands)
- `.planning/research/ARCHITECTURE.md` — Custom server pattern, MQTT singleton, EventEmitter bus, SSE streaming
- `.planning/research/PITFALLS.md` — MQTT reconnection bugs, SQLite WAL mode, Shelly Gen3 vs Gen1 format differences

### Project Context
- `.planning/PROJECT.md` — Shelly S3 Plug IP (192.168.3.167), MQTT broker (mqtt-master.local), constraints
- `.planning/REQUIREMENTS.md` — Phase 1 requirements (SHLY-01..06, SETT-01..03)

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- None — greenfield project, only README.md exists

### Established Patterns
- None yet — Phase 1 establishes the foundational patterns

### Integration Points
- MQTT broker at mqtt-master.local (no auth)
- Shelly S3 Plug at 192.168.3.167 (HTTP API for fallback, MQTT for primary)
- Deployment target: charging-master.local (fresh Debian LXC, ssh root@charging-master.local)

</code_context>

<specifics>
## Specific Ideas

- Auto-Discovery: Subscribe to MQTT broker, find Shellys by topic pattern (e.g. `shelly*/status/#`), present as selectable list with device names and switch info
- Plug Cards on Dashboard: Each card shows device name, online/offline status, current power (W), relay state — at a glance
- Settings: Clean sections for MQTT (host, port, credentials, test button) and Pushover (user key, API token)
- User knows the Netzbetreiber-Master project (Next.js 15, Drizzle ORM, similar stack) — can reference familiar patterns

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 01-foundation*
*Context gathered: 2026-03-25*
