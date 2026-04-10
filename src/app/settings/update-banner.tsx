'use client';

import { useCallback, useState } from 'react';
import type { UpdateInfoView, LastCheckResult } from '@/modules/self-update/types';

type CheckApiOk = { result: LastCheckResult };
type CheckApiCooldown = { status: 'cooldown'; retryAfterSeconds: number };
type CheckApiError = { status: 'error'; error: string };
type CheckApiResponse = CheckApiOk | CheckApiCooldown | CheckApiError;

type Props = {
  initialInfo: UpdateInfoView;
};

// German relative time formatter. Built once at module scope.
const RTF = new Intl.RelativeTimeFormat('de', { numeric: 'auto' });
const DATE_FMT = new Intl.DateTimeFormat('de', { dateStyle: 'medium', timeStyle: 'short' });

/**
 * Renders "vor 2 Stunden" / "vor 5 Minuten" / "gerade eben" for a past timestamp.
 * Uses epoch ms input. Returns the empty string if input is null.
 */
function formatRelative(epochMs: number | null): string {
  if (epochMs === null) return '';
  const diffSec = Math.round((epochMs - Date.now()) / 1000); // negative = past
  const absSec = Math.abs(diffSec);
  if (absSec < 45) return 'gerade eben';
  if (absSec < 60 * 60) return RTF.format(Math.round(diffSec / 60), 'minute');
  if (absSec < 60 * 60 * 24) return RTF.format(Math.round(diffSec / 3600), 'hour');
  return RTF.format(Math.round(diffSec / 86400), 'day');
}

/**
 * Formats an ISO commit date as a localized de-DE date+time.
 */
function formatCommitDate(iso: string): string {
  try {
    return DATE_FMT.format(new Date(iso));
  } catch {
    return iso;
  }
}

export function UpdateBanner({ initialInfo }: Props) {
  const [info, setInfo] = useState<UpdateInfoView>(initialInfo);
  const [isChecking, setIsChecking] = useState(false);
  const [cooldownSeconds, setCooldownSeconds] = useState<number | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  /**
   * Re-fetch the authoritative UpdateInfoView from /api/update/status after a
   * manual check completes (or any state transition). Keeps the banner in
   * sync with state.json without trusting the client's optimistic merge.
   */
  const refreshInfo = useCallback(async () => {
    try {
      const res = await fetch('/api/update/status', { cache: 'no-store' });
      if (res.ok) {
        const next = (await res.json()) as UpdateInfoView;
        setInfo(next);
      }
    } catch {
      // Non-fatal — we keep the stale in-memory view.
    }
  }, []);

  const handleCheck = useCallback(async () => {
    if (isChecking) return;
    setIsChecking(true);
    setCooldownSeconds(null);
    setLocalError(null);

    try {
      const res = await fetch('/api/update/check', { cache: 'no-store' });
      const data = (await res.json()) as CheckApiResponse;

      if (res.status === 429 && 'retryAfterSeconds' in data) {
        setCooldownSeconds(data.retryAfterSeconds);
      } else if ('error' in data && !('result' in data)) {
        setLocalError(data.error);
      }
      // Any successful path (200 with result OR 429 cooldown) should re-read
      // the authoritative view so the banner updates even if the result is
      // 'unchanged' (which doesn't update lastCheckResult).
      await refreshInfo();
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Netzwerkfehler');
    } finally {
      setIsChecking(false);
    }
  }, [isChecking, refreshInfo]);

  const lastCheckLabel =
    info.lastCheckAt === null
      ? 'Noch nicht geprüft'
      : `Letzter Check: ${formatRelative(info.lastCheckAt)}`;

  // =======================
  // Render state selection
  // =======================

  // STATE 1: Update available (highest priority — trumps everything else)
  if (info.updateAvailable && info.remote) {
    return (
      <div className="rounded-lg border border-green-500/30 bg-green-500/5 p-5 space-y-3">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 text-sm font-semibold text-green-300">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" />
              </span>
              Update verfügbar
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-neutral-400">
              <span className="font-mono text-neutral-200">{info.remote.shaShort}</span>
              <span>·</span>
              <span>{info.remote.author}</span>
              <span>·</span>
              <span>{formatCommitDate(info.remote.date)}</span>
            </div>
            <p className="mt-3 text-sm text-neutral-300 whitespace-pre-wrap break-words">
              {info.remote.message}
            </p>
          </div>
          <button
            type="button"
            onClick={handleCheck}
            disabled={isChecking}
            className="shrink-0 rounded border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-xs text-neutral-200 transition-colors hover:border-neutral-600 hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isChecking ? 'Prüft...' : 'Jetzt prüfen'}
          </button>
        </div>
        <div className="flex items-center justify-between text-xs text-neutral-500">
          <span>{lastCheckLabel}</span>
          {cooldownSeconds !== null && (
            <span className="text-amber-300">Bitte {cooldownSeconds} Sekunden warten</span>
          )}
          {localError !== null && <span className="text-amber-300">{localError}</span>}
        </div>
        {/*
          Install button is INTENTIONALLY not rendered in Phase 8.
          Phase 10 will add it here with a confirmation modal and the POST /api/update/trigger wiring.
          Per 08-CONTEXT.md: "the Install button is NOT rendered at all. This avoids rendering a dead button in the interim."
        */}
      </div>
    );
  }

  // STATE 2: Error (from state.lastCheckStatus === 'error')
  if (info.lastCheckStatus === 'error') {
    return (
      <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-5 space-y-2">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold text-amber-300">Update-Check fehlgeschlagen</div>
            <p className="mt-1 text-xs text-amber-200/80 break-words">
              {info.error ?? 'Unbekannter Fehler'}
            </p>
          </div>
          <button
            type="button"
            onClick={handleCheck}
            disabled={isChecking}
            className="shrink-0 rounded border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-xs text-neutral-200 transition-colors hover:border-neutral-600 hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isChecking ? 'Prüft...' : 'Erneut versuchen'}
          </button>
        </div>
        <div className="flex items-center justify-between text-xs text-neutral-500">
          <span>{lastCheckLabel}</span>
          {cooldownSeconds !== null && (
            <span className="text-amber-300">Bitte {cooldownSeconds} Sekunden warten</span>
          )}
        </div>
      </div>
    );
  }

  // STATE 3: Rate limited
  if (info.lastCheckStatus === 'rate_limited') {
    const resetLabel = info.rateLimitResetAt
      ? ` — Reset ${formatCommitDate(new Date(info.rateLimitResetAt * 1000).toISOString())}`
      : '';
    return (
      <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-5 space-y-2">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold text-amber-300">GitHub Rate-Limit erreicht</div>
            <p className="mt-1 text-xs text-amber-200/80">
              {info.error ?? 'Rate-Limit aktiv'}
              {resetLabel}
            </p>
          </div>
          <button
            type="button"
            onClick={handleCheck}
            disabled={isChecking}
            className="shrink-0 rounded border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-xs text-neutral-200 transition-colors hover:border-neutral-600 hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isChecking ? 'Prüft...' : 'Jetzt prüfen'}
          </button>
        </div>
        <div className="flex items-center justify-between text-xs text-neutral-500">
          <span>{lastCheckLabel}</span>
          {cooldownSeconds !== null && (
            <span className="text-amber-300">Bitte {cooldownSeconds} Sekunden warten</span>
          )}
        </div>
      </div>
    );
  }

  // STATE 4 & 5: Up-to-date (ok, updateAvailable=false) OR never checked
  const isUpToDate = info.lastCheckStatus === 'ok';
  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900/50 p-4">
      <div className="flex items-center justify-between gap-4">
        <div className="flex-1 min-w-0 text-sm text-neutral-400">
          {isUpToDate ? (
            <>
              <span className="text-neutral-200">Du bist auf dem neuesten Stand</span>
              <span className="mx-2 text-neutral-600">·</span>
              <span className="text-neutral-500 text-xs">{lastCheckLabel}</span>
            </>
          ) : (
            <>
              <span className="text-neutral-200">Noch nicht geprüft</span>
              <span className="mx-2 text-neutral-600">·</span>
              <span className="text-neutral-500 text-xs">
                Klicke auf &quot;Jetzt prüfen&quot;, um nach Updates zu suchen
              </span>
            </>
          )}
        </div>
        <button
          type="button"
          onClick={handleCheck}
          disabled={isChecking}
          className="shrink-0 rounded border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-xs text-neutral-200 transition-colors hover:border-neutral-600 hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isChecking ? 'Prüft...' : 'Jetzt prüfen'}
        </button>
      </div>
      {(cooldownSeconds !== null || localError !== null) && (
        <div className="mt-2 text-xs text-amber-300">
          {cooldownSeconds !== null && <span>Bitte {cooldownSeconds} Sekunden warten</span>}
          {localError !== null && <span>{localError}</span>}
        </div>
      )}
    </div>
  );
}
