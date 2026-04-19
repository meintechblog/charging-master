'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { PowerChart } from '@/components/charts/power-chart';
import { useChargeStream } from '@/hooks/use-charge-stream';
import type { WindowKey } from '@/hooks/use-sliding-window';
import type { ChargeStateEvent } from '@/modules/charging/types';

type CurvePoint = {
  offsetSeconds: number;
  apower: number;
};

type PlugDetailChartProps = {
  plugId: string;
  enableReferenceCurve?: boolean;
};

export function PlugDetailChart({ plugId, enableReferenceCurve }: PlugDetailChartProps) {
  const [initialData, setInitialData] = useState<Array<[number, number]> | null>(null);
  const [windowKey, setWindowKey] = useState<WindowKey>('15m');
  const [sessionStartedAt, setSessionStartedAt] = useState<number | null>(null);
  const [referenceData, setReferenceData] = useState<Array<[number, number]> | undefined>(undefined);
  const fetchedRef = useRef<string | null>(null);
  const sessionRef = useRef<{ profileId?: number; startedAt?: number } | null>(null);

  const fetchHistory = useCallback(async (pId: string, wk: WindowKey, since?: number) => {
    try {
      const url = since != null
        ? `/api/devices/${pId}/readings?since=${since}`
        : `/api/devices/${pId}/readings?window=${wk}`;
      const res = await fetch(url);
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
    // When a charge session is active, scope the chart to its startedAt;
    // otherwise respect the user's selected window.
    const key = sessionStartedAt != null
      ? `${plugId}:session:${sessionStartedAt}`
      : `${plugId}:${windowKey}`;
    if (fetchedRef.current === key) return;
    fetchedRef.current = key;
    setInitialData(null);
    if (sessionStartedAt != null) {
      fetchHistory(plugId, windowKey, sessionStartedAt);
    } else {
      fetchHistory(plugId, windowKey);
    }
  }, [plugId, windowKey, sessionStartedAt, fetchHistory]);

  // Reference curve: fetch and align when charge session is active
  const fetchCurve = useCallback(async (profileId: number, sessionStartedAt: number) => {
    try {
      const res = await fetch(`/api/profiles/${profileId}/curve`);
      if (!res.ok) {
        setReferenceData(undefined);
        return;
      }
      const curvePoints: CurvePoint[] = await res.json();
      // Align curve timestamps to session start time
      const aligned: Array<[number, number]> = curvePoints.map((pt) => [
        sessionStartedAt + pt.offsetSeconds * 1000,
        pt.apower,
      ]);
      setReferenceData(aligned);
    } catch {
      setReferenceData(undefined);
    }
  }, []);

  const onChargeEvent = useCallback(
    (event: ChargeStateEvent) => {
      if (!enableReferenceCurve) return;

      const isActive = event.state === 'matched' || event.state === 'charging' || event.state === 'countdown';

      if (isActive && event.sessionId) {
        // Fetch startedAt once per session to (a) scope the chart x-range
        // and (b) align the reference curve. Cached in sessionRef.
        if (sessionRef.current?.profileId !== event.profileId) {
          fetch(`/api/charging/sessions/${event.sessionId}`)
            .then((res) => res.json())
            .then((data: { startedAt?: number; session?: { startedAt: number } }) => {
              const startedAt = data.startedAt ?? data.session?.startedAt ?? Date.now();
              sessionRef.current = { profileId: event.profileId, startedAt };
              setSessionStartedAt(startedAt);
              if (enableReferenceCurve && event.profileId) {
                fetchCurve(event.profileId, startedAt);
              }
            })
            .catch(() => {});
        }
      } else if (event.state === 'complete' || event.state === 'idle' || event.state === 'aborted') {
        // Clear session scope + reference data when session ends
        setReferenceData(undefined);
        setSessionStartedAt(null);
        sessionRef.current = null;
      }
    },
    [enableReferenceCurve, fetchCurve]
  );

  useChargeStream(plugId, onChargeEvent);

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
      referenceData={referenceData}
    />
  );
}
