'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';

interface Session {
  id: number;
  plugId: string;
  plugName: string | null;
  profileId: number | null;
  profileName: string | null;
  state: string;
  detectionConfidence: number | null;
  targetSoc: number | null;
  estimatedSoc: number | null;
  startedAt: number;
  stoppedAt: number | null;
  stopReason: string | null;
  energyWh: number | null;
}

interface Plug {
  id: string;
  name: string;
}

const STATUS_LABELS: Record<string, string> = {
  complete: 'Abgeschlossen',
  error: 'Fehler',
  aborted: 'Abgebrochen',
  charging: 'Laden',
  detecting: 'Erkennung',
  learning: 'Lernen',
  learn_complete: 'Gelernt',
  matched: 'Erkannt',
  countdown: 'Countdown',
};

const STATUS_FILTER_OPTIONS = [
  { value: 'complete', label: 'Abgeschlossen' },
  { value: 'error', label: 'Fehler' },
  { value: 'aborted', label: 'Abgebrochen' },
  { value: 'charging', label: 'Laden' },
  { value: 'detecting', label: 'Erkennung' },
  { value: 'learning', label: 'Lernen' },
];

function statusBadgeClass(state: string): string {
  switch (state) {
    case 'complete':
      return 'bg-green-500/20 text-green-400';
    case 'error':
      return 'bg-red-500/20 text-red-400';
    case 'aborted':
      return 'bg-orange-500/20 text-orange-400';
    case 'charging':
    case 'countdown':
    case 'detecting':
    case 'matched':
      return 'bg-blue-500/20 text-blue-400';
    case 'learning':
    case 'learn_complete':
      return 'bg-yellow-500/20 text-yellow-400';
    default:
      return 'bg-neutral-500/20 text-neutral-400';
  }
}

function formatDate(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleDateString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }) + ' ' + d.toLocaleTimeString('de-DE', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatDuration(startedAt: number, stoppedAt: number | null): string {
  const end = stoppedAt ?? Date.now();
  const diffMs = end - startedAt;
  if (diffMs < 0) return '-';

  const totalMinutes = Math.floor(diffMs / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}min`;
  }
  return `${minutes} min`;
}

function formatEnergy(wh: number | null): string {
  if (wh == null) return '-';
  if (wh >= 1000) {
    return `${(wh / 1000).toFixed(2)} kWh`;
  }
  return `${wh.toFixed(1)} Wh`;
}

export default function HistoryPage() {
  const router = useRouter();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [plugs, setPlugs] = useState<Plug[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [selectedPlugId, setSelectedPlugId] = useState('');
  const [selectedStatus, setSelectedStatus] = useState('');
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);

  async function handleDelete(sessionId: number) {
    setDeletingId(sessionId);
    try {
      const res = await fetch(`/api/charging/sessions/${sessionId}`, { method: 'DELETE' });
      if (res.ok) {
        setSessions((prev) => prev.filter((s) => s.id !== sessionId));
        setTotal((t) => Math.max(0, t - 1));
      }
    } finally {
      setDeletingId(null);
      setConfirmDeleteId(null);
    }
  }

  const fetchSessions = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (selectedPlugId) params.set('plugId', selectedPlugId);
      if (selectedStatus) params.set('status', selectedStatus);
      params.set('limit', '50');

      const res = await fetch(`/api/history?${params.toString()}`);
      if (res.ok) {
        const data = await res.json();
        setSessions(data.sessions);
        setTotal(data.total);
        setPlugs(data.plugs);
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [selectedPlugId, selectedStatus]);

  useEffect(() => {
    fetchSessions();
  }, [fetchSessions]);

  return (
    <div className="max-w-7xl mx-auto">
      {/* Header */}
      <h1 className="text-2xl font-bold text-neutral-100 mb-6">Verlauf</h1>

      {/* Filter bar */}
      <div className="flex flex-wrap gap-3 mb-4">
        <select
          value={selectedPlugId}
          onChange={(e) => setSelectedPlugId(e.target.value)}
          className="bg-neutral-800 border border-neutral-700 text-neutral-200 text-sm rounded-md px-3 py-2 focus:outline-none focus:ring-1 focus:ring-blue-500"
        >
          <option value="">Alle Geräte</option>
          {plugs.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>

        <select
          value={selectedStatus}
          onChange={(e) => setSelectedStatus(e.target.value)}
          className="bg-neutral-800 border border-neutral-700 text-neutral-200 text-sm rounded-md px-3 py-2 focus:outline-none focus:ring-1 focus:ring-blue-500"
        >
          <option value="">Alle Status</option>
          {STATUS_FILTER_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>

        {total > 0 && (
          <span className="text-sm text-neutral-500 self-center ml-auto">
            {total} Ladevorgang{total !== 1 ? 'e' : ''}
          </span>
        )}
      </div>

      {/* Table */}
      {loading ? (
        <div className="text-neutral-500 text-sm py-8 text-center">Laden...</div>
      ) : sessions.length === 0 ? (
        <div className="text-neutral-500 text-sm py-8 text-center">
          Noch keine Ladevorgaenge aufgezeichnet.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-neutral-800">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-neutral-900 border-b border-neutral-800">
                <th className="text-left px-4 py-3 text-neutral-400 font-medium">Datum</th>
                <th className="text-left px-4 py-3 text-neutral-400 font-medium">Geraet</th>
                <th className="text-left px-4 py-3 text-neutral-400 font-medium">Profil</th>
                <th className="text-left px-4 py-3 text-neutral-400 font-medium">Status</th>
                <th className="text-right px-4 py-3 text-neutral-400 font-medium">Dauer</th>
                <th className="text-right px-4 py-3 text-neutral-400 font-medium">Energie</th>
                <th className="text-right px-4 py-3 text-neutral-400 font-medium">SOC</th>
                <th className="text-right px-4 py-3 text-neutral-400 font-medium w-20"></th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => (
                <tr
                  key={s.id}
                  onClick={() => router.push(`/history/${s.id}`)}
                  className="border-b border-neutral-800 bg-neutral-900 hover:bg-neutral-800/70 cursor-pointer transition-colors"
                >
                  <td className="px-4 py-3 text-neutral-100 whitespace-nowrap">
                    {formatDate(s.startedAt)}
                  </td>
                  <td className="px-4 py-3 text-neutral-100">
                    {s.plugName || s.plugId}
                  </td>
                  <td className="px-4 py-3 text-neutral-400">
                    {s.profileName || '-'}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${statusBadgeClass(s.state)}`}>
                      {STATUS_LABELS[s.state] || s.state}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-neutral-300 text-right whitespace-nowrap">
                    {formatDuration(s.startedAt, s.stoppedAt)}
                  </td>
                  <td className="px-4 py-3 text-neutral-300 text-right whitespace-nowrap">
                    {formatEnergy(s.energyWh)}
                  </td>
                  <td className="px-4 py-3 text-neutral-300 text-right">
                    {s.estimatedSoc != null ? `${s.estimatedSoc}%` : '-'}
                  </td>
                  <td
                    className="px-4 py-3 text-right"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {confirmDeleteId === s.id ? (
                      <div className="flex justify-end gap-1">
                        <button
                          onClick={() => handleDelete(s.id)}
                          disabled={deletingId === s.id}
                          className="text-xs text-red-400 hover:text-red-300 disabled:opacity-50"
                        >
                          {deletingId === s.id ? '...' : 'OK'}
                        </button>
                        <button
                          onClick={() => setConfirmDeleteId(null)}
                          className="text-xs text-neutral-500 hover:text-neutral-300"
                        >
                          ×
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => setConfirmDeleteId(s.id)}
                        className="text-xs text-neutral-500 hover:text-red-400 transition-colors"
                        title="Löschen"
                      >
                        Löschen
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
