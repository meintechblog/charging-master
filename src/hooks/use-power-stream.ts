'use client';

import { useEffect } from 'react';
import type { PowerReading, PlugOnlineEvent } from '@/modules/events/event-bus';

export type PowerCallback = (reading: PowerReading) => void;
export type OnlineCallback = (event: PlugOnlineEvent) => void;

// Singleton EventSource state (module-level, not React state)
let sharedEventSource: EventSource | null = null;
let powerListeners = new Map<string, Set<PowerCallback>>();
let onlineListeners = new Set<OnlineCallback>();
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

      // Dispatch to plugId-specific listeners
      const plugSet = powerListeners.get(reading.plugId);
      if (plugSet) {
        for (const cb of plugSet) cb(reading);
      }

      // Dispatch to wildcard listeners
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

function closeIfUnused() {
  if (refCount <= 0 && sharedEventSource) {
    sharedEventSource.close();
    sharedEventSource = null;
    refCount = 0;
  }
}

export function usePowerStream(plugId: string | '*', onReading: PowerCallback) {
  useEffect(() => {
    refCount++;
    getEventSource();

    let set = powerListeners.get(plugId);
    if (!set) {
      set = new Set();
      powerListeners.set(plugId, set);
    }
    set.add(onReading);

    return () => {
      const s = powerListeners.get(plugId);
      if (s) {
        s.delete(onReading);
        if (s.size === 0) powerListeners.delete(plugId);
      }
      refCount--;
      closeIfUnused();
    };
  }, [plugId, onReading]);
}

export function useOnlineStream(onEvent: OnlineCallback) {
  useEffect(() => {
    refCount++;
    getEventSource();

    onlineListeners.add(onEvent);

    return () => {
      onlineListeners.delete(onEvent);
      refCount--;
      closeIfUnused();
    };
  }, [onEvent]);
}
