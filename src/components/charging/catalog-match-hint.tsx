'use client';

import { useEffect, useState } from 'react';
import type { CatalogMatch } from '@/modules/catalog/types';

type Props = {
  profileId: number;
};

/**
 * After a profile's reference curve is saved, optionally scan the shared
 * catalog for similar curves. If the best match clears 90% shape similarity,
 * surface a banner offering to adopt the catalog's curve in place of the
 * just-learned one.
 *
 * Renders nothing when the catalog is disabled (the /api/catalog/match call
 * comes back 403 and the silent-failure path leaves `matches` null).
 * Adoption replaces only the curve + SOC boundaries — the profile's name,
 * photos, and other metadata stay intact.
 */
export function CatalogMatchHint({ profileId }: Props) {
  const [matches, setMatches] = useState<CatalogMatch[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [adopted, setAdopted] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const curveRes = await fetch(`/api/profiles/${profileId}/curve`);
        if (!curveRes.ok) return;
        const curve = await curveRes.json();
        if (!Array.isArray(curve.points) || curve.points.length < 2) return;

        const matchRes = await fetch('/api/catalog/match', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            points: curve.points.map((p: { offsetSeconds: number; apower: number }) => ({
              offsetSeconds: p.offsetSeconds,
              apower: p.apower,
            })),
            topN: 3,
            minSimilarity: 0.9,
          }),
        });
        if (!matchRes.ok) return;
        const { matches: hits } = (await matchRes.json()) as { matches: CatalogMatch[] };
        if (!cancelled) setMatches(hits ?? []);
      } catch {
        /* silent — match is best-effort */
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [profileId]);

  if (!matches || matches.length === 0 || adopted) {
    if (adopted) {
      return (
        <div className="rounded-md bg-blue-950/40 border border-blue-900 px-4 py-3 text-sm text-blue-200">
          ✓ Katalog-Curve übernommen. Die Profil-Metadaten (Name, Hersteller, Fotos) bleiben unverändert.
        </div>
      );
    }
    return null;
  }

  const best = matches[0];
  const pct = (n: number) => `${(n * 100).toFixed(0)} %`;

  async function handleAdopt(catalogId: string) {
    setBusyId(catalogId);
    setError(null);
    try {
      const res = await fetch(`/api/profiles/${profileId}/curve/replace-from-catalog`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ catalogId }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(`Fehler: ${data.error ?? res.statusText}`);
        return;
      }
      setAdopted(catalogId);
    } catch {
      setError('Netzwerkfehler');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="rounded-lg border border-amber-700/50 bg-amber-950/30 px-4 py-3 space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-amber-200 mb-1">
          Ähnliches Profil im Katalog gefunden
        </h3>
        <p className="text-xs text-amber-200/70 leading-relaxed">
          Deine gerade aufgenommene Kurve passt zu {matches.length === 1 ? 'einem' : `${matches.length}`} Katalog-Profil
          {matches.length === 1 ? '' : 'en'}. Wenn eins davon dein Gerät ist, kannst du dessen Curve
          übernehmen — die kommt aus geprüften Quellen. Dein Profil-Name + Fotos bleiben.
        </p>
      </div>

      <div className="space-y-2">
        {matches.map((m) => (
          <div
            key={m.catalogId}
            className={`flex items-center gap-3 rounded-md border px-3 py-2 ${
              m.catalogId === best.catalogId
                ? 'border-amber-600/60 bg-amber-900/30'
                : 'border-neutral-800 bg-neutral-900/60'
            }`}
          >
            <img
              src={`/api/catalog/profile/${m.catalogId}/photo`}
              alt={m.name}
              className="w-10 h-10 rounded object-cover border border-neutral-800 flex-shrink-0"
              onError={(e) => {
                (e.target as HTMLImageElement).style.display = 'none';
              }}
              loading="lazy"
            />
            <div className="min-w-0 flex-1">
              <div className="text-sm text-neutral-100 truncate">{m.name}</div>
              <div className="text-[11px] text-neutral-400 truncate">
                {m.manufacturer ?? '–'}
                {m.modelName ? ` · ${m.modelName}` : ''}
                {' · '}
                Shape-Match {pct(m.similarity)}
                {Math.abs(m.peakRatio - 1) > 0.2 && (
                  <span className="text-amber-400">
                    {' · Peak-Power weicht ab (×' + m.peakRatio.toFixed(2) + ')'}
                  </span>
                )}
              </div>
            </div>
            <button
              type="button"
              disabled={busyId !== null}
              onClick={() => handleAdopt(m.catalogId)}
              className="text-xs px-3 py-1.5 rounded bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white whitespace-nowrap"
            >
              {busyId === m.catalogId ? 'Übernehme…' : 'Curve übernehmen'}
            </button>
          </div>
        ))}
      </div>

      {error && <div className="text-xs text-red-400">{error}</div>}
    </div>
  );
}
