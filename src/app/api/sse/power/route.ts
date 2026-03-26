export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import type { PowerReading, PlugOnlineEvent } from '@/modules/events/event-bus';
import type { ChargeStateEvent } from '@/modules/charging/types';

export async function GET(request: Request) {
  const eventBus = globalThis.__eventBus;

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
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
