'use client';

/**
 * Prominent full-width card for an active charge session on the dashboard.
 *
 * Rationale: the earlier dashboard rendered active charges in the same
 * compact grid cell as idle plugs — users had to squint at a small
 * sparkline + 8-pt blue dot to know "something is happening here." This
 * card surfaces what matters at a glance:
 *
 *   ┌────────────────────────────────────────────────────────────────┐
 *   │ [photo]  Bosch PowerTube 625               73 % → Ziel 80 %    │
 *   │          Schuppen · 192.168.3.167  ⬤        ███████████░  Live │
 *   │                                              334 Wh · 173 W    │
 *   │                                              seit 1:42 · noch 5 min  │
 *   └────────────────────────────────────────────────────────────────┘
 *
 * Receives its initial state from the server (so first paint already shows
 * the active charge) and updates live via the existing charge + power SSE
 * streams. Links into the plug detail page on click.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePowerStream } from '@/hooks/use-power-stream';
import { useChargeStream } from '@/hooks/use-charge-stream';
import { SocConfidenceBar } from '@/components/charging/soc-confidence-bar';
import { formatEnergy, formatDurationMinutes } from '@/lib/format';
import type { ChargeStateEvent } from '@/modules/charging/types';

export type ActiveChargeInitial = {
  sessionId: number;
  profileId: number | null;
  profileName: string | null;
  photoUrl: string | null;
  state: string;
  estimatedSoc: number | null;
  socMin: number | null;
  socMax: number | null;
  targetSoc: number;
  energyWh: number;
  bandConfidence: number | null;
  startedAt: number;
};

type ActiveChargeCardProps = {
  plugId: string;
  plugName: string;
  plugIp?: string | null;
  online: boolean;
  initial: ActiveChargeInitial;
};

const ACTIVE_STATES = new Set<ChargeStateEvent['state']>([
  'detecting',
  'matched',
  'charging',
  'countdown',
]);

function formatElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  if (h > 0) return `${h}h ${m}min`;
  return `${m} min`;
}

export function ActiveChargeCard({
  plugId,
  plugName,
  plugIp,
  online,
  initial,
}: ActiveChargeCardProps) {
  const [state, setState] = useState<string>(initial.state);
  const [profileName, setProfileName] = useState<string | null>(initial.profileName);
  const [photoUrl, setPhotoUrl] = useState<string | null>(initial.photoUrl);
  const [estSoc, setEstSoc] = useState<number | null>(initial.estimatedSoc);
  const [socMin, setSocMin] = useState<number | null>(initial.socMin);
  const [socMax, setSocMax] = useState<number | null>(initial.socMax);
  const [targetSoc, setTargetSoc] = useState<number>(initial.targetSoc);
  const [energyWh, setEnergyWh] = useState<number>(initial.energyWh);
  const [bandConfidence, setBandConfidence] = useState<number | null>(initial.bandConfidence);
  const [etaSeconds, setEtaSeconds] = useState<number | null>(null);
  const [energyRemainingWh, setEnergyRemainingWh] = useState<number | null>(null);
  const [watts, setWatts] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState<number>(Date.now() - initial.startedAt);

  // Wall-clock elapsed tick every 10 s — startedAt is fixed, no need for SSE
  // to drive this. Cleared in the cleanup.
  useEffect(() => {
    const handle = window.setInterval(() => {
      setElapsed(Date.now() - initial.startedAt);
    }, 10_000);
    return () => window.clearInterval(handle);
  }, [initial.startedAt]);

  // Fetch photo lazily if the profileId changes during the session and the
  // initial server-side hint missed (e.g. the profile got committed AFTER
  // the page load).
  const fetchedPhotoForProfileRef = useRef<number | null>(initial.profileId);
  useEffect(() => {
    if (photoUrl != null) return;
    const pid = initial.profileId;
    if (pid == null) return;
    if (fetchedPhotoForProfileRef.current === pid) return;
    fetchedPhotoForProfileRef.current = pid;
    let aborted = false;
    fetch(`/api/profiles/${pid}/photos`)
      .then((r) => r.json())
      .then((data: { photos?: Array<{ id: number; isPrimary: boolean }> }) => {
        if (aborted) return;
        const photos = data.photos ?? [];
        if (photos.length === 0) return;
        const primary = photos.find((p) => p.isPrimary) ?? photos[0];
        setPhotoUrl(`/api/profiles/${pid}/photos/${primary.id}/file`);
      })
      .catch(() => {});
    return () => {
      aborted = true;
    };
  }, [photoUrl, initial.profileId]);

  const onChargeEvent = useCallback((event: ChargeStateEvent) => {
    setState(event.state);
    if (event.profileName) setProfileName(event.profileName);
    if (event.estimatedSoc != null) setEstSoc(event.estimatedSoc);
    if (event.socMin != null) setSocMin(event.socMin);
    if (event.socMax != null) setSocMax(event.socMax);
    if (event.targetSoc != null) setTargetSoc(event.targetSoc);
    if (event.energyChargedWh != null) setEnergyWh(event.energyChargedWh);
    if (event.energyRemainingWh != null) setEnergyRemainingWh(event.energyRemainingWh);
    if (event.etaSeconds != null) setEtaSeconds(event.etaSeconds);
    if (event.socBandConfidence != null) setBandConfidence(event.socBandConfidence);
  }, []);

  useChargeStream(plugId, onChargeEvent);

  const onReading = useCallback(
    (reading: { plugId: string; apower: number; timestamp: number }) => {
      if (reading.plugId !== plugId) return;
      setWatts(reading.apower);
    },
    [plugId]
  );

  usePowerStream(plugId, onReading);

  const isCountdown = state === 'countdown';
  const accentText = isCountdown ? 'text-amber-300' : 'text-blue-300';
  const accentRing = isCountdown ? 'ring-amber-500/60' : 'ring-blue-500/60';
  const accentDot = isCountdown ? 'bg-amber-400' : 'bg-blue-500';
  const fillClass = isCountdown ? 'bg-amber-400' : 'bg-blue-500';
  const isDetecting = state === 'detecting';

  return (
    <Link
      href={`/devices/${plugId}`}
      className={`block bg-neutral-900 rounded-lg ring-1 ${accentRing} p-4 hover:ring-2 transition-shadow`}
    >
      <div className="flex items-start gap-4">
        {/* Photo (or placeholder) */}
        <div className="shrink-0">
          {photoUrl != null ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={photoUrl}
              alt={profileName ?? 'Profilfoto'}
              className="w-28 h-14 object-contain rounded-md bg-neutral-800/60 ring-1 ring-neutral-800"
              loading="lazy"
            />
          ) : (
            <div className="w-28 h-14 rounded-md bg-neutral-800/60 ring-1 ring-neutral-800 flex items-center justify-center text-[10px] text-neutral-600">
              {isDetecting ? 'Erkenne…' : 'Kein Foto'}
            </div>
          )}
        </div>

        {/* Main column */}
        <div className="flex-1 min-w-0">
          {/* Profile name + plug identity */}
          <div className="flex items-baseline gap-2 mb-1">
            <span className="text-base font-semibold text-neutral-100 truncate">
              {profileName ?? (isDetecting ? 'Gerät wird erkannt…' : 'Unbekannt')}
            </span>
            <span className={`relative flex h-2 w-2 shrink-0`}>
              <span
                className={`absolute inline-flex h-full w-full rounded-full ${accentDot} opacity-60 animate-ping`}
              />
              <span
                className={`relative inline-flex h-2 w-2 rounded-full ${accentDot}`}
              />
            </span>
          </div>
          <div className="text-[11px] text-neutral-500 mb-3 flex items-center gap-2 truncate">
            <span>{plugName}</span>
            {plugIp && <span className="font-mono">· {plugIp}</span>}
            {!online && <span className="text-red-400">· offline</span>}
          </div>

          {/* SoC headline + bar */}
          {estSoc != null ? (
            <div className="mb-2">
              <div className="flex items-baseline gap-2 mb-1.5 tabular-nums">
                <span className="text-3xl font-bold text-neutral-100">{estSoc}</span>
                <span className="text-sm text-neutral-500">%</span>
                {socMin != null && socMax != null && socMax - socMin > 1 && (
                  <span className="text-[11px] text-neutral-500 ml-0.5">
                    ({socMin}–{socMax} %)
                  </span>
                )}
                <span className={`ml-auto text-xs ${accentText}`}>
                  Ziel {targetSoc} %
                </span>
              </div>
              <SocConfidenceBar
                socBest={estSoc}
                socMin={socMin ?? estSoc}
                socMax={socMax ?? estSoc}
                targetSoc={targetSoc}
                fillClass={fillClass}
                bandConfidence={bandConfidence ?? undefined}
              />
            </div>
          ) : (
            <div className="text-sm text-neutral-500 mb-2">
              Gerät wird erkannt …
            </div>
          )}

          {/* Stats row */}
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-neutral-400 tabular-nums mt-2">
            <span>
              <span className="text-neutral-200 font-medium">{formatEnergy(energyWh)}</span>
              <span className="text-neutral-500 ml-1">geladen</span>
            </span>
            {energyRemainingWh != null && energyRemainingWh > 0 && (
              <span>
                <span className="text-neutral-200 font-medium">{formatEnergy(energyRemainingWh)}</span>
                <span className="text-neutral-500 ml-1">fehlen</span>
              </span>
            )}
            <span>
              <span className="text-neutral-500">seit</span>{' '}
              <span className="text-neutral-200 font-medium">{formatElapsed(elapsed)}</span>
            </span>
            {etaSeconds != null && etaSeconds > 0 && (
              <span>
                <span className="text-neutral-500">noch</span>{' '}
                <span className="text-neutral-200 font-medium">{formatDurationMinutes(etaSeconds)}</span>
              </span>
            )}
            {watts != null && (
              <span className="ml-auto">
                <span className="text-neutral-200 font-medium">{watts.toFixed(1)} W</span>
              </span>
            )}
          </div>
        </div>
      </div>
    </Link>
  );
}
