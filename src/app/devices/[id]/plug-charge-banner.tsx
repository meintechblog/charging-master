'use client';

import { ChargeBanner } from '@/components/charging/charge-banner';

type PlugChargeBannerProps = {
  plugId: string;
};

export function PlugChargeBanner({ plugId }: PlugChargeBannerProps) {
  return <ChargeBanner plugId={plugId} />;
}
