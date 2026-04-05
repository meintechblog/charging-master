'use client';

import { useEffect, useRef } from 'react';
import type { PowerReading, PlugOnlineEvent } from '@/modules/events/event-bus';

export type PowerCallback = (reading: PowerReading) => void;
export type OnlineCallback = (event: PlugOnlineEvent) => void;

// Singleton EventSource state (module-level, not React state)
let sharedEventSource: EventSource | null = null;
const powerListeners = new Map<string, Set<PowerCallback>>();
const onlineListeners = new Set<OnlineCallback>();
let refCount = 0;

// Cache most recent reading per plug (survives navigation)
export const latestReadings = new Map<string, PowerReading>();

function getEventSource(): EventSource {
  if (sharedEventSource && sharedEventSource.readyState !== EventSource.CLOSED) {
    return sharedEventSource;
  }

  sharedEventSource = new EventSource('/api/sse/power');

  sharedEventSource.onmessage = (event) => {
    try {
      const reading: PowerReading = JSON.parse(event.data);
      latestReadings.set(reading.plugId, reading);

      const plugSet = powerListeners.get(reading.plugId);
      if (plugSet) {
        for (const cb of plugSet) cb(reading);
      }

      const wildcardSet = powerListeners.get('*');
      if (wildcardSet) {
        for (const cb of wildcardSet) cb(reading);
      }
    } catch {
      // Invalid JSON, ignore
    }
  };

  sharedEventSource.addEventListener('online', (event) => {
    try {
      const data: PlugOnlineEvent = JSON.parse((event as MessageEvent).data);
      for (const cb of onlineListeners) cb(data);
    } catch {
      // Invalid JSON, ignore
    }
  });

  sharedEventSource.onerror = () => {
    // Browser auto-reconnects EventSource; no manual action needed
  };

  return sharedEventSource;
}

let closeTimer: ReturnType<typeof setTimeout> | null = null;

function closeIfUnused() {
  // Defer the actual close: during a page navigation the old page's
  // subscribers unmount a tick before the new page's subscribers mount,
  // which would otherwise drop refCount to 0 and force the SSE connection
  // to reconnect — causing visible click latency.
  if (closeTimer) return;
  closeTimer = setTimeout(() => {
    closeTimer = null;
    if (refCount <= 0 && sharedEventSource) {
      sharedEventSource.close();
      sharedEventSource = null;
      refCount = 0;
    }
  }, 1500);
}

export function usePowerStream(plugId: string | '*', onReading: PowerCallback) {
  const cbRef = useRef(onReading);
  useEffect(() => {
    cbRef.current = onReading;
  }, [onReading]);

  useEffect(() => {
    refCount++;
    getEventSource();

    const stableHandler: PowerCallback = (reading) => {
      cbRef.current(reading);
    };

    let set = powerListeners.get(plugId);
    if (!set) {
      set = new Set();
      powerListeners.set(plugId, set);
    }
    set.add(stableHandler);

    return () => {
      const s = powerListeners.get(plugId);
      if (s) {
        s.delete(stableHandler);
        if (s.size === 0) powerListeners.delete(plugId);
      }
      refCount--;
      closeIfUnused();
    };
  }, [plugId]);
}

export function useOnlineStream(onEvent: OnlineCallback) {
  const cbRef = useRef(onEvent);
  useEffect(() => {
    cbRef.current = onEvent;
  }, [onEvent]);

  useEffect(() => {
    refCount++;
    getEventSource();

    const stableHandler: OnlineCallback = (event) => {
      cbRef.current(event);
    };

    onlineListeners.add(stableHandler);

    return () => {
      onlineListeners.delete(stableHandler);
      refCount--;
      closeIfUnused();
    };
  }, []);
}
