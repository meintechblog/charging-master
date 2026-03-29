# Phase 4: Notifications & History - Context

**Gathered:** 2026-03-29
**Status:** Ready for planning

<domain>
## Phase Boundary

Phase 4 delivers Pushover notifications for charge events and a charge session history with detail views. Users get notified about important events (device detected, target reached, errors) and can review past charging sessions with curves, stats, and event logs.

Requirements: NOTF-01, NOTF-02, NOTF-03, NOTF-04, HIST-01, HIST-02, HIST-03

</domain>

<decisions>
## Implementation Decisions

### Pushover-Nachrichten
- **D-40:** Alle 4 Events lösen Notifications aus: Ladevorgang erkannt, Ziel-SOC erreicht, Fehler, Lernvorgang abgeschlossen.
- **D-41:** Differenzierte Prioritäten: Normal (0) für Erkennung/Abschluss/Lernvorgang, Hoch (1) für Fehler (Alarm-Sound).
- **D-42:** Pushover Credentials bereits in Settings gespeichert (Phase 1: SETT-02). Notifications nur senden wenn Credentials konfiguriert sind.

### Lade-Historie UI
- **D-43:** History-Layout und Filter: Claude's Discretion — sinnvolles Layout (Tabelle oder Cards) mit sinnvollen Filtern (Gerät, Zeitraum, Status).
- **D-44:** Sidebar-Link "Verlauf" aktivieren (aktuell `disabled: true`).

### Session-Details
- **D-45:** Session-Detail zeigt alles: Ladekurve nachträglich (aus power_readings), Referenz-Overlay (Session + Referenzkurve übereinander), Stats-Übersicht (Start/Ende, Dauer, Energie, SOC, Profil, Plug), Ereignis-Log (State-Übergänge als Timeline).
- **D-46:** Profil-Seite zeigt letzte Sessions dieses Profils als zusätzliche Section.

### Claude's Discretion
- History-Seite Layout (Tabelle vs. Cards vs. hybrid)
- Filter-Kombination und Darstellung
- Pushover-Nachrichtentext und Formatierung
- Ereignis-Log Darstellung (Timeline, Liste, Badges)

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Existing Code
- `src/components/settings/pushover-settings.tsx` — Pushover Credentials UI (bereits gebaut)
- `src/db/schema.ts` — chargeSessions Tabelle mit state, startedAt, stoppedAt, energyWh, profileId
- `src/modules/charging/charge-monitor.ts` — emitChargeEvent für State-Übergänge
- `src/modules/events/event-bus.ts` — EventBus mit charge:* Events
- `src/app/api/sse/power/route.ts` — SSE Streaming Pattern
- `src/app/profiles/[id]/page.tsx` — Profil-Detail (Sessions-Section hier hinzufügen)
- `src/components/layout/sidebar.tsx` — Verlauf-Link disabled, muss aktiviert werden
- `src/components/charts/power-chart.tsx` — PowerChart mit referenceData Overlay-Support

### Prior Phase Decisions
- `.planning/phases/01-foundation/01-CONTEXT.md` — D-05 (Auto-Save), D-06 (MQTT Test)
- `.planning/phases/02-real-time-visualization/02-CONTEXT.md` — D-13 (Smooth Area Chart), D-19 (Global SSE)
- `.planning/phases/03-charge-intelligence/03-CONTEXT.md` — D-28 (Server-seitig persistent)

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `power-chart.tsx` — Hat bereits referenceData Overlay (dashed gray line)
- `event-bus.ts` — Hat emitChargeState, kann für Notification-Trigger genutzt werden
- `charge-monitor.ts` — Emittiert bereits charge:* Events bei jedem State-Übergang
- Pushover Settings in DB (pushover.userKey, pushover.apiToken)

### Established Patterns
- SSE für Real-time Events
- Server Components für Seiten, Client Components für Interaktion
- Drizzle ORM Queries
- force-dynamic auf allen DB-lesenden Pages

### Integration Points
- Neuer NotificationService: Hört auf charge:* Events, sendet Pushover
- Neue /history Seite + /history/[sessionId] Detail
- Sidebar: Verlauf-Link aktivieren
- Profil-Detail: Sessions-Section ergänzen

</code_context>

<specifics>
## Specific Ideas

- NotificationService als einfache Klasse in server.ts — hört auf EventBus charge:* Events, liest Pushover Credentials aus DB, sendet HTTP POST an Pushover API
- Session-Detail Page: Oben Stats-Cards (wie Profil-Detail), darunter Chart mit Referenz-Overlay, darunter Ereignis-Log als vertikale Timeline mit State-Badges
- History-Tabelle mit Sparklines pro Session (Mini-Vorschau der Ladekurve)
- Profil-Detail: Letzte 5-10 Sessions als kompakte Liste mit Link zur vollen Session-Detail

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 04-notifications-history*
*Context gathered: 2026-03-29*
