'use client';

import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import ReactECharts from 'echarts-for-react';
import type { EChartsOption } from 'echarts';
import { usePowerStream } from '@/hooks/use-power-stream';
import { useSlidingWindow, type WindowKey } from '@/hooks/use-sliding-window';

type PowerChartProps = {
  plugId: string;
  initialWindow?: WindowKey;
  initialData?: Array<[number, number]>;
  onWindowChange?: (key: WindowKey) => void;
  height?: string;
  referenceData?: Array<[number, number]>;
};

const WINDOW_OPTIONS: { key: WindowKey; label: string }[] = [
  { key: '5m', label: '5m' },
  { key: '15m', label: '15m' },
  { key: '30m', label: '30m' },
  { key: '1h', label: '1h' },
];

function buildChartOption(data: Array<[number, number]>, referenceData?: Array<[number, number]>): EChartsOption {
  const hasReference = referenceData && referenceData.length > 0;

  const series: EChartsOption['series'] = [
    {
      name: hasReference ? 'Aktuell' : undefined,
      type: 'line',
      smooth: true,
      showSymbol: false,
      areaStyle: {
        color: {
          type: 'linear',
          x: 0,
          y: 0,
          x2: 0,
          y2: 1,
          colorStops: [
            { offset: 0, color: 'rgba(59,130,246,0.5)' },
            { offset: 1, color: 'rgba(59,130,246,0.0)' },
          ],
        },
      },
      lineStyle: { color: '#3b82f6', width: 2 },
      data,
    },
  ];

  if (hasReference) {
    series.push({
      name: 'Referenz',
      type: 'line',
      smooth: true,
      showSymbol: false,
      lineStyle: { color: '#6b7280', width: 1.5, type: 'dashed' },
      areaStyle: undefined,
      data: referenceData,
      z: 0,
    });
  }

  return {
    backgroundColor: 'transparent',
    ...(hasReference
      ? { legend: { data: ['Aktuell', 'Referenz'], textStyle: { color: '#a3a3a3' } } }
      : {}),
    tooltip: {
      trigger: 'axis',
      formatter: (params: unknown) => {
        const items = params as Array<{ seriesName?: string; value: [number, number] }>;
        if (!items || items.length === 0) return '';
        const date = new Date(items[0].value[0]);
        const time = date.toLocaleTimeString('de-DE');
        const lines = items.map((item) => {
          const label = item.seriesName ? `${item.seriesName}: ` : '';
          return `${label}${item.value[1].toFixed(1)} W`;
        });
        return `${time}<br/>${lines.join('<br/>')}`;
      },
    },
    xAxis: {
      type: 'time',
      splitLine: { show: false },
      axisLabel: { color: '#737373' },
    },
    yAxis: {
      type: 'value',
      name: 'Watt',
      splitLine: { lineStyle: { color: '#262626' } },
      axisLabel: { color: '#737373' },
    },
    dataZoom: [
      { type: 'inside', xAxisIndex: 0 },
      {
        type: 'slider',
        xAxisIndex: 0,
        bottom: 10,
        borderColor: '#404040',
        fillerColor: 'rgba(59,130,246,0.15)',
      },
    ],
    series,
    animation: true,
    animationDuration: 300,
  };
}

export function PowerChart({ plugId, initialWindow, initialData, onWindowChange, height, referenceData }: PowerChartProps) {
  const [windowKey, setWindowKey] = useState<WindowKey>(initialWindow ?? '15m');
  const { push, clear } = useSlidingWindow(windowKey);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [chartData, setChartData] = useState<Array<[number, number]>>([]);
  const initialDataLoadedRef = useRef(false);

  // Load initial historical data into sliding window once
  useEffect(() => {
    if (initialData && initialData.length > 0 && !initialDataLoadedRef.current) {
      initialDataLoadedRef.current = true;
      let latestData: Array<[number, number]> = [];
      for (const [ts, val] of initialData) {
        latestData = push(ts, val);
      }
      setChartData(latestData);
    }
  }, [initialData, push]);

  const onReading = useCallback(
    (reading: { apower: number; timestamp: number }) => {
      const data = push(reading.timestamp, reading.apower);
      setChartData(data);
    },
    [push]
  );

  usePowerStream(plugId, onReading);

  const handleWindowChange = useCallback(
    (key: WindowKey) => {
      setWindowKey(key);
      clear();
      initialDataLoadedRef.current = false;
      onWindowChange?.(key);
    },
    [clear, onWindowChange]
  );

  const toggleFullscreen = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;

    if (!document.fullscreenElement) {
      el.requestFullscreen().then(() => setIsFullscreen(true)).catch(() => {});
    } else {
      document.exitFullscreen().then(() => setIsFullscreen(false)).catch(() => {});
    }
  }, []);

  return (
    <div ref={containerRef} className="bg-neutral-900 rounded-lg p-4">
      {/* Controls: time window buttons + fullscreen */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex gap-1">
          {WINDOW_OPTIONS.map((opt) => (
            <button
              key={opt.key}
              onClick={() => handleWindowChange(opt.key)}
              className={`px-3 py-1 text-xs rounded border transition-colors ${
                windowKey === opt.key
                  ? 'bg-blue-500/20 text-blue-400 border-blue-500/50'
                  : 'bg-neutral-800 text-neutral-400 border-neutral-700 hover:border-neutral-600'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <button
          onClick={toggleFullscreen}
          className="p-1.5 rounded text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800 transition-colors"
          title={isFullscreen ? 'Vollbild beenden' : 'Vollbild'}
        >
          {isFullscreen ? (
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M6 2v4H2M10 14v-4h4M14 2l-4 4M2 14l4-4" />
            </svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M2 6V2h4M14 10v4h-4M2 2l4 4M14 14l-4-4" />
            </svg>
          )}
        </button>
      </div>

      {/* Chart */}
      <ReactECharts
        option={buildChartOption(chartData, referenceData)}
        notMerge={true}
        style={{ height: isFullscreen ? 'calc(100vh - 80px)' : (height ?? '300px'), width: '100%' }}
        opts={{ renderer: 'canvas' }}
      />
    </div>
  );
}
