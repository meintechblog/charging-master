# Phase 2: Real-Time Visualization - Research

**Researched:** 2026-03-25
**Domain:** Real-time data streaming (SSE), charting (ECharts), relay control (MQTT publish)
**Confidence:** HIGH

## Summary

Phase 2 builds the live monitoring and manual control layer on top of the Phase 1 foundation (MQTT service, EventBus, database, plug management). The core deliverables are: (1) an SSE endpoint that bridges EventBus power readings to the browser, (2) ECharts-based real-time power charts with sliding window memory management, (3) enhanced plug cards with live watt values, relay status, and mini-sparklines, (4) relay toggle via MQTT publish command, and (5) a plug detail page with full-size interactive chart.

The existing codebase provides strong foundations: `EventBus` already emits typed `power:${plugId}` and `power:*` events, `MqttService` is a singleton exposed via `globalThis.__mqttService`, and the `PlugCard` component exists with online/offline status but needs extension for live data. The critical gap is that `MqttService` has no `publishCommand()` method -- this must be added for relay control.

**Primary recommendation:** Use a single global SSE endpoint (`/api/sse/power`) streaming all plug events, with client-side filtering by plugId. Use `echarts-for-react` with `'use client'` directive for all chart components. Implement sliding window in a React hook that maintains a fixed-size array and calls `setOption()` for incremental updates.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- **D-13:** Smooth Area Chart with gradient fill (accent color to transparent)
- **D-15:** Time window switchable with buttons: 5m / 15m / 30m / 1h. Default: 15m
- **D-16:** ECharts with dark theme, smooth animations, streaming-optimized. Sliding window to prevent memory leaks
- **D-17:** Toggle Switch directly in Plug Card -- one click, no confirmation dialog
- **D-18:** Optimistic Update + Spinner: UI switches immediately, short spinner until MQTT confirmation. On error rollback with error toast
- **D-19:** One global SSE stream for all plugs. Events filtered by plug ID on the client. Fewer server connections, simpler to manage
- **D-20:** Plug Card live elements: current watt value (with animation), relay status (colored indicator), online/offline status, mini-sparkline (last few minutes)
- **D-21:** Click on Plug Card opens detail view with large chart. Intuitive card-to-detail navigation
- **D-22:** Hover Tooltip with exact watt value + timestamp
- **D-23:** Zoom & Pan horizontal (zoom into time ranges)
- **D-24:** Fullscreen mode for detailed analysis

### Claude's Discretion
- Chart accent color (D-14) -- should fit sleek minimal dark theme, readable on dark background
- Relay Toggle design (D-17)
- SSE architecture details (D-19)
- Card-to-detail navigation pattern (D-21)
- ECharts configuration and animations
- Sparkline duration in cards (last 3-5 minutes)
- Default time window (15m suggested)

### Deferred Ideas (OUT OF SCOPE)
None -- discussion stayed within phase scope
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| VIZL-01 | User sees live power consumption chart updating in real-time (ECharts + SSE) | SSE endpoint pattern, ECharts streaming via setOption(), sliding window hook |
| VIZL-02 | Chart uses sliding window to prevent memory leaks on long sessions | Fixed-size array with shift()/push(), configurable window sizes (5m/15m/30m/1h) |
| VIZL-04 | Dashboard shows all active Shelly Plugs with current power and status | Global SSE stream with client-side filtering, enhanced PlugCard with live data |
| SHLY-04 | User can manually toggle Shelly relay on/off from the UI | New publishCommand() on MqttService, POST API route, optimistic UI toggle |
</phase_requirements>

## Standard Stack

### Core (already installed)
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| echarts | 6.0.0 | Charting engine | Best real-time capability, dark theme built-in, streaming support since v4. Verified current on npm |
| echarts-for-react | 3.0.6 | React wrapper | Thin wrapper providing `<ReactECharts>` with lifecycle management and resize handling |

### Supporting (new installs for this phase)
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| echarts | 6.0.0 | Chart rendering | All chart components (main chart, sparklines) |
| echarts-for-react | 3.0.6 | React integration | Wraps ECharts in React component with ref access |

### Not Needed
| Instead of | Why Not |
|------------|---------|
| react-sparklines | ECharts can render minimal sparklines in cards -- avoids adding another charting library. Use small ECharts instance with minimal config (no axis, no tooltip, no grid padding) |
| socket.io / WebSocket | SSE is sufficient (unidirectional server-to-client). Relay commands go via POST API routes |
| react-echarts-kit | Newer SSR-safe wrapper but echarts-for-react is well-proven and all chart components are 'use client' anyway |

**Installation:**
```bash
pnpm add echarts echarts-for-react
```

## Architecture Patterns

### Recommended Project Structure (Phase 2 additions)
```
src/
  app/
    api/
      sse/
        power/route.ts           # Global SSE endpoint for all plug power data
      devices/
        [id]/
          relay/route.ts         # POST: toggle relay on/off
    devices/
      [id]/
        page.tsx                 # Plug detail page with full chart
  components/
    charts/
      power-chart.tsx            # Full ECharts area chart (detail view)
      sparkline.tsx              # Mini ECharts sparkline (plug card)
    devices/
      plug-card.tsx              # Extended with live data, toggle, sparkline
      relay-toggle.tsx           # Toggle switch component with optimistic update
  hooks/
    use-power-stream.ts          # SSE connection + data buffer management
    use-sliding-window.ts        # Fixed-size array manager for chart data
  lib/
    sse/
      power-stream.ts            # Server-side SSE stream builder (server-only)
```

### Pattern 1: Single Global SSE Stream (D-19)
**What:** One SSE endpoint serves all plug data. Client subscribes once, filters events by plugId.
**When to use:** Always for this phase. Only one `EventSource` connection per browser tab.
**Why:** Browser limits concurrent SSE connections to 6 per domain (HTTP/1.1). With multiple plugs, per-plug SSE endpoints exhaust the limit quickly.

```typescript
// src/app/api/sse/power/route.ts
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request) {
  const eventBus = globalThis.__eventBus;

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();

      // Listen to ALL plug power events via wildcard
      const handler = (data: PowerReading) => {
        try {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(data)}\n\n`)
          );
        } catch {
          // Stream closed, ignore
        }
      };

      eventBus.on('power:*', handler);

      // Also stream online/offline events
      const onlineHandler = (event: PlugOnlineEvent) => {
        try {
          controller.enqueue(
            encoder.encode(`event: online\ndata: ${JSON.stringify(event)}\n\n`)
          );
        } catch {
          // Stream closed
        }
      };
      eventBus.on('online:*', onlineHandler);

      // Cleanup on disconnect
      request.signal.addEventListener('abort', () => {
        eventBus.off('power:*', handler);
        eventBus.off('online:*', onlineHandler);
        try { controller.close(); } catch { /* already closed */ }
      });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no', // Prevents nginx buffering
    },
  });
}
```

### Pattern 2: Client-Side Power Stream Hook
**What:** Custom React hook that manages the EventSource connection and distributes events to subscribers.
**When to use:** In any component needing live power data.

```typescript
// src/hooks/use-power-stream.ts
'use client';
import { useEffect, useRef, useCallback, useState } from 'react';
import type { PowerReading, PlugOnlineEvent } from '@/modules/events/event-bus';

type PowerCallback = (reading: PowerReading) => void;
type OnlineCallback = (event: PlugOnlineEvent) => void;

// Singleton EventSource shared across all hook instances
let sharedEventSource: EventSource | null = null;
let powerListeners = new Map<string, Set<PowerCallback>>();
let onlineListeners = new Set<OnlineCallback>();
let refCount = 0;

function getEventSource(): EventSource {
  if (!sharedEventSource || sharedEventSource.readyState === EventSource.CLOSED) {
    sharedEventSource = new EventSource('/api/sse/power');

    sharedEventSource.onmessage = (event) => {
      const reading: PowerReading = JSON.parse(event.data);
      // Notify plug-specific listeners
      const listeners = powerListeners.get(reading.plugId);
      listeners?.forEach(cb => cb(reading));
      // Notify wildcard listeners
      const wildcardListeners = powerListeners.get('*');
      wildcardListeners?.forEach(cb => cb(reading));
    };

    sharedEventSource.addEventListener('online', (event) => {
      const data: PlugOnlineEvent = JSON.parse((event as MessageEvent).data);
      onlineListeners.forEach(cb => cb(data));
    });
  }
  return sharedEventSource;
}

export function usePowerStream(plugId: string | '*', onReading: PowerCallback) {
  useEffect(() => {
    refCount++;
    getEventSource();

    if (!powerListeners.has(plugId)) {
      powerListeners.set(plugId, new Set());
    }
    powerListeners.get(plugId)!.add(onReading);

    return () => {
      powerListeners.get(plugId)?.delete(onReading);
      refCount--;
      if (refCount === 0 && sharedEventSource) {
        sharedEventSource.close();
        sharedEventSource = null;
      }
    };
  }, [plugId, onReading]);
}
```

### Pattern 3: Sliding Window Data Management (VIZL-02)
**What:** Fixed-size array that drops oldest entries when new data arrives, preventing unbounded memory growth.
**When to use:** In chart components to limit data points.

```typescript
// src/hooks/use-sliding-window.ts
'use client';
import { useRef, useCallback } from 'react';

// Window sizes in data points (at ~1 reading/2sec from Shelly)
const WINDOW_POINTS: Record<string, number> = {
  '5m': 150,    // 5 * 60 / 2
  '15m': 450,   // 15 * 60 / 2
  '30m': 900,   // 30 * 60 / 2
  '1h': 1800,   // 60 * 60 / 2
};

export function useSlidingWindow(windowKey: string = '15m') {
  const dataRef = useRef<Array<[number, number]>>([]); // [timestamp, watts]
  const maxPoints = WINDOW_POINTS[windowKey] ?? 450;

  const push = useCallback((timestamp: number, value: number) => {
    dataRef.current.push([timestamp, value]);
    if (dataRef.current.length > maxPoints) {
      dataRef.current = dataRef.current.slice(-maxPoints);
    }
    return dataRef.current;
  }, [maxPoints]);

  const getData = useCallback(() => dataRef.current, []);
  const clear = useCallback(() => { dataRef.current = []; }, []);

  return { push, getData, clear };
}
```

### Pattern 4: ECharts Real-Time Update via setOption
**What:** Use `chartInstance.setOption()` with partial option merge for incremental chart updates.
**When to use:** When new power data arrives from SSE.

```typescript
// Key insight: Do NOT use appendData (conflicts with setOption).
// Instead, maintain data array in React state/ref and call setOption with new data.

const chartRef = useRef<EChartsInstance | null>(null);

// On new data point from SSE:
const updateChart = useCallback((data: Array<[number, number]>) => {
  const chart = chartRef.current;
  if (!chart) return;

  chart.setOption({
    series: [{
      data: data,
    }],
  });
}, []);
```

### Pattern 5: Relay Control with Optimistic Update (D-18)
**What:** Toggle UI immediately, show spinner, wait for MQTT confirmation, rollback on error.
**When to use:** Relay toggle in plug cards.

```typescript
// Server-side: Add publishCommand to MqttService
// src/modules/mqtt/mqtt-service.ts (addition)
publishCommand(topicPrefix: string, command: 'on' | 'off' | 'toggle'): void {
  if (!this.client) throw new Error('MQTT not connected');
  this.client.publish(`${topicPrefix}/command/switch:0`, command);
}

// API Route: POST /api/devices/[id]/relay
// Reads plug from DB, calls mqttService.publishCommand()
```

### Anti-Patterns to Avoid
- **Multiple EventSource connections:** Do NOT create one SSE connection per plug card. Use the shared singleton pattern from Pattern 2.
- **appendData + setOption mixing:** ECharts has a known bug where `setOption()` clears data loaded via `appendData()`. Use only `setOption()` with full data array replacement.
- **SSR rendering ECharts:** ECharts requires the DOM. All chart components MUST have `'use client'` directive. Do NOT attempt server-side rendering of charts.
- **Missing `force-dynamic` on SSE route:** Without `export const dynamic = 'force-dynamic'`, Next.js may buffer or cache the response, breaking streaming.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Chart rendering | Custom canvas drawing | ECharts 6 + echarts-for-react | Handles animations, tooltips, zoom, dark theme, resize, accessibility |
| SSE reconnection | Manual reconnect logic | Browser native EventSource | Auto-reconnects with exponential backoff built-in |
| Chart dark theme | Custom color configs | ECharts built-in `theme: 'dark'` | Comprehensive dark palette including axes, grid, tooltips |
| Responsive charts | Manual resize listeners | echarts-for-react `opts={{ renderer: 'canvas' }}` | Wrapper handles resize observation automatically |

**Key insight:** ECharts provides extensive built-in functionality (zoom/pan via `dataZoom`, tooltips, fullscreen via toolbox). Configure these declaratively rather than building custom interaction handlers.

## Common Pitfalls

### Pitfall 1: SSE Buffering in Next.js
**What goes wrong:** SSE stream buffers all data and delivers as one blob instead of incrementally.
**Why it happens:** Missing `runtime = 'nodejs'` or `dynamic = 'force-dynamic'` export. Also nginx proxies buffer by default.
**How to avoid:** Always set both exports. Add `X-Accel-Buffering: no` header. Test with `curl -N` before building UI.
**Warning signs:** Data arrives in bursts in DevTools Network tab instead of incrementally.

### Pitfall 2: ECharts Memory Leak with Unbounded Data
**What goes wrong:** Chart accumulates data points forever, browser memory grows until tab crashes.
**Why it happens:** New SSE events push data but old data is never removed.
**How to avoid:** Sliding window pattern (Pattern 3). `shift()` old points when array exceeds window size. Use `useRef` for data array to avoid React re-render overhead on every data point.
**Warning signs:** Browser memory in Task Manager steadily increasing over time.

### Pitfall 3: SSE Connection Limit (6 per domain HTTP/1.1)
**What goes wrong:** Opening multiple SSE connections exhausts browser limit. Additional connections queue and block.
**Why it happens:** Creating a new EventSource per component or per plug.
**How to avoid:** Single global SSE endpoint (D-19). Singleton EventSource pattern in React hook. Client-side filtering by plugId.
**Warning signs:** Some connections stuck in "pending" state in DevTools.

### Pitfall 4: MqttService Missing publishCommand
**What goes wrong:** No way to send relay commands from the UI. The current `MqttService` only subscribes and receives data.
**Why it happens:** Phase 1 focused on ingestion, not control.
**How to avoid:** Add `publishCommand(topicPrefix, command)` method to MqttService before building relay toggle UI. Straightforward addition to existing class.
**Warning signs:** N/A -- this is a known gap in the current code.

### Pitfall 5: ECharts SSR Hydration Errors
**What goes wrong:** Next.js tries to SSR the ECharts component, fails because ECharts needs DOM/window.
**Why it happens:** Component not marked as client component, or ECharts/zrender not transpiled.
**How to avoid:** Mark all chart components with `'use client'`. Add `transpilePackages: ['echarts', 'zrender']` to `next.config.ts`.
**Warning signs:** "window is not defined" or hydration mismatch errors in console.

### Pitfall 6: Race Condition in Optimistic Relay Toggle
**What goes wrong:** User toggles relay, UI flips immediately, but MQTT state update arrives with the OLD state before the new state propagates, causing visual flickering.
**Why it happens:** Shelly publishes status periodically. The first status after toggle may still reflect the old state.
**How to avoid:** After toggle, ignore incoming SSE state updates for that plug for 3-5 seconds (debounce window). Only accept the first status update that matches the expected state, or timeout and rollback.
**Warning signs:** Toggle switch visually bounces between on/off states.

## Code Examples

### ECharts Area Chart Configuration (D-13, D-22, D-23, D-24)
```typescript
// Smooth area chart with gradient fill, dark theme
const chartOption: EChartsOption = {
  backgroundColor: 'transparent',
  tooltip: {
    trigger: 'axis',
    formatter: (params: any) => {
      const p = params[0];
      const date = new Date(p.value[0]);
      const time = date.toLocaleTimeString('de-DE');
      return `${time}<br/>${p.value[1].toFixed(1)} W`;
    },
  },
  xAxis: {
    type: 'time',
    splitLine: { show: false },
    axisLabel: { color: '#737373' }, // neutral-500
  },
  yAxis: {
    type: 'value',
    name: 'Watt',
    splitLine: { lineStyle: { color: '#262626' } }, // neutral-800
    axisLabel: { color: '#737373' },
  },
  dataZoom: [
    { type: 'inside', xAxisIndex: 0 }, // D-23: mouse wheel/pinch zoom
    { type: 'slider', xAxisIndex: 0, bottom: 10 }, // D-23: scroll bar
  ],
  toolbox: {
    feature: {
      dataZoom: { yAxisIndex: 'none' },
      restore: {},
      // D-24: Fullscreen handled by custom container button, not ECharts toolbox
    },
  },
  series: [{
    type: 'line',
    smooth: true,
    showSymbol: false,
    areaStyle: {
      color: {
        type: 'linear',
        x: 0, y: 0, x2: 0, y2: 1,
        colorStops: [
          { offset: 0, color: 'rgba(59, 130, 246, 0.5)' },  // blue-500 @ 50%
          { offset: 1, color: 'rgba(59, 130, 246, 0.0)' },   // transparent
        ],
      },
    },
    lineStyle: { color: '#3b82f6', width: 2 }, // blue-500
    data: [], // populated by sliding window
  }],
  animation: true,
  animationDuration: 300,
};
```

### Sparkline Configuration (D-20)
```typescript
// Minimal ECharts instance for plug card sparkline
const sparklineOption: EChartsOption = {
  grid: { top: 0, right: 0, bottom: 0, left: 0 },
  xAxis: { type: 'time', show: false },
  yAxis: { type: 'value', show: false },
  series: [{
    type: 'line',
    smooth: true,
    showSymbol: false,
    lineStyle: { color: '#3b82f6', width: 1.5 },
    areaStyle: {
      color: {
        type: 'linear',
        x: 0, y: 0, x2: 0, y2: 1,
        colorStops: [
          { offset: 0, color: 'rgba(59, 130, 246, 0.3)' },
          { offset: 1, color: 'rgba(59, 130, 246, 0.0)' },
        ],
      },
    },
    data: [],
  }],
  animation: false, // No animations for sparklines (performance)
};
// Container: ~120px wide x 40px tall
```

### Relay Toggle API Route
```typescript
// src/app/api/devices/[id]/relay/route.ts
export const runtime = 'nodejs';

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const body = await request.json();
  const command = body.command as 'on' | 'off' | 'toggle';

  if (!['on', 'off', 'toggle'].includes(command)) {
    return Response.json({ error: 'invalid_command' }, { status: 400 });
  }

  const mqttService = globalThis.__mqttService;
  if (!mqttService.isConnected()) {
    return Response.json({ error: 'mqtt_disconnected' }, { status: 503 });
  }

  // Look up plug's MQTT topic prefix from DB
  const plug = db.select().from(plugs).where(eq(plugs.id, id)).get();
  if (!plug) {
    return Response.json({ error: 'plug_not_found' }, { status: 404 });
  }

  mqttService.publishCommand(plug.mqttTopicPrefix, command);
  return Response.json({ ok: true, command });
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| ECharts appendData for streaming | setOption with full data replacement | ECharts v5+ (appendData bug) | Use setOption only, avoid mixing methods |
| next-transpile-modules package | `transpilePackages` in next.config.ts | Next.js 13.1+ | Native support, no extra package needed |
| Custom SSE polyfill | Native EventSource API | All modern browsers | No polyfill needed, auto-reconnect built-in |
| ECharts v5 dark theme | ECharts v6 intelligent dark mode | ECharts 6.0.0 (2025) | Improved auto-switching, better defaults |

## Open Questions

1. **Sparkline data retention during navigation**
   - What we know: When user navigates away from dashboard and back, sparkline data is lost (React state destroyed)
   - What's unclear: Whether to persist last N minutes of readings in a module-level cache or re-request from DB
   - Recommendation: Use module-level Map outside React (in `use-power-stream.ts`) to retain last 5 minutes per plug. Cheap memory cost (~500 points * plugs).

2. **ECharts accent color choice (D-14)**
   - What we know: Must be readable on dark background (neutral-950/900)
   - Recommendation: Blue-500 (`#3b82f6`) as primary accent. Provides good contrast on dark backgrounds, feels modern and technical. Consistent with Tailwind's blue palette already available.

3. **Next.js transpilePackages for ECharts**
   - What we know: echarts and zrender may need transpilation for Next.js bundling
   - Recommendation: Add `transpilePackages: ['echarts', 'zrender']` to `next.config.ts` proactively. If builds work without it, can be removed.

## Project Constraints (from CLAUDE.md)

- **Framework:** Next.js 15 with App Router, custom server.ts entry point
- **Database:** SQLite via better-sqlite3 + Drizzle ORM (WAL mode)
- **Styling:** Tailwind v4, dark-only theme (neutral-950/900/800 palette)
- **Components:** `'use client'` directive required for interactive components
- **API Routes:** Export named HTTP handlers, use `runtime = 'nodejs'` for SSE
- **Imports:** Use `@/` path alias for all internal imports
- **Naming:** PascalCase components, kebab-case files, camelCase functions
- **Server globals:** `globalThis.__eventBus`, `globalThis.__mqttService` for cross-handler access
- **GSD workflow:** All edits through GSD commands

## Sources

### Primary (HIGH confidence)
- [ECharts 6.0.0 npm](https://www.npmjs.com/package/echarts) - Version 6.0.0 verified March 2026
- [echarts-for-react npm](https://www.npmjs.com/package/echarts-for-react) - Version 3.0.6 verified
- [Next.js Route Handler docs](https://nextjs.org/docs/app/api-reference/file-conventions/route) - SSE via ReadableStream
- [Next.js SSE Discussion #48427](https://github.com/vercel/next.js/discussions/48427) - Community patterns and buffering fixes
- Existing codebase: `event-bus.ts`, `mqtt-service.ts`, `plug-card.tsx`, `server.ts`, `schema.ts` - Phase 1 foundations

### Secondary (MEDIUM confidence)
- [Pedro Alonso SSE in Next.js](https://www.pedroalonso.net/blog/sse-nextjs-real-time-notifications/) - SSE implementation pattern verified against Next.js docs
- [ECharts Dynamic Data Handbook](https://apache.github.io/echarts-handbook/en/how-to/data/dynamic-data/) - setOption streaming pattern
- [ECharts appendData issue #12327](https://github.com/apache/echarts/issues/12327) - appendData + setOption conflict bug

### Tertiary (LOW confidence)
- [ECharts sparkline feature requests](https://github.com/apache/echarts/issues/17693) - No native sparkline support, but minimal chart config works as workaround

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - ECharts 6.0.0 and echarts-for-react 3.0.6 verified on npm, SSE is native web standard
- Architecture: HIGH - SSE in Next.js Route Handlers via ReadableStream is well-documented; EventBus integration pattern proven in Phase 1
- Pitfalls: HIGH - SSE buffering, ECharts memory leaks, SSR issues all well-documented in community

**Research date:** 2026-03-25
**Valid until:** 2026-04-25 (stable stack, no breaking changes expected)
