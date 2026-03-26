import { db } from '@/db/client';
import { deviceProfiles, referenceCurves } from '@/db/schema';
import { eq } from 'drizzle-orm';
import Link from 'next/link';

export default async function ProfilesPage() {
  const profiles = db.select().from(deviceProfiles).all();

  const rows = profiles.map((profile) => {
    const curve = db
      .select()
      .from(referenceCurves)
      .where(eq(referenceCurves.profileId, profile.id))
      .get();

    return {
      ...profile,
      hasCurve: !!curve,
      totalEnergyWh: curve?.totalEnergyWh ?? null,
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
            Noch keine Profile angelegt. Starte mit dem Anlernen eines Geraets.
          </p>
          <Link
            href="/profiles/learn"
            className="inline-block mt-4 px-4 py-2 bg-blue-500 text-white text-sm font-medium rounded hover:bg-blue-600 transition-colors"
          >
            Geraet anlernen
          </Link>
        </div>
      ) : (
        <div className="bg-neutral-900 rounded-lg overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-neutral-800">
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
