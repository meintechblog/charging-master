# Phase 4: Notifications & History - Research

**Researched:** 2026-03-29
**Domain:** Pushover push notifications, charge session history UI, event-driven notification dispatch
**Confidence:** HIGH

## Summary

Phase 4 adds two features: (1) Pushover notifications triggered by charge events, and (2) a session history UI with detail views. Both build on well-established existing infrastructure -- the EventBus already emits `charge:*` events on every state transition, the `chargeSessions` table already stores all session data, and `sessionReadings` captures per-session power readings. The Pushover API is a simple HTTP POST with no SDK needed.

The notification service is a listener on the EventBus in `server.ts` that reads Pushover credentials from the `config` table and sends HTTP POST requests to `https://api.pushover.net/1/messages.json`. The history UI is a new `/history` page listing completed sessions with filters, plus a `/history/[sessionId]` detail page reusing the existing `PowerChart` component (which already supports `referenceData` overlay).

**Primary recommendation:** Implement as a NotificationService class initialized in `server.ts` alongside ChargeMonitor, and server-rendered history pages with client-side filtering. No new dependencies needed -- use native `fetch` for Pushover API calls.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- **D-40:** Alle 4 Events loesen Notifications aus: Ladevorgang erkannt, Ziel-SOC erreicht, Fehler, Lernvorgang abgeschlossen.
- **D-41:** Differenzierte Prioritaeten: Normal (0) fuer Erkennung/Abschluss/Lernvorgang, Hoch (1) fuer Fehler (Alarm-Sound).
- **D-42:** Pushover Credentials bereits in Settings gespeichert (Phase 1: SETT-02). Notifications nur senden wenn Credentials konfiguriert sind.
- **D-43:** History-Layout und Filter: Claude's Discretion -- sinnvolles Layout (Tabelle oder Cards) mit sinnvollen Filtern (Geraet, Zeitraum, Status).
- **D-44:** Sidebar-Link "Verlauf" aktivieren (aktuell `disabled: true`).
- **D-45:** Session-Detail zeigt alles: Ladekurve nachtraeglich (aus power_readings), Referenz-Overlay (Session + Referenzkurve uebereinander), Stats-Uebersicht (Start/Ende, Dauer, Energie, SOC, Profil, Plug), Ereignis-Log (State-Uebergaenge als Timeline).
- **D-46:** Profil-Seite zeigt letzte Sessions dieses Profils als zusaetzliche Section.

### Claude's Discretion
- History-Seite Layout (Tabelle vs. Cards vs. hybrid)
- Filter-Kombination und Darstellung
- Pushover-Nachrichtentext und Formatierung
- Ereignis-Log Darstellung (Timeline, Liste, Badges)

### Deferred Ideas (OUT OF SCOPE)
None -- discussion stayed within phase scope.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| NOTF-01 | User can configure Pushover credentials (user key, API token) | Already implemented in Phase 1 (SETT-02). `pushover-settings.tsx` stores to config table via `/api/settings`. No work needed. |
| NOTF-02 | Notification sent when charging starts and device is recognized | EventBus `charge:*` events with state `matched` provide the trigger. NotificationService listens and sends Pushover POST. |
| NOTF-03 | Notification sent when target SOC reached and charging stopped | EventBus `charge:*` events with state `complete` provide the trigger. |
| NOTF-04 | Notification sent when charging aborted or error occurs | EventBus `charge:*` events with states `error` and `aborted` provide the trigger. Priority 1 for errors (D-41). |
| HIST-01 | Each charge session is logged (device, start, end, energy consumed, final SOC) | Already implemented -- `chargeSessions` table captures all fields. ChargeMonitor updates state, energyWh, estimatedSoc, stoppedAt, stopReason on each transition. |
| HIST-02 | User can view charge history per device with session details | New `/history` page with table listing all completed sessions. Filter by device, status, time range. |
| HIST-03 | User can view past charge curves from session history | New `/history/[sessionId]` detail page. `sessionReadings` table stores per-session power data. Reuse `PowerChart` with `referenceData` overlay from reference curve. |
</phase_requirements>

## Standard Stack

### Core (already in project)
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| Next.js | 15.2.0 | Page routing, API routes, server components | Project framework |
| Drizzle ORM | 0.44.5 | Database queries for sessions, readings, config | Project ORM |
| ECharts (echarts-for-react) | existing | PowerChart component with reference overlay | Already built with full feature set |
| Native fetch | built-in | Pushover API HTTP POST | No SDK needed for single endpoint |

### Supporting
No new dependencies required. Everything needed is already in the project.

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Native fetch for Pushover | pushover-notifications npm | Overkill -- single POST endpoint, native fetch is simpler and zero-dep |
| Server-side table rendering | TanStack Table (client) | Unnecessary complexity -- sessions list is simple, server-rendered table with client filters suffices |

## Architecture Patterns

### Recommended Project Structure
```
src/
  modules/
    notifications/
      notification-service.ts     # EventBus listener, Pushover sender
      pushover-client.ts          # HTTP POST wrapper for Pushover API
  app/
    history/
      page.tsx                    # Session history list (server component)
      [sessionId]/
        page.tsx                  # Session detail (client component for chart)
    api/
      history/
        route.ts                  # GET sessions with filters (pagination, device, status, date range)
        [sessionId]/
          route.ts                # GET full session detail with all readings + reference curve
```

### Pattern 1: NotificationService as EventBus Listener
**What:** A class instantiated in `server.ts` that subscribes to `charge:*` events, filters for notification-worthy state transitions, reads Pushover credentials from DB, and sends HTTP POST.
**When to use:** For all four notification triggers (matched, complete, error/aborted, learn_complete).
**Example:**
```typescript
// src/modules/notifications/notification-service.ts
import type { EventBus } from '../events/event-bus';
import type { ChargeStateEvent } from '../charging/types';
import { sendPushover } from './pushover-client';
import { db } from '@/db/client';
import { config } from '@/db/schema';
import { eq } from 'drizzle-orm';

const NOTIFICATION_STATES = new Set(['matched', 'complete', 'error', 'aborted', 'learn_complete']);

export class NotificationService {
  private eventBus: EventBus;
  private handler: ((event: ChargeStateEvent) => void) | null = null;

  constructor(eventBus: EventBus) {
    this.eventBus = eventBus;
  }

  start(): void {
    this.handler = (event: ChargeStateEvent) => {
      if (NOTIFICATION_STATES.has(event.state)) {
        this.handleEvent(event);
      }
    };
    this.eventBus.on('charge:*', this.handler);
  }

  stop(): void {
    if (this.handler) {
      this.eventBus.removeListener('charge:*', this.handler);
      this.handler = null;
    }
  }

  private async handleEvent(event: ChargeStateEvent): Promise<void> {
    const credentials = this.getCredentials();
    if (!credentials) return; // D-42: skip if not configured

    const { title, message, priority } = this.buildMessage(event);
    await sendPushover({ ...credentials, title, message, priority });
  }

  private getCredentials(): { userKey: string; apiToken: string } | null {
    const userKey = db.select().from(config).where(eq(config.key, 'pushover.userKey')).get()?.value;
    const apiToken = db.select().from(config).where(eq(config.key, 'pushover.apiToken')).get()?.value;
    if (!userKey || !apiToken) return null;
    return { userKey, apiToken };
  }

  private buildMessage(event: ChargeStateEvent): { title: string; message: string; priority: number } {
    // D-41: Normal (0) for detection/completion/learn, High (1) for errors
    switch (event.state) {
      case 'matched':
        return {
          title: 'Ladevorgang erkannt',
          message: `${event.profileName ?? 'Unbekanntes Geraet'} wurde erkannt (${((event.confidence ?? 0) * 100).toFixed(0)}% Konfidenz)`,
          priority: 0,
        };
      case 'complete':
        return {
          title: 'Ziel-SOC erreicht',
          message: `Laden abgeschlossen bei ${event.estimatedSoc ?? '?'}% SOC`,
          priority: 0,
        };
      case 'error':
      case 'aborted':
        return {
          title: 'Ladefehler',
          message: `Ladevorgang fehlgeschlagen fuer ${event.profileName ?? 'Unbekanntes Geraet'}`,
          priority: 1,
        };
      case 'learn_complete':
        return {
          title: 'Lernvorgang abgeschlossen',
          message: `Referenzkurve fuer ${event.profileName ?? 'Geraet'} aufgezeichnet`,
          priority: 0,
        };
      default:
        return { title: 'Charging Master', message: `Status: ${event.state}`, priority: 0 };
    }
  }
}
```

### Pattern 2: Pushover HTTP Client
**What:** Simple async function wrapping a single `fetch` POST to the Pushover API.
**When to use:** Called by NotificationService for each notification.
**Example:**
```typescript
// src/modules/notifications/pushover-client.ts
const PUSHOVER_API_URL = 'https://api.pushover.net/1/messages.json';

type PushoverMessage = {
  userKey: string;
  apiToken: string;
  title: string;
  message: string;
  priority: number;
};

export async function sendPushover(msg: PushoverMessage): Promise<boolean> {
  try {
    const res = await fetch(PUSHOVER_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: msg.apiToken,
        user: msg.userKey,
        title: msg.title,
        message: msg.message,
        priority: msg.priority,
        // Priority 1 gets alarm sound by default
      }),
    });
    return res.ok;
  } catch {
    console.error('Pushover notification failed');
    return false;
  }
}
```

### Pattern 3: History API with Filtering
**What:** API route returning paginated sessions with optional filters for plug, status, and date range.
**When to use:** `/api/history` endpoint consumed by history page.
**Example:**
```typescript
// Query pattern for filtered sessions
const conditions = [];
if (plugId) conditions.push(eq(chargeSessions.plugId, plugId));
if (status) conditions.push(eq(chargeSessions.state, status));
if (from) conditions.push(gte(chargeSessions.startedAt, from));
if (to) conditions.push(lte(chargeSessions.startedAt, to));

const sessions = db.select({...})
  .from(chargeSessions)
  .leftJoin(plugs, eq(chargeSessions.plugId, plugs.id))
  .leftJoin(deviceProfiles, eq(chargeSessions.profileId, deviceProfiles.id))
  .where(and(...conditions))
  .orderBy(desc(chargeSessions.startedAt))
  .limit(limit)
  .offset(offset)
  .all();
```

### Pattern 4: Session Detail with Reference Overlay
**What:** Load session readings from `sessionReadings` table and reference curve from `referenceCurvePoints`, align timestamps, pass both to `PowerChart` as `initialData` and `referenceData`.
**When to use:** `/history/[sessionId]` detail page.
**Key insight:** `PowerChart` already accepts `referenceData` prop as `Array<[number, number]>` and renders it as a dashed gray overlay line. Session readings have `offsetMs` and reference curve points have `offsetSeconds` -- both need alignment to a common base timestamp for chart display.

### Anti-Patterns to Avoid
- **Polling for notifications instead of EventBus:** The EventBus already emits all charge state changes. Never poll the database for "new" events.
- **Client-side Pushover calls:** Pushover credentials must stay server-side. Never expose API token to the browser.
- **Loading all readings for history list:** Only load full readings on detail page. History list should show summary data only (from `chargeSessions` table).

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Push notification delivery | Custom WebSocket/polling | Pushover API (single HTTP POST) | Reliable cross-platform delivery, already configured in settings |
| Session power chart | New chart component | Existing `PowerChart` with `initialData` + `referenceData` | Already supports reference overlay, sliding window, fullscreen, zoom |
| Date formatting | Custom date formatting | `toLocaleDateString('de-DE')` / `toLocaleTimeString('de-DE')` | Already used throughout project (see profile-detail page) |
| Duration formatting | Custom duration calc | Simple `(stoppedAt - startedAt)` with h/m/s formatting | Sessions already store startedAt/stoppedAt as epoch ms |

## Common Pitfalls

### Pitfall 1: Duplicate Notifications on State Re-emission
**What goes wrong:** ChargeMonitor emits `charge:*` on every reading during charging/countdown (for SSE updates), which would trigger duplicate notifications.
**Why it happens:** `emitChargeEvent` is called in `updateSocTracking` (every reading) and in `handleTransition` (state changes). NotificationService must only react to state TRANSITIONS, not repeated emissions of the same state.
**How to avoid:** Track last-notified state per plug in NotificationService. Only send notification when state differs from last notification for that plug.
**Warning signs:** Multiple identical Pushover messages for the same event.

### Pitfall 2: Missing Session Readings for History Charts
**What goes wrong:** Session detail page shows empty chart because `sessionReadings` has no data.
**Why it happens:** Need to verify that `sessionReadings` is actually being populated during charge sessions. The schema exists but insertions happen elsewhere.
**How to avoid:** Check that the ChargeMonitor (or a separate listener) writes to `sessionReadings` during active sessions. If not yet implemented, this must be added.
**Warning signs:** `sessionReadings` table is empty after completed sessions.

### Pitfall 3: Pushover API Rate Limiting
**What goes wrong:** Pushover returns 429 or blocks the app.
**Why it happens:** Pushover allows 10,000 messages per app per month. Not a concern for normal use, but rapid error-recovery cycles could generate many notifications.
**How to avoid:** Implement simple cooldown -- don't send same notification type for same plug within 60 seconds.
**Warning signs:** Pushover API returning non-200 responses.

### Pitfall 4: Reference Curve Alignment for History Chart
**What goes wrong:** Session curve and reference curve don't line up visually.
**Why it happens:** Session readings use `offsetMs` (ms from session start), reference curve points use `offsetSeconds`. Both need conversion to absolute timestamps based on session `startedAt` for the chart to overlay correctly. Also, partial charges (CHRG-04) have a `curveOffsetSeconds` that shifts where on the reference curve the session started.
**How to avoid:** Convert both to absolute timestamps: `session.startedAt + reading.offsetMs` for session data, `session.startedAt - (curveOffsetSeconds * 1000) + (point.offsetSeconds * 1000)` for reference data.
**Warning signs:** Reference curve appears shifted left/right relative to actual session data.

## Code Examples

### Reading Pushover Credentials from Config
```typescript
// Pattern already used in settings -- read from config table
const userKey = db.select().from(config).where(eq(config.key, 'pushover.userKey')).get()?.value;
const apiToken = db.select().from(config).where(eq(config.key, 'pushover.apiToken')).get()?.value;
```

### Session History Query with Joins
```typescript
// Existing pattern from sessions/route.ts -- extend for history
const sessions = db
  .select({
    id: chargeSessions.id,
    plugId: chargeSessions.plugId,
    plugName: plugs.name,
    profileId: chargeSessions.profileId,
    profileName: deviceProfiles.name,
    state: chargeSessions.state,
    energyWh: chargeSessions.energyWh,
    estimatedSoc: chargeSessions.estimatedSoc,
    targetSoc: chargeSessions.targetSoc,
    startedAt: chargeSessions.startedAt,
    stoppedAt: chargeSessions.stoppedAt,
    stopReason: chargeSessions.stopReason,
  })
  .from(chargeSessions)
  .leftJoin(plugs, eq(chargeSessions.plugId, plugs.id))
  .leftJoin(deviceProfiles, eq(chargeSessions.profileId, deviceProfiles.id))
  .orderBy(desc(chargeSessions.startedAt))
  .all();
```

### Initializing NotificationService in server.ts
```typescript
// In server.ts main(), after ChargeMonitor initialization:
import { NotificationService } from './src/modules/notifications/notification-service';

const notificationService = new NotificationService(eventBus);
notificationService.start();

// In shutdown:
notificationService.stop();
```

### Sidebar Link Activation
```typescript
// In sidebar.tsx -- simply remove disabled: true
const NAV_ITEMS = [
  { href: '/', label: 'Dashboard' },
  { href: '/devices', label: 'Geraete' },
  { href: '/profiles', label: 'Profile' },
  { href: '/settings', label: 'Einstellungen' },
  { href: '/history', label: 'Verlauf' }, // removed disabled: true
];
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Pushover form-encoded POST | Pushover JSON POST | Supported since API v1 | Both work, JSON is cleaner with native fetch |

**Deprecated/outdated:**
- Nothing relevant -- Pushover API has been stable for years.

## Open Questions

1. **Are sessionReadings being populated during charge sessions?**
   - What we know: The `sessionReadings` table exists in schema, and the `GET /api/charging/sessions/[id]` route reads from it. The ChargeMonitor writes to `chargeSessions` but the code for inserting into `sessionReadings` is not visible in charge-monitor.ts.
   - What's unclear: Where/when individual readings are inserted into `sessionReadings`. This might be in a separate listener or might need to be implemented.
   - Recommendation: Check if sessionReadings insertion exists elsewhere. If not, add it to ChargeMonitor's `handlePowerReading` for active sessions (or as a separate EventBus listener). This is critical for HIST-03.

2. **State transition events for the timeline log**
   - What we know: D-45 requests an "Ereignis-Log (State-Uebergaenge als Timeline)" in session detail.
   - What's unclear: State transitions are not currently logged as separate records -- only the current state is stored on `chargeSessions`. To show a timeline, we either need a new `session_events` table or reconstruct from session data.
   - Recommendation: Add a lightweight `session_events` table (sessionId, state, timestamp) and insert a row on each `handleTransition` call. This is the cleanest approach for the timeline UI.

## Discretion Recommendations

### History Page Layout: Table
**Recommendation:** Use a table layout (not cards) for the history list. Reasons:
- Sessions have uniform fields (date, device, profile, duration, energy, status) -- perfect for tabular display
- Consistent with the project's existing patterns (the netzbetreiber-master parent project uses tables extensively)
- Easier to scan and compare sessions
- Add client-side filters above the table: device dropdown, status dropdown, date range

### Event Log Display: Vertical Timeline with State Badges
**Recommendation:** Use a vertical timeline with colored state badges (similar to git log). Each entry shows timestamp + state name + optional detail. States get colors: detecting (yellow), matched (blue), charging (green), complete (green-bright), error (red), aborted (orange).

### Pushover Message Text
**Recommendation:** German text, concise, with key data points. Include device name and relevant metric (SOC %, confidence %, etc.). Title should be the event type, message body the details.

## Sources

### Primary (HIGH confidence)
- Project codebase: `server.ts`, `charge-monitor.ts`, `event-bus.ts`, `schema.ts` -- direct code inspection
- Existing API routes: `sessions/route.ts`, `sessions/[id]/route.ts` -- confirmed data model and query patterns
- `power-chart.tsx` -- confirmed `referenceData` overlay support

### Secondary (MEDIUM confidence)
- [Pushover API documentation](https://pushover.net/api) -- POST endpoint, parameters, priority levels

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - no new dependencies, all existing project infrastructure
- Architecture: HIGH - patterns directly follow existing codebase conventions (EventBus listeners, Drizzle queries, server components)
- Pitfalls: HIGH - identified from direct code reading (duplicate emission pattern visible in charge-monitor.ts)
- Open questions: MEDIUM - sessionReadings population and state event logging need verification during implementation

**Research date:** 2026-03-29
**Valid until:** 2026-04-28 (stable -- all dependencies already in project)
