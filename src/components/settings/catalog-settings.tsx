'use client';

import { useState, useEffect, useRef, useCallback } from 'react';

type Props = { initialSettings: Record<string, string> };

type SyncStatus = {
  catalogEnabled: boolean;
  autoSyncEnabled: boolean;
  tokenConfigured: boolean;
  canAutoSync: boolean;
  disabledReason: string | null;
  lastPr: { number: number; url: string; branch: string | null } | null;
  lastSuccess: {
    profileId: number | null;
    profileName: string | null;
    catalogProfileId: string | null;
    reason: string;
    commitSha: string | null;
    prUrl: string | null;
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

export function CatalogSettings({ initialSettings }: Props) {
  const initialEnabled = initialSettings['catalog.enabled'] === 'true' ? 'true' : 'false';
  // Default 'true' wenn die config-row nicht existiert; matched server-side
  // isAutoSyncEnabled() default (auto-sync.ts). Explizites 'false' deaktiviert.
  const initialAutoSync = initialSettings['catalog.autoSync'] === 'false' ? 'false' : 'true';

  const [enabled, setEnabled] = useState(initialEnabled);
  const [autoSync, setAutoSync] = useState(initialAutoSync);

  const saveStatus = useAutoSave('catalog.enabled', enabled, initialEnabled);
  const autoSyncStatus = useAutoSave('catalog.autoSync', autoSync, initialAutoSync);

  const isOn = enabled === 'true';
  const isAutoSyncOn = autoSync === 'true';

  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [backfillState, setBackfillState] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [backfillResult, setBackfillResult] = useState<{ requested: number; synced: number; firstError?: string } | null>(null);

  // hasToken comes from the server (env-based GitHub-App-Konfiguration),
  // nicht aus einem UI-Input. Wenn das Backend env-vars nicht parst,
  // ist hasToken false und das Widget zeigt den disabledReason.
  const hasToken = syncStatus?.tokenConfigured ?? false;

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

      {isOn && !hasToken && (
        <div className="border-t border-neutral-800 pt-3 space-y-1">
          <p className="text-[11px] text-amber-300 leading-relaxed">
            GitHub-App ist nicht vollständig konfiguriert. Auto-Sync ist deaktiviert.
          </p>
          {syncStatus?.disabledReason && (
            <p className="text-[11px] text-neutral-500 font-mono break-all">
              {syncStatus.disabledReason}
            </p>
          )}
          <p className="text-[11px] text-neutral-500 leading-relaxed">
            Siehe{' '}
            <a
              href="https://github.com/meintechblog/charging-master/blob/main/docs/CATALOG_AUTOSYNC.md"
              target="_blank"
              rel="noopener noreferrer"
              className="underline"
            >
              docs/CATALOG_AUTOSYNC.md
            </a>{' '}
            für die Einrichtung.
          </p>
        </div>
      )}

      {isOn && hasToken && (
        <div className="border-t border-neutral-800 pt-3 space-y-3">
          <p className="text-[11px] text-neutral-500 leading-relaxed">
            GitHub-App ist via Environment konfiguriert. Auto-Sync öffnet Pull Requests im Catalog-Repo.
          </p>

          <div className="flex items-center justify-between gap-2">
            <label className="flex items-center gap-3 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={isAutoSyncOn}
                onChange={(e) => setAutoSync(e.target.checked ? 'true' : 'false')}
                className="w-4 h-4 accent-blue-500"
              />
              <span className="text-sm text-neutral-200">Auto-Sync der Profile</span>
            </label>
          </div>
          <p className="text-[11px] text-neutral-500 leading-relaxed -mt-1">
            Wenn aktiv, werden Änderungen an einem Profil (neues Foto, Curve-Save, Metadaten-Edit, Ladegerät-Edit)
            automatisch ~15s später als Pull Request im Catalog-Repo geöffnet.
          </p>

          {syncStatus?.lastPr && (
            <p className="text-[11px] text-neutral-400">
              Letzter PR:{' '}
              <a
                href={syncStatus.lastPr.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-400 hover:underline"
              >
                #{syncStatus.lastPr.number}
              </a>
              {syncStatus.lastSuccess && (
                <span className="text-neutral-500"> · {formatRelative(syncStatus.lastSuccess.createdAt)}</span>
              )}
            </p>
          )}

          <div className="flex items-center justify-between gap-3 pt-1">
            <p className="text-[11px] text-neutral-500 leading-snug">
              Backfill: Alle lokalen Profile mit Referenzkurve als PRs öffnen.
            </p>
            <button
              type="button"
              onClick={triggerBackfill}
              disabled={backfillState === 'running'}
              className="px-3 py-1.5 rounded-md bg-blue-600 hover:bg-blue-500 disabled:bg-neutral-700 disabled:text-neutral-500 text-white text-xs font-medium whitespace-nowrap transition-colors"
            >
              {backfillState === 'running' ? 'Synchronisiere…' : 'Jetzt synchronisieren'}
            </button>
          </div>

          {backfillResult && (
            <div className={`text-[11px] ${backfillState === 'error' ? 'text-red-400' : 'text-neutral-400'}`}>
              {backfillState === 'done' && (
                <>
                  Backfill: {backfillResult.synced} von {backfillResult.requested} Profilen synchronisiert.
                  {backfillResult.firstError && (
                    <span className="block text-amber-400 mt-1">Erster Fehler: {backfillResult.firstError}</span>
                  )}
                </>
              )}
              {backfillState === 'error' && (
                <>Fehler: {backfillResult.firstError ?? 'Unbekannt'}</>
              )}
            </div>
          )}
        </div>
      )}

      <div className="text-xs text-neutral-500 h-4">
        {(saveStatus === 'saving' || autoSyncStatus === 'saving') && <span>Speichere…</span>}
        {(saveStatus === 'saved' || autoSyncStatus === 'saved') &&
          !(saveStatus === 'saving' || autoSyncStatus === 'saving') && (
            <span className="text-green-400">Gespeichert ✓</span>
          )}
      </div>
    </div>
  );
}
