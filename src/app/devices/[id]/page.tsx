import { notFound } from 'next/navigation';
import Link from 'next/link';
import { db } from '@/db/client';
import { plugs, powerReadings } from '@/db/schema';
import { eq, desc } from 'drizzle-orm';
import { PlugDetailChart } from './plug-detail-chart';

export default async function PlugDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const plug = db.select().from(plugs).where(eq(plugs.id, id)).get();
  if (!plug) notFound();

  const latestReading = db
    .select()
    .from(powerReadings)
    .where(eq(powerReadings.plugId, id))
    .orderBy(desc(powerReadings.timestamp))
    .limit(1)
    .get();

  const currentWatts =
    latestReading != null ? latestReading.apower.toFixed(1) : '--';
  const relayOn = latestReading?.output ?? false;
  const totalEnergy =
    latestReading?.totalEnergy != null
      ? `${latestReading.totalEnergy.toFixed(2)} Wh`
      : '--';

  return (
    <div className="space-y-6">
      {/* Back link */}
      <Link
        href="/"
        className="inline-flex items-center gap-1.5 text-sm text-neutral-400 hover:text-neutral-100 transition-colors"
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        >
          <path d="M10 12L6 8l4-4" />
        </svg>
        Dashboard
      </Link>

      {/* Header */}
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-bold text-neutral-100">{plug.name}</h1>
        <span
          className={`w-2.5 h-2.5 rounded-full ${
            plug.online ? 'bg-green-500' : 'bg-neutral-600'
          }`}
          title={plug.online ? 'Online' : 'Offline'}
        />
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-3 gap-4">
        <div className="bg-neutral-900 rounded-lg border border-neutral-800 p-4">
          <p className="text-xs text-neutral-500 mb-1">Leistung</p>
          <p className="text-xl font-semibold text-neutral-100">
            {currentWatts}
            {currentWatts !== '--' && (
              <span className="text-sm text-neutral-500 ml-1">W</span>
            )}
          </p>
        </div>
        <div className="bg-neutral-900 rounded-lg border border-neutral-800 p-4">
          <p className="text-xs text-neutral-500 mb-1">Relay</p>
          <p className="text-xl font-semibold">
            <span
              className={
                relayOn
                  ? 'text-green-400'
                  : 'text-neutral-500'
              }
            >
              {relayOn ? 'Ein' : 'Aus'}
            </span>
          </p>
        </div>
        <div className="bg-neutral-900 rounded-lg border border-neutral-800 p-4">
          <p className="text-xs text-neutral-500 mb-1">Gesamtenergie</p>
          <p className="text-xl font-semibold text-neutral-100">{totalEnergy}</p>
        </div>
      </div>

      {/* Chart section */}
      <div className="bg-neutral-900 rounded-lg border border-neutral-800 p-6">
        <PlugDetailChart plugId={id} />
      </div>
    </div>
  );
}
