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

const inputClasses = 'bg-neutral-800 border border-neutral-700 text-neutral-100 rounded-md px-3 py-2 focus:ring-2 focus:ring-blue-500 outline-none';

export function CatalogSettings({ initialSettings }: Props) {
  const initialEnabled = initialSettings['catalog.enabled'] === 'true' ? 'true' : 'false';
  const initialToken = initialSettings['github.contentsToken'] ?? '';
  const initialRepo = initialSettings['github.repo'] ?? '';

  const [enabled, setEnabled] = useState(initialEnabled);
  const [token, setToken] = useState(initialToken);
  const [repo, setRepo] = useState(initialRepo);

  const saveStatus = useAutoSave('catalog.enabled', enabled, initialEnabled);
  const tokenStatus = useAutoSave('github.contentsToken', token, initialToken);
  const repoStatus = useAutoSave('github.repo', repo, initialRepo);

  const isOn = enabled === 'true';
  const hasToken = token.trim().length > 0;

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

      {isOn && (
        <div className="border-t border-neutral-800 pt-3 space-y-2">
          <div className="text-xs font-medium text-neutral-300">Eigene Profile in den Katalog publishen (optional)</div>
          <p className="text-[11px] text-neutral-500 leading-relaxed">
            Wenn ein GitHub Personal Access Token mit{' '}
            <code className="text-neutral-400">contents:write</code> Scope hinterlegt ist, kann die App
            geprüfte Profile mit einem Klick direkt ins Repo commiten. Sonst kannst du die Artefakte
            herunterladen und manuell per PR einreichen.
          </p>
          <label className="block">
            <span className="block text-[11px] text-neutral-400 mb-1">GitHub Personal Access Token</span>
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="github_pat_…"
              className={inputClasses + ' w-full font-mono text-xs'}
              autoComplete="off"
            />
          </label>
          <label className="block">
            <span className="block text-[11px] text-neutral-400 mb-1">
              GitHub Repository (Default: <code className="text-neutral-500">meintechblog/charging-master</code>)
            </span>
            <input
              type="text"
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
              placeholder="owner/repo"
              className={inputClasses + ' w-full text-xs'}
              autoComplete="off"
            />
          </label>
          <p className="text-[11px] text-neutral-500">
            Status:{' '}
            {hasToken ? (
              <span className="text-green-400">Auto-Publish aktiv</span>
            ) : (
              <span className="text-neutral-400">Manuell — Artefakte werden zum Download angeboten</span>
            )}
          </p>
        </div>
      )}

      <div className="text-xs text-neutral-500 h-4">
        {(saveStatus === 'saving' || tokenStatus === 'saving' || repoStatus === 'saving') && <span>Speichere…</span>}
        {(saveStatus === 'saved' || tokenStatus === 'saved' || repoStatus === 'saved') &&
          !(saveStatus === 'saving' || tokenStatus === 'saving' || repoStatus === 'saving') && (
            <span className="text-green-400">Gespeichert ✓</span>
          )}
      </div>
    </div>
  );
}
