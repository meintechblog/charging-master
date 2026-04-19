'use client';

import { ChargeBanner } from '@/components/charging/charge-banner';

type PlugChargeBannerProps = {
  plugId: string;
  plugName?: string;
  plugIp?: string;
};

export function PlugChargeBanner({ plugId, plugName, plugIp }: PlugChargeBannerProps) {
  return <ChargeBanner plugId={plugId} plugName={plugName} plugIp={plugIp} />;
}
