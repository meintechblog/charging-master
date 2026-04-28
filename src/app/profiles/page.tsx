import { db } from '@/db/client';
import { deviceProfiles, referenceCurves, profilePhotos } from '@/db/schema';
import { eq, and, desc } from 'drizzle-orm';
import Link from 'next/link';

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
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-neutral-100">Profile</h1>
        <Link
          href="/profiles/learn"
          className="px-4 py-2 bg-blue-500 text-white text-sm font-medium rounded hover:bg-blue-600 transition-colors"
        >
          Neues Profil
        </Link>
      </div>

      {rows.length === 0 ? (
        <div className="bg-neutral-900 rounded-lg p-8 text-center">
          <p className="text-neutral-400">
            Noch keine Profile angelegt. Starte mit dem Anlernen eines Geräts.
          </p>
          <Link
            href="/profiles/learn"
            className="inline-block mt-4 px-4 py-2 bg-blue-500 text-white text-sm font-medium rounded hover:bg-blue-600 transition-colors"
          >
            Gerät anlernen
          </Link>
        </div>
      ) : (
        <div className="bg-neutral-900 rounded-lg overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-neutral-800">
                <th className="text-left text-xs font-medium text-neutral-400 px-4 py-3 w-12" aria-label="Bild" />
                <th className="text-left text-xs font-medium text-neutral-400 px-4 py-3">Name</th>
                <th className="text-left text-xs font-medium text-neutral-400 px-4 py-3">Modell</th>
                <th className="text-left text-xs font-medium text-neutral-400 px-4 py-3">Ziel-SOC</th>
                <th className="text-left text-xs font-medium text-neutral-400 px-4 py-3">Referenzkurve</th>
                <th className="text-left text-xs font-medium text-neutral-400 px-4 py-3">Erstellt</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-b border-neutral-800 last:border-0 hover:bg-neutral-800/50 transition-colors">
                  <td className="px-4 py-3 w-12">
                    {row.primaryPhotoId != null ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={`/api/profiles/${row.id}/photos/${row.primaryPhotoId}/file`}
                        alt=""
                        className="w-9 h-9 rounded object-cover bg-neutral-950 border border-neutral-800"
                      />
                    ) : (
                      <div
                        className="w-9 h-9 rounded bg-neutral-800 border border-neutral-800 flex items-center justify-center text-xs text-neutral-500"
                        aria-hidden
                      >
                        {row.name.slice(0, 1).toUpperCase()}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <Link href={`/profiles/${row.id}`} className="text-sm text-neutral-100 hover:text-blue-400 transition-colors">
                      {row.name}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-sm text-neutral-400">
                    {row.modelName || '--'}
                  </td>
                  <td className="px-4 py-3 text-sm text-neutral-400">
                    {row.targetSoc}%
                  </td>
                  <td className="px-4 py-3 text-sm">
                    {row.hasCurve ? (
                      <span className="text-green-400">vorhanden</span>
                    ) : (
                      <span className="text-neutral-600">--</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-sm text-neutral-400">
                    {new Date(row.createdAt).toLocaleDateString('de-DE')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
