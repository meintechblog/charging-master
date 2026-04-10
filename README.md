# Charging-Master

**Smartes Lademanagement für Akkus über Shelly S3 Plug** — Automatische Geräteerkennung, SOC-Schätzung, Ladestopp bei gewünschtem Ladestand, und ein In-App Self-Update-Mechanismus.

Charging-Master löst ein einfaches Problem: Wenn du ein Ladegerät an die Steckdose anschließt, lädt es den Akku auf 100%. Das ist schlecht für die Langlebigkeit — besser wäre es, bei 80% aufzuhören. Aber dafür müsstest du ständig nachschauen und manuell abstecken.

Charging-Master übernimmt das für dich. Ein Shelly S3 Plug sitzt zwischen Steckdose und Ladegerät, misst die Leistung und schaltet bei Erreichen des Ziel-SOC automatisch ab.

---

## Features

### Echtzeit-Dashboard
- **Live Power Chart** — ECharts mit Smooth Area Gradient, Echtzeit-Streaming via SSE
- **Plug Cards** — Alle Shelly Plugs auf einen Blick: Watt, Relay-Status, Online/Offline, Mini-Sparkline
- **Relay Toggle** — Ein Klick schaltet den Shelly ein/aus (Optimistic Update + Spinner)
- **Zeitfenster** — 5m / 15m / 30m / 1h / Max, Auto-Scale Y-Achse
- **Detail-Ansicht** — Click auf Card öffnet großen Chart mit Zoom, Pan, Fullscreen, Hover-Tooltips

### Geräteprofile anlernen
- **Step-by-Step Wizard** — Name eingeben, Plug wählen, Aufnahme starten
- **Neu anlernen bestehender Profile** — Button öffnet den Wizard direkt bei Schritt 2 und ersetzt nur die Referenzkurve, Profil-ID und Historie bleiben erhalten
- **Server-seitige Aufzeichnung** — Browser kann geschlossen werden, Aufzeichnung läuft weiter
- **Live-Statistiken** — Aktuell, Max, Start, Durchschnitt (Watt), Energie (Wh/kWh), Dauer
- **Automatische Ladeende-Erkennung** — Leistung sinkt auf ~0W → "Profil speichern?"
- **Parallele Lernvorgänge** — Mehrere Geräte gleichzeitig anlernen, Übersicht mit Session-Cards
- **Referenzkurve** — Gespeicherte Ladekurve als Basis für SOC-Schätzung und Geräteerkennung

### Automatische Geräteerkennung
- **DTW Curve Matching** — Vergleicht die ersten 1-2 Minuten eines Ladevorgangs mit allen gespeicherten Profilen
- **Confidence-Anzeige** — Banner im Dashboard: "E-Bike erkannt (85%) — Ziel: 80%"
- **Manuelle Übersteuerung** — Profil wechseln, Ziel-SOC ändern, Abbrechen — jederzeit möglich
- **Unbekannte Geräte** — "Jetzt anlernen" oder "Bestehendes Profil zuweisen"

### SOC-Schätzung & Auto-Stopp
- **Energiebasierte SOC-Berechnung** — Kumulative Wh verglichen mit Referenzkurve, 10%-Schritte
- **Countdown** — Visuelle Anzeige in den letzten 5% vor dem Ziel
- **Automatischer Relay-Stopp** — Shelly HTTP API (`/rpc/Switch.Set`) mit Retry-Logik
- **Automatischer Relay-Start beim Anlernen** — Plug wird im Learn-Wizard-Step 4 automatisch eingeschaltet
- **Hysterese** — Verhindert schnelles Ein/Aus-Schalten

### Pushover-Benachrichtigungen
- **Event-Typen** — Gerät erkannt, Ziel-SOC erreicht, Fehler, Lernvorgang abgeschlossen, Self-Update erfolgreich/fehlgeschlagen
- **Differenzierte Prioritäten** — Normal für Info-Events, Hoch (Alarm-Sound) für Fehler und kritische Rollbacks
- **Konfigurierbar** — Pushover User Key + API Token in den Einstellungen

### Lade-Historie
- **Session-Übersicht** — Alle Ladevorgänge chronologisch mit Filtern (Gerät, Profil, Status, Zeitraum)
- **Session-Details** — Ladekurve nachträglich anzeigen, Referenz-Overlay, Stats, Ereignis-Log
- **Profil-Integration** — Letzte Ladevorgänge direkt auf der Profil-Seite

### Profil-Management
- **Umfangreiche Attribute** — Name, Hersteller, Modell, Artikelnummer, GTIN/EAN, Gewicht, Kaufdatum, Ladezyklen
- **Produkt-Links** — URL zum Produkt und zum Datenblatt/PDF hinterlegbar
- **Preishistorie** — Preis in Euro mit automatischer Änderungshistorie
- **Ziel-SOC** — Pro Profil konfigurierbar in 10%-Schritten (10%–100%)
- **Referenzkurve** — Grafische Darstellung mit Ladedauer, Energie (AC-seitig), Start-/Spitzenleistung

### Geräte-Management
- **HTTP Discovery** — Findet Shelly-Geräte automatisch im lokalen Subnetz per HTTP-Scan
- **Manuelle Eingabe** — IP-Adresse als Fallback
- **Pro-Plug Konfiguration** — Name, IP-Adresse, Polling-Intervall (Standard 1s), Aktiviert/Deaktiviert
- **Online/Offline-Erkennung** — Basierend auf HTTP-Erreichbarkeit

### Self-Update (v1.2)
- **Version-Anzeige** — Aktueller Commit-SHA + Build-Zeitpunkt auf der Settings-Seite (Hover = voller SHA, Klick = kopiert)
- **Background-Check alle 6h** — Pollt GitHub `main` mit ETag-basiertem `If-None-Match` (304 verbraucht kein Rate-Limit)
- **Update-Badge im Settings-Nav** — Roter Punkt sobald ein neuer Commit verfügbar ist
- **Jetzt prüfen** — Manueller Check mit 5-Minuten-Cooldown
- **Install-Modal** — Zeigt SHA-Vergleich, Commit-Message, Autor, Datum — **warnt rot** wenn gerade ein Akku geladen wird
- **Dedizierte systemd-Unit** — `charging-master-updater.service` (Type=oneshot) läuft als Sibling-Prozess, löst das "Kill your own parent"-Problem
- **Pipeline mit 9 Stufen** — Preflight → Snapshot → Drain → Stop → Fetch → Install → Build → Start → Verify
- **Live-Log-Stream** — SSE streamt `journalctl -fu charging-master-updater` mit Stage-Stepper
- **Reconnect-Overlay** — Beim Restart pollt die UI `/api/version` bis die neue SHA antwortet, dann automatischer Reload
- **Two-Stage Auto-Rollback** — Stage 1: `git reset` + rebuild. Stage 2: Tarball-Restore. Bei jedem Scheitern wird der vorherige SHA wiederhergestellt
- **Health-Probe** — Nach Restart bis zu 60s `/api/version` pollen, verlangt SHA-Match **und** DB healthy (kein silent success)
- **Update-Historie** — Tabelle der letzten 10 Updates: Datum, Von → Nach SHA, Status, Dauer, Error-Tooltip
- **Resumable Streaming-View** — Navigiert man während eines Updates weg und kommt zurück, wird die Streaming-Ansicht automatisch wiederhergestellt
- **Skip `pnpm install` bei UI-only Updates** — Wenn `package.json`/`pnpm-lock.yaml` zwischen alt und neu unverändert sind, wird `pnpm install` übersprungen (spart 30-90s)
- **Pushover-Notifications** — Erfolg, Rollback (Stufe 1/2) und kritische Fehler direkt aufs Handy

### Einstellungen
- **Pushover** — User Key + API Token
- **Auto-Save** — Jede Änderung wird sofort gespeichert
- **Version + Update-Management** — Aktueller SHA, Update-Banner, Install-Button, Update-Historie

---

## Tech Stack

| Komponente | Technologie |
|------------|-------------|
| **Framework** | Next.js 15 (App Router, Server Components) |
| **Custom Server** | `server.ts` — bootet Next.js + HttpPollingService + UpdateChecker + UpdateStateStore in einem Prozess |
| **Datenbank** | SQLite via better-sqlite3 + Drizzle ORM (WAL-Modus) |
| **Shelly-Kommunikation** | Direkte HTTP-Calls an `/rpc/...` (Shelly Gen3 API), kein MQTT-Broker mehr |
| **Self-Update** | Native `fetch` für GitHub API, `child_process.spawn` für systemctl, Bash-Pipeline für den Updater, keine externen Libraries |
| **Charts** | Apache ECharts 6 via echarts-for-react |
| **Echtzeit** | Server-Sent Events (SSE) via ReadableStream (sowohl Power-Daten als auch Updater-Logs) |
| **Algorithmen** | DTW (Dynamic Time Warping), Trapezintegration, Charge State Machine |
| **Notifications** | Pushover HTTP API |
| **Styling** | Tailwind CSS v4, Dark Theme (Sleek Minimal) |
| **Runtime** | Node.js 22, pnpm 10, TypeScript 5.9 strict |

---

## Architektur

```
Browser (SSE + EventSource)           Next.js App Router
    │                                       │
    ├── Dashboard ──────────── Server Components (DB Queries)
    ├── Live Power Charts ───── /api/sse/power (EventBus → ReadableStream)
    ├── Relay Control ────────── /api/devices/[id]/relay (Shelly HTTP API)
    ├── History ────────────── /api/history (Drizzle ORM)
    ├── Settings/Version ────── /api/version (git SHA + dbHealthy)
    ├── Update-Check ─────────── /api/update/status, /check
    ├── Update-Trigger ──────── /api/update/trigger (spawn systemctl --no-block)
    ├── Updater-Log Stream ──── /api/update/log (journalctl -fu via SSE)
    └── Rollback-Ack ─────────── /api/update/ack-rollback

server.ts (Custom Next Server, runs as systemd 'charging-master')
    │
    ├── UpdateStateStore.init() ── .update-state/state.json (atomic writes)
    ├── UpdateChecker ──────────── 6h setInterval against GitHub API (ETag cached)
    │
    ├── HttpPollingService ────── Polling Loop pro Plug (Shelly /rpc/Shelly.GetStatus)
    │   ├── Power Readings → EventBus
    │   ├── Online/Offline-Tracking
    │   └── stopPolling() ← aufgerufen vom Drain-Endpoint vor Updates
    │
    ├── EventBus ──────────────── Typed Events (power:*, charge:*, online:*)
    │
    ├── ChargeMonitor ─────────── Per-Plug State Machine
    │   ├── Detecting → Matched → Charging → Countdown → Stopping → Complete
    │   ├── DTW Curve Matching (curve-matcher.ts)
    │   ├── SOC Estimation (soc-estimator.ts)
    │   └── Relay Controller (HTTP → Shelly)
    │
    ├── NotificationService ──── Pushover bei State-Übergängen
    └── SessionRecorder ──────── Readings + Events in DB

charging-master-updater.service (systemd Type=oneshot, Sibling-Prozess)
    │
    └── scripts/update/run-update.sh
        ├── flock -n 9 (.update-state/updater.lock)
        ├── Preflight: disk/node/pnpm/git clean
        ├── Snapshot → .update-state/snapshots/<sha>.tar.gz
        ├── POST /api/internal/prepare-for-shutdown (WAL checkpoint + drain)
        ├── systemctl stop charging-master
        ├── git fetch + reset → pnpm install (skip wenn Lockfile unverändert) → rm -rf .next + pnpm build
        ├── systemctl start charging-master
        ├── Health Probe (60s, SHA match + dbHealthy)
        ├── trap ERR → Stage 1 Rollback (git reset + rebuild) → Stage 2 (tar extract)
        └── Pushover Notification + update_runs row

SQLite (data/charging-master.db, WAL-mode)
    ├── plugs, power_readings, config
    ├── device_profiles, reference_curves, reference_curve_points, soc_boundaries
    ├── charge_sessions, session_readings, session_events
    ├── price_history
    └── update_runs (Self-Update Audit-Log)

.update-state/ (cross-process state, gitignored)
    ├── state.json (currentSha, rollbackSha, lastCheckEtag, updateStatus, rollbackHappened, ...)
    ├── snapshots/<sha>.tar.gz (last 3 retained)
    └── updater.lock (flock FD)
```

---

## Installation

### Voraussetzungen

- **Debian 12/13 LXC Container** (oder jedes Debian-basierte System)
- **Root-Zugang**
- **Shelly S3 Plug Gen3** im lokalen Netz
- Optional: **Pushover** Account für Benachrichtigungen

### Installation via One-Liner

Auf dem Ziel-System als root:

```bash
curl -sSL https://raw.githubusercontent.com/meintechblog/charging-master/main/install.sh | bash -s -- install
```

Das Skript installiert Node.js 22, pnpm, sqlite3, jq, klont das Repo nach `/opt/charging-master`, baut die App und registriert zwei systemd-Units:
- `charging-master.service` — die Haupt-App (läuft auf Port 80)
- `charging-master-updater.service` — Type=oneshot, wird vom Self-Update getriggert

Danach ist die App erreichbar unter `http://<host-ip>` oder `http://charging-master.local` (via avahi).

### Manuelles Update per SSH

Falls das in-app Self-Update mal nicht funktionieren sollte:

```bash
ssh root@charging-master.local
cd /opt/charging-master
bash install.sh update
```

### Dev-Setup (lokal)

```bash
git clone https://github.com/meintechblog/charging-master.git
cd charging-master
pnpm install
npx drizzle-kit push
pnpm dev
```

Die App läuft dann unter `http://localhost:3000`. Auf dem Dev-System gibt der In-App-Updater `503 dev_mode` zurück (systemd-Unit existiert nur auf dem Ziel-System).

### Ersteinrichtung

1. **Geräte** → Shelly Plug per HTTP-Discovery finden und hinzufügen (oder IP-Adresse manuell eingeben)
2. **Profile** → Neues Profil → Gerät anlernen (kompletter Ladezyklus)
3. **Dashboard** → Live-Daten, Relay-Steuerung, automatische Erkennung
4. **Einstellungen** → Pushover konfigurieren (optional), Version und Updates einsehen

---

## Shelly S3 Plug einrichten

Der Shelly S3 Plug muss nur erreichbar sein — kein MQTT-Setup nötig.

1. Shelly Gen3 Gerät ins WLAN einbinden (via Shelly-App oder Web-UI)
2. IP-Adresse notieren
3. Charging-Master → Geräte → Discovery oder manuelle IP-Eingabe

Die App kommuniziert direkt mit den Shelly-Endpoints:

| Zweck | Shelly Endpoint |
|---|---|
| Power-Readings | `GET /rpc/Shelly.GetStatus` |
| Relay schalten | `GET /rpc/Switch.Set?id=0&on=<bool>` |
| Online-Check | HTTP-Erreichbarkeit auf Port 80 |

---

## Wie es funktioniert

### 1. Gerät anlernen

Schließe das Ladegerät an den Shelly Plug an. Starte den Lernvorgang in der App. Der Akku sollte möglichst leer sein. Die App zeichnet den kompletten Ladezyklus auf — die charakteristische Leistungskurve dient als "Fingerabdruck" des Geräts.

**Automatische Relay-Steuerung während des Anlernens:**
- Beim Schritt "Ladevorgang aktiv" (Step 4) wird der Shelly Plug automatisch **eingeschaltet** (HTTP `/rpc/Switch.Set?on=true`)
- Sobald die Leistung für 60 s unter 2 W fällt (`learn_complete`), wird der Plug automatisch **wieder ausgeschaltet** — symmetrisch zum regulären Auto-Stopp
- Beim manuellen Beenden via "Speichern" oder "Verwerfen" wird der Plug ebenfalls ausgeschaltet

**Neu anlernen eines bestehenden Profils:** Button auf der Profil-Seite öffnet den Wizard direkt bei der Plug-Auswahl. Am Ende wird nur die Referenzkurve ersetzt, Profil-ID und Historie bleiben erhalten.

### 2. SOC-Grenzen

Aus der Referenzkurve berechnet die App automatisch die 10%-SOC-Grenzen basierend auf der kumulativen Energie. Du stellst pro Profil dein Ziel ein (z.B. 80%).

### 3. Automatische Erkennung

Beim nächsten Ladevorgang erkennt die App anhand der ersten 1-2 Minuten der Ladekurve, welches Gerät geladen wird (DTW Curve Matching). Du bekommst eine Pushover-Nachricht und siehst ein Banner im Dashboard.

### 4. Auto-Stopp

Die App schätzt den aktuellen SOC basierend auf der eingespeisten Energie. Bei Erreichen des Ziels (z.B. 80%) wird der Relay des Shelly Plug automatisch ausgeschaltet — HTTP-POST mit Retry-Logik für maximale Zuverlässigkeit.

### 5. Self-Update

Die App pollt alle 6 Stunden gegen GitHub (`GET /repos/meintechblog/charging-master/commits/main`) mit `If-None-Match`-ETag. Bei einem neuen Commit erscheint:

- Badge auf dem "Einstellungen"-Nav-Eintrag
- Banner auf `/settings` mit neuem SHA, Commit-Message, Autor und Datum

Ein Klick auf "Installieren" öffnet ein Modal:
- Zeigt den SHA-Vergleich
- Warnt **rot** wenn gerade ein Akku geladen wird (inkl. Profil, SOC%, Target)
- Kann abgebrochen oder bestätigt werden

Nach Bestätigung startet der Updater als unabhängige systemd-Unit. Das UI wechselt in den Streaming-Mode, zeigt den Stage-Stepper (9 Stufen) und live `journalctl`-Output. Während des Restarts erscheint ein Reconnect-Overlay, das `/api/version` alle 2s pollt. Sobald die neue SHA antwortet, lädt die Seite automatisch neu.

**Bei Fehlern:**
1. **Stage 1 Rollback** — `git reset --hard` auf den vorherigen Commit, `pnpm install`, `pnpm build`, restart, health-probe
2. **Stage 2 Rollback** — Falls Stage 1 scheitert, wird der vorher erstellte Tarball-Snapshot extrahiert und der Dienst neu gestartet
3. **Kritischer Fehler** — Falls auch Stage 2 scheitert, Pushover-Alert mit Priorität 2 ("SSH required")

Beim nächsten Seitenaufruf zeigt die App einen roten Banner: *"Letztes Update fehlgeschlagen — Version wurde zurückgerollt"* mit Error-Details.

---

## Datenbank-Schema

12 Tabellen in SQLite:

| Tabelle | Beschreibung |
|---------|-------------|
| `plugs` | Registrierte Shelly Plugs |
| `power_readings` | Leistungsmesswerte (1s Auflösung bei aktivem Laden) |
| `config` | Key-Value Settings (Pushover, etc.) |
| `device_profiles` | Geräteprofile mit Attributen |
| `reference_curves` | Referenz-Ladekurven (Metadaten) |
| `reference_curve_points` | Einzelne Messpunkte der Referenzkurve |
| `soc_boundaries` | SOC-Grenzen in 10%-Schritten |
| `charge_sessions` | Ladevorgänge mit Status und Statistiken |
| `session_readings` | Messpunkte pro Ladevorgang |
| `session_events` | State-Übergänge (Ereignis-Log) |
| `price_history` | Preisänderungen pro Profil |
| `update_runs` | Self-Update Audit-Log (Start/End, from→to SHA, Status, Stage, Error, Rollback-Stage) |

---

## API-Endpunkte

### Geräte & Shelly

| Methode | Pfad | Beschreibung |
|---------|------|-------------|
| GET | `/api/devices` | Registrierte Plugs |
| POST | `/api/devices` | Plug hinzufügen |
| DELETE | `/api/devices` | Plug entfernen |
| GET | `/api/devices/discover` | HTTP Auto-Discovery im lokalen Subnetz |
| GET | `/api/devices/[id]/readings` | Power Readings (mit `since`/`window` Filter) |
| POST | `/api/devices/[id]/relay` | Relay schalten (on/off/toggle) |
| GET | `/api/sse/power` | SSE Stream für Echtzeit-Leistungsdaten |

### Profile & Learning

| Methode | Pfad | Beschreibung |
|---------|------|-------------|
| GET/POST | `/api/profiles` | Profile CRUD |
| GET/PUT/DELETE | `/api/profiles/[id]` | Einzelnes Profil |
| GET | `/api/profiles/[id]/curve` | Referenzkurve eines Profils |
| POST | `/api/charging/learn/start` | Lernvorgang starten (erstellt Profil oder überschreibt Referenzkurve) |
| POST | `/api/charging/learn/stop` | Lernvorgang stoppen/speichern |
| GET | `/api/charging/learn/status` | Aktive Lernvorgänge |

### Lade-Sessions & Historie

| Methode | Pfad | Beschreibung |
|---------|------|-------------|
| GET | `/api/charging/sessions` | Aktive Lade-Sessions (von UpdateModal geprüft) |
| GET/PUT | `/api/charging/sessions/[id]` | Session-Details/Override |
| POST | `/api/charging/sessions/[id]/abort` | Session abbrechen |
| GET | `/api/history` | Lade-Historie (paginiert, filterbar) |
| GET | `/api/history/[sessionId]` | Session-Details mit Kurve + Events |

### Self-Update & System

| Methode | Pfad | Beschreibung |
|---------|------|-------------|
| GET | `/api/version` | Aktueller Commit-SHA, Build-Zeitpunkt, Rollback-SHA, `dbHealthy` Probe (<50ms) |
| GET | `/api/update/status` | UpdateInfoView mit updateAvailable, remote-SHA, rollbackHappened, inProgressUpdate |
| GET | `/api/update/check` | Forciert einen GitHub-Check (5-min Cooldown, Rate-Limit über ETag) |
| POST | `/api/update/trigger` | Startet `charging-master-updater.service` via `systemctl start --no-block` (localhost-only, 503 dev_mode) |
| GET | `/api/update/log` | SSE-Stream von `journalctl -fu charging-master-updater` (dev-mode emittiert synthetische Events) |
| POST | `/api/update/ack-rollback` | Löscht `rollbackHappened` Flag in `state.json` (localhost-only) |
| GET | `/api/update/history` | Letzte Update-Runs aus `update_runs` (default 10, max 50) |
| POST | `/api/internal/prepare-for-shutdown` | WAL-Checkpoint + HttpPollingService-Drain vor Service-Stop (localhost-only) |
| GET/PUT | `/api/settings` | App-Einstellungen |

---

## Projekt-Struktur

```
charging-master/
├── src/
│   ├── app/
│   │   ├── api/                    # Next.js API Routes (siehe oben)
│   │   ├── dashboard/
│   │   ├── devices/
│   │   ├── profiles/
│   │   ├── history/
│   │   └── settings/               # VersionBadge, UpdateBanner, InstallModal, UpdateHistory, ...
│   ├── components/
│   │   ├── charging/               # Learn-Wizard, etc.
│   │   ├── layout/                 # Sidebar mit Update-Badge
│   │   └── settings/               # PushoverSettings, SettingsSection
│   ├── db/                         # Drizzle client + schema
│   ├── lib/
│   │   └── version.ts              # generiert (git-ignored) — CURRENT_SHA, BUILD_TIME
│   └── modules/
│       ├── charging/               # ChargeMonitor, Curve Matcher, SOC Estimator
│       ├── notifications/          # Pushover Client
│       ├── self-update/            # UpdateStateStore, UpdateChecker, GitHubClient
│       └── shelly/                 # HttpPollingService, Relay Controller
├── scripts/
│   ├── build/
│   │   └── generate-version.mjs    # Prebuild script → src/lib/version.ts
│   └── update/
│       ├── charging-master-updater.service    # systemd Unit
│       ├── run-update.sh                       # Bash Pipeline mit 2-Stage Rollback
│       └── dry-run-helpers.sh                  # Dev-Harness zum Testen der Helpers
├── drizzle/                        # Generated migrations
├── data/
│   └── charging-master.db          # SQLite (gitignored, WAL-mode)
├── .update-state/                  # Cross-process state (gitignored)
│   ├── state.json
│   ├── snapshots/
│   └── updater.lock
├── server.ts                       # Custom Next.js server
└── install.sh                      # One-line installer + update script
```

---

## Entwicklung

```bash
pnpm dev              # Dev-Server mit hot-reload (tsx watch server.ts)
pnpm build            # Production Build (gen:version → next build)
pnpm start            # Production Start (tsx server.ts, NODE_ENV=production)
pnpm gen:version      # Regeneriert src/lib/version.ts (wird automatisch vor dev/build aufgerufen)
pnpm db:push          # Schema direkt pushen (Dev)
pnpm db:generate      # Migration generieren
pnpm exec tsc --noEmit # TypeScript Check
pnpm exec vitest run  # Tests
```

---

## Lizenz

MIT

---

**Made with Charging-Master** — Weil 80% besser ist als 100%.
