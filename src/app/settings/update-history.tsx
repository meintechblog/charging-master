'use client';

import { useEffect, useState } from 'react';

type UpdateRun = {
  id: number;
  startAt: number;
  endAt: number | null;
  fromSha: string;
  fromShaShort: string;
  toSha: string | null;
  toShaShort: string | null;
  status: 'running' | 'success' | 'failed' | 'rolled_back';
  stage: string | null;
  errorMessage: string | null;
  rollbackStage: string | null;
  durationMs: number | null;
};

const DATE_FMT = new Intl.DateTimeFormat('de', {
  dateStyle: 'short',
  timeStyle: 'short',
});

function formatDuration(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m ${rem}s`;
}

function statusLabel(r: UpdateRun): { label: string; className: string } {
  switch (r.status) {
    case 'success':
      return { label: 'Erfolgreich', className: 'text-green-400' };
    case 'rolled_back':
      return {
        label: r.rollbackStage === 'stage2' ? 'Rollback (Stage 2)' : 'Rollback (Stage 1)',
        className: 'text-amber-400',
      };
    case 'failed':
      return { label: 'Fehlgeschlagen', className: 'text-red-400' };
    case 'running':
      return { label: 'Läuft…', className: 'text-blue-400' };
    default:
      return { label: r.status, className: 'text-neutral-400' };
  }
}

export function UpdateHistory(): React.ReactElement {
  const [runs, setRuns] = useState<UpdateRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    fetch('/api/update/history?limit=10', { signal: ctrl.signal })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data: { runs: UpdateRun[] }) => {
        setRuns(data.runs ?? []);
      })
      .catch((err) => {
        if (err?.name === 'AbortError') return;
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => ctrl.abort();
  }, []);

  if (error !== null) {
    return (
      <div className="rounded border border-red-500/30 bg-red-500/5 p-3 text-xs text-red-300">
        Update-Historie konnte nicht geladen werden: {error}
      </div>
    );
  }

  if (runs === null) {
    return (
      <div className="rounded border border-neutral-800 bg-neutral-950 p-3 text-xs text-neutral-500">
        Lade Update-Historie…
      </div>
    );
  }

  if (runs.length === 0) {
    return (
      <div className="rounded border border-neutral-800 bg-neutral-950 p-3 text-xs text-neutral-500">
        Noch keine Updates durchgeführt.
      </div>
    );
  }

  return (
    <div className="rounded border border-neutral-800 bg-neutral-950">
      <div className="border-b border-neutral-800 px-3 py-2 text-xs font-semibold text-neutral-300">
        Letzte Updates ({runs.length})
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="text-neutral-500">
            <tr>
              <th className="px-3 py-2 text-left font-normal">Datum</th>
              <th className="px-3 py-2 text-left font-normal">Von → Nach</th>
              <th className="px-3 py-2 text-left font-normal">Status</th>
              <th className="px-3 py-2 text-right font-normal">Dauer</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-900">
            {runs.map((r) => {
              const status = statusLabel(r);
              return (
                <tr key={r.id} className="text-neutral-200">
                  <td className="px-3 py-2 whitespace-nowrap text-neutral-400">
                    {DATE_FMT.format(new Date(r.startAt))}
                  </td>
                  <td className="px-3 py-2 font-mono whitespace-nowrap">
                    <span className="text-neutral-500">{r.fromShaShort}</span>
                    <span className="mx-1 text-neutral-700">→</span>
                    <span className={r.toShaShort !== null ? 'text-neutral-200' : 'text-neutral-600'}>
                      {r.toShaShort ?? '—'}
                    </span>
                  </td>
                  <td className={`px-3 py-2 ${status.className}`}>
                    {status.label}
                    {r.errorMessage !== null && r.status !== 'success' && (
                      <span
                        className="ml-1 cursor-help text-neutral-500"
                        title={r.errorMessage}
                      >
                        ⓘ
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right text-neutral-400">
                    {formatDuration(r.durationMs)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
