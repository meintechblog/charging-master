'use client';

/**
 * Session-relative live charging chart.
 *
 * Design rationale (researched 2026-05-20, see plug-detail-chart history):
 *   - X-axis: session-elapsed time (mm:ss / h:mm:ss). Reference was learned
 *     against elapsed time, so wallclock here would only confuse.
 *   - Y-axis: Watts, hard-anchored at 0, soft-cap at max(reference) × 1.15.
 *     Auto-scaling destroys the visual deviation we actually care about.
 *   - Reference curve: dim grey Bezier in back with a faint area-fill.
 *   - Live curve: bright cyan solid line on top with a "you-are-here" dot
 *     at the latest sample. No fill on live — filled-on-filled becomes mud.
 *   - dataZoom: inside, wheel + pinch, X-axis only. No range tabs.
 *   - No Y-axis toggle, no time-window tabs. The chart IS the controls.
 *
 * Reference alignment (v1.7-F revised):
 *   - X-axis = absolute reference-curve time (offsetSeconds, 0 → durationSec)
 *   - Reference plotted at NATIVE offsetSeconds positions
 *   - Live plotted at `[sessionElapsedSec + curveOffsetSeconds, apower]`
 *
 * This puts both series on the same "where on the reference curve are we"
 * X-axis. The matcher (or v1.7-F overrideSession recompute) writes
 * `curveOffsetSeconds` to tell us where the live charge JOINED the
 * reference — a Bosch eBike plugged in at 32 % SoC joins the reference at
 * about offset 3800 s (the point where the reference cumulativeWh first
 * crosses 32 % of totalEnergyWh). The live curve then grows to the right.
 *
 * Pre-v1.7-F bug: reference was shifted left by curveOffsetSeconds and
 * live started at session-elapsed x=0 — looked clean but mis-anchored
 * Bosch curves where curveOffsetSeconds was 0 (pin-bypass default) even
 * after override.
 */

import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import ReactECharts from 'echarts-for-react';
import type { EChartsOption } from 'echarts';
import { usePowerStream } from '@/hooks/use-power-stream';
import { useChargeStream } from '@/hooks/use-charge-stream';
import type { ChargeStateEvent } from '@/modules/charging/types';

type ReferencePoint = { offsetSeconds: number; apower: number };

type SessionMeta = {
  sessionId: number;
  startedAt: number;
  profileId: number;
  profileName: string;
  curveOffsetSeconds: number;
  targetSoc: number;
  durationSeconds: number;
};

type ChargeSessionChartProps = {
  plugId: string;
  height?: string;
};

const ACTIVE_STATES = new Set<ChargeStateEvent['state']>([
  'matched',
  'charging',
  'countdown',
]);
const TERMINAL_STATES = new Set<ChargeStateEvent['state']>([
  'complete',
  'idle',
  'aborted',
  'error',
]);

const MAX_LIVE_POINTS = 5000;

function formatElapsed(sec: number): string {
  if (!Number.isFinite(sec)) return '–';
  const total = Math.max(0, Math.floor(sec));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/**
 * Pick a "nice" X-axis tick interval (in seconds) so 4–6 labels fit the
 * total duration. 50-minute auto-ticks are jarring — round to canonical
 * units: 1/2/5/10/15/30/60 minutes.
 */
function pickTickIntervalSec(totalSec: number): number {
  const targetTicks = 5;
  const target = totalSec / targetTicks;
  const nice = [
    60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 14400,
  ];
  return nice.find((n) => n >= target) ?? 3600;
}

export function ChargeSessionChart({ plugId, height = '420px' }: ChargeSessionChartProps) {
  const [session, setSession] = useState<SessionMeta | null>(null);
  const [referenceCurve, setReferenceCurve] = useState<ReferencePoint[]>([]);
  const [liveData, setLiveData] = useState<Array<[number, number]>>([]);

  // Refs for hot-path access from stream callbacks without re-subscribing
  // on every state change.
  const sessionRef = useRef<SessionMeta | null>(null);
  const fetchedSessionRef = useRef<number | null>(null);

  const loadSession = useCallback(
    async (sessionId: number, profileId: number, profileName: string) => {
      try {
        const [sessRes, curveRes] = await Promise.all([
          fetch(`/api/charging/sessions/${sessionId}`).then((r) => r.json()),
          fetch(`/api/profiles/${profileId}/curve`).then((r) => r.json()),
        ]);
        const sessPayload = sessRes.session ?? sessRes;
        const startedAt: number = sessPayload.startedAt ?? Date.now();
        const curveOffsetSeconds: number = sessPayload.curveOffsetSeconds ?? 0;
        const targetSoc: number = sessPayload.targetSoc ?? 80;
        const curvePoints: ReferencePoint[] = Array.isArray(curveRes)
          ? curveRes
          : curveRes.points ?? [];
        const durationSeconds: number =
          (Array.isArray(curveRes) ? 0 : curveRes.durationSeconds) ??
          (curvePoints.length > 0
            ? curvePoints[curvePoints.length - 1].offsetSeconds
            : 0);
        const meta: SessionMeta = {
          sessionId,
          startedAt,
          profileId,
          profileName,
          curveOffsetSeconds,
          targetSoc,
          durationSeconds,
        };

        // Backfill: load all readings since session start so the chart
        // doesn't show empty space when the user opens the page mid-session.
        const readingsRes = await fetch(
          `/api/devices/${plugId}/readings?since=${startedAt}`
        ).then((r) => r.json());
        const initial: Array<[number, number]> = (readingsRes.readings ?? []).map(
          ([ts, w]: [number, number]) => [(ts - startedAt) / 1000, w]
        );

        sessionRef.current = meta;
        fetchedSessionRef.current = sessionId;
        setSession(meta);
        setReferenceCurve(curvePoints);
        setLiveData(initial);
      } catch {
        // Network error — leave state empty, will retry on next charge event
      }
    },
    [plugId]
  );

  const onChargeEvent = useCallback(
    (event: ChargeStateEvent) => {
      if (TERMINAL_STATES.has(event.state)) {
        sessionRef.current = null;
        fetchedSessionRef.current = null;
        setSession(null);
        setReferenceCurve([]);
        setLiveData([]);
        return;
      }

      if (!ACTIVE_STATES.has(event.state)) return;
      if (event.sessionId == null || event.profileId == null) return;

      // Re-fetch only if the SESSION changed (not on every reading-driven
      // charge event). profileId change inside the same session is unusual
      // but supported — it means override flipped the matched profile.
      if (fetchedSessionRef.current === event.sessionId) return;

      void loadSession(event.sessionId, event.profileId, event.profileName ?? '');
    },
    [loadSession]
  );

  useChargeStream(plugId, onChargeEvent);

  const onPowerReading = useCallback(
    (reading: { plugId: string; apower: number; timestamp: number }) => {
      if (reading.plugId !== plugId) return;
      const sess = sessionRef.current;
      if (!sess) return;
      const elapsedSec = (reading.timestamp - sess.startedAt) / 1000;
      if (elapsedSec < 0) return;
      setLiveData((prev) => {
        const last = prev[prev.length - 1];
        if (last && Math.abs(last[0] - elapsedSec) < 0.5) return prev;
        const next = [...prev, [elapsedSec, reading.apower] as [number, number]];
        return next.length > MAX_LIVE_POINTS
          ? next.slice(next.length - MAX_LIVE_POINTS)
          : next;
      });
    },
    [plugId]
  );

  usePowerStream(plugId, onPowerReading);

  // Keep ref in lockstep with state in case some other code (e.g. session
  // reset via terminal event) sets state without going through sessionRef.
  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  // v1.7-F: reference plotted at native offsetSeconds positions.
  const referenceData = useMemo<Array<[number, number]>>(() => {
    return referenceCurve.map((p) => [p.offsetSeconds, p.apower] as [number, number]);
  }, [referenceCurve]);

  // Live data shifted right by curveOffsetSeconds — so live x=0 (session
  // start) appears at the reference offset where the user's start-SoC lives.
  const liveDataAligned = useMemo<Array<[number, number]>>(() => {
    if (!session) return [];
    const offset = session.curveOffsetSeconds;
    return liveData.map((d) => [d[0] + offset, d[1]] as [number, number]);
  }, [session, liveData]);

  const yMax = useMemo(() => {
    if (referenceData.length === 0 && liveDataAligned.length === 0) return 250;
    const refMax = referenceData.reduce((m, [, w]) => (w > m ? w : m), 0);
    const liveMax = liveDataAligned.reduce((m, [, w]) => (w > m ? w : m), 0);
    const peak = Math.max(refMax, liveMax, 1);
    return Math.ceil((peak * 1.15) / 10) * 10;
  }, [referenceData, liveDataAligned]);

  const xMax = useMemo(() => {
    if (!session) return 0;
    const liveMax = liveDataAligned.length > 0
      ? liveDataAligned[liveDataAligned.length - 1][0]
      : 0;
    return Math.max(session.durationSeconds, liveMax + 60);
  }, [session, liveDataAligned]);

  const tickInterval = useMemo(
    () => pickTickIntervalSec(xMax > 0 ? xMax : 1800),
    [xMax]
  );

  const chartOption = useMemo<EChartsOption>(() => {
    const latestLive = liveDataAligned.length > 0
      ? liveDataAligned[liveDataAligned.length - 1]
      : null;

    return {
      backgroundColor: 'transparent',
      grid: { top: 36, left: 56, right: 16, bottom: 36 },
      legend: {
        data: ['Referenz', 'Aktuell'],
        textStyle: { color: '#a3a3a3', fontSize: 11 },
        top: 4,
        right: 8,
        itemWidth: 14,
        itemHeight: 8,
      },
      tooltip: {
        trigger: 'axis',
        backgroundColor: '#171717',
        borderColor: '#404040',
        borderWidth: 1,
        textStyle: { color: '#e5e5e5', fontSize: 12 },
        padding: [8, 10],
        formatter: (params: unknown) => {
          const items = params as Array<{
            seriesName?: string;
            value: [number, number];
            color?: string;
          }>;
          if (!items || items.length === 0) return '';
          const refTime = formatElapsed(items[0].value[0]);
          const lines = items.map((item) => {
            const dot =
              `<span style="display:inline-block;margin-right:6px;border-radius:50%;` +
              `width:8px;height:8px;background-color:${item.color};vertical-align:middle"></span>`;
            const label = item.seriesName ? `${item.seriesName}: ` : '';
            return `${dot}${label}<b>${item.value[1].toFixed(1)} W</b>`;
          });
          return `<div style="font-weight:600;margin-bottom:4px;color:#fafafa">@ ${refTime}</div>${lines.join('<br/>')}`;
        },
      },
      xAxis: {
        type: 'value',
        min: 0,
        max: xMax > 0 ? xMax : undefined,
        interval: tickInterval,
        axisLine: { lineStyle: { color: '#404040' } },
        axisTick: { lineStyle: { color: '#404040' } },
        axisLabel: {
          color: '#737373',
          formatter: (val: number) => formatElapsed(val),
          fontSize: 11,
        },
        splitLine: { show: false },
      },
      yAxis: {
        type: 'value',
        min: 0,
        max: yMax,
        axisLine: { lineStyle: { color: '#404040' } },
        axisLabel: {
          color: '#737373',
          formatter: (val: number) => `${val} W`,
          fontSize: 11,
        },
        splitLine: { lineStyle: { color: '#262626' } },
      },
      dataZoom: [
        {
          type: 'inside',
          xAxisIndex: 0,
          filterMode: 'none',
          zoomOnMouseWheel: true,
          moveOnMouseMove: true,
          preventDefaultMouseMove: false,
        },
      ],
      series: [
        {
          name: 'Referenz',
          type: 'line',
          smooth: 0.4,
          showSymbol: false,
          lineStyle: { color: '#525252', width: 1.5 },
          areaStyle: { color: 'rgba(255,255,255,0.04)' },
          data: referenceData,
          z: 1,
          animation: false,
        },
        {
          name: 'Aktuell',
          type: 'line',
          smooth: false,
          showSymbol: false,
          lineStyle: { color: '#06b6d4', width: 2.5 },
          data: liveDataAligned,
          z: 2,
          animation: false,
          markPoint: latestLive
            ? {
                symbol: 'circle',
                symbolSize: 10,
                itemStyle: {
                  color: '#06b6d4',
                  borderColor: '#0e7490',
                  borderWidth: 2,
                },
                data: [{ name: 'jetzt', coord: latestLive, value: latestLive[1] }],
                animation: false,
                silent: true,
              }
            : undefined,
        },
      ],
      animation: true,
      animationDuration: 200,
      animationDurationUpdate: 200,
    };
  }, [referenceData, liveDataAligned, yMax, xMax, tickInterval]);

  if (!session) {
    return (
      <div
        className="flex items-center justify-center bg-neutral-900 rounded-lg border border-neutral-800 px-6 py-12"
        style={{ minHeight: height }}
      >
        <div className="text-center max-w-md">
          <div className="text-sm text-neutral-400 mb-1.5">Kein aktiver Ladevorgang</div>
          <div className="text-xs text-neutral-500 leading-relaxed">
            Sobald ein Akku eingesteckt wird, erscheint hier die Live-Ladekurve
            mit Referenz-Overlay aus dem erkannten Profil.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-neutral-900 rounded-lg border border-neutral-800 p-4">
      <div className="flex items-baseline justify-between mb-2 px-1">
        <div className="text-sm text-neutral-300">
          {session.profileName || 'Aktuelle Sitzung'}
          <span className="text-xs text-neutral-500 ml-2">
            Ziel {session.targetSoc} %
          </span>
        </div>
        <div className="text-[11px] text-neutral-500">
          Referenzkurven-Zeit · Live startet bei {formatElapsed(session.curveOffsetSeconds)}
        </div>
      </div>
      <ReactECharts
        option={chartOption}
        notMerge={false}
        lazyUpdate={true}
        style={{ height, width: '100%' }}
        opts={{ renderer: 'canvas' }}
      />
    </div>
  );
}
