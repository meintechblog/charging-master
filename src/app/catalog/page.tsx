import { loadIndex, isCatalogEnabled } from '@/modules/catalog';
import { CatalogList } from './catalog-list';

export const dynamic = 'force-dynamic';

export default async function CatalogPage() {
  if (!isCatalogEnabled()) {
    return (
      <div className="max-w-2xl mx-auto py-12 px-4">
        <h1 className="text-2xl font-bold text-neutral-100 mb-4">Profil-Katalog</h1>
        <div className="rounded-md bg-neutral-900 border border-neutral-800 p-6 text-neutral-300">
          <p className="mb-3">
            Der Profil-Katalog ist derzeit <strong>deaktiviert</strong>.
          </p>
          <p className="text-sm text-neutral-400 mb-4">
            Aktiviere ihn in den{' '}
            <a href="/settings" className="text-blue-400 hover:underline">
              Einstellungen
            </a>{' '}
            unter „Profil-Katalog“. Danach siehst du hier alle geteilten
            Akku- und Ladegeräte-Profile aus dem Charging-Master Repo und
            kannst sie in deine lokale Sammlung übernehmen.
          </p>
        </div>
      </div>
    );
  }

  const index = loadIndex();
  if (!index) {
    return (
      <div className="max-w-2xl mx-auto py-12 px-4">
        <h1 className="text-2xl font-bold text-neutral-100 mb-4">Profil-Katalog</h1>
        <div className="rounded-md bg-neutral-900 border border-neutral-800 p-6 text-neutral-300">
          <p>Katalog-Daten konnten nicht geladen werden. Liegt die App auf einem aktuellen Stand?</p>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto py-8 px-4 space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-neutral-100">Profil-Katalog</h1>
        <p className="text-sm text-neutral-400 mt-1">
          {index.profiles.length} Akku-Profile · {index.chargers.length} Ladegeräte ·
          generiert {new Date(index.generatedAt).toLocaleString('de-DE')}
        </p>
      </div>

      <CatalogList index={index} />
    </div>
  );
}
