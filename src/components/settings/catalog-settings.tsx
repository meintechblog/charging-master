'use client';

import { useState, useEffect, useRef } from 'react';

type Props = { initialSettings: Record<string, string> };

function useAutoSave(key: string, value: string, initialValue: string) {
  const lastSavedValue = useRef(initialValue);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle');

  useEffect(() => {
    if (value === lastSavedValue.current) return;
    setSaveStatus('saving');
    const timer = setTimeout(() => {
      fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, value }),
      })
        .then(() => {
          lastSavedValue.current = value;
          setSaveStatus('saved');
          setTimeout(() => setSaveStatus('idle'), 2000);
        })
        .catch(() => setSaveStatus('idle'));
    }, 300);
    return () => clearTimeout(timer);
  }, [key, value]);

  return saveStatus;
}

export function CatalogSettings({ initialSettings }: Props) {
  const initialEnabled = initialSettings['catalog.enabled'] === 'true' ? 'true' : 'false';
  const [enabled, setEnabled] = useState(initialEnabled);
  const saveStatus = useAutoSave('catalog.enabled', enabled, initialEnabled);

  const isOn = enabled === 'true';

  return (
    <div className="space-y-3">
      <label className="flex items-center gap-3 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={isOn}
          onChange={(e) => setEnabled(e.target.checked ? 'true' : 'false')}
          className="w-4 h-4 accent-blue-500"
        />
        <span className="text-sm text-neutral-200">
          Profil-Katalog aktivieren
        </span>
      </label>

      <p className="text-[12px] text-neutral-500 leading-relaxed">
        Wenn aktiviert, zeigt die App unter <code className="text-neutral-300">/catalog</code> alle
        geteilten Akku- und Ladegeräte-Profile aus dem Repo. Du kannst Einträge
        direkt in deine lokale Sammlung übernehmen. Beim Anlernen einer neuen
        Ladekurve schlägt die App passende Katalog-Profile vor wenn die Form
        ähnlich ist (≥ 90% Match).
      </p>

      {isOn && (
        <div className="rounded-md bg-blue-950/40 border border-blue-900 px-3 py-2 text-[12px] text-blue-200 leading-relaxed">
          <a href="/catalog" className="font-medium text-blue-300 hover:underline">
            → Zum Katalog
          </a>{' '}
          ·{' '}
          <span className="text-blue-300/70">
            Die Daten werden bei jedem Self-Update automatisch aktualisiert.
          </span>
        </div>
      )}

      <div className="text-xs text-neutral-500 h-4">
        {saveStatus === 'saving' && <span>Speichere…</span>}
        {saveStatus === 'saved' && <span className="text-green-400">Gespeichert ✓</span>}
      </div>
    </div>
  );
}
