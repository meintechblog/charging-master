'use client';

import { useCallback, useEffect, useState } from 'react';
import type {
  UpdateInfoView,
  LastCheckResult,
  UpdatePipelineStage,
  UpdateTriggerResponse,
} from '@/modules/self-update/types';
import { InstallModal } from './install-modal';
import { UpdateStageStepper } from './update-stage-stepper';
import { UpdateLogPanel } from './update-log-panel';
import { ReconnectOverlay } from './reconnect-overlay';

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

// Client-side flow state machine for the install pipeline.
type FlowState =
  | { kind: 'idle' }
  | { kind: 'confirm' }
  | { kind: 'triggered'; startedAt: number; targetSha: string }
  | { kind: 'streaming'; startedAt: number; targetSha: string; initialSha: string }
  | { kind: 'reconnecting'; initialSha: string; targetSha: string }
  | { kind: 'error'; message: string };

const LOG_LINE_CAP = 2000;
const STAGE_REGEX = /\[stage=(preflight|snapshot|drain|stop|fetch|install|build|start|verify)\]/;

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

  // Phase 10 state: install flow + streaming data + rollback ack.
  // Resume path: if state.json already has updateStatus === 'installing' when
  // the page loads (user navigated away mid-update, reloaded, or opened the
  // Settings tab for the first time during an active update), start directly
  // in 'triggered' so the SSE effect auto-opens the log stream.
  const [flow, setFlow] = useState<FlowState>(() => {
    const inProgress = initialInfo.inProgressUpdate;
    if (inProgress !== undefined) {
      return { kind: 'triggered', startedAt: inProgress.startedAt, targetSha: inProgress.targetSha };
    }
    return { kind: 'idle' };
  });
  const [logLines, setLogLines] = useState<string[]>([]);
  const [currentStage, setCurrentStage] = useState<UpdatePipelineStage | null>(null);
  const [isSubmittingInstall, setIsSubmittingInstall] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);
  const [rollbackDismissed, setRollbackDismissed] = useState(false);
  const [isAckingRollback, setIsAckingRollback] = useState(false);

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

  // ===========================================================================
  // Install flow — POST /api/update/trigger
  // ===========================================================================

  const handleInstall = useCallback(async (): Promise<void> => {
    if (info.remote === undefined) return;
    setInstallError(null);
    setIsSubmittingInstall(true);
    try {
      const res = await fetch('/api/update/trigger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetSha: info.remote.sha }),
      });
      const data = (await res.json()) as UpdateTriggerResponse;

      if (res.status === 503) {
        setInstallError(`Dev-Modus: ${'error' in data ? data.error : 'Updater nicht verfügbar'}`);
        return;
      }
      if (!res.ok || data.status === 'error') {
        setInstallError('error' in data ? data.error : `HTTP ${res.status}`);
        return;
      }
      // 202 triggered — transition to 'triggered', SSE effect will open the stream
      setFlow({ kind: 'triggered', startedAt: data.startedAt, targetSha: data.targetSha });
      // Close the modal automatically on successful trigger
    } catch (err) {
      setInstallError(err instanceof Error ? err.message : 'Netzwerkfehler');
    } finally {
      setIsSubmittingInstall(false);
    }
  }, [info.remote]);

  // ===========================================================================
  // SSE subscription — opens when flow enters 'triggered', stays open for 'streaming'
  // ===========================================================================

  useEffect(() => {
    if (flow.kind !== 'triggered' && flow.kind !== 'streaming') return;

    const es = new EventSource('/api/update/log');

    es.onopen = () => {
      // Transition triggered → streaming on first successful open.
      setFlow(prev => prev.kind === 'triggered'
        ? { kind: 'streaming', startedAt: prev.startedAt, targetSha: prev.targetSha, initialSha: info.currentSha }
        : prev
      );
    };
    es.onmessage = (ev) => {
      setLogLines(prev => {
        const next = [...prev, ev.data];
        if (next.length > LOG_LINE_CAP) next.splice(0, next.length - LOG_LINE_CAP);
        return next;
      });
      // Parse [stage=<name>] — last match wins
      const match = STAGE_REGEX.exec(ev.data);
      if (match !== null) setCurrentStage(match[1] as UpdatePipelineStage);
    };
    es.onerror = () => {
      // SSE dropped. If we were streaming, transition to reconnecting.
      es.close();
      setFlow(prev => {
        if (prev.kind === 'streaming') {
          return { kind: 'reconnecting', initialSha: prev.initialSha, targetSha: prev.targetSha };
        }
        if (prev.kind === 'triggered') {
          // SSE never opened at all — treat as error
          return { kind: 'error', message: 'Log-Stream konnte nicht geöffnet werden' };
        }
        return prev;
      });
    };

    return () => { es.close(); };
    // Only re-run when streaming-ness flips or the currentSha changes. Using
    // flow.kind directly keeps the effect stable across individual log lines.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flow.kind, info.currentSha]);

  // ===========================================================================
  // Rollback banner ack — POST /api/update/ack-rollback
  // ===========================================================================

  const handleAckRollback = useCallback(async (): Promise<void> => {
    setIsAckingRollback(true);
    try {
      const res = await fetch('/api/update/ack-rollback', { method: 'POST' });
      if (res.ok) {
        setRollbackDismissed(true);
        await refreshInfo();
      }
    } catch {
      // silently fail — user can retry
    } finally {
      setIsAckingRollback(false);
    }
  }, [refreshInfo]);

  const lastCheckLabel =
    info.lastCheckAt === null
      ? 'Noch nicht geprüft'
      : `Letzter Check: ${formatRelative(info.lastCheckAt)}`;

  // =======================
  // Render state selection
  // =======================

  // ROLLBACK BANNER (highest priority — trumps everything else)
  if (info.rollbackHappened === true && !rollbackDismissed) {
    return (
      <div className="rounded-lg border border-red-500/50 bg-red-500/10 p-5 space-y-3">
        <div className="flex items-start gap-3">
          <div className="shrink-0 text-xl" aria-hidden="true">⚠</div>
          <div className="flex-1">
            <div className="text-sm font-semibold text-red-300">
              Letztes Update fehlgeschlagen — Version wurde zurückgerollt
            </div>
            <div className="mt-2 text-xs text-red-200/80">
              {info.rollbackStage === 'stage2'
                ? 'Stufe 2 (Tarball-Restore) hat den Server wiederhergestellt.'
                : info.rollbackStage === 'stage1'
                ? 'Stufe 1 (git reset) hat den Server wiederhergestellt.'
                : 'Auto-Rollback abgeschlossen.'}
            </div>
            {info.rollbackReason !== null && info.rollbackReason !== undefined && (
              <p className="mt-2 rounded bg-red-950/50 border border-red-900 px-3 py-2 text-xs text-red-200 whitespace-pre-wrap break-words">
                {info.rollbackReason}
              </p>
            )}
            <button
              type="button"
              onClick={handleAckRollback}
              disabled={isAckingRollback}
              className="mt-3 rounded border border-red-500/50 bg-red-900/30 px-3 py-1.5 text-xs text-red-100 hover:bg-red-900/50 disabled:opacity-50"
            >
              {isAckingRollback ? 'Bestätige…' : 'Verstanden'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // STREAMING / TRIGGERED — live update in progress
  if (flow.kind === 'triggered' || flow.kind === 'streaming') {
    return (
      <div className="rounded-lg border border-blue-500/30 bg-blue-500/5 p-5 space-y-4">
        <div>
          <div className="text-sm font-semibold text-blue-300">Update läuft…</div>
          <div className="mt-1 text-xs text-neutral-400 font-mono">
            {info.currentShaShort} → {flow.targetSha.slice(0, 7)}
          </div>
        </div>
        <UpdateStageStepper currentStage={currentStage} status="running" />
        <UpdateLogPanel lines={logLines} />
      </div>
    );
  }

  // RECONNECTING — SSE dropped, overlay polling /api/version
  if (flow.kind === 'reconnecting') {
    return (
      <>
        <div className="rounded-lg border border-blue-500/30 bg-blue-500/5 p-5 space-y-4">
          <div className="text-sm font-semibold text-blue-300">Update läuft…</div>
          <UpdateStageStepper currentStage={currentStage} status="running" />
          <UpdateLogPanel lines={logLines} />
        </div>
        <ReconnectOverlay initialSha={flow.initialSha} targetShaShort={flow.targetSha.slice(0, 7)} />
      </>
    );
  }

  // ERROR — trigger POST failed (non-503), show inline error banner with back button
  if (flow.kind === 'error') {
    return (
      <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-5">
        <div className="text-sm font-semibold text-red-300">Update konnte nicht gestartet werden</div>
        <p className="mt-1 text-xs text-red-200/80 break-words">{flow.message}</p>
        <button
          type="button"
          onClick={() => setFlow({ kind: 'idle' })}
          className="mt-3 rounded border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-xs text-neutral-200 hover:bg-neutral-800"
        >
          Zurück
        </button>
      </div>
    );
  }

  // STATE 1: Update available (highest priority — trumps everything else)
  if (info.updateAvailable && info.remote) {
    return (
      <>
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
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleCheck}
                disabled={isChecking}
                className="shrink-0 rounded border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-xs text-neutral-200 hover:border-neutral-600 hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isChecking ? 'Prüft...' : 'Erneut prüfen'}
              </button>
              <button
                type="button"
                onClick={() => { setInstallError(null); setFlow({ kind: 'confirm' }); }}
                className="shrink-0 rounded bg-green-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-green-500"
              >
                Installieren
              </button>
            </div>
          </div>
          <div className="flex items-center justify-between text-xs text-neutral-500">
            <span>{lastCheckLabel}</span>
            {cooldownSeconds !== null && (
              <span className="text-amber-300">Bitte {cooldownSeconds} Sekunden warten</span>
            )}
            {localError !== null && <span className="text-amber-300">{localError}</span>}
          </div>
        </div>
        {flow.kind === 'confirm' && info.remote !== undefined && (
          <InstallModal
            currentShaShort={info.currentShaShort}
            targetShaShort={info.remote.shaShort}
            commitMessage={info.remote.message}
            commitAuthor={info.remote.author}
            commitDateIso={info.remote.date}
            isSubmitting={isSubmittingInstall}
            submitError={installError}
            onConfirm={handleInstall}
            onCancel={() => { setFlow({ kind: 'idle' }); setInstallError(null); }}
          />
        )}
      </>
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
