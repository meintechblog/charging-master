import { notFound } from 'next/navigation';
import Link from 'next/link';
import { db } from '@/db/client';
import { plugs, powerReadings } from '@/db/schema';
import { eq, desc } from 'drizzle-orm';
import { ChargeSessionChart } from '@/components/charts/charge-session-chart';
import { PlugChargeBanner } from './plug-charge-banner';
import { formatEnergy } from '@/lib/format';

export const dynamic = 'force-dynamic';

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
    latestReading != null ? latestReading.apower.toFixed(1) : '—';
  const relayOn = latestReading?.output ?? false;
  const totalEnergy =
    latestReading?.totalEnergy != null
      ? formatEnergy(latestReading.totalEnergy)
      : '—';

  return (
    <div className="space-y-6">
      {/* Breadcrumb — minimal, mono, with arrow */}
      <Link
        href="/"
        className="group inline-flex items-center gap-2 text-[11px] font-mono uppercase tracking-[0.18em] transition-colors"
        style={{ color: 'var(--color-text-faint)' }}
      >
        <span className="transition-transform group-hover:-translate-x-0.5">←</span>
        <span className="group-hover:text-[color:var(--color-text-default)] transition-colors">
          Dashboard
        </span>
      </Link>

      {/* Header — eyebrow ID + big tracking-tight title + status rail */}
      <header className="flex items-end justify-between gap-4 flex-wrap">
        <div className="min-w-0">
          <div className="label-eyebrow mb-2">Gerät</div>
          <h1
            className="text-[32px] sm:text-[40px] font-semibold leading-none tracking-tight text-[color:var(--color-text-strong)] truncate"
            style={{ letterSpacing: '-0.02em' }}
          >
            {plug.name}
          </h1>
          <div className="mt-3 flex items-center gap-3 flex-wrap">
            <div className="flex items-center gap-1.5">
              <span
                className="status-orb"
                style={{ color: plug.online ? 'var(--color-ok)' : 'var(--color-danger)' }}
              />
              <span
                className="font-mono text-[10px] uppercase tracking-[0.18em]"
                style={{ color: plug.online ? 'var(--color-ok)' : 'var(--color-danger)' }}
              >
                {plug.online ? 'online' : 'offline'}
              </span>
            </div>
            {plug.ipAddress && (
              <>
                <span style={{ color: 'var(--color-text-muted)' }}>·</span>
                <span className="font-mono text-[11px]" style={{ color: 'var(--color-text-faint)' }}>
                  {plug.ipAddress}
                </span>
              </>
            )}
            <span style={{ color: 'var(--color-text-muted)' }}>·</span>
            <span className="font-mono text-[11px]" style={{ color: 'var(--color-text-muted)' }}>
              {plug.id}
            </span>
          </div>
        </div>
      </header>

      {/* Charge banner if active — keeps its own internal styling */}
      <PlugChargeBanner plugId={id} />

      {/* Stats cluster — three readouts separated by hairline verticals,
          tabular mono numbers as the focus. */}
      <div
        className="grid grid-cols-3 divide-x"
        style={{
          background: 'var(--color-ink-2)',
          border: '1px solid var(--color-line-soft)',
          borderRadius: 'var(--radius-lg)',
          // dividers use the same hairline as borders
        }}
      >
        <StatTile label="Leistung" value={currentWatts} unit="W" accent="var(--color-text-strong)" />
        <StatTile
          label="Relay"
          value={relayOn ? 'EIN' : 'AUS'}
          accent={relayOn ? 'var(--color-ok)' : 'var(--color-text-faint)'}
          uppercase
        />
        <StatTile label="Gesamt" value={totalEnergy} accent="var(--color-text-strong)" />
      </div>

      {/* Session-relative live charge chart with reference overlay. */}
      <ChargeSessionChart plugId={id} />
    </div>
  );
}

function StatTile({
  label,
  value,
  unit,
  accent,
  uppercase = false,
}: {
  label: string;
  value: string;
  unit?: string;
  accent: string;
  uppercase?: boolean;
}) {
  return (
    <div
      className="px-5 py-4 first:border-l-0"
      style={{ borderLeftColor: 'var(--color-line-soft)' }}
    >
      <div className="label-eyebrow mb-2">{label}</div>
      <div className="flex items-baseline gap-1.5">
        <span
          className={`font-mono-data text-[26px] sm:text-[30px] font-medium leading-none ${uppercase ? 'tracking-[0.12em]' : ''}`}
          style={{ color: accent, letterSpacing: uppercase ? '0.12em' : '-0.03em' }}
        >
          {value}
        </span>
        {unit && (
          <span
            className="text-[12px] font-mono uppercase tracking-[0.18em]"
            style={{ color: 'var(--color-text-faint)' }}
          >
            {unit}
          </span>
        )}
      </div>
    </div>
  );
}
