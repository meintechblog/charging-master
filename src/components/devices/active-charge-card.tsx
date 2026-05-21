'use client';

/**
 * Active charge card — the dashboard's instrument cluster.
 *
 * Visual hierarchy (industrial instrument cluster aesthetic):
 *
 *  ┌─┬──────────────────────────────────────────────────────────────────┐
 *  │█│ [photo]  PROFIL                                            CHARGING│
 *  │ │          Bosch PowerTube 625 · Schuppen                            │
 *  │ │                                                                    │
 *  │ │     73%       ZIEL 80%  ·  173 W                                  │
 *  │ │   ─────       SEIT  1:42  ·  NOCH ~5 min                          │
 *  │ │     SoC                                                            │
 *  │ │   ═══════════ Confidence Bar ═════════════                         │
 *  │ │   GELADEN 334 Wh        FEHLEN 124 Wh                              │
 *  └─┴──────────────────────────────────────────────────────────────────┘
 *
 *   ▌ left rail = state colour (cyan charging, amber countdown)
 *   ▌ huge mono SoC % is the hero
 *   ▌ all numbers are tabular mono so width never jiggles when digits tick
 *   ▌ labels are eyebrow-style uppercase tracking-wide; data is loud
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

function formatElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  if (h > 0) return `${h}h ${m.toString().padStart(2, '0')}m`;
  return `${m} min`;
}

function stateBadgeLabel(state: string): string {
  switch (state) {
    case 'detecting': return 'Erkenne';
    case 'matched':   return 'Erkannt';
    case 'charging':  return 'Lädt';
    case 'countdown': return 'Stoppt gleich';
    default:          return state;
  }
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

  // Wall-clock elapsed tick every 10 s.
  useEffect(() => {
    const handle = window.setInterval(() => {
      setElapsed(Date.now() - initial.startedAt);
    }, 10_000);
    return () => window.clearInterval(handle);
  }, [initial.startedAt]);

  // Lazy photo fetch if the profileId changes during the session and the
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
    return () => { aborted = true; };
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
  const isDetecting = state === 'detecting';
  const stateColor = isCountdown ? 'var(--color-warn)' : 'var(--color-accent)';
  const stateColorSoft = isCountdown ? 'var(--color-warn-soft)' : 'var(--color-accent-soft)';

  return (
    <Link
      href={`/devices/${plugId}`}
      className="group relative block overflow-hidden lift-hover"
      style={{
        background: 'var(--color-ink-2)',
        border: '1px solid var(--color-line-soft)',
        borderRadius: 'var(--radius-lg)',
      }}
    >
      {/* Status rail on the left edge — bleeds the full height of the card. */}
      <div
        className="absolute left-0 top-0 bottom-0 w-[3px]"
        style={{
          background: stateColor,
          boxShadow: `0 0 14px 0 ${stateColorSoft}`,
        }}
      />

      {/* Subtle accent wash bottom-right — softens the hard rectangle. */}
      <div
        className="pointer-events-none absolute -bottom-20 -right-20 w-60 h-60 rounded-full opacity-50"
        style={{
          background: `radial-gradient(circle, ${stateColorSoft} 0%, transparent 60%)`,
        }}
      />

      <div className="relative grid grid-cols-1 lg:grid-cols-[auto_1fr_auto] gap-5 lg:gap-7 px-6 py-5 pl-7">
        {/* ─────────────── Identity column ─────────────── */}
        <div className="flex items-start gap-4 lg:max-w-[280px]">
          {/* Photo — frame with hairline border, NOT a fluffy card */}
          <div className="shrink-0">
            {photoUrl != null ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={photoUrl}
                alt={profileName ?? 'Profilfoto'}
                className="w-24 h-16 object-contain"
                style={{
                  background: 'var(--color-ink-1)',
                  border: '1px solid var(--color-line-soft)',
                  borderRadius: 'var(--radius-sm)',
                }}
                loading="lazy"
              />
            ) : (
              <div
                className="w-24 h-16 flex items-center justify-center text-[10px] font-mono uppercase tracking-wider"
                style={{
                  background: 'var(--color-ink-1)',
                  border: '1px dashed var(--color-line-soft)',
                  borderRadius: 'var(--radius-sm)',
                  color: 'var(--color-text-muted)',
                }}
              >
                {isDetecting ? 'Scan…' : 'No Photo'}
              </div>
            )}
          </div>

          <div className="flex flex-col min-w-0 flex-1">
            {/* Eyebrow — current state in mono caps */}
            <div className="flex items-center gap-2 mb-1.5">
              <span className="status-orb status-orb-pulse" style={{ color: stateColor }} />
              <span
                className="font-mono text-[10px] uppercase tracking-[0.18em] font-medium"
                style={{ color: stateColor }}
              >
                {stateBadgeLabel(state)}
              </span>
            </div>
            {/* Headline — profile name */}
            <div className="text-[17px] font-semibold leading-tight text-[color:var(--color-text-strong)] truncate">
              {profileName ?? (isDetecting ? 'Gerät wird erkannt…' : 'Unbekannt')}
            </div>
            {/* Sub-label — plug + IP, mono with subtle separators */}
            <div className="mt-1 flex items-center gap-2 text-[11px] flex-wrap text-[color:var(--color-text-faint)]">
              <span>{plugName}</span>
              {plugIp && (
                <>
                  <span style={{ color: 'var(--color-text-muted)' }}>·</span>
                  <span className="font-mono">{plugIp}</span>
                </>
              )}
              {!online && (
                <>
                  <span style={{ color: 'var(--color-text-muted)' }}>·</span>
                  <span className="font-mono uppercase tracking-wider" style={{ color: 'var(--color-danger)' }}>offline</span>
                </>
              )}
            </div>
          </div>
        </div>

        {/* ─────────────── SoC hero + bar column ─────────────── */}
        <div className="flex flex-col justify-center lg:border-x lg:px-7 lg:border-[color:var(--color-line-faint)]">
          {estSoc != null ? (
            <>
              <div className="flex items-baseline gap-3 mb-3">
                <span className="label-eyebrow shrink-0">SoC</span>
                <span
                  className="font-mono-data leading-none font-medium text-[44px] sm:text-[52px] text-[color:var(--color-text-strong)]"
                  style={{ letterSpacing: '-0.04em' }}
                >
                  {estSoc}
                  <span className="text-[24px] sm:text-[28px] ml-0.5" style={{ color: 'var(--color-text-faint)' }}>%</span>
                </span>
                {socMin != null && socMax != null && socMax - socMin > 1 && (
                  <span
                    className="font-mono text-[11px] tabular-nums"
                    style={{ color: 'var(--color-text-muted)' }}
                  >
                    ±{Math.round((socMax - socMin) / 2)}
                  </span>
                )}
              </div>
              <SocConfidenceBar
                socBest={estSoc}
                socMin={socMin ?? estSoc}
                socMax={socMax ?? estSoc}
                targetSoc={targetSoc}
                fillColor={stateColor}
                bandConfidence={bandConfidence ?? undefined}
                hideTargetCaption
              />
            </>
          ) : (
            <div className="flex items-center gap-3">
              <span className="status-orb status-orb-pulse" style={{ color: 'var(--color-accent)' }} />
              <span className="text-[14px] text-[color:var(--color-text-soft)]">
                Lade-Charakteristik wird abgeglichen…
              </span>
            </div>
          )}
        </div>

        {/* ─────────────── Stats column ─────────────── */}
        <div className="grid grid-cols-2 lg:grid-cols-1 lg:auto-rows-min gap-x-6 gap-y-3 lg:gap-y-2.5 lg:min-w-[150px]">
          <StatLine label="Ziel" value={`${targetSoc}%`} accent="var(--color-warn)" mono />
          {watts != null && (
            <StatLine
              label="Live"
              value={`${watts.toFixed(0)} W`}
              accent="var(--color-text-strong)"
              mono
            />
          )}
          <StatLine label="Seit" value={formatElapsed(elapsed)} />
          {etaSeconds != null && etaSeconds > 0 && (
            <StatLine
              label="ETA"
              value={`~${formatDurationMinutes(etaSeconds)}`}
              accent={isCountdown ? 'var(--color-warn)' : 'var(--color-text-default)'}
            />
          )}
          <StatLine label="Geladen" value={formatEnergy(energyWh)} />
          {energyRemainingWh != null && energyRemainingWh > 0 && (
            <StatLine label="Fehlen" value={formatEnergy(energyRemainingWh)} />
          )}
        </div>
      </div>
    </Link>
  );
}

function StatLine({
  label,
  value,
  accent = 'var(--color-text-default)',
  mono = false,
}: {
  label: string;
  value: string;
  accent?: string;
  mono?: boolean;
}) {
  return (
    <div className="flex flex-col gap-0.5 min-w-0">
      <span className="label-eyebrow">{label}</span>
      <span
        className={`text-[15px] leading-none truncate ${mono ? 'font-mono-data font-medium' : 'font-medium'}`}
        style={{ color: accent }}
      >
        {value}
      </span>
    </div>
  );
}
