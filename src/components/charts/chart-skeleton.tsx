'use client';

/**
 * Shared loading placeholder shown while echarts-for-react resolves lazily.
 * Sized via inline style by the caller — the chart wrapper already knows
 * the height it needs, so we just fill it with a soft pulsing slab to keep
 * CLS = 0 and signal "something is coming".
 */
export function ChartSkeleton({ height, width = '100%' }: { height: string | number; width?: string | number }) {
  return (
    <div
      aria-busy="true"
      aria-label="Lade Diagramm…"
      className="animate-pulse rounded-md bg-neutral-800/40 border border-neutral-800"
      style={{ height, width }}
    />
  );
}
