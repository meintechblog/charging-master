# Phase 2: Real-Time Visualization - Context

**Gathered:** 2026-03-25
**Status:** Ready for planning

<domain>
## Phase Boundary

Phase 2 delivers live power visualization and manual relay control. Users see real-time power consumption charts (ECharts via SSE streaming), plug cards with live data updates, and can toggle Shelly relays from the dashboard. No charging intelligence, no device profiles, no notifications — just live monitoring and manual control.

Requirements: VIZL-01, VIZL-02, VIZL-04, SHLY-04

</domain>

<decisions>
## Implementation Decisions

### Live Chart Design
- **D-13:** Smooth Area Chart with gradient fill (accent color to transparent). Best for monitoring use case — visually engaging and shows power trends clearly.
- **D-14:** Akzentfarbe: Claude's Discretion — passend zum Sleek Minimal Dark Theme, gut lesbar auf dark background.
- **D-15:** Zeitfenster umschaltbar mit Buttons: 5m / 15m / 30m / 1h. Default: 15m.
- **D-16:** ECharts mit dark theme, smooth animations, streaming-optimiert. Sliding window um Memory Leaks zu verhindern.

### Relay Control UX
- **D-17:** Toggle Switch direkt im Plug Card — ein Klick, kein Bestaetigungsdialog. Schnell und intuitiv.
- **D-18:** Optimistic Update + Spinner: UI schaltet sofort um, kurzer Spinner bis MQTT-Bestaetigung kommt. Bei Fehler Rollback mit Error-Toast.

### Dashboard Live Updates
- **D-19:** Ein globaler SSE Stream fuer alle Plugs. Events nach Plug-ID im Client gefiltert. Weniger Server-Connections, einfacher zu managen.
- **D-20:** Plug Card Live-Elemente: Aktueller Watt-Wert (mit Animation), Relay Status (farbiger Indikator), Online/Offline Status, Mini-Sparkline (letzte paar Minuten).
- **D-21:** Click auf Plug Card oeffnet Detail-Ansicht mit grossem Chart. Intuitive Card-to-Detail Navigation.

### Chart Interaction
- **D-22:** Hover Tooltip mit exaktem Watt-Wert + Timestamp.
- **D-23:** Zoom & Pan horizontal (reinzoomen in Zeitbereiche).
- **D-24:** Fullscreen-Modus fuer detaillierte Analyse.

### Claude's Discretion
- Chart-Akzentfarbe (D-14)
- Relay Toggle Design (D-17 — user said "entscheide du, wie es am geilsten ist")
- SSE-Architektur (D-19 — user said "du entscheidest")
- Card-to-Detail Navigation Pattern (D-21 — user said "wie es im Geiste ist")
- ECharts-Konfiguration und Animationen
- Sparkline-Dauer in Cards (letzte 3-5 Minuten?)
- Default Zeitfenster (15m vorgeschlagen)

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Real-Time Streaming
- `.planning/research/ARCHITECTURE.md` — SSE via Next.js Route Handlers (ReadableStream), EventBus integration
- `.planning/research/STACK.md` — ECharts 6, echarts-for-react 3.0.6, SSE browser EventSource API
- `.planning/research/PITFALLS.md` — ECharts memory leaks with sliding window, SSE buffering issues

### Existing Code (Phase 1)
- `src/modules/events/event-bus.ts` — EventBus with typed events (emitPowerReading)
- `src/modules/mqtt/mqtt-service.ts` — MQTT singleton, power data persistence
- `src/components/devices/plug-card.tsx` — Existing plug card (needs live data + relay toggle)
- `src/components/layout/sidebar.tsx` — Sidebar with MQTT status
- `src/db/schema.ts` — Database schema (plugs, power_readings tables)

### Phase 1 Decisions
- `.planning/phases/01-foundation/01-CONTEXT.md` — D-01 (Sidebar), D-02 (Cards), D-03 (Dark Theme), D-10 (Sampling)

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `plug-card.tsx` — Existing plug card component, needs extension with live watt value, relay toggle, sparkline
- `event-bus.ts` — Already has `emitPowerReading` event type, ready for SSE consumers
- `mqtt-service.ts` — Singleton with `subscribeToPlug()`, `publishCommand()` for relay control
- `sidebar.tsx` — Has MQTT status indicator (static prop, needs SSE connection)
- `app-shell.tsx` — Sidebar + content wrapper, reuse as-is

### Established Patterns
- Tailwind v4 dark-only theme with neutral-950/900/800 palette
- Drizzle ORM for DB queries
- Next.js App Router with server components and client components ("use client")
- API routes in `src/app/api/`

### Integration Points
- SSE endpoint: New `/api/sse/power` route consuming EventBus events
- Relay control: New `/api/devices/[id]/relay` route calling mqtt-service.publishCommand()
- Chart data: Query `power_readings` table for historical data, SSE for real-time
- Plug detail page: New `/devices/[id]` route with full chart

</code_context>

<specifics>
## Specific Ideas

- Mini-Sparkline in Plug Cards: Tiny line chart showing last few minutes, gives context without opening detail
- Fullscreen chart: ECharts toolbox with fullscreen button, maybe also a dedicated "expand" icon on the chart container
- Watt-Wert Animation: Counter-style animation when value changes (like a ticker)
- Relay Toggle: Small toggle switch with green (on) / gray (off) states, spinner overlay during transition

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 02-real-time-visualization*
*Context gathered: 2026-03-25*
