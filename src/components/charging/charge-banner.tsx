'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { useChargeStream } from '@/hooks/use-charge-stream';
import { SocButtons } from '@/components/charging/soc-buttons';
import { CountdownDisplay } from '@/components/charging/countdown-display';
import { UnknownDeviceDialog } from '@/components/charging/unknown-device-dialog';
import type { ChargeStateEvent } from '@/modules/charging/types';

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
};

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
  const dismissedUnknownRef = useRef(false);
  const autoDismissRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Fetch profiles for override dropdown
  useEffect(() => {
    fetch('/api/profiles')
      .then((res) => res.json())
      .then((data: { profiles: Profile[] }) => setProfiles(data.profiles ?? []))
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
    });

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

  // Don't render when idle or no session
  if (!session || session.state === 'idle' || session.state === 'aborted') {
    return showUnknown && session?.sessionId ? (
      <UnknownDeviceDialog
        plugId={plugId}
        sessionId={session.sessionId}
        onClose={() => { dismissedUnknownRef.current = true; setShowUnknown(false); }}
      />
    ) : null;
  }

  // Detecting state - subtle banner
  if (session.state === 'detecting') {
    return (
      <>
        <div className="bg-neutral-800 border-l-4 border-neutral-500 rounded-r-lg p-4 mb-4">
          <PlugIdentity plugName={plugName} plugIp={plugIp} />
          <div className="flex items-center gap-2">
            <svg
              className="animate-spin h-4 w-4 text-neutral-400"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <circle cx="12" cy="12" r="10" strokeOpacity="0.25" />
              <path d="M12 2a10 10 0 0 1 10 10" strokeLinecap="round" />
            </svg>
            <span className="text-sm text-neutral-400">Gerät wird erkannt...</span>
          </div>
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
      <div className="bg-neutral-800 border-l-4 border-green-500 rounded-r-lg p-4 mb-4">
        <PlugIdentity plugName={plugName} plugIp={plugIp} />
        <p className="text-sm text-green-400">
          Ladevorgang abgeschlossen bei {session.estimatedSoc ?? '--'}%
        </p>
      </div>
    );
  }

  // Active states: matched, charging, countdown
  const isCountdown = session.state === 'countdown';

  return (
    <div className="bg-neutral-800 border-l-4 border-blue-500 rounded-r-lg p-4 mb-4">
      <PlugIdentity plugName={plugName} plugIp={plugIp} />
      {/* Header info */}
      <div className="flex items-start justify-between mb-3">
        <div>
          <p className="text-sm font-medium text-neutral-100">
            {session.profileName ?? 'Unbekannt'} erkannt
            {session.confidence != null && (
              <span className="text-neutral-400 ml-1">
                ({Math.round(session.confidence * 100)} % Konfidenz)
              </span>
            )}
          </p>
          <p className="text-xs text-neutral-400 mt-0.5">
            Ladevorgang gestartet, Ziel: {session.targetSoc ?? '--'}%
          </p>
          {(session.elapsedMs != null || session.etaSeconds != null) && (
            <p className="text-xs text-neutral-500 mt-1 tabular-nums flex gap-3">
              {session.elapsedMs != null && (
                <span>
                  Läuft seit <span className="text-neutral-300">{formatDuration(session.elapsedMs / 1000)}</span>
                </span>
              )}
              {session.etaSeconds != null && session.etaSeconds > 0 && (
                <span>
                  Noch ca. <span className="text-neutral-300">{formatDuration(session.etaSeconds)}</span>
                </span>
              )}
            </p>
          )}
        </div>

        {/* Abort button */}
        <button
          onClick={handleAbort}
          className="text-xs text-red-400 hover:text-red-300 transition-colors whitespace-nowrap"
        >
          {confirmAbort ? 'Wirklich abbrechen?' : 'Abbrechen'}
        </button>
      </div>

      {/* SOC display */}
      <div className="flex items-center gap-4 mb-3">
        {isCountdown && session.estimatedSoc != null && session.targetSoc != null ? (
          <CountdownDisplay
            estimatedSoc={session.estimatedSoc}
            targetSoc={session.targetSoc}
          />
        ) : (
          <>
            {/* Large SOC text */}
            <span className="text-3xl font-bold text-neutral-100 tabular-nums">
              {session.estimatedSoc ?? '--'}%
            </span>

            {/* Progress bar */}
            {session.estimatedSoc != null && session.targetSoc != null && (
              <div className="flex-1 h-2 bg-neutral-700 rounded-full overflow-hidden">
                <div
                  className="h-full bg-blue-500 rounded-full transition-all duration-1000 ease-linear"
                  style={{
                    width: `${Math.min(100, (session.estimatedSoc / session.targetSoc) * 100)}%`,
                  }}
                />
              </div>
            )}
          </>
        )}
      </div>

      {/* Override controls */}
      <div className="flex flex-col gap-2 border-t border-neutral-700 pt-3">
        {/* Current SOC override — rebases tracking baseline to user-supplied value */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-neutral-500 shrink-0">Aktueller SOC:</span>
          {!editingSoc ? (
            <button
              onClick={() => {
                setEditingSoc(true);
                setSocInput(String(session.estimatedSoc ?? 0));
                setSocError(null);
              }}
              className="text-xs text-blue-400 hover:text-blue-300 transition-colors"
            >
              {session.estimatedSoc ?? '--'}% korrigieren
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
                className="w-16 px-2 py-0.5 text-xs bg-neutral-900 border border-neutral-700 rounded text-neutral-100 focus:outline-none focus:border-blue-500"
              />
              <span className="text-xs text-neutral-500">%</span>
              <button
                type="submit"
                className="px-2 py-0.5 text-xs bg-blue-500 hover:bg-blue-600 text-white rounded transition-colors"
              >
                OK
              </button>
              <button
                type="button"
                onClick={() => {
                  setEditingSoc(false);
                  setSocInput('');
                  setSocError(null);
                }}
                className="px-2 py-0.5 text-xs text-neutral-500 hover:text-neutral-300"
              >
                x
              </button>
              {socError && <span className="text-xs text-red-400 ml-1">{socError}</span>}
            </form>
          )}
        </div>

        {/* Profile override */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-neutral-500 shrink-0">Profil ändern:</span>
          {!showProfileDropdown ? (
            <button
              onClick={() => setShowProfileDropdown(true)}
              className="text-xs text-blue-400 hover:text-blue-300 transition-colors"
            >
              {session.profileName ?? 'Keins'}
            </button>
          ) : (
            <div className="flex gap-1 flex-wrap">
              {profiles.map((p) => (
                <button
                  key={p.id}
                  onClick={() => handleOverrideProfile(p.id)}
                  className={`px-2 py-0.5 text-xs rounded transition-colors ${
                    p.id === session.profileId
                      ? 'bg-blue-500 text-white'
                      : 'bg-neutral-700 text-neutral-300 hover:bg-neutral-600'
                  }`}
                >
                  {p.name}
                </button>
              ))}
              <button
                onClick={() => setShowProfileDropdown(false)}
                className="px-2 py-0.5 text-xs text-neutral-500 hover:text-neutral-300"
              >
                x
              </button>
            </div>
          )}
        </div>

        {/* SOC override */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-neutral-500 shrink-0">Ziel-SOC:</span>
          <SocButtons
            value={session.targetSoc ?? 80}
            onChange={handleOverrideSoc}
          />
        </div>
      </div>
    </div>
  );
}
