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
  // effectiveWindow forces 'max' while a session is active so sliding-window
  // trimming doesn't hide pre-15-min data; otherwise user's picker wins.
  const [userWindow, setUserWindow] = useState<WindowKey>('15m');
  const [sessionStartedAt, setSessionStartedAt] = useState<number | null>(null);
  const windowKey: WindowKey = sessionStartedAt != null ? 'max' : userWindow;
  const setWindowKey = setUserWindow;
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

  // Reference curve: fetch and align when charge session is active.
  // curveOffsetSeconds = where in the reference the matcher anchored the
  // live data. Live time 0 (= sessionStartedAt) corresponds to reference
  // offset = curveOffsetSeconds, so we must shift the entire curve LEFT
  // by curveOffsetSeconds. Any point with offsetSeconds < curveOffsetSeconds
  // ends up before sessionStartedAt and is correctly hidden by the chart's
  // session-scoped x-range; what the user sees is the matched anchor going
  // forward — the forecast of where the charge is headed.
  const fetchCurve = useCallback(async (
    profileId: number,
    sessionStartedAt: number,
    curveOffsetSeconds: number,
  ) => {
    try {
      const res = await fetch(`/api/profiles/${profileId}/curve`);
      if (!res.ok) {
        setReferenceData(undefined);
        return;
      }
      const payload = await res.json() as
        | CurvePoint[]
        | { points: CurvePoint[] };
      const curvePoints: CurvePoint[] = Array.isArray(payload)
        ? payload
        : payload.points ?? [];
      const aligned: Array<[number, number]> = curvePoints.map((pt) => [
        sessionStartedAt + (pt.offsetSeconds - curveOffsetSeconds) * 1000,
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
        // Fetch session details once per profile-match to (a) scope the
        // chart x-range to startedAt and (b) align the reference curve
        // using the matcher's curveOffsetSeconds. Cached in sessionRef.
        if (sessionRef.current?.profileId !== event.profileId) {
          fetch(`/api/charging/sessions/${event.sessionId}`)
            .then((res) => res.json())
            .then((data: {
              startedAt?: number;
              curveOffsetSeconds?: number | null;
              session?: { startedAt: number; curveOffsetSeconds?: number | null };
            }) => {
              const startedAt = data.startedAt ?? data.session?.startedAt ?? Date.now();
              const curveOffsetSeconds =
                data.curveOffsetSeconds ?? data.session?.curveOffsetSeconds ?? 0;
              sessionRef.current = { profileId: event.profileId, startedAt };
              setSessionStartedAt(startedAt);
              if (enableReferenceCurve && event.profileId) {
                fetchCurve(event.profileId, startedAt, curveOffsetSeconds);
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
