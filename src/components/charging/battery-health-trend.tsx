'use client';

import { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import type { EChartsOption } from 'echarts';

const ReactECharts = dynamic(() => import('echarts-for-react'), { ssr: false });

type Snapshot = {
  id: number;
  recordedAt: number;
  totalEnergyWhAc: number;
  effectiveDcWh: number;
  efficiencyUsed: number;
  peakPowerW: number | null;
  durationSeconds: number | null;
  source: string;
};

type Summary = {
  count: number;
  baselineDcWh: number | null;
  latestDcWh: number | null;
  baselineDate: number | null;
  latestDate: number | null;
  degradationPct: number | null;
};

type Props = { profileId: number };

export function BatteryHealthTrend({ profileId }: Props) {
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/profiles/${profileId}/health`)
      .then((r) => r.ok ? r.json() : { snapshots: [], summary: null })
      .then((data) => {
        setSnapshots(data.snapshots ?? []);
        setSummary(data.summary ?? null);
      })
      .finally(() => setLoading(false));
  }, [profileId]);

  if (loading) return <p className="text-sm text-neutral-500">Lade Akku-Gesundheit…</p>;

  if (snapshots.length === 0) {
    return (
      <p className="text-sm text-neutral-500">
        Noch keine Health-Snapshots. Jeder Lernvorgang erzeugt einen Datenpunkt — re-learne den Akku alle paar Monate, um Kapazitätsverlust zu tracken.
      </p>
    );
  }

  const option: EChartsOption = {
    backgroundColor: 'transparent',
    tooltip: {
      trigger: 'axis',
      formatter: (params: unknown) => {
        const arr = params as Array<{ axisValue: string; data: number }>;
        const p = arr[0];
        return `${p.axisValue}<br/>DC im Akku: <b>${p.data.toFixed(0)} Wh</b>`;
      },
      backgroundColor: 'rgba(23,23,23,0.95)',
      borderColor: '#404040',
      textStyle: { color: '#e5e5e5' },
    },
    grid: { top: 16, left: 48, right: 16, bottom: 32 },
    xAxis: {
      type: 'category',
      data: snapshots.map((s) => new Date(s.recordedAt).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit' })),
      axisLine: { lineStyle: { color: '#404040' } },
      axisLabel: { color: '#a3a3a3', fontSize: 11 },
    },
    yAxis: {
      type: 'value',
      name: 'DC Wh',
      nameTextStyle: { color: '#737373', fontSize: 10 },
      axisLine: { show: false },
      splitLine: { lineStyle: { color: '#262626' } },
      axisLabel: { color: '#a3a3a3', fontSize: 11 },
    },
    series: [{
      type: 'line',
      data: snapshots.map((s) => Math.round(s.effectiveDcWh)),
      smooth: true,
      symbol: 'circle',
      symbolSize: 7,
      lineStyle: { color: '#10b981', width: 2 },
      itemStyle: { color: '#10b981' },
      areaStyle: { color: 'rgba(16,185,129,0.15)' },
    }],
  };

  const deg = summary?.degradationPct;
  const degColor = deg == null ? 'text-neutral-400' : deg < 5 ? 'text-green-400' : deg < 15 ? 'text-yellow-400' : 'text-red-400';
  const degSign = deg == null ? '' : deg >= 0 ? '−' : '+';
  const degAbs = deg != null ? Math.abs(deg).toFixed(1) : '—';
  const baselineStr = summary?.baselineDate ? new Date(summary.baselineDate).toLocaleDateString('de-DE') : '—';

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="bg-neutral-800/50 rounded p-3">
          <div className="text-xs text-neutral-500">Snapshots</div>
          <div className="text-lg font-bold text-neutral-100">{summary?.count ?? 0}</div>
        </div>
        <div className="bg-neutral-800/50 rounded p-3">
          <div className="text-xs text-neutral-500">Aktuell DC</div>
          <div className="text-lg font-bold text-neutral-100">{summary?.latestDcWh != null ? `${Math.round(summary.latestDcWh)} Wh` : '—'}</div>
        </div>
        <div className="bg-neutral-800/50 rounded p-3">
          <div className="text-xs text-neutral-500">Baseline ({baselineStr})</div>
          <div className="text-lg font-bold text-neutral-100">{summary?.baselineDcWh != null ? `${Math.round(summary.baselineDcWh)} Wh` : '—'}</div>
        </div>
        <div className="bg-neutral-800/50 rounded p-3">
          <div className="text-xs text-neutral-500">Verlust</div>
          <div className={`text-lg font-bold font-mono ${degColor}`}>{deg != null ? `${degSign}${degAbs} %` : '—'}</div>
        </div>
      </div>
      {snapshots.length >= 2 && (
        <div className="rounded bg-neutral-950 p-2">
          <ReactECharts option={option} style={{ height: 220 }} theme="dark" />
        </div>
      )}
    </div>
  );
}
