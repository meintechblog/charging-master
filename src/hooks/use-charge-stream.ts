'use client';

import { useEffect } from 'react';
import type { ChargeStateEvent } from '@/modules/charging/types';

export type ChargeCallback = (event: ChargeStateEvent) => void;

// Module-level listener registry (mirrors use-power-stream.ts pattern)
let chargeListeners = new Map<string, Set<ChargeCallback>>();
let eventSourceRef: EventSource | null = null;
let refCount = 0;

function getEventSource(): EventSource {
  if (eventSourceRef && eventSourceRef.readyState !== EventSource.CLOSED) {
    return eventSourceRef;
  }

  eventSourceRef = new EventSource('/api/sse/power');

  eventSourceRef.addEventListener('charge', (event) => {
    try {
      const data: ChargeStateEvent = JSON.parse((event as MessageEvent).data);

      // Dispatch to plugId-specific listeners
      const plugSet = chargeListeners.get(data.plugId);
      if (plugSet) {
        for (const cb of plugSet) cb(data);
      }

      // Dispatch to wildcard listeners
      const wildcardSet = chargeListeners.get('*');
      if (wildcardSet) {
        for (const cb of wildcardSet) cb(data);
      }
    } catch {
      // Invalid JSON, ignore
    }
  });

  eventSourceRef.onerror = () => {
    // Browser auto-reconnects EventSource; no manual action needed
  };

  return eventSourceRef;
}

function closeIfUnused() {
  if (refCount <= 0 && eventSourceRef) {
    eventSourceRef.close();
    eventSourceRef = null;
    refCount = 0;
  }
}

export function useChargeStream(plugId: string | '*', onEvent: ChargeCallback) {
  useEffect(() => {
    refCount++;
    getEventSource();

    let set = chargeListeners.get(plugId);
    if (!set) {
      set = new Set();
      chargeListeners.set(plugId, set);
    }
    set.add(onEvent);

    return () => {
      const s = chargeListeners.get(plugId);
      if (s) {
        s.delete(onEvent);
        if (s.size === 0) chargeListeners.delete(plugId);
      }
      refCount--;
      closeIfUnused();
    };
  }, [plugId, onEvent]);
}
