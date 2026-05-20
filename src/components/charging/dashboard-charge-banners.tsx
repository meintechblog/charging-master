'use client';

import { useEffect, useState } from 'react';
import { PlugCard } from '@/components/devices/plug-card';
import {
  ActiveChargeCard,
  type ActiveChargeInitial,
} from '@/components/devices/active-charge-card';
import { useChargeStream } from '@/hooks/use-charge-stream';
import type { ChargeStateEvent } from '@/modules/charging/types';

type PlugInfo = {
  id: string;
  name: string;
  ipAddress: string | null;
  online: boolean;
  enabled: boolean;
  lastSeen: number | null;
  output?: boolean;
};

type DashboardChargeBannersProps = {
  plugs: PlugInfo[];
  /** Initial active sessions from the server, keyed by plugId — no SSE
      round-trip needed on first paint. */
  initialActiveByPlug?: Record<string, ActiveChargeInitial>;
};

const ACTIVE_STATES = new Set<ChargeStateEvent['state']>([
  'detecting',
  'matched',
  'charging',
  'countdown',
]);

const TERMINAL_STATES = new Set<ChargeStateEvent['state']>([
  'complete',
  'aborted',
  'idle',
  'error',
]);

export function DashboardChargeBanners({
  plugs,
  initialActiveByPlug = {},
}: DashboardChargeBannersProps) {
  // Mirror the server-side hint into client state, then let SSE drive
  // updates. New sessions appearing client-side are inserted with a
  // minimal-but-usable initial shape; terminal events delete the entry.
  const [activeByPlug, setActiveByPlug] = useState<Record<string, ActiveChargeInitial>>(
    initialActiveByPlug
  );

  useChargeStream('*', (event) => {
    if (TERMINAL_STATES.has(event.state)) {
      setActiveByPlug((prev) => {
        if (!(event.plugId in prev)) return prev;
        const next = { ...prev };
        delete next[event.plugId];
        return next;
      });
      return;
    }
    if (!ACTIVE_STATES.has(event.state)) return;
    setActiveByPlug((prev) => {
      const existing = prev[event.plugId];
      const merged: ActiveChargeInitial = {
        sessionId: event.sessionId ?? existing?.sessionId ?? 0,
        profileId: event.profileId ?? existing?.profileId ?? null,
        profileName: event.profileName ?? existing?.profileName ?? null,
        photoUrl: existing?.photoUrl ?? null,
        state: event.state,
        estimatedSoc: event.estimatedSoc ?? existing?.estimatedSoc ?? null,
        socMin: event.socMin ?? existing?.socMin ?? null,
        socMax: event.socMax ?? existing?.socMax ?? null,
        targetSoc: event.targetSoc ?? existing?.targetSoc ?? 80,
        energyWh: event.energyChargedWh ?? existing?.energyWh ?? 0,
        bandConfidence: event.socBandConfidence ?? existing?.bandConfidence ?? null,
        startedAt: existing?.startedAt ?? Date.now(),
      };
      return { ...prev, [event.plugId]: merged };
    });
  });

  // If the server hint was missing a startedAt for any plug, fall back to
  // "now" — only affects clients that load a page while a session is
  // present only via SSE (rare); the elapsed counter would otherwise be
  // wildly negative on first render.
  useEffect(() => {
    setActiveByPlug((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const [pid, info] of Object.entries(prev)) {
        if (info.startedAt === 0) {
          next[pid] = { ...info, startedAt: Date.now() };
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, []);

  const activePlugs = plugs.filter((p) => p.id in activeByPlug);
  const idlePlugs = plugs.filter((p) => !(p.id in activeByPlug));

  return (
    <div className="flex flex-col gap-6">
      {activePlugs.length > 0 && (
        <section>
          <div className="text-[10px] uppercase tracking-wider text-neutral-500 mb-2">
            Aktive Ladevorgänge
          </div>
          <div className="flex flex-col gap-3">
            {activePlugs.map((plug) => (
              <ActiveChargeCard
                key={plug.id}
                plugId={plug.id}
                plugName={plug.name}
                plugIp={plug.ipAddress}
                online={plug.online}
                initial={activeByPlug[plug.id]}
              />
            ))}
          </div>
        </section>
      )}

      {idlePlugs.length > 0 && (
        <section>
          {activePlugs.length > 0 && (
            <div className="text-[10px] uppercase tracking-wider text-neutral-500 mb-2">
              Andere Steckdosen
            </div>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {idlePlugs.map((plug) => (
              <PlugCard key={plug.id} plug={plug} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
