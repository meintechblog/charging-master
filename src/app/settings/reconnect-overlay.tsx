'use client';

import { useEffect, useRef, useState } from 'react';

type VersionResponse = {
  sha: string;
  shaShort: string;
  buildTime: string;
  rollbackSha: string | null;
  dbHealthy: boolean;
};

type Props = {
  /** SHA observed before the update trigger — the overlay reloads when /api/version returns a different SHA. */
  initialSha: string;
  /** Optional: target SHA the user asked for, shown as "Erwartet: ..." hint. */
  targetShaShort?: string;
};

const POLL_INTERVAL_MS = 2_000;
const TIMEOUT_MS = 90_000;

type OverlayState = 'polling' | 'timeout';

export function ReconnectOverlay({ initialSha, targetShaShort }: Props) {
  const [state, setState] = useState<OverlayState>('polling');
  const [elapsedSec, setElapsedSec] = useState(0);
  const startedAtRef = useRef(Date.now());
  const cancelledRef = useRef(false);

  useEffect(() => {
    // setTimeout chain, not setInterval — guarantees no overlapping fetches
    // if /api/version takes >2s during a slow restart.
    let tickTimer: ReturnType<typeof setTimeout> | null = null;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;

    async function poll(): Promise<void> {
      if (cancelledRef.current) return;

      const elapsed = Date.now() - startedAtRef.current;
      if (elapsed >= TIMEOUT_MS) {
        setState('timeout');
        return;
      }

      try {
        const res = await fetch('/api/version', { cache: 'no-store' });
        if (res.ok) {
          const body = (await res.json()) as VersionResponse;
          if (body.sha !== initialSha && body.dbHealthy) {
            // SHA changed AND DB is healthy — the new version is live.
            window.location.reload();
            return;
          }
        }
      } catch {
        // Fetch failed (server still down) — keep polling silently.
      }

      if (!cancelledRef.current) {
        pollTimer = setTimeout(poll, POLL_INTERVAL_MS);
      }
    }

    // Elapsed ticker for the visible countdown — updates once per second
    function tick(): void {
      if (cancelledRef.current) return;
      setElapsedSec(Math.floor((Date.now() - startedAtRef.current) / 1000));
      tickTimer = setTimeout(tick, 1_000);
    }

    poll();
    tick();

    return () => {
      cancelledRef.current = true;
      if (pollTimer !== null) clearTimeout(pollTimer);
      if (tickTimer !== null) clearTimeout(tickTimer);
    };
  }, [initialSha]);

  function handleRetry(): void {
    startedAtRef.current = Date.now();
    cancelledRef.current = false;
    setState('polling');
    setElapsedSec(0);
    // Re-trigger effect by forcing a dummy state write? Simplest: reload.
    window.location.reload();
  }

  const remaining = Math.max(0, Math.ceil((TIMEOUT_MS - (elapsedSec * 1000)) / 1000));

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="reconnect-overlay-title"
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/85 p-4"
      // Backdrop click does NOTHING — non-dismissable while update in flight
      onClick={(e) => e.stopPropagation()}
    >
      <div className="w-full max-w-md rounded-lg border border-neutral-700 bg-neutral-900 p-8 text-center shadow-2xl">
        {state === 'polling' ? (
          <>
            <div className="mx-auto mb-4 h-12 w-12 animate-spin rounded-full border-4 border-neutral-700 border-t-blue-500" aria-hidden="true" />
            <h2 id="reconnect-overlay-title" className="text-lg font-semibold text-neutral-100">
              Server wird neu gestartet…
            </h2>
            <p className="mt-2 text-sm text-neutral-400">
              Dies kann bis zu 90 Sekunden dauern.
            </p>
            <p className="mt-4 font-mono text-xs text-neutral-500">
              {elapsedSec}s / 90s · noch {remaining}s
            </p>
            {targetShaShort !== undefined && (
              <p className="mt-2 font-mono text-[11px] text-neutral-600">
                Erwartet: {targetShaShort}
              </p>
            )}
          </>
        ) : (
          <>
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-red-600 text-2xl text-white" aria-hidden="true">✕</div>
            <h2 id="reconnect-overlay-title" className="text-lg font-semibold text-red-300">
              Neustart hat zu lange gedauert
            </h2>
            <p className="mt-2 text-sm text-neutral-300">
              Der Server hat sich nicht innerhalb von 90 Sekunden zurückgemeldet.
            </p>
            <div className="mt-4 rounded bg-neutral-950 border border-neutral-800 p-3 text-left font-mono text-[11px] text-neutral-300">
              <div className="mb-1 text-neutral-500">Per SSH prüfen:</div>
              systemctl status charging-master<br />
              journalctl -u charging-master-updater
            </div>
            <button
              type="button"
              onClick={handleRetry}
              className="mt-5 rounded border border-neutral-700 bg-neutral-800 px-4 py-1.5 text-sm text-neutral-200 hover:bg-neutral-700"
            >
              Seite neu laden
            </button>
          </>
        )}
      </div>
    </div>
  );
}
