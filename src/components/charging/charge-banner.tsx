'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { useChargeStream } from '@/hooks/use-charge-stream';
import { SocButtons } from '@/components/charging/soc-buttons';
import { CountdownDisplay } from '@/components/charging/countdown-display';
import { UnknownDeviceDialog } from '@/components/charging/unknown-device-dialog';
import { SocConfidenceBar } from '@/components/charging/soc-confidence-bar';
import { formatEnergy } from '@/lib/format';
import type { ChargeStateEvent } from '@/modules/charging/types';

const formatWh = formatEnergy;

type Profile = { id: number; name: string };

type ChargeBannerProps = {
  plugId: string;
  plugName?: string;
  plugIp?: string;
};

type SessionState = {
  state: ChargeStateEvent['state'];
  profileId?: number;
  profileName?: string;
  confidence?: number;
  estimatedSoc?: number;
  targetSoc?: number;
  sessionId?: number;
  elapsedMs?: number;
  etaSeconds?: number;
  energyChargedWh?: number;
  energyRemainingWh?: number;
  detectionSamples?: number;
  detectionTargetSamples?: number;
  bestCandidateName?: string;
  bestCandidateConfidence?: number;
  // Phase 11 band fields — retained so SocBandIndicator below has a
  // server-rendered initialAsciiBar fallback on first paint.
  socMin?: number;
  socMax?: number;
  socBandConfidence?: number;
  socAsciiBar?: string;
  // Phase 12 FPD-05 watchdog fields.
  watchdogKind?: ChargeStateEvent['watchdogKind'];
  stalePowerSeconds?: number;
  stalePowerFiresAt?: number;
};

// Local state snapshot for the red 'fired' banner. We retain the last fired
// event in component state so the banner persists after the SSE stream
// inevitably emits subsequent 'none'-kind events post-abort (e.g. when the
// next session begins or polling resumes). Keyed by sessionId so a new
// session naturally re-arms the banner.
type FiredSnapshot = { sessionId: number; profileName?: string };

/**
 * Derive the warning-bar fraction. Returns 0 for any non-warning kind so the
 * caller can hide the bar unconditionally; for warning kind the value is
 * clamped to [0,1] and guarded against NaN/Infinity at all edges
 * (firesAt < now → 1, both 0 → 0, firesAt undefined → 0).
 */
export function deriveWatchdogFraction(
  kind: ChargeStateEvent['watchdogKind'] | undefined,
  secondsAtZero: number | undefined,
  firesAtMs: number | undefined,
  now: number,
): number {
  if (kind !== 'warning') return 0;
  const at = secondsAtZero ?? 0;
  if (firesAtMs == null) {
    // Defensive: warning kind without a firesAt timestamp is a contract bug
    // on the server side, but we still need a finite, in-range value.
    return at > 0 ? 1 : 0;
  }
  const firesIn = Math.max(0, (firesAtMs - now) / 1000);
  if (firesIn === 0) return 1;
  const denom = firesIn + at;
  if (denom === 0) return 0;
  const raw = at / denom;
  return Math.max(0, Math.min(1, raw));
}


function formatDuration(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return '--';
  const totalMinutes = Math.max(1, Math.round(totalSeconds / 60));
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}min`;
  return `${m} min`;
}

const ACTIVE_STATES = new Set(['matched', 'charging', 'countdown', 'detecting']);
const COMPLETE_STATES = new Set(['complete', 'stopping']);

function PlugIdentity({ plugName, plugIp }: { plugName?: string; plugIp?: string }) {
  if (!plugName && !plugIp) return null;
  return (
    <div className="flex items-center gap-1.5 mb-2 text-xs text-neutral-500">
      <svg
        className="h-3 w-3 text-neutral-500"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M9 2v6M15 2v6" />
        <path d="M5 8h14v4a7 7 0 0 1-14 0z" />
        <path d="M12 15v7" />
      </svg>
      {plugName && <span className="text-neutral-300 font-medium truncate">{plugName}</span>}
      {plugIp && (
        <span className="text-neutral-600 font-mono text-[10px]">· {plugIp}</span>
      )}
    </div>
  );
}

export function ChargeBanner({ plugId, plugName, plugIp }: ChargeBannerProps) {
  const [session, setSession] = useState<SessionState | null>(null);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [showProfileDropdown, setShowProfileDropdown] = useState(false);
  const [confirmAbort, setConfirmAbort] = useState(false);
  const [showUnknown, setShowUnknown] = useState(false);
  const [editingSoc, setEditingSoc] = useState(false);
  const [socInput, setSocInput] = useState<string>('');
  const [socError, setSocError] = useState<string | null>(null);
  // Phase 12 FPD-05 — fired-banner local state (persists past the post-abort
  // 'none' event flicker) + ack flag keyed on sessionId.
  const [firedSnapshot, setFiredSnapshot] = useState<FiredSnapshot | null>(null);
  const [ackedSessionId, setAckedSessionId] = useState<number | null>(null);
  const dismissedUnknownRef = useRef(false);
  const autoDismissRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Fetch profiles for override dropdown
  useEffect(() => {
    fetch('/api/profiles')
      .then((res) => res.json())
      .then((data: Profile[] | { profiles: Profile[] }) => {
        // /api/profiles returns an array directly; UnknownDeviceDialog
        // callers may also have assumed a wrapped shape — accept both.
        const list = Array.isArray(data) ? data : (data.profiles ?? []);
        setProfiles(list);
      })
      .catch(() => {});
  }, []);

  const onChargeEvent = useCallback((event: ChargeStateEvent) => {
    setSession({
      state: event.state,
      profileId: event.profileId,
      profileName: event.profileName,
      confidence: event.confidence,
      estimatedSoc: event.estimatedSoc,
      targetSoc: event.targetSoc,
      sessionId: event.sessionId,
      elapsedMs: event.elapsedMs,
      etaSeconds: event.etaSeconds,
      energyChargedWh: event.energyChargedWh,
      energyRemainingWh: event.energyRemainingWh,
      detectionSamples: event.detectionSamples,
      detectionTargetSamples: event.detectionTargetSamples,
      bestCandidateName: event.bestCandidateName,
      bestCandidateConfidence: event.bestCandidateConfidence,
      socMin: event.socMin,
      socMax: event.socMax,
      socBandConfidence: event.socBandConfidence,
      socAsciiBar: event.socAsciiBar,
      watchdogKind: event.watchdogKind,
      stalePowerSeconds: event.stalePowerSeconds,
      stalePowerFiresAt: event.stalePowerFiresAt,
    });

    // FPD-05: capture the 'fired' event into firedSnapshot so the red banner
    // survives subsequent 'none'-kind events on the same SSE stream.
    if (event.watchdogKind === 'fired' && event.sessionId !== undefined) {
      setFiredSnapshot({ sessionId: event.sessionId, profileName: event.profileName });
    }

    // Reset dismissed flag when transitioning from idle to a new detection
    if (event.state === 'idle') {
      dismissedUnknownRef.current = false;
    }

    // Only surface UnknownDeviceDialog after the detection buffer is exhausted
    // (MAX_DETECTION_READINGS without match). Before that, the banner's own
    // "Gerät wird erkannt..." spinner communicates in-progress detection.
    if (event.state === 'detecting' && event.detectionExhausted && !event.profileId && !dismissedUnknownRef.current) {
      setShowUnknown(true);
    } else if (event.state !== 'detecting' || event.profileId) {
      setShowUnknown(false);
    }
  }, []);

  useChargeStream(plugId, onChargeEvent);

  // FPD-05 M3 — when the fired sessionId changes (new abort on a new
  // session, or first 'fired' event after page reload during an aborted
  // session), re-read the localStorage ack key. Without this, a reload
  // during an active fired-and-acked session would never re-arm the banner
  // for the NEXT session (the useState initializer only runs once).
  const firedSessionId = firedSnapshot?.sessionId;
  useEffect(() => {
    if (firedSessionId === undefined) {
      setAckedSessionId(null);
      return;
    }
    if (typeof window === 'undefined') {
      setAckedSessionId(null);
      return;
    }
    const acked = localStorage.getItem(`charging-watchdog-ack-${firedSessionId}`) === '1';
    setAckedSessionId(acked ? firedSessionId : null);
  }, [firedSessionId]);

  const handleAckWatchdog = useCallback(() => {
    if (firedSessionId === undefined) return;
    try {
      localStorage.setItem(`charging-watchdog-ack-${firedSessionId}`, '1');
    } catch {
      // localStorage unavailable (private mode etc.) — ack is still ephemeral.
    }
    setAckedSessionId(firedSessionId);
  }, [firedSessionId]);

  // Auto-dismiss complete banner after 10 seconds
  useEffect(() => {
    if (session && COMPLETE_STATES.has(session.state)) {
      autoDismissRef.current = setTimeout(() => {
        setSession(null);
      }, 10000);
    }
    return () => {
      if (autoDismissRef.current) clearTimeout(autoDismissRef.current);
    };
  }, [session?.state]);

  const handleOverrideProfile = useCallback(
    async (profileId: number) => {
      if (!session?.sessionId) return;
      setShowProfileDropdown(false);
      try {
        await fetch(`/api/charging/sessions/${session.sessionId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ profileId }),
        });
      } catch {
        // Ignore
      }
    },
    [session?.sessionId]
  );

  const handleOverrideSoc = useCallback(
    async (targetSoc: number) => {
      if (!session?.sessionId) return;
      try {
        await fetch(`/api/charging/sessions/${session.sessionId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ targetSoc }),
        });
      } catch {
        // Ignore
      }
    },
    [session?.sessionId]
  );

  const handleSubmitEstimatedSoc = useCallback(
    async (raw: string) => {
      if (!session?.sessionId) return;
      const parsed = Number.parseInt(raw, 10);
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > 100) {
        setSocError('0 - 100');
        return;
      }
      setSocError(null);
      try {
        const res = await fetch(`/api/charging/sessions/${session.sessionId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ estimatedSoc: parsed }),
        });
        if (!res.ok) {
          setSocError('Fehler');
          return;
        }
        setEditingSoc(false);
        setSocInput('');
      } catch {
        setSocError('Fehler');
      }
    },
    [session?.sessionId]
  );

  const handleAbort = useCallback(async () => {
    if (!session?.sessionId) return;
    if (!confirmAbort) {
      setConfirmAbort(true);
      return;
    }
    try {
      await fetch(`/api/charging/sessions/${session.sessionId}/abort`, {
        method: 'POST',
      });
    } catch {
      // Ignore
    }
    setConfirmAbort(false);
  }, [session?.sessionId, confirmAbort]);

  // Phase 12 FPD-05 — red "Session abgebrochen" banner, rendered as a top-level
  // overlay so it survives the parent branch returns below (idle/aborted/etc).
  // Only visible while firedSnapshot has a sessionId AND the user hasn't acked
  // that specific sessionId (re-checked via useEffect on firedSessionId change).
  const showFiredBanner =
    firedSnapshot !== null && ackedSessionId !== firedSnapshot.sessionId;
  const firedOverlay = showFiredBanner ? (
    <div
      data-testid="watchdog-fired"
      className="bg-red-900/40 border-l-4 border-red-700 rounded-lg p-4 mb-2"
    >
      <PlugIdentity plugName={plugName} plugIp={plugIp} />
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-red-200">
          Session abgebrochen — Battery full?
          {firedSnapshot?.profileName && (
            <span className="text-red-300 ml-1">({firedSnapshot.profileName})</span>
          )}
        </p>
        <button
          data-testid="watchdog-ack"
          onClick={handleAckWatchdog}
          className="px-3 py-1 rounded bg-red-700/40 hover:bg-red-700/60 text-red-100 text-xs whitespace-nowrap"
        >
          Verstanden
        </button>
      </div>
    </div>
  ) : null;

  // Don't render when idle or no session — but DO render the fired overlay
  // if it's active (the abort transition itself routes through the
  // session.state === 'aborted' branch which would otherwise hide everything).
  if (!session || session.state === 'idle' || session.state === 'aborted') {
    const unknown = showUnknown && session?.sessionId ? (
      <UnknownDeviceDialog
        plugId={plugId}
        sessionId={session.sessionId}
        onClose={() => { dismissedUnknownRef.current = true; setShowUnknown(false); }}
      />
    ) : null;
    if (firedOverlay || unknown) {
      return (
        <>
          {firedOverlay}
          {unknown}
        </>
      );
    }
    return null;
  }

  // Detecting state - subtle banner with live progress
  if (session.state === 'detecting') {
    const samples = session.detectionSamples ?? 0;
    const target = session.detectionTargetSamples ?? 60;
    const progressPct = Math.min(100, Math.round((samples / target) * 100));
    const candidatePct =
      session.bestCandidateConfidence != null
        ? Math.round(session.bestCandidateConfidence * 100)
        : null;
    const showCandidate =
      session.bestCandidateName != null &&
      session.bestCandidateConfidence != null &&
      session.bestCandidateConfidence >= 0.5;

    // Rough ETA to next match attempt: every 12 readings ≈ 60 s
    const samplesUntilNextProbe = 12 - (samples % 12 || 12);
    const secondsUntilNextProbe = samplesUntilNextProbe * 5;

    return (
      <>
        {firedOverlay}
        <div className="bg-neutral-800 border-l-4 border-neutral-500 rounded-lg p-4">
          <PlugIdentity plugName={plugName} plugIp={plugIp} />
          <div className="flex items-center gap-2">
            <svg
              className="animate-spin h-4 w-4 text-neutral-400 shrink-0"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <circle cx="12" cy="12" r="10" strokeOpacity="0.25" />
              <path d="M12 2a10 10 0 0 1 10 10" strokeLinecap="round" />
            </svg>
            <span className="text-sm text-neutral-300">
              {showCandidate
                ? `Vermutlich ${session.bestCandidateName} (Match ${candidatePct} %)`
                : 'Gerät wird erkannt…'}
            </span>
          </div>
          <div className="mt-2 space-y-1.5">
            <div className="h-1 w-full rounded-full bg-neutral-700/60 overflow-hidden">
              <div
                className="h-full bg-blue-500/70 transition-[width] duration-500"
                style={{ width: `${progressPct}%` }}
              />
            </div>
            <div className="flex items-center justify-between text-[11px] text-neutral-500 tabular-nums">
              <span>
                {samples}/{target} Messwerte
              </span>
              <span>
                Nächster Match-Versuch in ~{secondsUntilNextProbe}s
              </span>
            </div>
          </div>
          {session.sessionId && profiles.length > 0 && (
            <div className="mt-3 pt-3 border-t border-neutral-700/60 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-neutral-500">
              {!showProfileDropdown ? (
                <button
                  onClick={() => setShowProfileDropdown(true)}
                  className="text-neutral-400 hover:text-blue-400 transition-colors underline-offset-2 hover:underline"
                >
                  Profil manuell zuweisen
                </button>
              ) : (
                <div className="flex gap-1 flex-wrap items-center">
                  <span className="text-neutral-500 mr-1">Profil:</span>
                  {profiles.map((p) => (
                    <button
                      key={p.id}
                      onClick={() => handleOverrideProfile(p.id)}
                      className="px-2 py-0.5 rounded bg-neutral-700 text-neutral-200 hover:bg-neutral-600"
                    >
                      {p.name}
                    </button>
                  ))}
                  <button
                    onClick={() => setShowProfileDropdown(false)}
                    className="text-neutral-500 hover:text-neutral-300 px-1"
                  >
                    ×
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
        {showUnknown && session.sessionId && (
          <UnknownDeviceDialog
            plugId={plugId}
            sessionId={session.sessionId}
            onClose={() => { dismissedUnknownRef.current = true; setShowUnknown(false); }}
          />
        )}
      </>
    );
  }

  // Complete / stopping state - success banner
  if (COMPLETE_STATES.has(session.state)) {
    return (
      <>
        {firedOverlay}
        <div className="bg-neutral-800 border-l-4 border-green-500 rounded-lg p-4">
          <PlugIdentity plugName={plugName} plugIp={plugIp} />
          <p className="text-sm text-green-400">
            Ladevorgang abgeschlossen bei {session.estimatedSoc ?? '--'}%
          </p>
        </div>
      </>
    );
  }

  // Active states: matched, charging, countdown
  const isCountdown = session.state === 'countdown';
  const accent = isCountdown ? 'border-amber-500' : 'border-blue-500';
  const fill = isCountdown ? 'bg-amber-400' : 'bg-blue-500';
  const progressPct = session.estimatedSoc != null && session.targetSoc != null
    ? Math.min(100, (session.estimatedSoc / session.targetSoc) * 100)
    : 0;

  return (
    <>
      {firedOverlay}
      <div className={`bg-neutral-900/80 border ${accent.replace('border-', 'border-')} border-t-0 rounded-b-lg px-5 py-4 -mt-px`}>
      {/* Row 1: plug identity (compact) + abort */}
      <div className="flex items-center justify-between">
        <PlugIdentity plugName={plugName} plugIp={plugIp} />
        <button
          onClick={handleAbort}
          className="text-xs text-neutral-500 hover:text-red-400 transition-colors whitespace-nowrap"
        >
          {confirmAbort ? 'Wirklich abbrechen?' : '× Abbrechen'}
        </button>
      </div>

      {/* Row 2: profile name + optional confidence subtitle */}
      <div className="mt-1 mb-4">
        <div className="text-base font-semibold text-neutral-100">
          {session.profileName ?? 'Unbekannt'}
        </div>
        {session.confidence != null && session.confidence > 0 && session.confidence < 1 && (
          <div className="text-[11px] text-neutral-500 mt-0.5">
            {Math.round(session.confidence * 100)} % Konfidenz
          </div>
        )}
      </div>

      {/* Row 3: big SOC number + progress bar + target marker */}
      {isCountdown && session.estimatedSoc != null && session.targetSoc != null ? (
        <div className="mb-4">
          <CountdownDisplay
            estimatedSoc={session.estimatedSoc}
            targetSoc={session.targetSoc}
          />
        </div>
      ) : (
        <div className="mb-4">
          <div className="flex items-baseline gap-2 mb-2 tabular-nums">
            <span className="text-4xl font-bold text-neutral-100">
              {session.estimatedSoc ?? '--'}
            </span>
            <span className="text-lg text-neutral-500">%</span>
            {session.socMin != null && session.socMax != null &&
              session.socMax - session.socMin > 1 && (
                <span className="text-xs text-neutral-500 ml-1">
                  ({session.socMin}–{session.socMax} %)
                </span>
              )}
          </div>
          {/* Full 0–100 % SoC bar with uncertainty band, current best, and
              target marker. Replaces the old fill-to-target progress + the
              separate ASCII band that lived below it. */}
          <SocConfidenceBar
            socBest={session.estimatedSoc ?? 0}
            socMin={session.socMin ?? session.estimatedSoc ?? 0}
            socMax={session.socMax ?? session.estimatedSoc ?? 0}
            targetSoc={session.targetSoc ?? 80}
            fillClass={fill}
          />
        </div>
      )}

      {/* Row 4: metrics as prominent stat cards (replaces the old inline
          text strip + ASCII SOC band). The ChargeSessionChart on the detail
          page covers SoC visualization; the cards surface the four numbers
          users actually scan: how much charged, how much remains, elapsed
          time, ETA. */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <div className="bg-neutral-800/50 rounded-md px-3 py-2">
          <div className="text-[10px] text-neutral-500 uppercase tracking-wide">Geladen</div>
          <div className="text-lg font-semibold text-neutral-100 tabular-nums">
            {formatWh(session.energyChargedWh)}
          </div>
        </div>
        <div className="bg-neutral-800/50 rounded-md px-3 py-2">
          <div className="text-[10px] text-neutral-500 uppercase tracking-wide">Fehlt</div>
          <div className="text-lg font-semibold text-neutral-100 tabular-nums">
            {session.energyRemainingWh != null && session.energyRemainingWh > 0
              ? formatWh(session.energyRemainingWh)
              : '–'}
          </div>
        </div>
        <div className="bg-neutral-800/50 rounded-md px-3 py-2">
          <div className="text-[10px] text-neutral-500 uppercase tracking-wide">Seit</div>
          <div className="text-lg font-semibold text-neutral-100 tabular-nums">
            {session.elapsedMs != null ? formatDuration(session.elapsedMs / 1000) : '–'}
          </div>
        </div>
        <div className="bg-neutral-800/50 rounded-md px-3 py-2">
          <div className="text-[10px] text-neutral-500 uppercase tracking-wide">Noch ca.</div>
          <div className="text-lg font-semibold text-neutral-100 tabular-nums">
            {session.etaSeconds != null && session.etaSeconds > 0
              ? formatDuration(session.etaSeconds)
              : '–'}
          </div>
        </div>
      </div>

      {/* Phase 12 FPD-05 — yellow watchdog warning bar. Gated on
          watchdogKind === 'warning' AND state ∈ {charging, countdown}: when
          kind is 'none' the bar is hidden, when 'fired' the top-level
          firedOverlay above handles it. Bar fraction derived via
          deriveWatchdogFraction (NaN-guarded). */}
      {session.watchdogKind === 'warning' &&
        (session.state === 'charging' || session.state === 'countdown') && (
          <div data-testid="watchdog-warning" className="mt-3">
            <div className="flex items-center justify-between text-[11px] text-amber-300 mb-1">
              <span>Watchdog: 0 W seit {Math.round(session.stalePowerSeconds ?? 0)}s</span>
              <span className="text-amber-500/70">
                Akku evtl. voll — bricht automatisch ab
              </span>
            </div>
            <div className="relative h-1.5 bg-neutral-800 rounded-full overflow-hidden">
              <div
                data-testid="watchdog-warning-fill"
                className="h-full bg-amber-400 transition-[width] duration-500"
                style={{
                  width: `${deriveWatchdogFraction(
                    session.watchdogKind,
                    session.stalePowerSeconds,
                    session.stalePowerFiresAt,
                    Date.now(),
                  ) * 100}%`,
                }}
              />
            </div>
          </div>
        )}

      {/* Row 5: inline controls — lazy-expand per group */}
      <div className="mt-3 pt-3 border-t border-neutral-800/80 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-neutral-500">
        {/* SOC korrigieren */}
        {!editingSoc ? (
          <button
            onClick={() => {
              setEditingSoc(true);
              setSocInput(String(session.estimatedSoc ?? 0));
              setSocError(null);
            }}
            className="text-neutral-400 hover:text-blue-400 transition-colors underline-offset-2 hover:underline"
          >
            SOC korrigieren
          </button>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void handleSubmitEstimatedSoc(socInput);
            }}
            className="flex items-center gap-1"
          >
            <input
              type="number"
              min={0}
              max={100}
              value={socInput}
              onChange={(e) => {
                setSocInput(e.target.value);
                setSocError(null);
              }}
              autoFocus
              className="w-14 px-2 py-0.5 bg-neutral-950 border border-neutral-700 rounded text-neutral-100 focus:outline-none focus:border-blue-500"
            />
            <span>%</span>
            <button
              type="submit"
              className="px-2 py-0.5 bg-blue-500 hover:bg-blue-600 text-white rounded"
            >
              OK
            </button>
            <button
              type="button"
              onClick={() => { setEditingSoc(false); setSocInput(''); setSocError(null); }}
              className="text-neutral-500 hover:text-neutral-300 px-1"
            >
              ×
            </button>
            {socError && <span className="text-red-400 ml-1">{socError}</span>}
          </form>
        )}

        {/* Profile change */}
        <span className="text-neutral-700">·</span>
        {!showProfileDropdown ? (
          <button
            onClick={() => setShowProfileDropdown(true)}
            className="text-neutral-400 hover:text-blue-400 transition-colors underline-offset-2 hover:underline"
          >
            Profil ändern
          </button>
        ) : (
          <div className="flex gap-1 flex-wrap">
            {profiles.map((p) => (
              <button
                key={p.id}
                onClick={() => handleOverrideProfile(p.id)}
                className={`px-2 py-0.5 rounded ${
                  p.id === session.profileId
                    ? 'bg-blue-500 text-white'
                    : 'bg-neutral-800 text-neutral-300 hover:bg-neutral-700'
                }`}
              >
                {p.name}
              </button>
            ))}
            <button
              onClick={() => setShowProfileDropdown(false)}
              className="text-neutral-500 hover:text-neutral-300 px-1"
            >
              ×
            </button>
          </div>
        )}

        {/* Target SOC */}
        <span className="text-neutral-700">·</span>
        <div className="flex items-center gap-1">
          <span>Ziel</span>
          <SocButtons
            value={session.targetSoc ?? 80}
            onChange={handleOverrideSoc}
          />
        </div>
      </div>
      </div>
    </>
  );
}
