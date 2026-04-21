import { scanSubnet } from '@/modules/shelly/discovery-scanner';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;

      const safeEnqueue = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          closed = true;
        }
      };

      request.signal.addEventListener('abort', () => {
        closed = true;
        try {
          controller.close();
        } catch {
          // already closed
        }
      });

      try {
        await scanSubnet({
          onDevice: (device) => {
            safeEnqueue(`event: device\ndata: ${JSON.stringify(device)}\n\n`);
          },
          onProgress: (scanned, total) => {
            safeEnqueue(
              `event: progress\ndata: ${JSON.stringify({ scanned, total })}\n\n`
            );
          },
        });

        safeEnqueue(`event: done\ndata: {}\n\n`);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'scan_failed';
        safeEnqueue(`event: error\ndata: ${JSON.stringify({ error: message })}\n\n`);
      } finally {
        if (!closed) {
          closed = true;
          try {
            controller.close();
          } catch {
            // already closed
          }
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
