# Charging-Master

**Smartes Lademanagement für Akkus über Shelly S3 Plug** — Automatische Geräteerkennung, SOC-Schätzung und Ladestopp bei gewünschtem Ladestand.

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
- **Automatischer Relay-Stopp** — MQTT-Befehl + HTTP-Fallback + Retry-Logik
- **Hysterese** — Verhindert schnelles Ein/Aus-Schalten

### Pushover-Benachrichtigungen
- **4 Event-Typen** — Gerät erkannt, Ziel-SOC erreicht, Fehler, Lernvorgang abgeschlossen
- **Differenzierte Prioritäten** — Normal für Info-Events, Hoch (Alarm-Sound) für Fehler
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
- **MQTT Auto-Discovery** — Findet Shelly-Geräte automatisch auf dem MQTT-Broker
- **Manuelle Eingabe** — Topic-Prefix als Fallback
- **Pro-Plug Konfiguration** — Name, IP-Adresse, Polling-Intervall, Aktiviert/Deaktiviert

### Einstellungen
- **MQTT-Broker** — Host, Port, optional Credentials, Verbindungstest-Button
- **Pushover** — User Key + API Token
- **Auto-Save** — Jede Änderung wird sofort gespeichert

---

## Tech Stack

| Komponente | Technologie |
|------------|-------------|
| **Framework** | Next.js 15 (App Router, Server Components) |
| **Custom Server** | server.ts — bootet Next.js + MQTT Client in einem Prozess |
| **Datenbank** | SQLite via better-sqlite3 + Drizzle ORM (WAL-Modus) |
| **MQTT** | mqtt.js 5 — Shelly Gen3 API |
| **Charts** | Apache ECharts 6 via echarts-for-react |
| **Echtzeit** | Server-Sent Events (SSE) via ReadableStream |
| **Algorithmen** | DTW (Dynamic Time Warping), Trapezintegration, Charge State Machine |
| **Notifications** | Pushover HTTP API |
| **Styling** | Tailwind CSS v4, Dark Theme (Sleek Minimal) |
| **Runtime** | Node.js 22, pnpm, TypeScript 5.9 strict |

---

## Architektur

```
Browser (SSE)              Next.js App Router
    │                           │
    ├── Dashboard ──────── Server Components (DB Queries)
    ├── Live Charts ────── /api/sse/power (EventBus → ReadableStream)
    ├── Relay Control ──── /api/devices/[id]/relay (MQTT + HTTP Fallback)
    └── History ────────── /api/history (Drizzle ORM)

Server (server.ts)
    │
    ├── MqttService ─────── MQTT Broker (mqtt-master.local)
    │   ├── Subscribe to Shelly topics
    │   ├── HTTP Polling (1s) für zuverlässige Power-Daten
    │   ├── publishCommand (Relay on/off)
    │   └── Watchdog (Reconnect bei stale connections)
    │
    ├── EventBus ────────── Typed Events (power:*, charge:*, online:*)
    │
    ├── ChargeMonitor ───── Per-Plug State Machine
    │   ├── Detecting → Matched → Charging → Countdown → Stopping → Complete
    │   ├── DTW Curve Matching (curve-matcher.ts)
    │   ├── SOC Estimation (soc-estimator.ts)
    │   └── Relay Controller (relay-controller.ts)
    │
    ├── NotificationService ── Pushover bei State-Übergängen
    │
    └── SessionRecorder ──── Readings + Events in DB

SQLite (data/charging-master.db)
    ├── plugs, power_readings, config
    ├── device_profiles, reference_curves, reference_curve_points, soc_boundaries
    ├── charge_sessions, session_readings, session_events
    └── price_history
```

---

## Installation

### Voraussetzungen

- **Node.js 22+** und **pnpm**
- **Shelly S3 Plug** (oder kompatibel) mit MQTT aktiviert
- **MQTT Broker** (z.B. Mosquitto)
- Optional: **Pushover** Account für Benachrichtigungen

### Setup

```bash
# Repository klonen
git clone https://github.com/meintechblog/charging-master.git
cd charging-master

# Dependencies installieren
pnpm install

# Datenbank erstellen
npx drizzle-kit push

# App starten
pnpm tsx server.ts
```

Die App ist dann erreichbar unter **http://localhost:3000**.

### Ersteinrichtung

1. **Einstellungen** → MQTT-Broker konfigurieren (Host + Port)
2. **Verbindung testen** → Grüner Indikator in der Sidebar
3. **Geräte** → Shelly Plug per Auto-Discovery finden und hinzufügen
4. **Profile** → Neues Profil → Gerät anlernen (kompletter Ladezyklus)
5. **Dashboard** → Live-Daten, Relay-Steuerung, automatische Erkennung

### Deployment auf LXC/Server

```bash
# Auf dem Server
mkdir -p /opt/charging-master
rsync -avz --exclude=node_modules --exclude=.next --exclude=.git . root@server:/opt/charging-master/

# Auf dem Server
cd /opt/charging-master
pnpm install
npx drizzle-kit push

# systemd Service
cat > /etc/systemd/system/charging-master.service << EOF
[Unit]
Description=Charging-Master Web App
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/charging-master
ExecStart=/usr/bin/npx tsx server.ts
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=development
KillMode=control-group
TimeoutStopSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now charging-master
```

---

## Shelly S3 Plug einrichten

Der Shelly S3 Plug muss MQTT aktiviert haben:

```bash
# MQTT aktivieren + status_ntf einschalten
curl -s 'http://SHELLY_IP/rpc/Mqtt.SetConfig' \
  -d '{"config":{"enable":true,"server":"BROKER_IP:1883","status_ntf":true}}'

# Reboot
curl -s 'http://SHELLY_IP/rpc/Shelly.Reboot'
```

> **Wichtig:** Den Broker als IP-Adresse angeben, nicht als Hostname — der Shelly kann lokale DNS-Namen oft nicht auflösen.

---

## Wie es funktioniert

### 1. Gerät anlernen

Schließe das Ladegerät an den Shelly Plug an. Starte den Lernvorgang in der App. Der Akku sollte möglichst leer sein. Die App zeichnet den kompletten Ladezyklus auf — die charakteristische Leistungskurve dient als "Fingerabdruck" des Geräts.

### 2. SOC-Grenzen

Aus der Referenzkurve berechnet die App automatisch die 10%-SOC-Grenzen basierend auf der kumulativen Energie. Du stellst pro Profil dein Ziel ein (z.B. 80%).

### 3. Automatische Erkennung

Beim nächsten Ladevorgang erkennt die App anhand der ersten 1-2 Minuten der Ladekurve, welches Gerät geladen wird (DTW Curve Matching). Du bekommst eine Pushover-Nachricht und siehst ein Banner im Dashboard.

### 4. Auto-Stopp

Die App schätzt den aktuellen SOC basierend auf der eingespeisten Energie. Bei Erreichen des Ziels (z.B. 80%) wird der Relay des Shelly Plug automatisch ausgeschaltet — MQTT-Befehl mit HTTP-Fallback für maximale Zuverlässigkeit.

---

## Datenbank-Schema

11 Tabellen in SQLite:

| Tabelle | Beschreibung |
|---------|-------------|
| `plugs` | Registrierte Shelly Plugs |
| `power_readings` | Leistungsmesswerte (1s Auflösung bei aktivem Laden) |
| `config` | Key-Value Settings (MQTT, Pushover) |
| `device_profiles` | Geräteprofile mit Attributen |
| `reference_curves` | Referenz-Ladekurven (Metadaten) |
| `reference_curve_points` | Einzelne Messpunkte der Referenzkurve |
| `soc_boundaries` | SOC-Grenzen in 10%-Schritten |
| `charge_sessions` | Ladevorgänge mit Status und Statistiken |
| `session_readings` | Messpunkte pro Ladevorgang |
| `session_events` | State-Übergänge (Ereignis-Log) |
| `price_history` | Preisänderungen pro Profil |

---

## API-Endpunkte

| Methode | Pfad | Beschreibung |
|---------|------|-------------|
| GET | `/api/devices` | Registrierte Plugs |
| POST | `/api/devices` | Plug hinzufügen |
| DELETE | `/api/devices` | Plug entfernen |
| GET | `/api/devices/discover` | MQTT Auto-Discovery |
| GET | `/api/devices/[id]/readings` | Power Readings (mit `since`/`window` Filter) |
| POST | `/api/devices/[id]/relay` | Relay schalten (on/off/toggle) |
| GET | `/api/sse/power` | SSE Stream für Echtzeit-Leistungsdaten |
| GET | `/api/mqtt/status` | MQTT-Verbindungsstatus |
| POST | `/api/mqtt/test` | MQTT-Verbindung testen |
| GET/PUT | `/api/settings` | App-Einstellungen |
| GET/POST | `/api/profiles` | Profile CRUD |
| GET/PUT/DELETE | `/api/profiles/[id]` | Einzelnes Profil |
| GET | `/api/profiles/[id]/curve` | Referenzkurve eines Profils |
| POST | `/api/charging/learn/start` | Lernvorgang starten |
| POST | `/api/charging/learn/stop` | Lernvorgang stoppen/speichern |
| GET | `/api/charging/learn/status` | Aktive Lernvorgänge |
| GET | `/api/charging/sessions` | Aktive Lade-Sessions |
| GET/PUT | `/api/charging/sessions/[id]` | Session-Details/Override |
| POST | `/api/charging/sessions/[id]/abort` | Session abbrechen |
| GET | `/api/history` | Lade-Historie (paginiert, filterbar) |
| GET | `/api/history/[sessionId]` | Session-Details mit Kurve + Events |

---

## Lizenz

MIT

---

**Made with Charging-Master** — Weil 80% besser ist als 100%.
