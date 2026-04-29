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

export async function GET(request: Request) {
  const eventBus = globalThis.__eventBus;

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
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
          };
          controller.enqueue(
            encoder.encode(`event: charge\ndata: ${JSON.stringify(snapshot)}\n\n`)
          );
        }
      } catch {
        // Snapshot is best-effort — never break the live stream
      }

      const powerHandler = (reading: PowerReading) => {
        try {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(reading)}\n\n`)
          );
        } catch {
          // Controller closed, ignore
        }
      };

      const onlineHandler = (event: PlugOnlineEvent) => {
        try {
          controller.enqueue(
            encoder.encode(`event: online\ndata: ${JSON.stringify(event)}\n\n`)
          );
        } catch {
          // Controller closed, ignore
        }
      };

      const chargeHandler = (event: ChargeStateEvent) => {
        try {
          controller.enqueue(
            encoder.encode(`event: charge\ndata: ${JSON.stringify(event)}\n\n`)
          );
        } catch {
          // Controller closed, ignore
        }
      };

      eventBus.on('power:*', powerHandler);
      eventBus.on('online:*', onlineHandler);
      eventBus.on('charge:*', chargeHandler);

      request.signal.addEventListener('abort', () => {
        try {
          eventBus.off('power:*', powerHandler);
          eventBus.off('online:*', onlineHandler);
          eventBus.off('charge:*', chargeHandler);
          controller.close();
        } catch {
          // Already closed, ignore
        }
      });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
