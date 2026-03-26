'use client';

import { ChargeBanner } from '@/components/charging/charge-banner';

type DashboardChargeBannersProps = {
  plugIds: string[];
};

export function DashboardChargeBanners({ plugIds }: DashboardChargeBannersProps) {
  return (
    <div className="space-y-2">
      {plugIds.map((id) => (
        <ChargeBanner key={id} plugId={id} />
      ))}
    </div>
  );
}
