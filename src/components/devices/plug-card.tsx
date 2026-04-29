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
  if (
    charge.bestCandidateName &&
    charge.bestCandidateConfidence != null &&
    charge.bestCandidateConfidence >= 0.5
  ) {
    const pct = Math.round(charge.bestCandidateConfidence * 100);
    return `Vermutlich ${charge.bestCandidateName} (${pct} %)`;
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

  return (
    <Link
      href={`/devices/${plug.id}`}
      className={`block bg-neutral-900 rounded-lg border border-neutral-800 p-4 hover:border-neutral-700 transition-colors cursor-pointer ${
        !plug.enabled ? 'opacity-50' : ''
      }`}
    >
      {/* Header: Name + Online Status */}
      <div className="flex items-center justify-between mb-3">
        <span className="text-base font-medium text-neutral-100 truncate">
          {plug.name}
        </span>
        <div className="flex items-center gap-1.5">
          <span
            className={`w-2 h-2 rounded-full ${
              isOnline ? 'bg-green-500' : 'bg-red-500'
            }`}
          />
          <span className="text-xs text-neutral-400">
            {isOnline ? 'Online' : 'Offline'}
          </span>
        </div>
      </div>

      {/* Watt Display */}
      <div className="mb-3 flex items-end justify-between">
        <div>
          <span
            className="text-3xl font-bold text-neutral-100 tabular-nums transition-all duration-300"
          >
            {watts !== null ? watts.toFixed(1) : '--'}
          </span>
          <span className="text-sm text-neutral-400 ml-1">W</span>
        </div>

        {/* Relay Toggle - stop propagation to prevent Link navigation */}
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

      {/* Sparkline */}
      {sparkData.length > 2 && (
        <div className="mb-2">
          <Sparkline data={sparkData} />
        </div>
      )}

      {/* Active charging indicator */}
      {charge && (
        <div className="mt-3 pt-3 border-t border-neutral-800 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <span className="relative flex h-2 w-2 shrink-0">
              <span className="absolute inline-flex h-full w-full rounded-full bg-blue-500 opacity-60 animate-ping" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-blue-500" />
            </span>
            <span className="text-xs text-neutral-300 truncate">
              {charge.state === 'detecting'
                ? formatDetectingLabel(charge)
                : charge.profileName ?? 'Ladevorgang'}
            </span>
            {charge.state !== 'detecting' &&
              charge.estimatedSoc != null &&
              charge.targetSoc != null && (
                <span className="text-xs text-neutral-500 tabular-nums shrink-0">
                  {charge.estimatedSoc}% → {charge.targetSoc}%
                </span>
              )}
          </div>
          <span className="text-xs text-blue-400 hover:text-blue-300 shrink-0">
            Details →
          </span>
        </div>
      )}

      {/* Last Seen (only when offline) */}
      {!isOnline && !charge && (
        <div className="text-xs text-neutral-500">
          {plug.lastSeen
            ? formatRelativeTime(plug.lastSeen)
            : 'Noch nie gesehen'}
        </div>
      )}
    </Link>
  );
}
