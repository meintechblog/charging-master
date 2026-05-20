'use client';

import { useState, useEffect, useRef, useCallback } from 'react';

type Props = { initialSettings: Record<string, string> };

type SyncStatus = {
  catalogEnabled: boolean;
  autoSyncEnabled: boolean;
  tokenConfigured: boolean;
  canAutoSync: boolean;
  lastSuccess: {
    profileId: number | null;
    profileName: string | null;
    catalogProfileId: string | null;
    reason: string;
    commitSha: string | null;
    createdAt: number;
  } | null;
  recentSyncErrors: Array<{
    id: number;
    profileId: number | null;
    profileName: string | null;
    reason: string;
    errorMessage: string | null;
    createdAt: number;
  }>;
};

function formatRelative(ts: number): string {
  const diff = Date.now() - ts;
  const sec = Math.round(diff / 1000);
  if (sec < 60) return `vor ${sec}s`;
  const min = Math.round(sec / 60);
  if (min < 60) return `vor ${min} min`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `vor ${hr} h`;
  const days = Math.round(hr / 24);
  return `vor ${days} Tagen`;
}

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
  // catalog.autoSync defaults to "true" when absent — matches server-side
  // isAutoSyncEnabled().
  const initialAutoSync = initialSettings['catalog.autoSync'] === 'false' ? 'false' : 'true';

  const [enabled, setEnabled] = useState(initialEnabled);
  const [token, setToken] = useState(initialToken);
  const [repo, setRepo] = useState(initialRepo);
  const [autoSync, setAutoSync] = useState(initialAutoSync);

  const saveStatus = useAutoSave('catalog.enabled', enabled, initialEnabled);
  const tokenStatus = useAutoSave('github.contentsToken', token, initialToken);
  const repoStatus = useAutoSave('github.repo', repo, initialRepo);
  const autoSyncStatus = useAutoSave('catalog.autoSync', autoSync, initialAutoSync);

  const isOn = enabled === 'true';
  const hasToken = token.trim().length > 0;
  const isAutoSyncOn = autoSync === 'true';

  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [backfillState, setBackfillState] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [backfillResult, setBackfillResult] = useState<{ requested: number; synced: number; firstError?: string } | null>(null);

  const reloadStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/catalog/sync-status');
      if (res.ok) setSyncStatus(await res.json());
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    if (!isOn) return;
    reloadStatus();
    const t = setInterval(reloadStatus, 30_000);
    return () => clearInterval(t);
  }, [isOn, reloadStatus]);

  const triggerBackfill = async () => {
    setBackfillState('running');
    setBackfillResult(null);
    try {
      const res = await fetch('/api/catalog/sync-now', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const json = await res.json();
      if (!res.ok) {
        setBackfillState('error');
        setBackfillResult({ requested: 0, synced: 0, firstError: json?.error ?? `HTTP ${res.status}` });
        return;
      }
      const firstError = (json.results as Array<{ status: string; error?: string }> | undefined)
        ?.find((r) => r.status !== 'success')?.error;
      setBackfillState('done');
      setBackfillResult({
        requested: json.requested ?? 0,
        synced: json.syncedProfiles ?? 0,
        firstError,
      });
      reloadStatus();
    } catch (err) {
      setBackfillState('error');
      setBackfillResult({ requested: 0, synced: 0, firstError: err instanceof Error ? err.message : String(err) });
    }
  };

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

      {isOn && hasToken && (
        <div className="border-t border-neutral-800 pt-3 space-y-3">
          <label className="flex items-center gap-3 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={isAutoSyncOn}
              onChange={(e) => setAutoSync(e.target.checked ? 'true' : 'false')}
              className="w-4 h-4 accent-blue-500"
            />
            <span className="text-sm text-neutral-200">
              Auto-Sync der Profile
            </span>
          </label>
          <p className="text-[11px] text-neutral-500 leading-relaxed -mt-1">
            Wenn aktiv, werden Änderungen an einem Profil (neues Foto, Curve-Save, Metadaten-Edit, Ladegerät-Edit)
            automatisch ~15s später in den Katalog auf GitHub gepushed. Bei deaktiviertem Auto-Sync musst du
            Profile manuell über die Profil-Detailseite einreichen.
          </p>

          {syncStatus && (
            <div className="rounded-md bg-neutral-900 border border-neutral-800 px-3 py-2 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <div className="text-[11px] text-neutral-400">
                  {syncStatus.lastSuccess ? (
                    <>
                      Letzte Synchronisation:{' '}
                      <span className="text-neutral-200">{formatRelative(syncStatus.lastSuccess.createdAt)}</span>
                      {syncStatus.lastSuccess.profileName && (
                        <span className="text-neutral-500"> · {syncStatus.lastSuccess.profileName}</span>
                      )}
                      {syncStatus.lastSuccess.commitSha && (
                        <span className="text-neutral-600 font-mono"> · {syncStatus.lastSuccess.commitSha.slice(0, 7)}</span>
                      )}
                    </>
                  ) : (
                    <span className="text-neutral-500">Noch keine erfolgreiche Synchronisation.</span>
                  )}
                </div>
                <span className={`text-[11px] ${syncStatus.canAutoSync ? 'text-green-400' : 'text-amber-400'}`}>
                  {syncStatus.canAutoSync ? '● aktiv' : '○ inaktiv'}
                </span>
              </div>

              {syncStatus.recentSyncErrors.length > 0 && (
                <details className="text-[11px]">
                  <summary className="cursor-pointer text-red-400 hover:text-red-300">
                    {syncStatus.recentSyncErrors.length} letzte Fehler
                  </summary>
                  <ul className="mt-1 space-y-1 pl-2 text-red-300/80">
                    {syncStatus.recentSyncErrors.slice(0, 5).map((e) => (
                      <li key={e.id} className="font-mono break-all">
                        <span className="text-neutral-500">{formatRelative(e.createdAt)}</span>{' '}
                        {e.profileName && <span className="text-neutral-400">{e.profileName} · </span>}
                        {e.errorMessage?.slice(0, 120) ?? 'unknown'}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          )}

          <div className="flex items-center justify-between gap-3 pt-1">
            <p className="text-[11px] text-neutral-500 leading-snug">
              Backfill: Alle lokalen Profile mit Referenzkurve neu publishen — z. B. nach erstmaliger Token-Eingabe.
            </p>
            <button
              type="button"
              onClick={triggerBackfill}
              disabled={backfillState === 'running'}
              className="px-3 py-1.5 rounded-md bg-blue-600 hover:bg-blue-500 disabled:bg-neutral-700 disabled:text-neutral-500 text-white text-xs font-medium whitespace-nowrap"
            >
              {backfillState === 'running' ? 'Synchronisiere…' : 'Jetzt synchronisieren'}
            </button>
          </div>
          {backfillResult && (
            <div className={`text-[11px] ${backfillState === 'error' ? 'text-red-400' : 'text-neutral-400'}`}>
              {backfillState === 'error' ? (
                <span>Fehler: {backfillResult.firstError ?? 'unbekannt'}</span>
              ) : (
                <span>
                  {backfillResult.synced}/{backfillResult.requested} Profile synchronisiert
                  {backfillResult.firstError && (
                    <span className="text-red-400/80"> · Erster Fehler: {backfillResult.firstError}</span>
                  )}
                </span>
              )}
            </div>
          )}
        </div>
      )}

      <div className="text-xs text-neutral-500 h-4">
        {(saveStatus === 'saving' || tokenStatus === 'saving' || repoStatus === 'saving' || autoSyncStatus === 'saving') && <span>Speichere…</span>}
        {(saveStatus === 'saved' || tokenStatus === 'saved' || repoStatus === 'saved' || autoSyncStatus === 'saved') &&
          !(saveStatus === 'saving' || tokenStatus === 'saving' || repoStatus === 'saving' || autoSyncStatus === 'saving') && (
            <span className="text-green-400">Gespeichert ✓</span>
          )}
      </div>
    </div>
  );
}
