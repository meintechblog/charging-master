'use client';

import { useEffect, useRef } from 'react';
import type { ChargeStateEvent } from '@/modules/charging/types';

export type ChargeCallback = (event: ChargeStateEvent) => void;

// Module-level listener registry. We store stable wrapper functions per
// subscription so a changing user callback (common when components pass
// inline functions) does NOT tear the listener down and reopen the SSE
// connection on every parent re-render.
const chargeListeners = new Map<string, Set<ChargeCallback>>();
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

      const plugSet = chargeListeners.get(data.plugId);
      if (plugSet) {
        for (const cb of plugSet) cb(data);
      }

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

let closeTimer: ReturnType<typeof setTimeout> | null = null;

function closeIfUnused() {
  // Defer the actual close: during a page navigation the old page's
  // subscribers unmount a tick before the new page's subscribers mount,
  // which would otherwise drop refCount to 0 and force the SSE connection
  // to reconnect — causing visible click latency.
  if (closeTimer) return;
  closeTimer = setTimeout(() => {
    closeTimer = null;
    if (refCount <= 0 && eventSourceRef) {
      eventSourceRef.close();
      eventSourceRef = null;
      refCount = 0;
    }
  }, 1500);
}

export function useChargeStream(plugId: string | '*', onEvent: ChargeCallback) {
  // Always-current callback ref — no re-subscription when caller passes
  // a new inline function on every render.
  const cbRef = useRef(onEvent);
  useEffect(() => {
    cbRef.current = onEvent;
  }, [onEvent]);

  useEffect(() => {
    refCount++;
    getEventSource();

    const stableHandler: ChargeCallback = (event) => {
      cbRef.current(event);
    };

    let set = chargeListeners.get(plugId);
    if (!set) {
      set = new Set();
      chargeListeners.set(plugId, set);
    }
    set.add(stableHandler);

    return () => {
      const s = chargeListeners.get(plugId);
      if (s) {
        s.delete(stableHandler);
        if (s.size === 0) chargeListeners.delete(plugId);
      }
      refCount--;
      closeIfUnused();
    };
  }, [plugId]);
}
