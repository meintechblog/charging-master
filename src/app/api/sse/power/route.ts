// src/app/api/sse/power/route.ts
// Multi-channel live stream for the dashboard: power readings + plug online
// state + charge state events. Single SSE connection serves all three feeds
// to keep the per-tab fd count down.
//
// Load-bearing details (mirrors the pattern proven in
// /api/update/log/route.ts):
//   1. 10 s SSE heartbeat as a comment frame (`: …`) — without this, idle
//      tabs lose the TCP connection silently and the UI shows stale data
//      until the user reloads, which is the classic "hängt beim Laden"
//      perception.
//   2. cleanup() is called from BOTH `request.signal.abort` AND the
//      ReadableStream `cancel()` callback. Either alone leaves dangling
//      EventBus listeners that pile up on tab switches (memory leak in the
//      server process, eventually mistuned event delivery).
//   3. enqueue() throws if the controller has been closed by the time a
//      late event fires — wrapped in safeEnqueue() so a stale callback can
//      never crash the request.

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import type { PowerReading, PlugOnlineEvent } from '@/modules/events/event-bus';
import type { ChargeStateEvent, ChargeState } from '@/modules/charging/types';
import { db } from '@/db/client';
import { chargeSessions, deviceProfiles } from '@/db/schema';
import { eq, inArray } from 'drizzle-orm';

const ACTIVE_REPLAY_STATES: ChargeState[] = [
  'detecting',
  'matched',
  'charging',
  'countdown',
  'learning',
];

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
} as const;

export async function GET(request: Request) {
  const eventBus = globalThis.__eventBus;
  const encoder = new TextEncoder();

  // Listener refs captured in closure so cleanup() can detach them. Set in
  // start(), read in cleanup(). Initialised to null so the empty-bus case
  // (eventBus undefined during a hot-reload race) doesn't NPE in cleanup.
  let powerHandler: ((reading: PowerReading) => void) | null = null;
  let onlineHandler: ((event: PlugOnlineEvent) => void) | null = null;
  let chargeHandler: ((event: ChargeStateEvent) => void) | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let cleanedUp = false;

  const cleanup = (): void => {
    if (cleanedUp) return;
    cleanedUp = true;
    if (heartbeatTimer !== null) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (eventBus) {
      if (powerHandler) eventBus.off('power:*', powerHandler);
      if (onlineHandler) eventBus.off('online:*', onlineHandler);
      if (chargeHandler) eventBus.off('charge:*', chargeHandler);
    }
    powerHandler = null;
    onlineHandler = null;
    chargeHandler = null;
  };

  request.signal.addEventListener('abort', cleanup);

  const stream = new ReadableStream({
    start(controller) {
      const safeEnqueue = (data: Uint8Array): void => {
        try {
          controller.enqueue(data);
        } catch {
          /* stream closed */
        }
      };

      // Replay current charge-state for any active session so clients that
      // connect mid-session (page reload, tab open) see the current state
      // immediately. Without this, charge events only fire on state
      // transitions and a late connector stays blank until the next one
      // (e.g. detecting → matched, up to ~10 min away).
      try {
        const now = Date.now();
        const active = db
          .select({
            sessionId: chargeSessions.id,
            plugId: chargeSessions.plugId,
            state: chargeSessions.state,
            profileId: chargeSessions.profileId,
            profileName: deviceProfiles.name,
            targetSoc: chargeSessions.targetSoc,
            estimatedSoc: chargeSessions.estimatedSoc,
            detectionConfidence: chargeSessions.detectionConfidence,
            startedAt: chargeSessions.startedAt,
            // Hydrate the SOC confidence band on mid-session reconnect so
            // the dashboard's CSS-driven band paints immediately instead of
            // waiting for the next live charge event.
            socMin: chargeSessions.socMin,
            socMax: chargeSessions.socMax,
            bandConfidence: chargeSessions.bandConfidence,
          })
          .from(chargeSessions)
          .leftJoin(deviceProfiles, eq(chargeSessions.profileId, deviceProfiles.id))
          .where(inArray(chargeSessions.state, ACTIVE_REPLAY_STATES))
          .all();

        for (const row of active) {
          const snapshot: ChargeStateEvent = {
            plugId: row.plugId,
            state: row.state as ChargeState,
            sessionId: row.sessionId,
            profileId: row.profileId ?? undefined,
            profileName: row.profileName ?? undefined,
            confidence: row.detectionConfidence ?? undefined,
            targetSoc: row.targetSoc ?? undefined,
            estimatedSoc: row.estimatedSoc ?? undefined,
            elapsedMs: now - row.startedAt,
            socMin: row.socMin ?? undefined,
            socMax: row.socMax ?? undefined,
            socBandConfidence: row.bandConfidence ?? undefined,
          };
          safeEnqueue(
            encoder.encode(`event: charge\ndata: ${JSON.stringify(snapshot)}\n\n`)
          );
        }
      } catch {
        // Snapshot is best-effort — never break the live stream
      }

      if (!eventBus) {
        // Server hasn't finished booting (very early request) — emit one
        // synthetic heartbeat so the client EventSource sees the connection
        // as healthy, then keep ticking.
        safeEnqueue(encoder.encode(`: bus-not-ready ${Date.now()}\n\n`));
      } else {
        powerHandler = (reading: PowerReading) => {
          safeEnqueue(encoder.encode(`data: ${JSON.stringify(reading)}\n\n`));
        };
        onlineHandler = (event: PlugOnlineEvent) => {
          safeEnqueue(encoder.encode(`event: online\ndata: ${JSON.stringify(event)}\n\n`));
        };
        chargeHandler = (event: ChargeStateEvent) => {
          safeEnqueue(encoder.encode(`event: charge\ndata: ${JSON.stringify(event)}\n\n`));
        };
        eventBus.on('power:*', powerHandler);
        eventBus.on('online:*', onlineHandler);
        eventBus.on('charge:*', chargeHandler);
      }

      // 10s heartbeat as SSE comment — invisible to the client's
      // onmessage handler but keeps any intermediate proxy (and the
      // browser's own TCP layer) from idle-timeout closing the stream.
      heartbeatTimer = setInterval(() => {
        safeEnqueue(encoder.encode(`: heartbeat ${Date.now()}\n\n`));
      }, 10_000);
    },
    cancel() {
      // Called when the client disconnects (tab closed) OR when the Response
      // is garbage-collected. cleanup() is idempotent — request.signal.abort
      // may also fire first, but browsers and Node versions differ on which
      // hook is reached. Belt and braces.
      cleanup();
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}
