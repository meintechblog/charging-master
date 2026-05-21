import { loadIndex, isCatalogEnabled } from '@/modules/catalog';
import { CatalogList } from './catalog-list';
import { PageHeader } from '@/components/layout/page-header';

export const dynamic = 'force-dynamic';

export default async function CatalogPage() {
  if (!isCatalogEnabled()) {
    return (
      <div>
        <PageHeader eyebrow="Bibliothek · 05" title="Profil-Katalog" />
        <div
          className="p-6"
          style={{
            background: 'var(--color-ink-2)',
            border: '1px solid var(--color-line-soft)',
            borderRadius: 'var(--radius-lg)',
          }}
        >
          <div className="label-eyebrow mb-2" style={{ color: 'var(--color-warn)' }}>Deaktiviert</div>
          <p className="text-[14px] text-[color:var(--color-text-default)] mb-3">
            Der Profil-Katalog ist derzeit deaktiviert.
          </p>
          <p className="text-[13px] text-[color:var(--color-text-soft)]">
            Aktiviere ihn in den{' '}
            <a href="/settings" className="transition-colors" style={{ color: 'var(--color-accent)' }}>
              Einstellungen
            </a>{' '}
            unter „Profil-Katalog". Danach siehst du hier alle geteilten Akku- und Ladegeräte-Profile aus dem Charging-Master Repo und kannst sie in deine lokale Sammlung übernehmen.
          </p>
        </div>
      </div>
    );
  }

  const index = loadIndex();
  if (!index) {
    return (
      <div>
        <PageHeader eyebrow="Bibliothek · 05" title="Profil-Katalog" />
        <div
          className="p-6"
          style={{
            background: 'var(--color-ink-2)',
            border: '1px solid var(--color-line-soft)',
            borderRadius: 'var(--radius-lg)',
          }}
        >
          <p className="text-[14px] text-[color:var(--color-text-default)]">
            Katalog-Daten konnten nicht geladen werden. Liegt die App auf einem aktuellen Stand?
          </p>
        </div>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        eyebrow={`Bibliothek · 05 · ${index.profiles.length} Profile · ${index.chargers.length} Ladegeräte`}
        title="Profil-Katalog"
        sublabel={
          <span className="font-mono text-[11px] tabular-nums">
            generiert {new Date(index.generatedAt).toLocaleString('de-DE')}
          </span>
        }
      />
      <CatalogList index={index} />
    </div>
  );
}
