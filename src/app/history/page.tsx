'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { PageHeader, StatusBadge } from '@/components/layout/page-header';

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

function statusColor(state: string): string {
  switch (state) {
    case 'complete': return 'var(--color-ok)';
    case 'error': return 'var(--color-danger)';
    case 'aborted': return 'var(--color-danger)';
    case 'charging':
    case 'countdown':
    case 'detecting':
    case 'matched':
      return 'var(--color-accent)';
    case 'learning':
    case 'learn_complete':
      return 'var(--color-warn)';
    default: return 'var(--color-text-faint)';
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

  const selectClass = 'text-sm rounded-md px-3 py-2 focus:outline-none transition-colors';
  const selectStyle: React.CSSProperties = {
    background: 'var(--color-ink-2)',
    border: '1px solid var(--color-line-soft)',
    color: 'var(--color-text-default)',
  };

  return (
    <div>
      <PageHeader
        eyebrow={`Archiv · 06 · ${total.toString().padStart(3, '0')} Ladevorgänge`}
        title="Verlauf"
      />

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-3 mb-6">
        <select
          value={selectedPlugId}
          onChange={(e) => setSelectedPlugId(e.target.value)}
          className={selectClass}
          style={selectStyle}
        >
          <option value="">Alle Geräte</option>
          {plugs.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>

        <select
          value={selectedStatus}
          onChange={(e) => setSelectedStatus(e.target.value)}
          className={selectClass}
          style={selectStyle}
        >
          <option value="">Alle Status</option>
          {STATUS_FILTER_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </div>

      {loading ? (
        <div className="py-12 text-center">
          <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-[color:var(--color-text-muted)]">
            laden…
          </span>
        </div>
      ) : sessions.length === 0 ? (
        <div
          className="py-12 text-center"
          style={{
            background: 'var(--color-ink-2)',
            border: '1px solid var(--color-line-soft)',
            borderRadius: 'var(--radius-lg)',
          }}
        >
          <div className="label-eyebrow mb-2">Archiv leer</div>
          <p className="text-[14px] text-[color:var(--color-text-soft)]">
            Noch keine Ladevorgänge aufgezeichnet.
          </p>
        </div>
      ) : (
        <div
          className="overflow-hidden"
          style={{
            background: 'var(--color-ink-2)',
            border: '1px solid var(--color-line-soft)',
            borderRadius: 'var(--radius-lg)',
          }}
        >
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr style={{ borderBottom: '1px solid var(--color-line-soft)' }}>
                  <th className="text-left label-eyebrow px-4 py-3">Datum</th>
                  <th className="text-left label-eyebrow px-4 py-3">Gerät</th>
                  <th className="text-left label-eyebrow px-4 py-3">Profil</th>
                  <th className="text-left label-eyebrow px-4 py-3">Status</th>
                  <th className="text-right label-eyebrow px-4 py-3">Dauer</th>
                  <th className="text-right label-eyebrow px-4 py-3">Energie</th>
                  <th className="text-right label-eyebrow px-4 py-3">SoC</th>
                  <th className="text-right label-eyebrow px-4 py-3 w-20" />
                </tr>
              </thead>
              <tbody>
                {sessions.map((s, idx) => (
                  <tr
                    key={s.id}
                    onClick={() => router.push(`/history/${s.id}`)}
                    className="cursor-pointer transition-colors hover:bg-[color:var(--color-ink-3)]"
                    style={{
                      borderTop: idx === 0 ? 'none' : '1px solid var(--color-line-faint)',
                    }}
                  >
                    <td className="px-4 py-3 text-[13px] font-mono tabular-nums whitespace-nowrap text-[color:var(--color-text-default)]">
                      {formatDate(s.startedAt)}
                    </td>
                    <td className="px-4 py-3 text-[14px] text-[color:var(--color-text-strong)]">
                      {s.plugName || s.plugId}
                    </td>
                    <td className="px-4 py-3 text-[13px] text-[color:var(--color-text-soft)]">
                      {s.profileName || '—'}
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge
                        label={STATUS_LABELS[s.state] || s.state}
                        color={statusColor(s.state)}
                      />
                    </td>
                    <td className="px-4 py-3 text-[13px] font-mono tabular-nums text-right whitespace-nowrap text-[color:var(--color-text-default)]">
                      {formatDuration(s.startedAt, s.stoppedAt)}
                    </td>
                    <td className="px-4 py-3 text-[13px] font-mono tabular-nums text-right whitespace-nowrap text-[color:var(--color-text-default)]">
                      {formatEnergy(s.energyWh)}
                    </td>
                    <td className="px-4 py-3 text-[13px] font-mono tabular-nums text-right text-[color:var(--color-text-default)]">
                      {s.estimatedSoc != null ? `${s.estimatedSoc}%` : '—'}
                    </td>
                    <td className="px-4 py-3 text-right" onClick={(e) => e.stopPropagation()}>
                      {confirmDeleteId === s.id ? (
                        <div className="flex justify-end gap-2">
                          <button
                            onClick={() => handleDelete(s.id)}
                            disabled={deletingId === s.id}
                            className="text-[11px] font-mono uppercase tracking-wider disabled:opacity-50"
                            style={{ color: 'var(--color-danger)' }}
                          >
                            {deletingId === s.id ? '…' : 'OK'}
                          </button>
                          <button
                            onClick={() => setConfirmDeleteId(null)}
                            className="text-[11px] font-mono"
                            style={{ color: 'var(--color-text-muted)' }}
                          >
                            ×
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() => setConfirmDeleteId(s.id)}
                          className="text-[10px] font-mono uppercase tracking-[0.16em] transition-colors hover:text-[color:var(--color-danger)]"
                          style={{ color: 'var(--color-text-muted)' }}
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
        </div>
      )}
    </div>
  );
}
