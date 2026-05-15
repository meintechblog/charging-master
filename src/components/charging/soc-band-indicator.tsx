'use client';

import { useState, type CSSProperties } from 'react';
import { useChargeStream } from '@/hooks/use-charge-stream';
import type { ChargeStateEvent } from '@/modules/charging/types';

type BandState = {
  min: number;
  max: number;
  best: number;
  target: number;
  asciiBar?: string;
};

type Props = {
  plugId: string;
  initialAsciiBar?: string;
};

// Custom CSS variables drive the band-fill width AND the marker positions.
// React's typings reject unknown style keys, so we cast through CSSProperties.
type CSSVarStyle = CSSProperties & Record<`--${string}`, string>;

export function SocBandIndicator({ plugId, initialAsciiBar }: Props) {
  // Seed state with ASCII-only stub when caller passed an initial bar — first
  // paint shows something useful before the SSE callback fires. Band-container
  // stays hidden until a real event sets min/max/best/target.
  const [band, setBand] = useState<BandState | null>(
    initialAsciiBar
      ? { min: 0, max: 100, best: 0, target: 0, asciiBar: initialAsciiBar }
      : null,
  );
  const [hasLiveBand, setHasLiveBand] = useState(false);

  useChargeStream(plugId, (event: ChargeStateEvent) => {
    if (
      event.socMin != null &&
      event.socMax != null &&
      event.estimatedSoc != null &&
      event.targetSoc != null
    ) {
      setBand({
        min: event.socMin,
        max: event.socMax,
        best: event.estimatedSoc,
        target: event.targetSoc,
        asciiBar: event.socAsciiBar,
      });
      setHasLiveBand(true);
    }
  });

  // No initial ASCII and no live event → render nothing visible.
  if (!band && !initialAsciiBar) {
    return null;
  }

  // We have an initial ASCII bar but no live band yet → render <pre> fallback
  // only. (Tests cover this: getByTestId('soc-band-ascii') in the no-event path.)
  if (!hasLiveBand) {
    return (
      <>
        <pre
          data-testid="soc-band-ascii"
          className="font-mono text-sm text-neutral-400 whitespace-pre leading-tight"
        >
          {band?.asciiBar ?? initialAsciiBar}
        </pre>
        <noscript>
          <pre className="font-mono text-sm whitespace-pre">{initialAsciiBar}</pre>
        </noscript>
      </>
    );
  }

  if (!band) return null;

  const containerStyle: CSSVarStyle = {
    '--soc-min': `${band.min}%`,
    '--soc-max': `${band.max}%`,
    '--soc-best': `${band.best}%`,
    '--soc-target': `${band.target}%`,
  };

  return (
    <>
      <div
        data-testid="band-container"
        className="relative h-10 bg-neutral-900 rounded-full overflow-hidden w-full"
        style={containerStyle}
      >
        <div
          data-testid="band-fill"
          className="absolute top-0 bottom-0 bg-blue-500/30 rounded-sm transition-all duration-700 ease-out"
          style={{
            left: 'var(--soc-min)',
            width: 'calc(var(--soc-max) - var(--soc-min))',
          }}
        />
        <div
          data-testid="band-best"
          className="absolute top-0 bottom-0 w-0.5 bg-blue-300 transition-all duration-700 ease-out"
          style={{ left: 'var(--soc-best)' }}
        />
        <div
          data-testid="band-target"
          className="absolute top-0 bottom-0 w-0.5 bg-emerald-400"
          style={{ left: 'var(--soc-target)' }}
        />
      </div>
      {band.asciiBar && (
        <pre className="font-mono text-sm text-neutral-400 whitespace-pre mt-2 leading-tight overflow-x-auto">
          {band.asciiBar}
        </pre>
      )}
      <noscript>
        <pre className="font-mono text-sm whitespace-pre">{initialAsciiBar}</pre>
      </noscript>
    </>
  );
}
