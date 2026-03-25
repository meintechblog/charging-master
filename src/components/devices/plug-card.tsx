'use client';

import { useState, useCallback, useRef } from 'react';
import Link from 'next/link';
import { usePowerStream } from '@/hooks/use-power-stream';
import { Sparkline } from '@/components/charts/sparkline';
import { RelayToggle } from '@/components/devices/relay-toggle';

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
  const [sparkData, setSparkData] = useState<Array<[number, number]>>([]);
  const lastToggleAtRef = useRef<number>(0);

  const onReading = useCallback(
    (reading: { apower: number; output: boolean; timestamp: number }) => {
      setWatts(reading.apower);

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

  usePowerStream(plug.id, onReading);

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
              plug.online ? 'bg-green-500' : 'bg-red-500'
            }`}
          />
          <span className="text-xs text-neutral-400">
            {plug.online ? 'Online' : 'Offline'}
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
            initialState={relayOn}
            disabled={!plug.online}
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

      {/* Last Seen (only when offline) */}
      {!plug.online && (
        <div className="text-xs text-neutral-500">
          {plug.lastSeen
            ? formatRelativeTime(plug.lastSeen)
            : 'Noch nie gesehen'}
        </div>
      )}
    </Link>
  );
}
