// src/app/api/update/log/route.ts
// GET /api/update/log — Server-Sent Events stream that tails
// `journalctl -fu charging-master-updater` and pipes the lines as
// `data: <line>\n\n` frames. The UI's live log panel consumes it via
// EventSource to render the updater's progress in real time.
//
// Satisfies LIVE-01 + LIVE-02. The load-bearing detail is DOUBLE cleanup:
// the journalctl child MUST be killed on BOTH `request.signal.abort` AND
// the ReadableStream `cancel()` callback. Without both hooks browsers can
// leave zombie journalctl processes when a tab closes mid-stream.
//
// On dev machines (macOS — no journalctl, no charging-master-updater unit)
// we fall back to a synthetic stream emitting a couple of `[dev-mode]`
// frames plus periodic heartbeats so the UI can be eye-checked without
// systemd.

import { spawn, type ChildProcess } from 'node:child_process';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  // Disable nginx buffering even though we don't use nginx in prod — belt
  // and braces for any future reverse-proxy deployment.
  'X-Accel-Buffering': 'no',
} as const;

const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function isLocalhostHost(request: Request): boolean {
  const raw = request.headers.get('host');
  if (!raw) return false;
  const host = raw.startsWith('[')
    ? raw.slice(0, raw.indexOf(']') + 1)
    : raw.split(':')[0];
  return ALLOWED_HOSTS.has(host);
}

/**
 * Wrap raw text as SSE `data:` frames. Splits on newlines so a multi-line
 * chunk from journalctl becomes multiple discrete events. Empty lines are
 * dropped to avoid emitting blank frames that terminate an event early.
 */
function frame(text: string): string {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  return lines.map((l) => `data: ${l}\n\n`).join('');
}

export async function GET(request: Request): Promise<Response> {
  if (!isLocalhostHost(request)) {
    return new Response('forbidden', { status: 403 });
  }

  const encoder = new TextEncoder();
  let child: ChildProcess | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let stdoutBuffer = '';

  // CRITICAL: cleanup() must be idempotent — called from BOTH
  // request.signal.abort AND ReadableStream cancel(). If journalctl is still
  // alive, SIGTERM it; if it survives 1s, SIGKILL. Mitigates T-10-06 + T-10-08
  // (zombie process DoS).
  const cleanup = (): void => {
    if (heartbeatTimer !== null) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (child !== null && !child.killed) {
      const c = child;
      try {
        c.kill('SIGTERM');
      } catch {
        /* ignore — already dead */
      }
      // .unref() so the 1s kill timer doesn't keep the Node event loop alive.
      setTimeout(() => {
        try {
          if (!c.killed) c.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }, 1000).unref();
      child = null;
    }
  };

  request.signal.addEventListener('abort', cleanup);

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // Helper: enqueue safely — once the controller is closed any further
      // enqueue() throws. We swallow those because cleanup() may have already
      // fired while a last journalctl chunk was in flight.
      const safeEnqueue = (data: Uint8Array): void => {
        try {
          controller.enqueue(data);
        } catch {
          /* stream closed */
        }
      };

      // Attempt to spawn journalctl. If spawn itself throws synchronously
      // (very rare) we catch below and emit a synthetic dev stream.
      try {
        child = spawn(
          'journalctl',
          [
            '-fu',
            'charging-master-updater',
            '--output=cat',
            '--lines=100',
            '--no-pager',
          ],
          { stdio: ['ignore', 'pipe', 'pipe'] },
        );

        child.on('error', (err) => {
          // ENOENT arrives here on macOS dev (no journalctl binary).
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            safeEnqueue(
              encoder.encode(
                frame('[dev-mode] journalctl not available — synthetic stream'),
              ),
            );
            safeEnqueue(
              encoder.encode(
                frame(
                  '[dev-mode] [stage=preflight] This is a dev-mode synthetic log.',
                ),
              ),
            );
            safeEnqueue(
              encoder.encode(
                frame(
                  '[dev-mode] Trigger the updater on a real LXC host to see real logs.',
                ),
              ),
            );
            return;
          }
          safeEnqueue(encoder.encode(frame(`[error] journalctl: ${err.message}`)));
        });

        child.stdout?.on('data', (chunk: Buffer) => {
          stdoutBuffer += chunk.toString('utf8');
          const lastNewline = stdoutBuffer.lastIndexOf('\n');
          if (lastNewline === -1) return;
          // Line-buffered flush: only emit complete lines, keep the trailing
          // partial line in the buffer for the next chunk. journalctl -f
          // normally emits whole lines, but a fast-writing updater can split
          // on TCP packet boundaries.
          const complete = stdoutBuffer.slice(0, lastNewline);
          stdoutBuffer = stdoutBuffer.slice(lastNewline + 1);
          safeEnqueue(encoder.encode(frame(complete)));
        });

        child.stderr?.on('data', (chunk: Buffer) => {
          safeEnqueue(
            encoder.encode(frame(`[stderr] ${chunk.toString('utf8').trim()}`)),
          );
        });

        child.on('exit', (code) => {
          // exit 4/5 from journalctl (+ the 'unit not found' variants) — fall
          // back to the synthetic dev stream so the connection stays useful.
          if (code === 4 || code === 5) {
            safeEnqueue(
              encoder.encode(
                frame('[dev-mode] updater unit not installed — synthetic stream'),
              ),
            );
            safeEnqueue(encoder.encode(frame('[dev-mode] [stage=preflight] synthetic')));
          } else if (code !== null && code !== 0) {
            safeEnqueue(encoder.encode(frame(`[journalctl exited code=${code}]`)));
          }
        });
      } catch (err) {
        // Very rare: synchronous throw from spawn (e.g., EMFILE). Emit a
        // synthetic dev frame so the UI still sees *something* on the wire.
        safeEnqueue(
          encoder.encode(
            frame(
              `[dev-mode] spawn threw: ${err instanceof Error ? err.message : String(err)}`,
            ),
          ),
        );
        safeEnqueue(encoder.encode(frame('[dev-mode] [stage=preflight] synthetic')));
      }

      // 10s heartbeat as SSE comment (leading `:`) — invisible to the
      // client's onmessage handler but keeps the TCP connection from idling
      // out on any intermediate hop (and lets the client notice TCP death
      // quickly when the server is restarted mid-update).
      heartbeatTimer = setInterval(() => {
        safeEnqueue(encoder.encode(`: heartbeat ${Date.now()}\n\n`));
      }, 10_000);
    },
    cancel() {
      // Called when the client disconnects (tab closed) OR when the Response
      // is garbage-collected. MUST call cleanup() even though the abort
      // listener should also fire — 10-01-PLAN explicitly lists BOTH hooks
      // as load-bearing. In practice only one fires per disconnect but
      // browsers differ and we need belt-and-braces.
      cleanup();
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}
