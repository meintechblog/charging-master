'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { PowerChart } from '@/components/charts/power-chart';
import type { WindowKey } from '@/hooks/use-sliding-window';

type PlugDetailChartProps = {
  plugId: string;
};

export function PlugDetailChart({ plugId }: PlugDetailChartProps) {
  const [initialData, setInitialData] = useState<Array<[number, number]> | null>(null);
  const [windowKey, setWindowKey] = useState<WindowKey>('15m');
  const fetchedRef = useRef<string | null>(null);

  const fetchHistory = useCallback(async (pId: string, wk: WindowKey) => {
    try {
      const res = await fetch(`/api/devices/${pId}/readings?window=${wk}`);
      if (!res.ok) {
        setInitialData([]);
        return;
      }
      const json: { readings: Array<[number, number]> } = await res.json();
      setInitialData(json.readings);
    } catch {
      setInitialData([]);
    }
  }, []);

  useEffect(() => {
    const key = `${plugId}:${windowKey}`;
    if (fetchedRef.current === key) return;
    fetchedRef.current = key;
    setInitialData(null);
    fetchHistory(plugId, windowKey);
  }, [plugId, windowKey, fetchHistory]);

  if (initialData === null) {
    return (
      <div className="flex items-center justify-center h-[400px]">
        <div className="flex items-center gap-2 text-neutral-500 text-sm">
          <svg
            className="animate-spin h-4 w-4"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <circle cx="12" cy="12" r="10" strokeOpacity="0.25" />
            <path d="M12 2a10 10 0 0 1 10 10" strokeLinecap="round" />
          </svg>
          Lade Verlaufsdaten...
        </div>
      </div>
    );
  }

  return (
    <PowerChart
      plugId={plugId}
      initialWindow={windowKey}
      initialData={initialData}
      onWindowChange={setWindowKey}
      height="400px"
    />
  );
}
