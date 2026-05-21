import { db } from '@/db/client';
import { deviceProfiles, referenceCurves, profilePhotos } from '@/db/schema';
import { eq, and, desc } from 'drizzle-orm';
import Link from 'next/link';
import { PageHeader, PrimaryButton } from '@/components/layout/page-header';

export const dynamic = 'force-dynamic';

export default async function ProfilesPage() {
  const profiles = db.select().from(deviceProfiles).all();

  const rows = profiles.map((profile) => {
    const curve = db
      .select()
      .from(referenceCurves)
      .where(eq(referenceCurves.profileId, profile.id))
      .get();

    // Pick the explicit primary photo, fall back to the oldest upload so the
    // list never shows a blank slot when at least one photo exists.
    const primary = db
      .select({ id: profilePhotos.id })
      .from(profilePhotos)
      .where(and(eq(profilePhotos.profileId, profile.id), eq(profilePhotos.isPrimary, true)))
      .get()
      ?? db
        .select({ id: profilePhotos.id })
        .from(profilePhotos)
        .where(eq(profilePhotos.profileId, profile.id))
        .orderBy(desc(profilePhotos.createdAt))
        .limit(1)
        .get();

    return {
      ...profile,
      hasCurve: !!curve,
      totalEnergyWh: curve?.totalEnergyWh ?? null,
      primaryPhotoId: primary?.id ?? null,
    };
  });

  return (
    <div>
      <PageHeader
        eyebrow={`Daten · 03 · ${rows.length.toString().padStart(2, '0')} Profile`}
        title="Profile"
        action={
          <PrimaryButton href="/profiles/learn">+ Neues Profil</PrimaryButton>
        }
      />

      {rows.length === 0 ? (
        <div
          className="relative overflow-hidden p-10 text-center"
          style={{
            background: 'var(--color-ink-2)',
            border: '1px solid var(--color-line-soft)',
            borderRadius: 'var(--radius-lg)',
          }}
        >
          <div className="label-eyebrow mb-3">Sammlung leer</div>
          <p className="text-[14px] text-[color:var(--color-text-soft)] mb-5">
            Noch keine Profile angelegt. Lern ein Gerät an, damit die App seine Ladekurve verstehen kann.
          </p>
          <PrimaryButton href="/profiles/learn">Gerät anlernen →</PrimaryButton>
        </div>
      ) : (
        <div
          className="overflow-hidden"
          style={{
            background: 'var(--color-ink-2)',
            border: '1px solid var(--color-line-soft)',
            borderRadius: 'var(--radius-lg)',
          }}
        >
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px]">
              <thead>
                <tr style={{ borderBottom: '1px solid var(--color-line-soft)' }}>
                  <th className="px-4 py-3 w-12" aria-label="Bild" />
                  <th className="text-left label-eyebrow px-4 py-3">Name</th>
                  <th className="text-left label-eyebrow px-4 py-3">Modell</th>
                  <th className="text-left label-eyebrow px-4 py-3">Ziel-SoC</th>
                  <th className="text-left label-eyebrow px-4 py-3">Referenzkurve</th>
                  <th className="text-left label-eyebrow px-4 py-3">Erstellt</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, idx) => (
                  <tr
                    key={row.id}
                    className="transition-colors hover:bg-[color:var(--color-ink-3)]"
                    style={{
                      borderTop: idx === 0 ? 'none' : '1px solid var(--color-line-faint)',
                    }}
                  >
                    <td className="px-4 py-3 w-12">
                      {row.primaryPhotoId != null ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={`/api/profiles/${row.id}/photos/${row.primaryPhotoId}/file`}
                          alt=""
                          className="w-9 h-9 object-cover"
                          style={{
                            background: 'var(--color-ink-1)',
                            border: '1px solid var(--color-line-soft)',
                            borderRadius: 'var(--radius-sm)',
                          }}
                        />
                      ) : (
                        <div
                          className="w-9 h-9 flex items-center justify-center text-[11px] font-mono uppercase"
                          style={{
                            background: 'var(--color-ink-1)',
                            border: '1px solid var(--color-line-soft)',
                            borderRadius: 'var(--radius-sm)',
                            color: 'var(--color-text-faint)',
                          }}
                          aria-hidden
                        >
                          {row.name.slice(0, 1).toUpperCase()}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <Link
                        href={`/profiles/${row.id}`}
                        className="text-[14px] font-medium transition-colors hover:text-[color:var(--color-accent)]"
                        style={{ color: 'var(--color-text-strong)' }}
                      >
                        {row.name}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-[13px] text-[color:var(--color-text-soft)]">
                      {row.modelName || '—'}
                    </td>
                    <td className="px-4 py-3 text-[13px] font-mono tabular-nums text-[color:var(--color-text-default)]">
                      {row.targetSoc}%
                    </td>
                    <td className="px-4 py-3">
                      {row.hasCurve ? (
                        <span className="inline-flex items-center gap-1.5 text-[11px] font-mono uppercase tracking-[0.16em]" style={{ color: 'var(--color-ok)' }}>
                          <span className="status-orb" style={{ color: 'var(--color-ok)' }} />
                          aktiv
                        </span>
                      ) : (
                        <span className="text-[11px] font-mono uppercase tracking-[0.16em] text-[color:var(--color-text-muted)]">
                          fehlt
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-[13px] font-mono tabular-nums text-[color:var(--color-text-faint)]">
                      {new Date(row.createdAt).toLocaleDateString('de-DE')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
