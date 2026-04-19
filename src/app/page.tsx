import { db } from '@/db/client';
import { plugs, powerReadings } from '@/db/schema';
import { desc, eq } from 'drizzle-orm';
import { DashboardChargeBanners } from '@/components/charging/dashboard-charge-banners';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const allPlugs = db.select().from(plugs).all();

  // Get latest power reading per plug for initial relay state
  const plugsWithOutput = allPlugs.map((plug) => {
    const latest = db
      .select({ output: powerReadings.output })
      .from(powerReadings)
      .where(eq(powerReadings.plugId, plug.id))
      .orderBy(desc(powerReadings.timestamp))
      .limit(1)
      .get();

    return {
      ...plug,
      output: latest?.output ?? false,
    };
  });

  return (
    <div>
      <h1 className="text-2xl font-bold text-neutral-100 mb-6">Dashboard</h1>

      {plugsWithOutput.length === 0 ? (
        <div className="bg-neutral-900 rounded-lg border border-neutral-800 p-8 text-center">
          <p className="text-neutral-400 mb-4">Keine Geräte hinzugefügt</p>
          <Link
            href="/devices"
            className="text-blue-400 hover:text-blue-300 underline text-sm"
          >
            Gerät hinzufügen
          </Link>
        </div>
      ) : (
        <>
          {/* Plugs grouped with their active charge banner */}
          <DashboardChargeBanners
            plugs={plugsWithOutput.map((p) => ({
              id: p.id,
              name: p.name,
              ipAddress: p.ipAddress,
              online: p.online,
              enabled: p.enabled,
              lastSeen: p.lastSeen,
              output: p.output,
            }))}
          />
        </>
      )}
    </div>
  );
}
