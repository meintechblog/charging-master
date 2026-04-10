# Charging-Master

## What This Is

Eine Web-App, die Ladevorgaenge von Akkus (E-Bike, iPad, etc.) ueber Shelly S3 Plugs intelligent steuert. Der User kann Geraete anlernen (Referenz-Ladekurve aufzeichnen), ein Lade-Ziel in Prozent festlegen, und die App stoppt den Ladevorgang automatisch beim gewuenschten SOC. Die App erkennt angeschlossene Geraete automatisch anhand ihrer charakteristischen Ladekurve und benachrichtigt den User via Pushover.

## Core Value

Der Akku wird automatisch beim gewuenschten SOC-Level gestoppt — kein manuelles Nachschauen, kein Ueberladen, laengere Akku-Lebensdauer.

## Current Milestone: v1.2 Self-Update

**Goal:** In-App-Update-Mechanismus, der neue Versionen aus dem GitHub-Repo automatisch erkennt und auf Knopfdruck einspielt — mit sauberem Restart und Auto-Rollback bei Fehler.

**Target features:**
- Versions-Awareness: App kennt ihren eigenen Commit-SHA und Build-Zeitpunkt
- Background-Check alle 6h gegen GitHub API (`/repos/meintechblog/charging-master/commits/main`)
- UI-Indicator in Settings: aktuelle Version, letzter Check, "Update verfügbar"-Badge
- Update-Button stößt dedizierte `charging-master-updater.service` systemd-Unit an
- Updater-Pipeline: git fetch/reset → pnpm install → pnpm build → systemctl restart
- Auto-Rollback auf vorherigen HEAD-SHA bei Fehler in beliebigem Schritt
- Live-Log des laufenden Updates in der UI (SSE-Stream aus journalctl)
- Browser-Reconnect nach Restart: UI pollt `/api/version` bis neue Version antwortet, dann Auto-Reload

## Requirements

### Validated

- Shelly S3 Plug Integration via MQTT (Leistungsdaten lesen) — Phase 1 (v1.0, wird in v1.1 durch HTTP ersetzt)
- Mehrere Shelly Plugs parallel unterstuetzen — Phase 1
- MQTT-Broker konfigurierbar (Host, Port, optional Credentials) — Phase 1 (v1.0, wird in v1.1 entfernt)
- Dashboard mit Uebersicht aller aktiven Ladevorgaenge (Plug Cards) — Phase 1

### Active

- [ ] Ladekurve grafisch darstellen (Echtzeit + Referenz-Overlay)
- [ ] Shelly Relay manuell steuern (Switch ein/aus)
- [ ] Geraeteprofil anlernen: Kompletten Ladezyklus aufzeichnen und als Referenz-Ladekurve speichern
- [ ] SOC-Grenzen automatisch aus Referenz-Ladekurve ableiten (10%-Schritte)
- [ ] Automatische Geraeteerkennung via Kurven-Matching (erste 1-2 Min des Ladevorgangs)
- [ ] Manuelles Uebersteuern des erkannten Profils jederzeit moeglich
- [ ] Lade-Ziel pro Geraeteprofil konfigurierbar (z.B. 80%)
- [ ] Automatischer Ladestopp bei Erreichen des Ziel-SOC (Shelly Switch aus)
- [ ] Erkennung Ladevorgang-Ende (Leistung sinkt auf ~0W)
- [ ] Pushover-Benachrichtigungen (Ladestart, Geraeteerkennung, Ladestopp, Abbruch)
- [ ] Ladehistorie pro Geraet

### Out of Scope

- Multi-User / Authentifizierung — Single-User App im lokalen Netz
- Andere Smart-Plug-Marken (Tasmota, TP-Link) — spaeter moeglich, v1 nur Shelly S3
- Mobile App — Web-App reicht, responsive Design
- Cloud-Anbindung — alles lokal auf LXC
- DC-seitige Messung — nur AC-Leistung via Shelly verfuegbar
- Energiekosten-Tracking — nicht im Scope fuer v1

## Context

### Problem

Ladegeraete laden Akkus standardmaessig auf 100%. Fuer die Langlebigkeit waere 80% optimal. Der User muesste staendig den Ladestand pruefen und manuell abstecken. Ein Shelly S3 Plug zwischen Steckdose und Ladegeraet liefert AC-Leistungsdaten und einen schaltbaren Relay.

### Physikalischer Hintergrund

Waehrend des Ladevorgangs steigt die Spannung auf DC-Seite (Akku), die Stromstaerke bleibt konstant (CC-Phase), dann sinkt der Strom bei konstanter Spannung (CV-Phase). Auf AC-Seite spiegelt sich das in einer charakteristischen Leistungskurve wider. Diese Kurve ist geraetespezifisch und kann als Fingerprint genutzt werden.

### Herausforderung: Teilladungen

Der Akku ist nicht immer bei 0% wenn er angeschlossen wird. Bei Wiederkehrenden Ladevorgaengen muss die App die aktuelle Position auf der Referenzkurve finden, basierend auf der aktuellen Leistung und dem Kurvenverlauf.

### MQTT-Infrastruktur

Bestehender MQTT-Broker auf mqtt-master.local (ohne Authentifizierung). Shelly S3 Plug publisht Leistungsdaten auf MQTT-Topics. Die App subscribed und steuert den Switch per MQTT-Publish.

### Shelly S3 Plug

- **IP-Adresse**: 192.168.3.167
- **Web-UI**: http://192.168.3.167
- **HTTP API**: http://192.168.3.167/rpc/Switch.Set, /rpc/Shelly.GetStatus, etc.
- **MQTT Topics**: Muessen noch ermittelt werden (abhaengig von Device-ID/Konfiguration)

### Deployment-Ziel

Frischer Debian LXC Container unter charging-master.local. Zugang: `ssh root@charging-master.local`. Node.js und alles weitere muss installiert werden.

## Constraints

- **Deployment**: Debian LXC Container (charging-master.local), Root-Zugang via SSH
- **Smart Plug**: Shelly S3 Plug (Gen3 API, MQTT-faehig)
- **Kommunikation**: HTTP-API direkt zu Shelly Plugs (kein Broker noetig)
- **Datenbank**: SQLite (kein DB-Server, Single-User, Performance)
- **Design**: Modernes Dark Theme, sexy Echtzeit-Charts
- **Netzwerk**: Lokales Netz fuer Shelly-Kommunikation; Internet-Zugang fuer GitHub/npm zum Self-Update erforderlich
- **Single-User**: Keine Authentifizierung
- **Charts**: Apache ECharts — Echtzeit-Streaming, Smooth Animations, Overlay-Support

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Next.js 15 als Framework | Bewaeht, User kennt es, Server Components + API Routes, gutes React-Oekosystem | -- Pending |
| SQLite statt PostgreSQL | Single-User, kein DB-Server noetig, perfekte Performance, zero Setup auf LXC | -- Pending |
| Apache ECharts fuer Charts | Beste Echtzeit-Faehigkeit, Smooth Animations, Overlay-Support, sexiest Charts | -- Pending |
| MQTT als primaere Kommunikation | Echtzeit-Push statt Polling, Shelly S3 unterstuetzt MQTT nativ | -- Pending |
| Kurven-Matching fuer Geraeteerkennung | Genauer als reines Leistungs-Matching, nutzt die ersten 1-2 Min des Ladevorgangs | -- Pending |
| Pushover fuer Notifications | Einfach, zuverlaessig, User hat es bereits im Einsatz | -- Pending |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd:transition`):
1. Requirements invalidated? -> Move to Out of Scope with reason
2. Requirements validated? -> Move to Validated with phase reference
3. New requirements emerged? -> Add to Active
4. Decisions to log? -> Add to Key Decisions
5. "What This Is" still accurate? -> Update if drifted

**After each milestone** (via `/gsd:complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-04-10 — Milestone v1.2 started*
