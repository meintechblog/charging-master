# Phase 1: Foundation - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-03-25
**Phase:** 1-Foundation
**Areas discussed:** App Layout / Navigation, Settings UI, Plug Management, Data Persistence

---

## App Layout / Navigation

| Option | Description | Selected |
|--------|-------------|----------|
| Sidebar + Content | Linke Sidebar mit Navigation, Content rechts — klassisch, skaliert gut | yes |
| Top-Nav + Content | Horizontale Navigation oben, Content darunter — einfacher | |
| Tab-basiert | Tabs am oberen Rand — kompakt, mobile-friendly | |

**User's choice:** Sidebar + Content
**Notes:** None

| Option | Description | Selected |
|--------|-------------|----------|
| Plug-Uebersicht als Cards | Jeder Shelly Plug als Card mit Status, Watt, Relay | yes |
| Live-Chart zentral | Grosser Chart im Mittelpunkt, Plug-Liste daneben | |
| Kombination | Oben Cards, darunter Chart des ausgewaehlten Plugs | |

**User's choice:** Plug-Uebersicht als Cards
**Notes:** None

| Option | Description | Selected |
|--------|-------------|----------|
| Sleek Minimal | Dunkle Flaechen, wenig Rahmen, subtile Schatten — a la Vercel/Linear | yes |
| Neon Accent | Dunkler Hintergrund mit kraeftigen Akzentfarben | |
| Industrial | Dunkelgrau mit harten Kanten, Monospace — technisch | |

**User's choice:** Sleek Minimal
**Notes:** None

---

## Settings UI

| Option | Description | Selected |
|--------|-------------|----------|
| Eigene Seite mit Sections | Dedizierte /settings Seite mit Abschnitten | yes |
| Sidebar-Panel | Settings als ausklappbares Panel in der Sidebar | |
| Modal/Drawer | Settings als Modal oder Slide-in Drawer | |

**User's choice:** "sag du wie es am coolsten ist"
**Notes:** Claude decided: Dedicated /settings page with sections — best fit for sidebar layout

| Option | Description | Selected |
|--------|-------------|----------|
| Auto-Save | Jede Aenderung sofort gespeichert | yes |
| Save-Button | Explizit speichern | |
| Auto-Save + Undo | Sofort speichern mit Undo-Toast | |

**User's choice:** Auto-Save
**Notes:** None

| Option | Description | Selected |
|--------|-------------|----------|
| Ja, Test-Button | Button der MQTT-Verbindung testet | yes |
| Nein, Status reicht | Connection-Status im Dashboard | |

**User's choice:** Ja, Test-Button
**Notes:** None

---

## Plug Management

| Option | Description | Selected |
|--------|-------------|----------|
| IP-Adresse eingeben | User gibt IP ein, App holt Device-Info via HTTP | |
| MQTT Topic manuell | User gibt Topic-Prefix ein | |
| Beides anbieten | IP-basiert als Default, MQTT-Topic als Advanced | |

**User's choice:** MQTT Auto-Discovery (free text)
**Notes:** User suggested auto-discovery on MQTT broker — subscribe, find Shellys, present as selection list with names and switches. Manual entry as fallback.

| Option | Description | Selected |
|--------|-------------|----------|
| Name / Alias | Benutzerfreundlicher Name | yes |
| Standard-Ladeprofil | Default-Profil fuer Auto-Match Fallback | yes |
| Polling-Intervall | Wie oft Power-Daten gelesen werden | yes |
| Aktiviert/Deaktiviert | Plug temporaer deaktivieren | yes |

**User's choice:** All options selected
**Notes:** User didn't fully understand Standard-Ladeprofil — explained as Phase 3 default profile for when auto-detection doesn't match.

---

## Data Persistence

| Option | Description | Selected |
|--------|-------------|----------|
| Jede Sekunde | Maximale Aufloesung, 86.400/Tag | |
| Alle 5 Sekunden | Guter Kompromiss, 17.280/Tag | |
| Dynamisch | 1s waehrend Laden, 30s im Leerlauf | yes (modified) |

**User's choice:** Dynamic — 5s during charging, 1-2min during idle
**Notes:** User adjusted the dynamic option: 5s is granular enough during charging, 1-2 min during idle since nothing happens.

| Option | Description | Selected |
|--------|-------------|----------|
| Ja, nach 30 Tagen | Raw loeschen, Sessions behalten | |
| Nein, alles behalten | Kein Cleanup | |
| Du entscheidest | Claude waehlt Default | |

**User's choice:** Aggregation after 30 days (free text)
**Notes:** User suggested aggregating older data (>30 days) to minute averages instead of deleting. Keep everything, just compress.

---

## Claude's Discretion

- Settings page organization (user said "sag du wie es am coolsten ist")

## Deferred Ideas

None — discussion stayed within phase scope
