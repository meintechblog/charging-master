'use client';

// src/app/settings/update-state/quarantine-list.tsx
//
// Client component rendering the quarantine summary (file count + timestamp),
// the recursive file list (relative paths per RESEARCH Open Q8 lock), and the
// "Alle löschen" red button that calls
// DELETE /api/admin/update-state/quarantine (shipped in Plan 13-03) then
// router.refresh() to re-run the parent server component.
//
// Mirrors handleAckRollback in src/app/settings/update-banner.tsx — same
// setIsLoading → await fetch → on-ok refresh → finally setIsLoading(false)
// shape (PATTERNS §12). Idempotent on the server side, so a double-click or
// a click after a sibling tab already cleared the dir still returns 200.

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { UpdateState } from '@/modules/self-update/types';

type Props = {
  quarantine: NonNullable<UpdateState['lastQuarantine']> | null;
  files: string[];
};

const DATE_FMT = new Intl.DateTimeFormat('de', { dateStyle: 'medium', timeStyle: 'short' });

export function QuarantineList({ quarantine, files }: Props) {
  const router = useRouter();
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (quarantine === null) {
    return <p className="text-sm text-neutral-400">Keine Quarantäne-Dateien.</p>;
  }

  const handleDelete = async (): Promise<void> => {
    setIsDeleting(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/update-state/quarantine', { method: 'DELETE' });
      if (!res.ok) {
        setError(`Löschen fehlgeschlagen (HTTP ${res.status})`);
        setIsDeleting(false);
        return;
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setIsDeleting(false);
    }
  };

  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-950 p-4 space-y-4">
      <div className="text-xs text-neutral-400">
        <span className="font-mono">{quarantine.fileCount} Datei(en)</span>
        {' · '}
        <span>{DATE_FMT.format(new Date(quarantine.timestamp))}</span>
      </div>
      <ul className="font-mono text-xs text-neutral-300 space-y-1">
        {files.map((f) => (
          <li key={f}>{f}</li>
        ))}
        {files.length === 0 && (
          <li className="text-neutral-500">(Verzeichnis ist leer oder bereits entfernt.)</li>
        )}
      </ul>
      <div>
        <button
          type="button"
          onClick={handleDelete}
          disabled={isDeleting}
          className="rounded border border-red-500/50 bg-red-900/30 px-3 py-1.5 text-xs text-red-100 hover:bg-red-900/50 disabled:opacity-50"
        >
          {isDeleting ? 'Lösche…' : 'Alle löschen'}
        </button>
        {error !== null && <p className="mt-2 text-xs text-red-300">{error}</p>}
      </div>
    </div>
  );
}
