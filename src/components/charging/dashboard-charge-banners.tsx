'use client';

import { ChargeBanner } from '@/components/charging/charge-banner';

type PlugInfo = {
  id: string;
  name: string;
  ipAddress: string | null;
};

type DashboardChargeBannersProps = {
  plugs: PlugInfo[];
};

export function DashboardChargeBanners({ plugs }: DashboardChargeBannersProps) {
  return (
    <div className="space-y-2">
      {plugs.map((plug) => (
        <ChargeBanner
          key={plug.id}
          plugId={plug.id}
          plugName={plug.name}
          plugIp={plug.ipAddress ?? undefined}
        />
      ))}
    </div>
  );
}
