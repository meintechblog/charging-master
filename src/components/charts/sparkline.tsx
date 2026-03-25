'use client';

import { useRef, useEffect } from 'react';
import ReactECharts from 'echarts-for-react';
import type { EChartsOption } from 'echarts';

type SparklineProps = {
  data: Array<[number, number]>;
  width?: number;
  height?: number;
};

function buildSparklineOption(): EChartsOption {
  return {
    grid: { top: 0, right: 0, bottom: 0, left: 0 },
    xAxis: { type: 'time', show: false },
    yAxis: { type: 'value', show: false },
    series: [
      {
        type: 'line',
        smooth: true,
        showSymbol: false,
        lineStyle: { color: '#3b82f6', width: 1.5 },
        areaStyle: {
          color: {
            type: 'linear',
            x: 0,
            y: 0,
            x2: 0,
            y2: 1,
            colorStops: [
              { offset: 0, color: 'rgba(59,130,246,0.3)' },
              { offset: 1, color: 'rgba(59,130,246,0.0)' },
            ],
          },
        },
        data: [],
      },
    ],
    animation: false,
  };
}

export function Sparkline({ data, width = 120, height = 40 }: SparklineProps) {
  const chartRef = useRef<ReactECharts>(null);

  useEffect(() => {
    const chart = chartRef.current?.getEchartsInstance();
    if (chart) {
      chart.setOption({ series: [{ data }] });
    }
  }, [data]);

  return (
    <ReactECharts
      ref={chartRef}
      option={buildSparklineOption()}
      style={{ width: `${width}px`, height: `${height}px` }}
      opts={{ renderer: 'canvas' }}
    />
  );
}
