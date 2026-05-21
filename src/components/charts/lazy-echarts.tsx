'use client';

import type { ComponentType } from 'react';
import dynamic from 'next/dynamic';
import type { EChartsReactProps } from 'echarts-for-react/lib/types';
import { ChartSkeleton } from './chart-skeleton';

/**
 * Single lazy boundary that registers ECharts core + the components we
 * actually use AND ships the `echarts-for-react` React wrapper. Everything
 * inside this dynamic() call lands in its own chunk that ONLY loads when a
 * chart component mounts — not in any page's first-load JS.
 *
 * Tree-shaking benefit: ~1.14 MB all-in-one ECharts → ~626 kB after
 * cherry-picking LineChart + Canvas renderer + the handful of components
 * we touch (Tooltip, Grid, Legend, DataZoomInside, MarkLine, MarkPoint,
 * MarkArea). The all-in-one bundle drags in pie/bar/sunburst/3D/maps that
 * we will never render here.
 *
 * Why the wrapper indirection: echarts-for-react accepts an optional
 * `echarts` prop and uses it instead of importing the full library
 * itself. By pre-binding our configured `echartsCore` here, consumers get
 * a drop-in <ReactECharts/> with no config noise.
 *
 * Skeleton height is parameterised because chart slots vary from a 40 px
 * sparkline to a 420 px full-width session chart.
 */

type LazyEChartsLoader = ComponentType<EChartsReactProps>;

const loaderCache = new Map<string, LazyEChartsLoader>();

export function makeLazyECharts(opts: { height: number; width?: number | string }): LazyEChartsLoader {
  const key = `${opts.height}-${opts.width ?? 'full'}`;
  const cached = loaderCache.get(key);
  if (cached) return cached;

  const loader = dynamic(
    async () => {
      const [coreMod, chartsMod, componentsMod, renderersMod, wrapperMod] = await Promise.all([
        import('echarts/core'),
        import('echarts/charts'),
        import('echarts/components'),
        import('echarts/renderers'),
        import('echarts-for-react/lib/core'),
      ]);

      coreMod.use([
        chartsMod.LineChart,
        componentsMod.TooltipComponent,
        componentsMod.GridComponent,
        componentsMod.LegendComponent,
        componentsMod.DataZoomInsideComponent,
        componentsMod.MarkLineComponent,
        componentsMod.MarkPointComponent,
        componentsMod.MarkAreaComponent,
        renderersMod.CanvasRenderer,
      ]);

      const ReactECharts = wrapperMod.default;
      const Configured = (props: EChartsReactProps) => <ReactECharts echarts={coreMod} {...props} />;
      Configured.displayName = 'LazyECharts';
      return Configured;
    },
    {
      ssr: false,
      loading: () => <ChartSkeleton height={opts.height} width={opts.width ?? '100%'} />,
    }
  ) as LazyEChartsLoader;

  loaderCache.set(key, loader);
  return loader;
}
