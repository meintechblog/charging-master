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

// CSS-variable state palette so the colours track the global token system.
// `text` is for state-label foreground, `dot` for the status orb / timeline.
const STATE_TOKENS: Record<string, { text: string; dot: string; bg: string }> = {
  detecting: { text: 'var(--color-accent)', dot: 'var(--color-accent)', bg: 'var(--color-accent-soft)' },
  matched: { text: 'var(--color-accent)', dot: 'var(--color-accent)', bg: 'var(--color-accent-soft)' },
  charging: { text: 'var(--color-accent)', dot: 'var(--color-accent)', bg: 'var(--color-accent-soft)' },
  countdown: { text: 'var(--color-warn)', dot: 'var(--color-warn)', bg: 'var(--color-warn-soft)' },
  complete: { text: 'var(--color-ok)', dot: 'var(--color-ok)', bg: 'var(--color-ok-soft)' },
  error: { text: 'var(--color-danger)', dot: 'var(--color-danger)', bg: 'var(--color-danger-soft)' },
  aborted: { text: 'var(--color-danger)', dot: 'var(--color-danger)', bg: 'var(--color-danger-soft)' },
  learning: { text: 'var(--color-warn)', dot: 'var(--color-warn)', bg: 'var(--color-warn-soft)' },
  learn_complete: { text: 'var(--color-ok)', dot: 'var(--color-ok)', bg: 'var(--color-ok-soft)' },
  stopping: { text: 'var(--color-info)', dot: 'var(--color-info)', bg: 'var(--color-info-soft)' },
};

function tokensFor(state: string): { text: string; dot: string; bg: string } {
  return STATE_TOKENS[state] ?? { text: 'var(--color-text-faint)', dot: 'var(--color-text-muted)', bg: 'var(--color-ink-3)' };
}

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
    <div
      className="px-4 py-3"
      style={{
        background: 'var(--color-ink-2)',
        border: '1px solid var(--color-line-soft)',
        borderRadius: 'var(--radius-lg)',
      }}
    >
      <div className="label-eyebrow mb-1.5">{label}</div>
      <div
        className="font-mono-data text-[16px] font-medium leading-tight truncate"
        style={{ color: accent ?? 'var(--color-text-strong)', letterSpacing: '-0.02em' }}
        title={value}
      >
        {value}
      </div>
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
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const NON_TERMINAL = new Set(['detecting', 'matched', 'charging', 'countdown', 'stopping', 'learning']);

    async function tick(initial: boolean) {
      try {
        const res = await fetch(`/api/history/${sessionId}`, { cache: 'no-store' });
        if (!res.ok) {
          if (initial) setError(true);
          return;
        }
        const data: SessionDetail = await res.json();
        if (cancelled) return;
        setSession(data);
        if (NON_TERMINAL.has(data.state)) {
          timer = setTimeout(() => tick(false), 5000);
        }
      } catch {
        if (initial && !cancelled) setError(true);
      } finally {
        if (initial && !cancelled) setLoading(false);
      }
    }

    tick(true);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [sessionId]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="flex items-center gap-3">
          <span className="status-orb status-orb-pulse" style={{ color: 'var(--color-accent)' }} />
          <span className="text-[13px] font-mono uppercase tracking-[0.2em] text-[color:var(--color-text-faint)]">
            laden…
          </span>
        </div>
      </div>
    );
  }

  if (error || !session) {
    return (
      <div className="text-center py-12">
        <div className="label-eyebrow mb-3">Session 404</div>
        <p className="text-[15px] text-[color:var(--color-text-soft)] mb-5">Session nicht gefunden.</p>
        <Link
          href="/history"
          className="inline-flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.18em] transition-colors"
          style={{ color: 'var(--color-accent)' }}
        >
          ← Zurück zur Übersicht
        </Link>
      </div>
    );
  }

  // Build chart data from readings using elapsed time (offset from start)
  const sessionChartData: Array<[number, number]> = session.readings.map((r) => [
    r.offsetMs,
    r.apower,
  ]);

  // Build reference curve data with proper alignment (accounting for curveOffsetSeconds)
  let refChartData: Array<[number, number]> | undefined;
  if (session.referenceCurve && session.referenceCurve.points.length > 0) {
    const offsetMs = (session.referenceCurve.curveOffsetSeconds ?? 0) * 1000;
    refChartData = session.referenceCurve.points.map((p) => [
      p.offsetSeconds * 1000 - offsetMs,
      p.apower,
    ]);
  }

  const stateTokens = tokensFor(session.state);
  const stateLabel = STATE_LABELS[session.state] ?? session.state;
  const isLive = ['detecting', 'matched', 'charging', 'countdown', 'stopping', 'learning'].includes(session.state);

  return (
    <div className="space-y-7">
      {/* Breadcrumb */}
      <Link
        href="/history"
        className="group inline-flex items-center gap-2 text-[11px] font-mono uppercase tracking-[0.18em]"
        style={{ color: 'var(--color-text-faint)' }}
      >
        <span className="transition-transform group-hover:-translate-x-0.5">←</span>
        <span className="group-hover:text-[color:var(--color-text-default)] transition-colors">
          Verlauf
        </span>
      </Link>

      {/* Header — session id (mono), timestamp, state pill */}
      <header className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-baseline gap-3 mb-2">
            <span className="label-eyebrow">Session</span>
            <span
              className="font-mono text-[12px] tabular-nums"
              style={{ color: 'var(--color-text-faint)' }}
            >
              #{session.id.toString().padStart(5, '0')}
            </span>
          </div>
          <h1
            className="text-[28px] sm:text-[34px] font-semibold leading-none tracking-tight text-[color:var(--color-text-strong)]"
            style={{ letterSpacing: '-0.02em' }}
          >
            {formatTimestamp(session.startedAt)}
          </h1>
        </div>
        <div
          className="inline-flex items-center gap-2 px-3 py-1.5"
          style={{
            background: stateTokens.bg,
            border: '1px solid color-mix(in srgb, ' + stateTokens.dot + ' 30%, transparent)',
            borderRadius: 'var(--radius-md)',
          }}
        >
          <span
            className={isLive ? 'status-orb status-orb-pulse' : 'status-orb'}
            style={{ color: stateTokens.dot }}
          />
          <span
            className="font-mono text-[10px] uppercase tracking-[0.18em] font-medium"
            style={{ color: stateTokens.text }}
          >
            {stateLabel}
          </span>
        </div>
      </header>

      {/* Stats grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="Start" value={formatTimestamp(session.startedAt)} />
        <StatCard
          label="Ende"
          value={session.stoppedAt ? formatTimestamp(session.stoppedAt) : 'Aktiv'}
          accent={session.stoppedAt ? undefined : 'var(--color-ok)'}
        />
        <StatCard label="Dauer" value={formatDurationMs(session.durationMs)} accent="var(--color-accent)" />
        <StatCard label="Energie" value={formatEnergy(session.energyWh)} accent="var(--color-ok)" />
        <StatCard label="SoC" value={session.estimatedSoc != null ? `${session.estimatedSoc}%` : '—'} />
        <StatCard label="Profil" value={session.profileName ?? '—'} />
        <StatCard label="Plug" value={session.plugName ?? session.plugId} />
        <StatCard label="Plug-ID" value={session.plugId} accent="var(--color-text-faint)" />
      </div>

      {/* Power curve */}
      <section>
        <div className="flex items-center gap-3 mb-3">
          <span className="font-mono text-[10px] uppercase tracking-[0.2em] font-medium text-[color:var(--color-text-faint)]">
            Ladekurve
          </span>
          {isLive && (
            <span className="inline-flex items-center gap-1.5">
              <span className="status-orb status-orb-pulse" style={{ color: 'var(--color-ok)' }} />
              <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-[color:var(--color-ok)]">
                Live · 5 s
              </span>
            </span>
          )}
          <span className="flex-1 h-px" style={{ background: 'var(--color-line-faint)' }} />
        </div>
        {sessionChartData.length > 0 ? (
          <PowerChart
            plugId={`session-${sessionId}`}
            initialData={sessionChartData}
            referenceData={refChartData}
            height="400px"
            initialWindow="max"
            static
          />
        ) : (
          <div
            className="p-8 text-center"
            style={{
              background: 'var(--color-ink-2)',
              border: '1px solid var(--color-line-soft)',
              borderRadius: 'var(--radius-lg)',
            }}
          >
            <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-[color:var(--color-text-muted)]">
              keine messdaten
            </span>
          </div>
        )}
      </section>

      {/* Event timeline — minimal, mono timestamps, hairline rail */}
      <section>
        <div className="flex items-center gap-3 mb-3">
          <span className="font-mono text-[10px] uppercase tracking-[0.2em] font-medium text-[color:var(--color-text-faint)]">
            Ereignis-Log
          </span>
          <span
            className="font-mono text-[10px] tabular-nums"
            style={{ color: 'var(--color-text-muted)' }}
          >
            {session.events.length.toString().padStart(2, '0')}
          </span>
          <span className="flex-1 h-px" style={{ background: 'var(--color-line-faint)' }} />
        </div>
        {session.events.length > 0 ? (
          <div
            className="p-5"
            style={{
              background: 'var(--color-ink-2)',
              border: '1px solid var(--color-line-soft)',
              borderRadius: 'var(--radius-lg)',
            }}
          >
            <ol className="relative">
              {session.events.map((event, idx) => {
                const ev = tokensFor(event.state);
                const label = STATE_LABELS[event.state] ?? event.state;
                const isLast = idx === session.events.length - 1;

                return (
                  <li key={idx} className="flex gap-4 pb-3 last:pb-0">
                    <div className="flex flex-col items-center w-3">
                      <span
                        className="w-2.5 h-2.5 rounded-full mt-[5px] shrink-0"
                        style={{
                          background: ev.dot,
                          boxShadow: `0 0 8px 0 ${ev.dot}`,
                        }}
                      />
                      {!isLast && (
                        <span
                          className="w-px flex-1 my-1"
                          style={{ background: 'var(--color-line-soft)' }}
                        />
                      )}
                    </div>
                    <div className="flex items-center gap-3 flex-wrap pt-px">
                      <span className="font-mono text-[11px] tabular-nums text-[color:var(--color-text-faint)]">
                        {formatTime(event.timestamp)}
                      </span>
                      <span
                        className="font-mono text-[10px] uppercase tracking-[0.18em] font-medium"
                        style={{ color: ev.text }}
                      >
                        {label}
                      </span>
                    </div>
                  </li>
                );
              })}
            </ol>
          </div>
        ) : (
          <div
            className="p-6 text-center"
            style={{
              background: 'var(--color-ink-2)',
              border: '1px solid var(--color-line-soft)',
              borderRadius: 'var(--radius-lg)',
            }}
          >
            <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-[color:var(--color-text-muted)]">
              keine ereignisse
            </span>
          </div>
        )}
      </section>
    </div>
  );
}
