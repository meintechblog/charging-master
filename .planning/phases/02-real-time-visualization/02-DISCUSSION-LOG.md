# Phase 2: Real-Time Visualization - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-03-25
**Phase:** 2-Real-Time Visualization
**Areas discussed:** Live Chart Design, Relay Control UX, Dashboard Refresh, Chart Interaction

---

## Live Chart Design

| Option | Description | Selected |
|--------|-------------|----------|
| Smooth Area Chart | Gefuellte Flaeche unter Linie, Gradient | yes (Claude's choice) |
| Clean Line Chart | Nur Linie, minimalistisch | |
| Stepped Line | Treppenstufen, technischer Look | |

**User's choice:** "So wie es fuer den Use Case am geilsten ist entscheide du"
**Notes:** Claude chose Smooth Area Chart — best for monitoring dashboards

| Option | Description | Selected |
|--------|-------------|----------|
| Electric Blue | Klassisch fuer Energie | |
| Green | Laden/Energie Assoziation | |
| Cyan | Modern, futuristisch | |
| Du entscheidest | Claude waehlt | yes |

**User's choice:** "Du entscheidest"

| Option | Description | Selected |
|--------|-------------|----------|
| Letzte 5 Minuten | Kompakt | |
| Letzte 15 Minuten | Guter Ueberblick | |
| Letzte 30 Minuten | Mehr Kontext | |
| Umschaltbar | 5m/15m/30m/1h Buttons | yes |

**User's choice:** Umschaltbar

---

## Relay Control UX

| Option | Description | Selected |
|--------|-------------|----------|
| Toggle im Plug Card | Ein Klick, schnell | yes (Claude's choice) |
| Toggle + Bestaetigung | Mit Dialog | |
| Dedicated Button | Separater Power-Button | |

**User's choice:** "Kein Plan wie es am geilsten ist. Entscheide du."
**Notes:** Claude chose Toggle im Card — schnellste UX

| Option | Description | Selected |
|--------|-------------|----------|
| Optimistic Update | Sofort, korrigiert bei Fehler | |
| Wait for Confirmation | Warten auf MQTT | |
| Optimistic + Spinner | Sofort + Spinner bis Bestaetigung | yes |

**User's choice:** Optimistic + Spinner

---

## Dashboard Refresh

| Option | Description | Selected |
|--------|-------------|----------|
| Ein globaler SSE Stream | Alle Plugs, Client-seitig gefiltert | yes (Claude's choice) |
| SSE pro Plug | Isolierter, mehr Connections | |
| Du entscheidest | Claude waehlt | |

**User's choice:** "Du entscheidest"
**Notes:** Claude chose globaler SSE Stream

Plug Card Live-Elemente (multi-select):
- Aktueller Watt-Wert: yes
- Relay Status: yes
- Online/Offline: yes
- Mini-Sparkline: yes

**User's choice:** Alle 4 ausgewaehlt

---

## Chart Interaction

Interaktionen (multi-select):
- Hover Tooltip: yes
- Zoom & Pan: yes
- Zeitfenster-Buttons: yes (already decided)
- Fullscreen: yes

**User's choice:** Alle 4 ausgewaehlt

| Option | Description | Selected |
|--------|-------------|----------|
| Click auf Card -> Detail | Plug Card oeffnet Detail-Ansicht | yes (Claude's choice) |
| Chart unter Cards | Immer sichtbar, Dropdown-Auswahl | |
| Beides | Chart sichtbar + Card-Focus | |

**User's choice:** "Entscheide du, wie es im Geiste ist."
**Notes:** Claude chose Click Card -> Detail — intuitivstes Pattern

---

## Claude's Discretion

- Chart style (Smooth Area), color, relay toggle design, SSE architecture, navigation pattern
- User delegated most visual/UX decisions to Claude

## Deferred Ideas

None
