'use client';

import { PlugCard } from '@/components/devices/plug-card';
import { ChargeBanner } from '@/components/charging/charge-banner';

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
};

export function DashboardChargeBanners({ plugs }: DashboardChargeBannersProps) {
  return (
    <div className="flex flex-col gap-3">
      {plugs.map((plug) => (
        <div key={plug.id} className="flex flex-col gap-0">
          <PlugCard plug={plug} />
          <ChargeBanner
            plugId={plug.id}
            plugName={plug.name}
            plugIp={plug.ipAddress ?? undefined}
          />
        </div>
      ))}
    </div>
  );
}
