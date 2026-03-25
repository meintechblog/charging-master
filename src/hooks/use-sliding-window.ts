'use client';

import { useRef, useCallback } from 'react';

export const WINDOW_POINTS: Record<WindowKey, number> = {
  '5m': 150,   // 5 * 60 / 2 at ~1 reading per 2 seconds
  '15m': 450,
  '30m': 900,
  '1h': 1800,
};

export type WindowKey = '5m' | '15m' | '30m' | '1h';

export function useSlidingWindow(windowKey: WindowKey = '15m') {
  const maxPoints = WINDOW_POINTS[windowKey] ?? 450;
  const dataRef = useRef<Array<[number, number]>>([]);

  const push = useCallback(
    (timestamp: number, value: number): Array<[number, number]> => {
      dataRef.current.push([timestamp, value]);
      if (dataRef.current.length > maxPoints) {
        dataRef.current = dataRef.current.slice(-maxPoints);
      }
      return dataRef.current;
    },
    [maxPoints]
  );

  const getData = useCallback((): Array<[number, number]> => {
    return dataRef.current;
  }, []);

  const clear = useCallback(() => {
    dataRef.current = [];
  }, []);

  return { push, getData, clear };
}
