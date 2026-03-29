'use client';

import { useState, useEffect } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { PowerChart } from '@/components/charts/power-chart';

type Reading = {
  offsetMs: number;
  apower: number;
  voltage: number | null;
  current: number | null;
  timestamp: number;
};

type SessionEvent = {
  state: string;
  timestamp: number;
};

type ReferenceCurve = {
  points: Array<{ offsetSeconds: number; apower: number; cumulativeWh: number }>;
  curveOffsetSeconds: number | null;
};

type SessionDetail = {
  id: number;
  plugId: string;
  plugName: string | null;
  profileId: number | null;
  profileName: string | null;
  state: string;
  detectionConfidence: number | null;
  curveOffsetSeconds: number | null;
  targetSoc: number | null;
  estimatedSoc: number | null;
  startedAt: number;
  stoppedAt: number | null;
  stopReason: string | null;
  energyWh: number | null;
  dtwScore: number | null;
  durationMs: number;
  readings: Reading[];
  events: SessionEvent[];
  referenceCurve: ReferenceCurve | null;
};

const STATE_COLORS: Record<string, string> = {
  detecting: 'bg-blue-500/20 text-blue-400',
  matched: 'bg-blue-500/20 text-blue-400',
  charging: 'bg-green-500/20 text-green-400',
  countdown: 'bg-green-500/20 text-green-400',
  complete: 'bg-emerald-500/20 text-emerald-300',
  error: 'bg-red-500/20 text-red-400',
  aborted: 'bg-orange-500/20 text-orange-400',
  learning: 'bg-yellow-500/20 text-yellow-400',
  learn_complete: 'bg-yellow-500/20 text-yellow-400',
  stopping: 'bg-blue-500/20 text-blue-400',
};

const STATE_DOT_COLORS: Record<string, string> = {
  detecting: 'bg-blue-400',
  matched: 'bg-blue-400',
  charging: 'bg-green-400',
  countdown: 'bg-green-400',
  complete: 'bg-emerald-300',
  error: 'bg-red-400',
  aborted: 'bg-orange-400',
  learning: 'bg-yellow-400',
  learn_complete: 'bg-yellow-400',
  stopping: 'bg-blue-400',
};

const STATE_LABELS: Record<string, string> = {
  detecting: 'Erkennung',
  matched: 'Erkannt',
  charging: 'Laden',
  countdown: 'Countdown',
  complete: 'Abgeschlossen',
  error: 'Fehler',
  aborted: 'Abgebrochen',
  learning: 'Lernen',
  learn_complete: 'Lernvorgang abgeschlossen',
  stopping: 'Wird gestoppt',
};

function formatDurationMs(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}min ${seconds}s`;
  if (minutes > 0) return `${minutes}min ${seconds}s`;
  return `${seconds}s`;
}

function formatEnergy(wh: number | null): string {
  if (wh == null) return '-';
  if (wh >= 1000) return `${(wh / 1000).toFixed(2)} kWh`;
  return `${wh.toFixed(1)} Wh`;
}

function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('de-DE', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function StatCard({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div className="bg-neutral-900 rounded-lg p-4 border border-neutral-800">
      <div className="text-xs text-neutral-500 mb-1">{label}</div>
      <div className={`text-lg font-bold font-mono ${accent ?? 'text-neutral-100'}`}>{value}</div>
    </div>
  );
}

export default function SessionDetailPage() {
  const params = useParams<{ sessionId: string }>();
  const sessionId = params.sessionId;

  const [session, setSession] = useState<SessionDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    fetch(`/api/history/${sessionId}`)
      .then((res) => {
        if (!res.ok) throw new Error('not found');
        return res.json();
      })
      .then((data) => setSession(data))
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, [sessionId]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <span className="text-neutral-400 text-sm">Laden...</span>
      </div>
    );
  }

  if (error || !session) {
    return (
      <div className="text-center py-12">
        <p className="text-neutral-400 mb-4">Session nicht gefunden.</p>
        <Link href="/history" className="text-blue-400 hover:text-blue-300 text-sm">
          Zurueck zur Uebersicht
        </Link>
      </div>
    );
  }

  // Build chart data from readings
  const sessionChartData: Array<[number, number]> = session.readings.map((r) => [
    session.startedAt + r.offsetMs,
    r.apower,
  ]);

  // Build reference curve data with proper alignment (accounting for curveOffsetSeconds)
  let refChartData: Array<[number, number]> | undefined;
  if (session.referenceCurve && session.referenceCurve.points.length > 0) {
    const offsetMs = (session.referenceCurve.curveOffsetSeconds ?? 0) * 1000;
    refChartData = session.referenceCurve.points.map((p) => [
      session.startedAt - offsetMs + p.offsetSeconds * 1000,
      p.apower,
    ]);
  }

  const stateColor = STATE_COLORS[session.state] ?? 'bg-neutral-700 text-neutral-300';
  const stateLabel = STATE_LABELS[session.state] ?? session.state;

  return (
    <div className="space-y-6">
      {/* Breadcrumb */}
      <div>
        <div className="flex items-center gap-2 text-xs text-neutral-500 mb-1">
          <Link href="/history" className="hover:text-neutral-300 transition-colors">
            Verlauf
          </Link>
          <span>/</span>
          <span className="text-neutral-400">{formatTimestamp(session.startedAt)}</span>
        </div>
        <h1 className="text-2xl font-bold text-neutral-100">Session #{session.id}</h1>
      </div>

      {/* Stats cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="Start" value={formatTimestamp(session.startedAt)} />
        <StatCard
          label="Ende"
          value={session.stoppedAt ? formatTimestamp(session.stoppedAt) : 'Aktiv'}
          accent={session.stoppedAt ? undefined : 'text-green-400'}
        />
        <StatCard label="Dauer" value={formatDurationMs(session.durationMs)} accent="text-blue-400" />
        <StatCard label="Energie" value={formatEnergy(session.energyWh)} accent="text-green-400" />
        <StatCard label="SOC" value={session.estimatedSoc != null ? `${session.estimatedSoc}%` : '-'} />
        <StatCard label="Profil" value={session.profileName ?? '-'} />
        <StatCard label="Plug" value={session.plugName ?? session.plugId} />
        <div className="bg-neutral-900 rounded-lg p-4 border border-neutral-800">
          <div className="text-xs text-neutral-500 mb-1">Status</div>
          <span className={`inline-block px-2 py-0.5 rounded text-sm font-medium ${stateColor}`}>
            {stateLabel}
          </span>
        </div>
      </div>

      {/* Power curve chart */}
      <div>
        <h2 className="text-sm font-medium text-neutral-400 mb-3">Ladekurve</h2>
        {sessionChartData.length > 0 ? (
          <PowerChart
            plugId={`session-${sessionId}`}
            initialData={sessionChartData}
            referenceData={refChartData}
            height="400px"
            initialWindow="max"
          />
        ) : (
          <div className="bg-neutral-900 rounded-lg p-8 border border-neutral-800 text-center">
            <p className="text-sm text-neutral-500">Keine Messdaten fuer diese Session vorhanden.</p>
          </div>
        )}
      </div>

      {/* Ereignis-Log (event timeline) */}
      <div>
        <h2 className="text-sm font-medium text-neutral-400 mb-3">Ereignis-Log</h2>
        {session.events.length > 0 ? (
          <div className="bg-neutral-900 rounded-lg p-4 border border-neutral-800">
            <div className="relative">
              {session.events.map((event, idx) => {
                const dotColor = STATE_DOT_COLORS[event.state] ?? 'bg-neutral-500';
                const badgeColor = STATE_COLORS[event.state] ?? 'bg-neutral-700 text-neutral-300';
                const label = STATE_LABELS[event.state] ?? event.state;
                const isLast = idx === session.events.length - 1;

                return (
                  <div key={idx} className="flex gap-4">
                    {/* Timeline column */}
                    <div className="flex flex-col items-center">
                      <div className={`w-3 h-3 rounded-full ${dotColor} mt-1 shrink-0`} />
                      {!isLast && <div className="w-0.5 flex-1 bg-neutral-700 my-1" />}
                    </div>

                    {/* Content */}
                    <div className={`pb-4 ${isLast ? '' : ''}`}>
                      <div className="flex items-center gap-3">
                        <span className="text-xs font-mono text-neutral-500">
                          {formatTime(event.timestamp)}
                        </span>
                        <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${badgeColor}`}>
                          {label}
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="bg-neutral-900 rounded-lg p-8 border border-neutral-800 text-center">
            <p className="text-sm text-neutral-500">Keine Ereignisse aufgezeichnet.</p>
          </div>
        )}
      </div>
    </div>
  );
}
