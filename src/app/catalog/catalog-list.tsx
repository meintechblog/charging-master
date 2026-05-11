'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { CatalogIndex, CatalogIndexProfile, CatalogIndexCharger } from '@/modules/catalog/types';

type Props = { index: CatalogIndex };

function formatWh(wh: number): string {
  if (wh >= 1000) return `${(wh / 1000).toFixed(2)} kWh`;
  return `${wh.toFixed(0)} Wh`;
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h >= 1) return `${h} h ${m} min`;
  return `${m} min`;
}

export function CatalogList({ index }: Props) {
  const [filter, setFilter] = useState('');
  const router = useRouter();

  const fLower = filter.trim().toLowerCase();
  const profiles = fLower
    ? index.profiles.filter((p) =>
        [p.name, p.manufacturer, p.modelName, p.chemistry]
          .filter((x): x is string => typeof x === 'string')
          .some((v) => v.toLowerCase().includes(fLower))
      )
    : index.profiles;
  const chargers = fLower
    ? index.chargers.filter((c) =>
        [c.name, c.manufacturer, c.model]
          .filter((x): x is string => typeof x === 'string')
          .some((v) => v.toLowerCase().includes(fLower))
      )
    : index.chargers;

  return (
    <div className="space-y-8">
      <input
        type="search"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="Hersteller, Modell oder Chemie filtern…"
        className="w-full bg-neutral-900 border border-neutral-800 text-neutral-100 rounded-md px-3 py-2 focus:ring-2 focus:ring-blue-500 outline-none"
      />

      <section>
        <h2 className="text-lg font-semibold text-neutral-100 mb-3">
          Akku-Profile <span className="text-neutral-500 text-sm font-normal">({profiles.length})</span>
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {profiles.map((p) => (
            <ProfileCard key={p.id} profile={p} chargers={index.chargers} onImported={(localId) => router.push(`/profiles/${localId}`)} />
          ))}
          {profiles.length === 0 && (
            <p className="text-sm text-neutral-500 col-span-full">Keine Treffer.</p>
          )}
        </div>
      </section>

      <section>
        <h2 className="text-lg font-semibold text-neutral-100 mb-3">
          Ladegeräte <span className="text-neutral-500 text-sm font-normal">({chargers.length})</span>
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {chargers.map((c) => (
            <ChargerCard key={c.id} charger={c} />
          ))}
          {chargers.length === 0 && (
            <p className="text-sm text-neutral-500 col-span-full">Keine Treffer.</p>
          )}
        </div>
      </section>
    </div>
  );
}

function ProfileCard({
  profile,
  chargers,
  onImported,
}: {
  profile: CatalogIndexProfile;
  chargers: CatalogIndexCharger[];
  onImported: (localProfileId: number) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const linkedCharger = profile.chargerCatalogId
    ? chargers.find((c) => c.id === profile.chargerCatalogId)
    : null;

  async function handleImport() {
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch('/api/catalog/import-profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: profile.id }),
      });
      const data = await res.json();
      if (!res.ok) {
        setResult(`Fehler: ${data.error ?? res.statusText}`);
        return;
      }
      if (data.status === 'already_exists') {
        setResult('Profil existiert bereits lokal.');
        onImported(data.localProfileId);
      } else {
        setResult('Übernommen.');
        onImported(data.localProfileId);
      }
    } catch (err) {
      setResult(err instanceof Error ? err.message : 'Netzwerkfehler');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="bg-neutral-900 border border-neutral-800 rounded-lg p-4 flex flex-col gap-3">
      <div className="flex items-start gap-3">
        {profile.hasPhoto ? (
          <img
            src={`/api/catalog/profile/${profile.id}/photo`}
            alt={profile.name}
            className="w-20 h-20 object-cover rounded-md border border-neutral-800 flex-shrink-0"
            loading="lazy"
          />
        ) : (
          <div className="w-20 h-20 rounded-md border border-neutral-800 bg-neutral-950 flex-shrink-0 flex items-center justify-center text-neutral-700 text-xs">
            kein Foto
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-neutral-100 truncate">{profile.name}</div>
          {profile.manufacturer && (
            <div className="text-xs text-neutral-400 truncate">{profile.manufacturer}</div>
          )}
          {profile.modelName && (
            <div className="text-[11px] text-neutral-500 truncate">{profile.modelName}</div>
          )}
        </div>
      </div>

      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] text-neutral-400">
        <dt className="text-neutral-500">Kapazität</dt>
        <dd>{profile.capacityWh ? formatWh(profile.capacityWh) : '–'}</dd>
        <dt className="text-neutral-500">Chemie</dt>
        <dd>{profile.chemistry ?? '–'}</dd>
        <dt className="text-neutral-500">Ladedauer</dt>
        <dd>{formatDuration(profile.durationSeconds)}</dd>
        <dt className="text-neutral-500">Peak</dt>
        <dd>{profile.peakPowerW.toFixed(0)} W</dd>
        <dt className="text-neutral-500">AC-Energie</dt>
        <dd>{formatWh(profile.totalEnergyWh)}</dd>
        <dt className="text-neutral-500">Ziel-SOC</dt>
        <dd>{profile.targetSoc} %</dd>
        {linkedCharger && (
          <>
            <dt className="text-neutral-500">Ladegerät</dt>
            <dd className="truncate">{linkedCharger.name}</dd>
          </>
        )}
      </dl>

      {profile.productUrl && (
        <a
          href={profile.productUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[11px] text-blue-400 hover:underline truncate"
        >
          ↗ Hersteller-Link
        </a>
      )}

      <div className="flex items-center gap-2 mt-auto">
        <button
          type="button"
          disabled={busy}
          onClick={handleImport}
          className="flex-1 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:hover:bg-blue-600 text-white text-sm font-medium rounded-md py-2"
        >
          {busy ? 'Übernehme…' : 'In meine Profile übernehmen'}
        </button>
      </div>

      {result && (
        <div className="text-[11px] text-neutral-400">{result}</div>
      )}
    </div>
  );
}

function ChargerCard({ charger }: { charger: CatalogIndexCharger }) {
  return (
    <div className="bg-neutral-900 border border-neutral-800 rounded-lg p-4 flex items-start gap-3">
      {charger.hasPhoto ? (
        <img
          src={`/api/catalog/charger/${charger.id}/photo`}
          alt={charger.name}
          className="w-16 h-16 object-cover rounded-md border border-neutral-800 flex-shrink-0"
          loading="lazy"
        />
      ) : (
        <div className="w-16 h-16 rounded-md border border-neutral-800 bg-neutral-950 flex-shrink-0 flex items-center justify-center text-neutral-700 text-xs">
          kein Foto
        </div>
      )}
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold text-neutral-100 truncate">{charger.name}</div>
        {charger.manufacturer && (
          <div className="text-xs text-neutral-400 truncate">{charger.manufacturer}</div>
        )}
        <dl className="mt-2 grid grid-cols-3 gap-x-2 gap-y-1 text-[11px] text-neutral-400">
          <dt className="text-neutral-500">Output</dt>
          <dd className="col-span-2">
            {charger.maxVoltageV ?? '–'} V / {charger.maxCurrentA ?? '–'} A {charger.outputType}
          </dd>
          <dt className="text-neutral-500">η</dt>
          <dd className="col-span-2">{(charger.efficiency * 100).toFixed(0)} %</dd>
        </dl>
      </div>
    </div>
  );
}
