# Phase 3: Charge Intelligence - Research

**Researched:** 2026-03-26
**Domain:** Device profile learning, DTW curve matching, SOC estimation, charging state machine, auto-stop relay control
**Confidence:** MEDIUM-HIGH

## Summary

Phase 3 is the core value delivery of the entire project. It adds device profile learning (recording full charge cycles), automatic device detection via Dynamic Time Warping (DTW) curve matching, State-of-Charge (SOC) estimation from reference curves, a persistent server-side charging state machine, and automatic charging stop at target SOC via relay control.

The existing codebase provides strong foundations: a singleton MqttService with `publishCommand` for relay control, an EventBus with typed power readings, SSE streaming to the browser, a PowerChart component (ECharts), and SQLite via Drizzle ORM with WAL mode. Phase 3 extends all of these. The primary new module is `ChargeMonitor` -- a server-side singleton service that subscribes to EventBus power readings and manages per-plug charge state machines.

**Primary recommendation:** Build the ChargeMonitor as a server-side singleton (same pattern as MqttService), implement DTW from scratch (~60 lines of TypeScript, no library dependency needed), use energy-based SOC estimation with 10% boundary pre-computation, and extend the existing SSE endpoint with charge state events.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- **D-25:** Wizard / Step-by-Step to start learning: 1. Enter device name 2. Select Shelly Plug 3. Hint "Akku moeglichst leer?" 4. Start recording.
- **D-26:** During learning: Live chart showing the charge curve being recorded in real-time, Wh counter, elapsed time, "Ladevorgang aktiv" badge. Full detail visible.
- **D-27:** Learning end detection: App auto-detects when power drops to ~0W (charge complete). Shows confirmation dialog.
- **D-28:** CRITICAL: Learning runs completely server-side. User can close browser. State persisted in DB.
- **D-29:** Dedicated /profiles page in sidebar navigation.
- **D-30:** Profile attributes: Name (required), Beschreibung, Modellbezeichnung, Kaufdatum, geschaetzte Ladezyklen (all optional). Extended attributes for v2 community library.
- **D-31:** Ziel-SOC per profile via 10%-Schritte Buttons (10%, 20%, ... 100%).
- **D-32:** Profile actions: View reference curve, edit attributes, re-learn, delete.
- **D-33:** When device detected: Banner with confidence, override controls.
- **D-34:** User can intervene at any time: change profile, adjust SOC, abort.
- **D-36:** Unknown device: Offer "Jetzt anlernen" or "Bestehendes Profil zuweisen".
- **D-37:** Countdown in dashboard during last ~5% before target SOC.
- **D-39:** No separate emergency stop button -- existing Relay Toggle is sufficient.

### Claude's Discretion
- Override UI layout (D-35)
- Relay failure/retry strategy (D-38)
- DTW algorithm implementation details (threshold tuning, window size, confidence calculation)
- SOC estimation algorithm (energy-based from reference curve)
- Charge state machine design (idle -> detecting -> charging -> countdown -> stopped)
- Power threshold for "charging started" vs "idle" detection
- How curve data from manual profile assignments feeds back into recognition

### Deferred Ideas (OUT OF SCOPE)
- Profile community library (export/import via GitHub repo) -- v2
- Profile image upload -- v2
- Multiple reference curves per profile -- v2 (single reference curve sufficient for v1)
- Partial charge curve alignment (start at 40% SOC) -- v1.x after basic matching works
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| PROF-01 | User can create a new device profile (name, description) | DB schema `device_profiles` table, /profiles page, API routes |
| PROF-02 | User can start "learn mode" to record a full reference charge cycle | ChargeMonitor `LEARNING` state, server-side recording, wizard UI |
| PROF-03 | Reference charge curve is stored with timestamped power data points | `reference_curves` + `reference_curve_points` tables, downsample to 1/sec |
| PROF-04 | App automatically detects charge-complete (power drops to ~0W) | Power threshold detection in ChargeMonitor, configurable idle threshold |
| PROF-05 | App derives SOC boundaries (10% steps) from reference curve (energy-based) | Energy integration algorithm, `soc_boundaries` table |
| PROF-06 | User can set target SOC per device profile (e.g., 80%) | `target_soc` column on `device_profiles`, 10%-step button UI |
| PROF-07 | User can view and manage all device profiles (list, edit, delete) | /profiles page, /api/profiles CRUD routes |
| CHRG-01 | App auto-detects which device is charging via curve matching (first 1-2 min) | DTW subsequence matching algorithm, quick-reject by power range |
| CHRG-02 | User can manually override the detected profile at any time | API route to reassign session profile, banner UI controls |
| CHRG-03 | App estimates current SOC based on position on reference curve | Energy-based SOC tracking using cumulative Wh vs reference |
| CHRG-04 | App handles partial charges (device not at 0% when plugged in) | Subsequence DTW finds offset on reference curve, SOC = offset position |
| CHRG-05 | App automatically stops charging at target SOC by switching relay off | ChargeMonitor `COUNTDOWN` -> `STOPPING` states, relay command |
| CHRG-06 | Auto-stop uses HTTP API fallback if MQTT switch command fails | Existing relay route pattern extended with verification loop |
| CHRG-07 | Relay switching includes hysteresis to prevent rapid on/off cycling | Minimum state duration, cooldown timer, debounce logic |
| VIZL-03 | Current charge curve overlaid on reference curve in same chart | ECharts dual series -- dashed line for reference, solid for live |
</phase_requirements>

## Standard Stack

### Core (already installed)
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| better-sqlite3 | 12.8.0 | SQLite driver | Already in use, synchronous API, fast |
| drizzle-orm | 0.45.1 | Type-safe ORM | Already in use for all DB operations |
| echarts | 6.0.0 | Charting library | Already in use for PowerChart, supports multi-series overlay natively |
| echarts-for-react | 3.0.6 | React wrapper | Already in use |
| mqtt | 5.15.1 | MQTT client | Already in use for Shelly communication |

### No New Dependencies Needed

DTW is implemented from scratch (~60 lines). The state machine is a simple TypeScript class (no library). SOC estimation is arithmetic over stored curve data. **Zero new npm packages required for Phase 3.**

Rationale for no DTW library:
- Available npm packages (`dtw`, `dynamic-time-warping`, `dynamic-time-warping-2`) are tiny, unmaintained wrappers around ~30 lines of code
- We need **subsequence DTW** (not standard DTW), which none of those packages support
- Our data sizes are small (120 query points vs. ~7200 reference points with windowed search) -- no performance optimization needed
- Custom implementation is easier to tune for our specific use case (power thresholds, confidence scoring)

Rationale for no FSM library:
- Our state machine has 6-7 states with simple, deterministic transitions
- Each transition triggers specific side effects (DB writes, relay commands, SSE events)
- A library would add abstraction overhead without meaningful benefit
- A plain TypeScript class with a `transition(event)` method and a `switch` statement is sufficient and more readable

## Architecture Patterns

### New Module Structure
```
src/
  modules/
    charging/
      charge-monitor.ts       # Server-side singleton, manages per-plug state machines
      charge-state-machine.ts # FSM: idle -> detecting -> learning -> matched -> charging -> countdown -> stopping -> complete
      dtw.ts                  # DTW distance + subsequence DTW matching
      curve-matcher.ts        # Orchestrates quick-reject + DTW, returns MatchResult
      soc-estimator.ts        # Energy-based SOC calculation from reference curve
      relay-controller.ts     # MQTT publish + HTTP fallback + verify + retry
    events/
      event-bus.ts            # Extended with charge state events (existing file)
  db/
    schema.ts                 # Extended with new tables (existing file)
  app/
    profiles/
      page.tsx                # Profile list page
      [id]/
        page.tsx              # Profile detail / edit page
      learn/
        page.tsx              # Learn mode wizard page
    api/
      profiles/
        route.ts              # GET list, POST create
        [id]/
          route.ts            # GET, PUT, DELETE single profile
          curve/
            route.ts          # GET reference curve data points
      charging/
        sessions/
          route.ts            # GET active sessions
          [id]/
            route.ts          # GET session detail, PUT override profile/SOC
            abort/
              route.ts        # POST abort session
        learn/
          start/
            route.ts          # POST start learn mode for a plug
          stop/
            route.ts          # POST stop/save learn mode
          status/
            route.ts          # GET current learn mode status
  components/
    charts/
      power-chart.tsx         # Extended with reference curve overlay series
    charging/
      charge-banner.tsx       # Active session banner with controls
      learn-wizard.tsx        # Step-by-step learn mode wizard
      soc-buttons.tsx         # 10%-step SOC target selector
      countdown-display.tsx   # Last 5% countdown visualization
```

### Pattern 1: ChargeMonitor as Server-Side Singleton

**What:** A class instantiated once in `server.ts`, subscribing to EventBus power readings, managing one state machine per plug.
**When:** Always running while the server is up.
**Why:** D-28 requires learn mode to survive browser close. The ChargeMonitor is the authority for all charging state.

```typescript
// server.ts addition
const chargeMonitor = new ChargeMonitor(eventBus, mqttService, db);
chargeMonitor.start();
globalThis.__chargeMonitor = chargeMonitor;
```

The ChargeMonitor:
1. Listens to `power:*` events from EventBus
2. Maintains a `Map<string, ChargeStateMachine>` (plugId -> FSM)
3. On each power reading, feeds it to the corresponding FSM
4. FSM transitions trigger: DB writes, SSE events, relay commands

### Pattern 2: Charge State Machine (per plug)

**What:** Explicit finite state machine with these states:

```
IDLE ──(apower > CHARGE_THRESHOLD for DETECTION_DELAY)──> DETECTING
  ^                                                           |
  |                                            (DTW match found)
  |                                                           |
  |                                                           v
  |                                                       MATCHED
  |                                                    (banner shown)
  |                                                           |
  |                                              (user confirms or timeout)
  |                                                           |
  |                                                           v
  +──(apower < IDLE_THRESHOLD for IDLE_DELAY)──────── CHARGING
  |                                                           |
  |                                              (SOC >= target - 5%)
  |                                                           |
  |                                                           v
  +──(manual abort)─────────────────────────── COUNTDOWN
  |                                                           |
  |                                              (SOC >= target)
  |                                                           |
  |                                                           v
  +──────────────────────────────────────── STOPPING
                                                              |
                                                   (relay confirmed off)
                                                              |
                                                              v
                                                          COMPLETE ──> IDLE
```

Additionally, a separate `LEARNING` state for learn mode:
```
IDLE ──(user starts learn mode)──> LEARNING ──(apower < IDLE_THRESHOLD)──> LEARN_COMPLETE
```

**When:** One per registered plug.
**Why:** Makes state transitions explicit and testable. Each transition has well-defined side effects.

### Pattern 3: SSE Event Extension for Charge State

**What:** Extend the existing `/api/sse/power` endpoint to also emit charge state events.
**When:** Any charge state transition occurs.
**Implementation:** Add new event types to EventBus:

```typescript
// New events on EventBus
eventBus.emit('charge:state', {
  plugId: string,
  state: 'idle' | 'detecting' | 'matched' | 'charging' | 'countdown' | 'stopping' | 'complete' | 'learning',
  profileId?: number,
  profileName?: string,
  confidence?: number,
  estimatedSoc?: number,
  targetSoc?: number,
  sessionId?: number,
});
```

The existing SSE route adds a listener for `charge:*` and emits as a named SSE event. Browser-side code adds an `addEventListener('charge', ...)` on the shared EventSource.

### Pattern 4: Energy-Based SOC Estimation

**What:** Track cumulative Wh consumed since charge start. Compare against reference curve's pre-computed energy boundaries.
**When:** During active CHARGING state, updated on each power reading.
**Why:** More reliable than time-based estimation because charging speed varies with temperature and voltage.

```typescript
// Pre-computed during learn mode save
interface SocBoundary {
  soc: number;          // 10, 20, 30 ... 100
  offsetSeconds: number;
  cumulativeWh: number; // Key metric for SOC estimation
}

// During charging
const currentWh = sessionCumulativeWh;
const totalWh = referenceTotalWh;

// Find offset on reference curve
const estimatedSocFromEnergy = (currentWh / totalWh) * 100;

// For partial charges: startWh is estimated from DTW curve offset
const adjustedSoc = startSoc + ((currentWh / (totalWh - startWh)) * (100 - startSoc));
```

### Anti-Patterns to Avoid

- **Running DTW in the MQTT message handler:** Buffer readings in ChargeMonitor, run DTW asynchronously after accumulating 60-120 seconds of data
- **Storing every raw reading during learn mode at full frequency:** Downsample to 1 reading/second for reference curves. Keep session_readings at native frequency only for active display.
- **Polling for charge state from UI:** Use SSE push. The charge state lives on the server; the browser is a passive consumer.
- **Direct relay control from UI during auto-stop:** All relay commands for auto-stop go through ChargeMonitor, which handles verification and retry. Manual toggle via existing relay route remains separate.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Chart overlay | Custom canvas rendering | ECharts multi-series (built-in) | ECharts natively supports multiple series on the same axes with different styles |
| Time-series storage | Custom binary format | SQLite `reference_curve_points` table | SQLite handles 14,400 points per curve trivially |
| Real-time push | Polling loop | Existing SSE infrastructure | Already built and working in Phase 2 |
| HTTP relay fallback | Custom HTTP client | `fetch()` to Shelly HTTP API | Standard `fetch` is sufficient for simple GET requests to local device |

**Key insight:** DTW and the state machine are the only genuinely new algorithms. Everything else extends existing infrastructure.

## Common Pitfalls

### Pitfall 1: Charge Detection False Positives
**What goes wrong:** Microwave, kettle, or other high-power devices trigger charge detection when plugged into the Shelly.
**Why it happens:** Power threshold alone cannot distinguish a charger from another appliance.
**How to avoid:** Use a **sustained power** check -- require power above threshold for at least 30 seconds before transitioning from IDLE to DETECTING. Additionally, the DTW matching in DETECTING state acts as a second gate -- if no profile matches after 2 minutes, the session is marked as "unknown device" (not auto-managed).
**Warning signs:** Frequent false DETECTING states in the charge_sessions table.

### Pitfall 2: Shelly Status Updates Are Event-Driven, Not Periodic
**What goes wrong:** During constant-power phases (CC charging), Shelly may publish updates only every 10-30 seconds because the value barely changes. This creates sparse data for curve recording and matching.
**Why it happens:** Shelly Gen2/Gen3 devices publish status on significant change, not at fixed intervals.
**How to avoid:** During LEARNING and CHARGING states, the ChargeMonitor should request periodic status updates via MQTT RPC command (`<prefix>/rpc` with `Switch.GetStatus`) every 2-5 seconds to ensure consistent data density. The MqttService already has `publishCommand` -- add a `requestStatus(topicPrefix)` method.
**Warning signs:** Gaps in recorded reference curves, inaccurate SOC estimation.

### Pitfall 3: DTW Confidence Threshold Tuning
**What goes wrong:** Threshold too low = wrong device matched. Threshold too high = valid device not recognized.
**Why it happens:** DTW distance values are data-dependent and hard to predict without real data.
**How to avoid:** Start with a conservative threshold (require high confidence, e.g., 0.85). Log all DTW scores to the charge_sessions table so the threshold can be tuned empirically. Show confidence in the UI banner so the user sees when matching is weak.
**Warning signs:** User frequently overrides detected profile.

### Pitfall 4: Relay Command Failure During Auto-Stop
**What goes wrong:** MQTT `off` command is sent but relay doesn't actually switch. Charging continues past target SOC.
**Why it happens:** MQTT QoS 0 is fire-and-forget. Network hiccup = lost command.
**How to avoid:** After sending MQTT `off`, wait 2-3 seconds. Check next power reading. If apower is still above threshold, retry via HTTP API (`http://<ip>/rpc/Switch.Set?id=0&on=false`). If HTTP also fails, enter ERROR state and emit alert event (for Phase 4 Pushover notification).
**Warning signs:** `stop_reason = 'error'` in charge_sessions.

### Pitfall 5: Race Condition Between Manual Toggle and Auto-Stop
**What goes wrong:** User manually toggles relay ON via dashboard while ChargeMonitor is in STOPPING state. ChargeMonitor immediately turns it OFF again, creating a rapid on/off cycle.
**How to avoid:** Implement hysteresis (CHRG-07). After auto-stop triggers relay OFF, enter a cooldown period (minimum 60 seconds). During cooldown, if relay is manually turned ON, abort the auto-stop and transition to IDLE. Also: any manual relay action during an active session should pause auto-management and let the user take control.
**Warning signs:** Rapid relay switching visible in power readings.

### Pitfall 6: Learn Mode Recording Interrupted by Server Restart
**What goes wrong:** Server restarts during a multi-hour learn recording. Recording state is lost.
**Why it happens:** If recording state is only in-memory (ChargeMonitor Map), it doesn't survive process restart.
**How to avoid:** Persist learn mode state in the `charge_sessions` table with `state = 'learning'`. On server startup, ChargeMonitor checks for any sessions in 'learning' state and resumes recording. All readings during learn mode are persisted to `session_readings` immediately (not buffered).
**Warning signs:** Incomplete reference curves after server restart.

### Pitfall 7: SOC Estimation Drift During Partial Charges
**What goes wrong:** Device plugged in at ~50% SOC. DTW estimates starting position, but cumulative energy tracking drifts because the reference curve was recorded from 0%.
**Why it happens:** The non-linear CC-to-CV charging relationship means equal time intervals don't correspond to equal energy intervals. If the starting offset estimate is slightly wrong, the error compounds.
**How to avoid:** Use energy (Wh) as the primary SOC metric, not time. Cross-check against the reference curve's pre-computed SOC boundaries. If energy-based and time-based estimates diverge by more than 10%, log a warning and prefer the energy-based estimate.
**Warning signs:** SOC jumps or resets during a charging session.

## Code Examples

### DTW Implementation (subsequence variant)

```typescript
// src/modules/charging/dtw.ts

/**
 * Standard DTW distance between two 1D sequences.
 * Returns normalized distance (lower = more similar).
 */
export function dtwDistance(query: number[], reference: number[]): number {
  const n = query.length;
  const m = reference.length;

  // Cost matrix -- use flat array for performance
  const cost = new Float64Array((n + 1) * (m + 1));
  const w = m + 1;

  // Initialize with infinity
  cost.fill(Infinity);
  cost[0] = 0;

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const d = Math.abs(query[i - 1] - reference[j - 1]);
      cost[i * w + j] = d + Math.min(
        cost[(i - 1) * w + j],     // insertion
        cost[i * w + (j - 1)],     // deletion
        cost[(i - 1) * w + (j - 1)] // match
      );
    }
  }

  return cost[n * w + m] / Math.max(n, m);
}

/**
 * Subsequence DTW: find the best matching window of `query` within `reference`.
 * Returns { offset, distance } where offset is the starting index in reference.
 */
export function subsequenceDtw(
  query: number[],
  reference: number[],
  windowStep: number = 5
): { offset: number; distance: number } {
  const queryLen = query.length;
  const refLen = reference.length;

  let bestOffset = 0;
  let bestDistance = Infinity;

  // Slide query window along reference
  for (let offset = 0; offset <= refLen - queryLen; offset += windowStep) {
    const refWindow = reference.slice(offset, offset + queryLen);
    const dist = dtwDistance(query, refWindow);

    if (dist < bestDistance) {
      bestDistance = dist;
      bestOffset = offset;
    }
  }

  return { offset: bestOffset, distance: bestDistance };
}
```

### Curve Matcher

```typescript
// src/modules/charging/curve-matcher.ts

export interface MatchResult {
  profileId: number;
  profileName: string;
  confidence: number;       // 0.0-1.0
  curveOffsetSeconds: number;
  estimatedStartSoc: number;
}

const CONFIDENCE_THRESHOLD = 0.70;
const POWER_TOLERANCE_PERCENT = 0.25; // 25% tolerance for quick-reject

export async function matchCurve(
  queryReadings: number[], // 60-120 power readings at 1/sec
  profiles: ProfileWithCurve[]
): Promise<MatchResult | null> {
  // Phase 1: Quick-reject by initial power range
  const avgQueryPower = queryReadings.slice(0, 10).reduce((a, b) => a + b, 0) / 10;
  const candidates = profiles.filter(p => {
    const tolerance = p.curve.startPower * POWER_TOLERANCE_PERCENT;
    return Math.abs(avgQueryPower - p.curve.startPower) <= tolerance;
  });

  if (candidates.length === 0) return null;

  // Phase 2: Subsequence DTW on remaining candidates
  let bestMatch: MatchResult | null = null;
  let bestDistance = Infinity;

  for (const profile of candidates) {
    const refPowers = profile.curvePoints.map(p => p.apower);
    const { offset, distance } = subsequenceDtw(queryReadings, refPowers);

    if (distance < bestDistance) {
      bestDistance = distance;
      const confidence = Math.max(0, 1 - distance / (avgQueryPower || 1));
      const offsetSeconds = profile.curvePoints[offset]?.offsetSeconds ?? 0;
      const totalDuration = profile.curve.durationSeconds;

      bestMatch = {
        profileId: profile.id,
        profileName: profile.name,
        confidence,
        curveOffsetSeconds: offsetSeconds,
        estimatedStartSoc: Math.round((offsetSeconds / totalDuration) * 100),
      };
    }
  }

  if (bestMatch && bestMatch.confidence >= CONFIDENCE_THRESHOLD) {
    return bestMatch;
  }

  return null;
}
```

### Relay Controller with Fallback

```typescript
// src/modules/charging/relay-controller.ts

const VERIFY_DELAY_MS = 3000;
const MAX_RETRIES = 3;

export async function switchRelayOff(
  mqttService: MqttService,
  plug: { mqttTopicPrefix: string; ipAddress: string | null },
  eventBus: EventBus
): Promise<boolean> {
  // Attempt 1: MQTT
  mqttService.publishCommand(plug.mqttTopicPrefix, 'off');

  // Wait and verify via next power reading
  const verified = await waitForPowerDrop(eventBus, plug.mqttTopicPrefix, VERIFY_DELAY_MS);
  if (verified) return true;

  // Attempt 2-3: HTTP fallback
  if (plug.ipAddress) {
    for (let retry = 0; retry < MAX_RETRIES; retry++) {
      try {
        const res = await fetch(
          `http://${plug.ipAddress}/rpc/Switch.Set?id=0&on=false`,
          { signal: AbortSignal.timeout(3000) }
        );
        if (res.ok) {
          const innerVerified = await waitForPowerDrop(eventBus, plug.mqttTopicPrefix, VERIFY_DELAY_MS);
          if (innerVerified) return true;
        }
      } catch {
        // HTTP request failed, retry
      }
    }
  }

  return false; // All attempts failed
}
```

### ECharts Reference Curve Overlay (VIZL-03)

```typescript
// Extension to buildChartOption in power-chart.tsx
function buildChartOption(
  liveData: Array<[number, number]>,
  referenceData?: Array<[number, number]> // [timestamp, watts] aligned to session start
): EChartsOption {
  const series: EChartsOption['series'] = [
    {
      name: 'Aktuell',
      type: 'line',
      smooth: true,
      showSymbol: false,
      areaStyle: { /* existing blue gradient */ },
      lineStyle: { color: '#3b82f6', width: 2 },
      data: liveData,
    },
  ];

  if (referenceData && referenceData.length > 0) {
    series.push({
      name: 'Referenz',
      type: 'line',
      smooth: true,
      showSymbol: false,
      lineStyle: {
        color: '#6b7280',  // gray-500
        width: 1.5,
        type: 'dashed',
      },
      areaStyle: undefined, // No fill for reference
      data: referenceData,
      z: 0, // Behind the live data
    });
  }

  return {
    /* ... existing config ... */
    legend: referenceData ? {
      data: ['Aktuell', 'Referenz'],
      textStyle: { color: '#a3a3a3' },
    } : undefined,
    series,
  };
}
```

### Database Schema Extension

```typescript
// Additions to src/db/schema.ts

export const deviceProfiles = sqliteTable('device_profiles', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  description: text('description'),
  modelName: text('model_name'),        // Modellbezeichnung
  purchaseDate: text('purchase_date'),   // Kaufdatum (ISO string)
  estimatedCycles: integer('estimated_cycles'), // geschaetzte Ladezyklen
  targetSoc: integer('target_soc').notNull().default(80),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const referenceCurves = sqliteTable('reference_curves', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  profileId: integer('profile_id').notNull().references(() => deviceProfiles.id, { onDelete: 'cascade' }),
  startPower: real('start_power').notNull(),
  peakPower: real('peak_power').notNull(),
  totalEnergyWh: real('total_energy_wh').notNull(),
  durationSeconds: integer('duration_seconds').notNull(),
  pointCount: integer('point_count').notNull(),
  createdAt: integer('created_at').notNull(),
});

export const referenceCurvePoints = sqliteTable('reference_curve_points', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  curveId: integer('curve_id').notNull().references(() => referenceCurves.id, { onDelete: 'cascade' }),
  offsetSeconds: integer('offset_seconds').notNull(),
  apower: real('apower').notNull(),
  voltage: real('voltage'),
  current: real('current'),
  cumulativeWh: real('cumulative_wh').notNull(), // Running total for SOC estimation
});

export const socBoundaries = sqliteTable('soc_boundaries', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  curveId: integer('curve_id').notNull().references(() => referenceCurves.id, { onDelete: 'cascade' }),
  soc: integer('soc').notNull(),              // 10, 20, 30 ... 100
  offsetSeconds: integer('offset_seconds').notNull(),
  cumulativeWh: real('cumulative_wh').notNull(),
  expectedPower: real('expected_power').notNull(),
});

export const chargeSessions = sqliteTable('charge_sessions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  plugId: text('plug_id').notNull().references(() => plugs.id),
  profileId: integer('profile_id').references(() => deviceProfiles.id),
  state: text('state').notNull().default('detecting'),
  // states: idle, detecting, matched, charging, countdown, stopping, complete, aborted, learning, learn_complete, error
  detectionConfidence: real('detection_confidence'),
  curveOffsetSeconds: integer('curve_offset_seconds'),
  targetSoc: integer('target_soc'),
  estimatedSoc: integer('estimated_soc'),
  startedAt: integer('started_at').notNull(),
  stoppedAt: integer('stopped_at'),
  stopReason: text('stop_reason'), // target_reached, manual, error, idle_detected, aborted
  energyWh: real('energy_wh'),
  dtwScore: real('dtw_score'),      // Raw DTW distance for threshold tuning
  createdAt: integer('created_at').notNull(),
});

export const sessionReadings = sqliteTable('session_readings', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  sessionId: integer('session_id').notNull().references(() => chargeSessions.id, { onDelete: 'cascade' }),
  offsetMs: integer('offset_ms').notNull(),
  apower: real('apower').notNull(),
  voltage: real('voltage'),
  current: real('current'),
  timestamp: integer('timestamp').notNull(),
});
```

### Indexes for Performance

```typescript
// Drizzle ORM index definitions -- add to schema
import { index } from 'drizzle-orm/sqlite-core';

// On reference_curve_points: fast curve loading
// CREATE INDEX idx_rcp_curve ON reference_curve_points(curve_id, offset_seconds)

// On session_readings: fast session data retrieval
// CREATE INDEX idx_sr_session ON session_readings(session_id, offset_ms)

// On charge_sessions: find active sessions
// CREATE INDEX idx_cs_state ON charge_sessions(state)
// CREATE INDEX idx_cs_plug ON charge_sessions(plug_id, started_at)
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Euclidean distance for curve matching | DTW (Dynamic Time Warping) | Standard in NILM research since ~2015 | Handles temporal distortions from temperature, voltage, aging |
| Time-based SOC estimation | Energy-based (Wh integration) | Industry standard | Non-linear CC-to-CV means time != energy proportionally |
| Client-side state management | Server-side persistent state machine | Architectural decision D-28 | Learn mode survives browser close, single source of truth |

## Open Questions

1. **DTW Confidence Calibration**
   - What we know: DTW distance values are unitless and data-dependent. We need a mapping from distance to confidence (0-1).
   - What's unclear: The exact normalization and threshold values that work well with real Shelly power data.
   - Recommendation: Start with `confidence = max(0, 1 - (distance / averagePower))`. Log all DTW scores. Tune threshold after collecting 5-10 real charge sessions. Default threshold: 0.70 (conservative).

2. **Charge Detection Power Threshold**
   - What we know: Need to distinguish "device charging" from "nothing connected" or "standby".
   - What's unclear: The right wattage threshold. Some chargers draw only 5-10W at end of charge (CV taper), while standby might be 1-2W.
   - Recommendation: Use 5W as CHARGE_START threshold (consistent with existing `ACTIVE_POWER_THRESHOLD` in MqttService). Use 2W as CHARGE_END threshold (with 60s sustained below to confirm). Make these configurable per profile.

3. **Reference Curve Downsampling Rate**
   - What we know: 1 reading/second during a 4-hour charge = 14,400 points. This is fine for storage but may be excessive for DTW computation.
   - What's unclear: Whether further downsampling (1 per 5 seconds = 2,880 points) would improve DTW speed without hurting accuracy.
   - Recommendation: Store at 1/sec (full resolution). For DTW matching, use 1 per 5 seconds (query: 12-24 points, reference: ~2880 points). This makes DTW near-instant.

4. **Manual Profile Assignment Feedback**
   - What we know: D-36 says when assigning existing profile to unknown device, "the curve data feeds back into the profile to improve future recognition."
   - What's unclear: How exactly to merge a new charge curve into an existing reference.
   - Recommendation: For v1, simply log the assignment and DTW score. Do NOT modify the reference curve automatically. This avoids curve corruption. Multiple reference curves per profile is deferred to v2.

## Sources

### Primary (HIGH confidence)
- Existing codebase: `server.ts`, `mqtt-service.ts`, `event-bus.ts`, `schema.ts`, `power-chart.tsx`, `relay/route.ts` -- direct code inspection
- `.planning/research/ARCHITECTURE.md` -- DTW algorithm design, state machine design, data model
- `.planning/research/PITFALLS.md` -- Relay QoS 0 failure, sparse Shelly updates, false positives
- [SQLite WAL Mode docs](https://www.sqlite.org/wal.html) -- concurrent read/write guarantees

### Secondary (MEDIUM confidence)
- [DTW for NILM research](https://www.sciencedirect.com/science/article/abs/pii/S0306261917302209) -- DTW is standard for power curve matching
- [Wikipedia: Dynamic Time Warping](https://en.wikipedia.org/wiki/Dynamic_time_warping) -- algorithm definition and properties
- [tslearn subsequence DTW docs](https://tslearn.readthedocs.io/en/stable/gen_modules/metrics/tslearn.metrics.dtw_subsequence_path.html) -- subsequence variant specification
- [ECharts 6 features](https://echarts.apache.org/handbook/en/basics/release-note/v6-feature/) -- multi-series, dark mode, streaming support
- npm packages `dtw`, `dynamic-time-warping` -- evaluated and rejected (too simple, no subsequence support)

### Tertiary (LOW confidence)
- DTW confidence normalization formula -- custom heuristic, needs empirical validation with real data
- Charge detection thresholds (5W start, 2W end) -- reasonable estimates, need tuning with real Shelly devices

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- all libraries already in use, no new deps
- Architecture: HIGH -- follows established singleton/EventBus patterns from Phase 1-2
- DTW algorithm: MEDIUM -- algorithm is well-understood, but threshold tuning needs real data
- State machine: HIGH -- simple FSM, well-defined transitions
- SOC estimation: MEDIUM -- energy-based approach is standard, but accuracy depends on reference curve quality
- Pitfalls: HIGH -- documented from research and existing PITFALLS.md

**Research date:** 2026-03-26
**Valid until:** 2026-04-26 (stable domain, no fast-moving dependencies)
