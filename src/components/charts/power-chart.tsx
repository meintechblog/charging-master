'use client';

import { useState, useRef, useCallback } from 'react';
import ReactECharts from 'echarts-for-react';
import type { EChartsOption } from 'echarts';
import { usePowerStream } from '@/hooks/use-power-stream';
import { useSlidingWindow, type WindowKey } from '@/hooks/use-sliding-window';

type PowerChartProps = {
  plugId: string;
  initialWindow?: WindowKey;
};

const WINDOW_OPTIONS: { key: WindowKey; label: string }[] = [
  { key: '5m', label: '5m' },
  { key: '15m', label: '15m' },
  { key: '30m', label: '30m' },
  { key: '1h', label: '1h' },
];

function buildChartOption(): EChartsOption {
  return {
    backgroundColor: 'transparent',
    tooltip: {
      trigger: 'axis',
      formatter: (params: unknown) => {
        const p = (params as Array<{ value: [number, number] }>)[0];
        if (!p) return '';
        const date = new Date(p.value[0]);
        const time = date.toLocaleTimeString('de-DE');
        return `${time}<br/>${p.value[1].toFixed(1)} W`;
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
    series: [
      {
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
        data: [],
      },
    ],
    animation: true,
    animationDuration: 300,
  };
}

export function PowerChart({ plugId, initialWindow }: PowerChartProps) {
  const [windowKey, setWindowKey] = useState<WindowKey>(initialWindow ?? '15m');
  const { push, clear } = useSlidingWindow(windowKey);
  const chartRef = useRef<ReactECharts>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const onReading = useCallback(
    (reading: { apower: number; timestamp: number }) => {
      const data = push(reading.timestamp, reading.apower);
      const chart = chartRef.current?.getEchartsInstance();
      if (chart) {
        chart.setOption({ series: [{ data }] });
      }
    },
    [push]
  );

  usePowerStream(plugId, onReading);

  const handleWindowChange = useCallback(
    (key: WindowKey) => {
      setWindowKey(key);
      clear();
    },
    [clear]
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
        ref={chartRef}
        option={buildChartOption()}
        style={{ height: isFullscreen ? 'calc(100vh - 80px)' : '300px', width: '100%' }}
        opts={{ renderer: 'canvas' }}
      />
    </div>
  );
}
