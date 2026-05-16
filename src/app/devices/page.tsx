import { db } from '@/db/client';
import { plugs, deviceProfiles } from '@/db/schema';
import { DeviceManager } from './device-manager';

export const dynamic = 'force-dynamic';

export default async function DevicesPage() {
  const registeredPlugs = db.select().from(plugs).all();
  const profileChoices = db
    .select({ id: deviceProfiles.id, name: deviceProfiles.name })
    .from(deviceProfiles)
    .all();

  return (
    <div>
      <h1 className="text-2xl font-bold text-neutral-100 mb-6">Geräte</h1>
      <DeviceManager registeredPlugs={registeredPlugs} profileChoices={profileChoices} />
    </div>
  );
}
