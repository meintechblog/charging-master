# Phase 3: Charge Intelligence - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-03-26
**Phase:** 3-Charge Intelligence
**Areas discussed:** Learn Mode UX, Profil-Management, Auto-Erkennung UX, Auto-Stopp Verhalten

---

## Learn Mode UX

| Option | Description | Selected |
|--------|-------------|----------|
| Button auf Devices-Seite | Einfacher Start-Button | |
| Wizard / Step-by-Step | Gefuehrter Prozess | yes |
| Du entscheidest | Claude waehlt | |

**User's choice:** Wizard / Step-by-Step

| Option | Description | Selected |
|--------|-------------|----------|
| Live-Chart + Fortschritt | Echtzeit-Kurve, Wh-Zaehler, Zeit | yes |
| Minimal-Anzeige | Nur Badge auf Card | |
| Beides | Badge + Chart Detail | |

**User's choice:** Live-Chart + Fortschritt

| Option | Description | Selected |
|--------|-------------|----------|
| Auto-Erkennung + Bestaetigung | Ladeende erkennen, Dialog zeigen | yes |
| Voll-Automatisch | Sofort speichern | |
| Manueller Stop | User klickt Stop | |

**User's choice:** Auto-Erkennung + Bestaetigung
**Notes:** User betonte: Learn Mode MUSS server-seitig laufen, persistent ueber Browser-Sessions. App kann geschlossen werden, Aufzeichnung laeuft weiter. Stunden-lange Ladevorgaenge moeglich.

---

## Profil-Management

| Option | Description | Selected |
|--------|-------------|----------|
| Eigene /profiles Seite | Dediziert in Sidebar | yes |
| In der Devices-Seite | Tab neben Geraeten | |
| Du entscheidest | Claude waehlt | |

**User's choice:** Eigene /profiles Seite

Konfigurierbare Attribute (multi-select):
- Name + Beschreibung: yes
- Ziel-SOC: yes (via 10%-Schritte Buttons)
- Referenzkurve anzeigen: yes
- Profil neu anlernen: yes

**User's choice:** Alle ausgewaehlt + erweiterte optionale Felder (Modellbezeichnung, Kaufdatum, Ladezyklen)
**Notes:** User hat Idee fuer v2: Community-Bibliothek fuer Profile ueber GitHub-Repo. Erweiterte Attribute (Modell, Kaufdatum, Zyklen) vorbereiten fuer spaetere Export/Import. Bild-Upload deferred.

| Option | Description | Selected |
|--------|-------------|----------|
| Slider 0-100% | Stufenlos | |
| 10%-Schritte Buttons | Passend zu SOC-Grenzen | yes |
| Dropdown | Vordefinierte Werte | |

**User's choice:** 10%-Schritte Buttons

---

## Auto-Erkennung UX

| Option | Description | Selected |
|--------|-------------|----------|
| Banner + Auto-Start | Banner mit Override-Buttons | yes |
| Dialog / Modal | Fragt vor dem Start | |
| Silent + Notification | Automatisch ohne UI | |

**User's choice:** Banner + Auto-Start, mit jederzeit Eingriff moeglich (Profil wechseln, SOC aendern, abbrechen)

| Option | Description | Selected |
|--------|-------------|----------|
| Dropdown in Banner | Inline Profil-Wechsel | |
| Profil-Auswahl Page | Link zu separater Seite | |
| Du entscheidest | Claude waehlt | yes |

**User's choice:** Du entscheidest

| Option | Description | Selected |
|--------|-------------|----------|
| Anlernen anbieten | "Jetzt anlernen?" Button | yes (erweitert) |
| Ignorieren + Loggen | Kein Eingriff | |
| Manuell zuweisen | Profil-Dropdown | |

**User's choice:** Anlernen anbieten ODER bestehendes Profil zuweisen. Wenn bestehendes Profil zugewiesen wird, soll die Kurve als zusaetzlicher Datenpunkt fuer bessere Erkennung gespeichert werden.

---

## Auto-Stopp Verhalten

| Option | Description | Selected |
|--------|-------------|----------|
| Warnung bei 90% des Ziels | Vorwarnung + Notification | |
| Nur beim Stopp | Direkt Relay aus | |
| Countdown | Letzte 5% visuell + Stopp | yes |

**User's choice:** Countdown

| Option | Description | Selected |
|--------|-------------|----------|
| HTTP Fallback + Alarm | Sofort HTTP, dann Alarm | |
| Retry 3x + Alarm | 3x MQTT, HTTP, Alarm | |
| Du entscheidest | Sicherste Strategie | yes |

**User's choice:** Du entscheidest

| Option | Description | Selected |
|--------|-------------|----------|
| Ja, roter Button | Grosser Notfall-Button | |
| Relay Toggle reicht | Bestehender Toggle | yes |
| Beides | Toggle + extra Button | |

**User's choice:** Relay Toggle reicht

---

## Claude's Discretion

- Override UI Layout
- Relay failure strategy
- DTW implementation details
- Charge state machine design

## Deferred Ideas

- Profile community library via GitHub (v2)
- Profile image upload (v2)
- Multiple reference curves per profile (v2)
