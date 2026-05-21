'use client';

import { useState, useCallback, useRef } from 'react';
import Link from 'next/link';
import { usePowerStream, useOnlineStream } from '@/hooks/use-power-stream';
import { useChargeStream } from '@/hooks/use-charge-stream';
import { Sparkline } from '@/components/charts/sparkline';
import { RelayToggle } from '@/components/devices/relay-toggle';
import type { ChargeStateEvent } from '@/modules/charging/types';

const ACTIVE_CHARGE_STATES = new Set<ChargeStateEvent['state']>([
  'detecting',
  'matched',
  'charging',
  'countdown',
]);

type PlugCardProps = {
  plug: {
    id: string;
    name: string;
    online: boolean;
    enabled: boolean;
    lastSeen: number | null;
    output?: boolean;
  };
};

const MAX_SPARK_POINTS = 90; // ~3 minutes at 1 reading/2sec

function formatDetectingLabel(charge: {
  detectionSamples?: number;
  detectionTargetSamples?: number;
  bestCandidateName?: string;
  bestCandidateConfidence?: number;
}): string {
  const samples = charge.detectionSamples;
  const target = charge.detectionTargetSamples;

  // Surface the best speculative candidate when DTW already has a strong
  // (≥0.5) hint — keeps the user informed without committing to a profile.
  // Label disambiguates from SoC: "Match 69 %" can't be misread as "69 % SoC".
  if (
    charge.bestCandidateName &&
    charge.bestCandidateConfidence != null &&
    charge.bestCandidateConfidence >= 0.5
  ) {
    const pct = Math.round(charge.bestCandidateConfidence * 100);
    return `Vermutlich ${charge.bestCandidateName} (Match ${pct} %)`;
  }

  if (samples != null && target != null) {
    return `Erkenne Gerät… ${samples}/${target}`;
  }
  return 'Gerät wird erkannt…';
}

function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `vor ${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `vor ${minutes} Min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `vor ${hours} Std`;
  const days = Math.floor(hours / 24);
  return `vor ${days} Tagen`;
}

export function PlugCard({ plug }: PlugCardProps) {
  const [watts, setWatts] = useState<number | null>(null);
  const [relayOn, setRelayOn] = useState(plug.output ?? false);
  const [isOnline, setIsOnline] = useState(plug.online);
  const [sparkData, setSparkData] = useState<Array<[number, number]>>([]);
  const [charge, setCharge] = useState<{
    state: ChargeStateEvent['state'];
    profileName?: string;
    estimatedSoc?: number;
    targetSoc?: number;
    detectionSamples?: number;
    detectionTargetSamples?: number;
    bestCandidateName?: string;
    bestCandidateConfidence?: number;
  } | null>(null);
  const lastToggleAtRef = useRef<number>(0);

  const onReading = useCallback(
    (reading: { apower: number; output: boolean; timestamp: number }) => {
      setWatts(reading.apower);
      setIsOnline(true); // If we get a reading, it's online

      // Respect debounce: ignore SSE relay updates within 4s of a toggle
      const elapsed = Date.now() - lastToggleAtRef.current;
      if (elapsed >= 4000) {
        setRelayOn(reading.output);
      }

      setSparkData((prev) => {
        const next = [...prev, [reading.timestamp, reading.apower] as [number, number]];
        return next.length > MAX_SPARK_POINTS ? next.slice(-MAX_SPARK_POINTS) : next;
      });
    },
    []
  );

  const onOnline = useCallback(
    (event: { plugId: string; online: boolean }) => {
      if (event.plugId === plug.id) {
        setIsOnline(event.online);
      }
    },
    [plug.id]
  );

  const onCharge = useCallback((event: ChargeStateEvent) => {
    if (ACTIVE_CHARGE_STATES.has(event.state)) {
      setCharge({
        state: event.state,
        profileName: event.profileName,
        estimatedSoc: event.estimatedSoc,
        targetSoc: event.targetSoc,
        detectionSamples: event.detectionSamples,
        detectionTargetSamples: event.detectionTargetSamples,
        bestCandidateName: event.bestCandidateName,
        bestCandidateConfidence: event.bestCandidateConfidence,
      });
    } else {
      setCharge(null);
    }
  }, []);

  usePowerStream(plug.id, onReading);
  useOnlineStream(onOnline);
  useChargeStream(plug.id, onCharge);

  const handleRelayToggle = useCallback((newState: boolean) => {
    lastToggleAtRef.current = Date.now();
    setRelayOn(newState);
  }, []);

  const offline = !isOnline;
  const idle = !charge;

  return (
    <Link
      href={`/devices/${plug.id}`}
      className={`group relative block overflow-hidden p-4 lift-hover ${!plug.enabled ? 'opacity-50' : ''}`}
      style={{
        background: 'var(--color-ink-2)',
        border: '1px solid var(--color-line-soft)',
        borderRadius: 'var(--radius-lg)',
      }}
    >
      {/* Header: name on top, status row */}
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium text-[color:var(--color-text-strong)] truncate leading-tight">
            {plug.name}
          </div>
          <div className="mt-1 flex items-center gap-1.5">
            <span
              className="status-orb"
              style={{ color: offline ? 'var(--color-danger)' : 'var(--color-ok)' }}
            />
            <span
              className="font-mono text-[10px] uppercase tracking-[0.16em]"
              style={{ color: offline ? 'var(--color-danger)' : 'var(--color-text-faint)' }}
            >
              {offline ? 'offline' : 'online'}
            </span>
          </div>
        </div>

        <div
          onClick={(e) => e.preventDefault()}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') e.stopPropagation(); }}
          role="presentation"
        >
          <RelayToggle
            plugId={plug.id}
            state={relayOn}
            disabled={!isOnline}
            onToggle={handleRelayToggle}
          />
        </div>
      </div>

      {/* Big mono watt readout */}
      <div className="flex items-baseline gap-1.5 mb-1">
        <span
          className="font-mono-data text-[32px] leading-none font-medium text-[color:var(--color-text-strong)]"
          style={{ letterSpacing: '-0.03em' }}
        >
          {watts !== null ? watts.toFixed(1) : '—'}
        </span>
        <span className="text-[12px] font-mono uppercase tracking-[0.18em] text-[color:var(--color-text-faint)]">W</span>
      </div>

      {/* Sparkline */}
      <div className="h-[34px] flex items-end mt-1">
        {sparkData.length > 2 ? (
          <Sparkline data={sparkData} />
        ) : (
          <div className="text-[10px] font-mono uppercase tracking-wider text-[color:var(--color-text-muted)]">
            keine daten
          </div>
        )}
      </div>

      {/* Active charging strip */}
      {charge && (
        <div
          className="mt-3 pt-3 flex items-center justify-between gap-2"
          style={{ borderTop: '1px solid var(--color-line-faint)' }}
        >
          <div className="flex items-center gap-2 min-w-0">
            <span className="status-orb status-orb-pulse" style={{ color: 'var(--color-accent)' }} />
            <span className="text-[11px] truncate text-[color:var(--color-text-default)]">
              {charge.state === 'detecting'
                ? formatDetectingLabel(charge)
                : charge.profileName ?? 'Ladevorgang'}
            </span>
            {charge.state !== 'detecting' &&
              charge.estimatedSoc != null &&
              charge.targetSoc != null && (
                <span className="font-mono text-[11px] tabular-nums shrink-0" style={{ color: 'var(--color-text-faint)' }}>
                  {charge.estimatedSoc}→{charge.targetSoc}
                </span>
              )}
          </div>
        </div>
      )}

      {/* Last-seen strip (only offline + idle) */}
      {offline && idle && (
        <div
          className="mt-3 pt-3 text-[10px] font-mono uppercase tracking-wider text-[color:var(--color-text-muted)]"
          style={{ borderTop: '1px solid var(--color-line-faint)' }}
        >
          {plug.lastSeen ? formatRelativeTime(plug.lastSeen) : 'noch nie gesehen'}
        </div>
      )}
    </Link>
  );
}
