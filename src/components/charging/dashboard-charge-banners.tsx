'use client';

import { PlugCard } from '@/components/devices/plug-card';

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
        <PlugCard key={plug.id} plug={plug} />
      ))}
    </div>
  );
}
