import { db } from '@/db/client';
import { plugs, deviceProfiles } from '@/db/schema';
import { DeviceManager } from './device-manager';
import { PageHeader } from '@/components/layout/page-header';

export const dynamic = 'force-dynamic';

export default async function DevicesPage() {
  const registeredPlugs = db.select().from(plugs).all();
  const profileChoices = db
    .select({ id: deviceProfiles.id, name: deviceProfiles.name })
    .from(deviceProfiles)
    .all();

  return (
    <div>
      <PageHeader
        eyebrow={`Hardware · 02 · ${registeredPlugs.length.toString().padStart(2, '0')} aktiv`}
        title="Geräte"
      />
      <DeviceManager registeredPlugs={registeredPlugs} profileChoices={profileChoices} />
    </div>
  );
}
