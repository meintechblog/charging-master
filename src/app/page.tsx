import { db } from '@/db/client';
import { plugs } from '@/db/schema';
import { PlugCard } from '@/components/devices/plug-card';
import Link from 'next/link';

export default async function HomePage() {
  const allPlugs = db.select().from(plugs).all();

  return (
    <div>
      <h1 className="text-2xl font-bold text-neutral-100 mb-6">Dashboard</h1>

      {allPlugs.length === 0 ? (
        <div className="bg-neutral-900 rounded-lg border border-neutral-800 p-8 text-center">
          <p className="text-neutral-400 mb-4">Keine Geraete hinzugefuegt</p>
          <Link
            href="/devices"
            className="text-blue-400 hover:text-blue-300 underline text-sm"
          >
            Geraet hinzufuegen
          </Link>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {allPlugs.map((plug) => (
            <PlugCard key={plug.id} plug={plug} />
          ))}
        </div>
      )}
    </div>
  );
}
