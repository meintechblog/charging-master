'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense, useState, useEffect } from 'react';
import Link from 'next/link';
import { LearnWizard } from '@/components/charging/learn-wizard';
import { formatDuration, formatEnergy } from '@/lib/format';

type LearnSession = {
  sessionId: number;
  plugId: string;
  profileId: number;
  state: string;
  startedAt: number;
  durationMs: number;
  readingCount: number;
  latestPower: number;
  cumulativeWh: number;
  startPower: number;
  avgPower: number;
  maxPower: number;
};

function LearnOverview() {
  const [sessions, setSessions] = useState<LearnSession[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;

    async function fetch_sessions() {
      try {
        const res = await fetch('/api/charging/learn/status');
        if (res.ok && active) {
          setSessions(await res.json());
        }
      } catch { /* ignore */ }
      if (active) setLoading(false);
    }

    fetch_sessions();
    const interval = setInterval(fetch_sessions, 3000);
    return () => { active = false; clearInterval(interval); };
  }, []);

  const activeSessions = sessions.filter(s => s.state === 'learning');
  const completedSessions = sessions.filter(s => s.state === 'learn_complete');

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-neutral-100">Geräte anlernen</h1>
        <Link
          href="/profiles/learn?new=1"
          className="px-4 py-2 bg-blue-500 text-white text-sm font-medium rounded hover:bg-blue-600 transition-colors"
        >
          + Neuer Lernvorgang
        </Link>
      </div>

      {loading ? (
        <div className="text-sm text-neutral-400">Laden...</div>
      ) : activeSessions.length === 0 && completedSessions.length === 0 ? (
        <div className="bg-neutral-900 rounded-lg border border-neutral-800 p-8 text-center">
          <p className="text-neutral-400 mb-4">Keine aktiven Lernvorgänge</p>
          <Link
            href="/profiles/learn?new=1"
            className="text-blue-400 hover:text-blue-300 underline text-sm"
          >
            Gerät anlernen starten
          </Link>
        </div>
      ) : (
        <div className="space-y-4">
          {/* Active sessions */}
          {activeSessions.length > 0 && (
            <div>
              <h2 className="text-sm font-medium text-neutral-400 mb-3">Aktive Lernvorgänge</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {activeSessions.map(s => (
                  <Link
                    key={s.sessionId}
                    href={`/profiles/learn?plugId=${s.plugId}`}
                    className="bg-neutral-900 rounded-lg border border-neutral-800 p-4 hover:border-blue-500/50 transition-colors block"
                  >
                    <div className="flex items-center justify-between mb-3">
                      <span className="text-sm font-medium text-neutral-100 truncate">
                        {s.plugId.replace('shellyplugsg3-', '')}
                      </span>
                      <span className="flex items-center gap-1.5 text-xs text-green-400">
                        <span className="relative flex h-2 w-2">
                          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
                          <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" />
                        </span>
                        Aktiv
                      </span>
                    </div>
                    <div className="grid grid-cols-3 gap-2 text-xs">
                      <div>
                        <div className="text-neutral-500">Leistung</div>
                        <div className="font-mono text-neutral-200">{s.latestPower.toFixed(1)} W</div>
                      </div>
                      <div>
                        <div className="text-neutral-500">Energie</div>
                        <div className="font-mono text-neutral-200">{formatEnergy(s.cumulativeWh)}</div>
                      </div>
                      <div>
                        <div className="text-neutral-500">Dauer</div>
                        <div className="font-mono text-neutral-200">{formatDuration(s.durationMs)}</div>
                      </div>
                    </div>
                  </Link>
                ))}
              </div>
            </div>
          )}

          {/* Completed sessions waiting for save */}
          {completedSessions.length > 0 && (
            <div>
              <h2 className="text-sm font-medium text-neutral-400 mb-3">Abgeschlossen — Profil speichern?</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {completedSessions.map(s => (
                  <Link
                    key={s.sessionId}
                    href={`/profiles/learn?plugId=${s.plugId}`}
                    className="bg-neutral-900 rounded-lg border border-green-500/30 p-4 hover:border-green-500/50 transition-colors block"
                  >
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-sm font-medium text-neutral-100 truncate">
                        {s.plugId.replace('shellyplugsg3-', '')}
                      </span>
                      <span className="text-xs text-green-400">Fertig</span>
                    </div>
                    <div className="text-xs text-neutral-400">
                      {formatEnergy(s.cumulativeWh)} in {formatDuration(s.durationMs)}
                    </div>
                  </Link>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function LearnContent() {
  const searchParams = useSearchParams();
  const plugId = searchParams.get('plugId') ?? undefined;
  const profileId = searchParams.get('profileId') ?? undefined;
  const isNew = searchParams.get('new') === '1';

  // Show wizard if plugId specified (resume active session),
  // profileId specified (re-learn reference curve for existing profile),
  // or new=1 (start fresh new-device flow).
  if (plugId || profileId || isNew) {
    return (
      <div>
        <div className="flex items-center gap-3 mb-6">
          <Link
            href="/profiles/learn"
            className="text-sm text-neutral-400 hover:text-neutral-200 transition-colors"
          >
            ← Übersicht
          </Link>
          <h1 className="text-2xl font-bold text-neutral-100">Gerät anlernen</h1>
        </div>
        <LearnWizard initialProfileId={profileId} initialPlugId={plugId} />
      </div>
    );
  }

  // Otherwise show overview
  return <LearnOverview />;
}

export default function LearnPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center h-64">
          <span className="text-neutral-400 text-sm">Laden...</span>
        </div>
      }
    >
      <LearnContent />
    </Suspense>
  );
}
