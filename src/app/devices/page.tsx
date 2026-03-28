import { db } from '@/db/client';
import { plugs } from '@/db/schema';
import { DeviceManager } from './device-manager';

export const dynamic = 'force-dynamic';

export default async function DevicesPage() {
  const registeredPlugs = db.select().from(plugs).all();

  return (
    <div>
      <h1 className="text-2xl font-bold text-neutral-100 mb-6">Geraete</h1>
      <DeviceManager registeredPlugs={registeredPlugs} />
    </div>
  );
}
