'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { ProfileForm, type ProfileFormValues } from '@/components/charging/profile-form';
import { PowerChart } from '@/components/charts/power-chart';

type Plug = {
  id: string;
  name: string | null;
  shellyDeviceId: string;
  ipAddress: string | null;
};

type LearnStatus = {
  sessionId: number;
  plugId: string;
  profileId: number;
  state: string;
  startedAt: number;
  durationMs: number;
  readingCount: number;
  latestPower: number;
  cumulativeWh: number;
};

type LearnWizardProps = {
  initialProfileId?: string;
  initialPlugId?: string;
};

export function LearnWizard({ initialProfileId, initialPlugId }: LearnWizardProps) {
  const router = useRouter();
  const [step, setStep] = useState(1);
  const [profileValues, setProfileValues] = useState<ProfileFormValues | null>(null);
  const [plugs, setPlugs] = useState<Plug[]>([]);
  const [selectedPlugId, setSelectedPlugId] = useState<string | null>(initialPlugId ?? null);
  const [batteryConfirmed, setBatteryConfirmed] = useState(false);
  const [createdProfileId, setCreatedProfileId] = useState<number | null>(
    initialProfileId ? parseInt(initialProfileId, 10) : null
  );
  const [sessionId, setSessionId] = useState<number | null>(null);
  const [learnStatus, setLearnStatus] = useState<LearnStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showComplete, setShowComplete] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTimeRef = useRef<number>(0);

  // On mount, check for active learning sessions (D-28: browser-close resilience)
  useEffect(() => {
    async function checkActive() {
      try {
        const res = await fetch('/api/charging/learn/status');
        if (res.ok) {
          const sessions: LearnStatus[] = await res.json();
          const active = sessions.find(
            (s) => s.state === 'learning' || s.state === 'learn_complete'
          );
          if (active) {
            setCreatedProfileId(active.profileId);
            setSelectedPlugId(active.plugId);
            setSessionId(active.sessionId);
            setLearnStatus(active);
            startTimeRef.current = active.startedAt;
            setStep(4);
            if (active.state === 'learn_complete') {
              setShowComplete(true);
            }
          }
        }
      } catch {
        // Ignore
      }
    }
    checkActive();
  }, []);

  // Load plugs for step 2
  useEffect(() => {
    if (step === 2) {
      fetch('/api/devices')
        .then((res) => res.json())
        .then((data) => setPlugs(Array.isArray(data) ? data : []))
        .catch(() => setPlugs([]));
    }
  }, [step]);

  // Poll learn status during step 4
  useEffect(() => {
    if (step === 4 && !showComplete) {
      const poll = async () => {
        try {
          const res = await fetch('/api/charging/learn/status');
          if (res.ok) {
            const sessions: LearnStatus[] = await res.json();
            const active = sessions.find(
              (s) =>
                (s.state === 'learning' || s.state === 'learn_complete') &&
                s.plugId === selectedPlugId
            );
            if (active) {
              setLearnStatus(active);
              if (active.state === 'learn_complete') {
                setShowComplete(true);
              }
            }
          }
        } catch {
          // Ignore poll errors
        }
      };

      poll();
      pollRef.current = setInterval(poll, 5000);

      return () => {
        if (pollRef.current) clearInterval(pollRef.current);
      };
    }
  }, [step, selectedPlugId, showComplete]);

  // Step 1 submit: create profile
  const handleProfileSubmit = useCallback(async (values: ProfileFormValues) => {
    setProfileValues(values);

    // Create profile if not re-learning
    if (!createdProfileId) {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch('/api/profiles', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(values),
        });
        if (res.ok) {
          const created = await res.json();
          setCreatedProfileId(created.id);
        } else {
          const err = await res.json();
          setError(err.message || err.error || 'Fehler beim Erstellen');
          setLoading(false);
          return;
        }
      } catch {
        setError('Netzwerkfehler');
        setLoading(false);
        return;
      }
      setLoading(false);
    }

    setStep(2);
  }, [createdProfileId]);

  // Step 3 -> 4: Start learning
  async function startLearning() {
    if (!selectedPlugId || !createdProfileId) return;

    setLoading(true);
    setError(null);

    try {
      const res = await fetch('/api/charging/learn/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plugId: selectedPlugId, profileId: createdProfileId }),
      });

      if (res.ok) {
        const data = await res.json();
        setSessionId(data.sessionId);
        startTimeRef.current = Date.now();
        setStep(4);
      } else {
        const err = await res.json();
        setError(err.message || err.error || 'Fehler beim Starten');
      }
    } catch {
      setError('Netzwerkfehler');
    }

    setLoading(false);
  }

  // Stop learning (save or discard)
  async function stopLearning(action: 'save' | 'discard') {
    if (!selectedPlugId) return;

    setLoading(true);
    try {
      const res = await fetch('/api/charging/learn/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plugId: selectedPlugId, action }),
      });

      if (res.ok) {
        if (action === 'save' && createdProfileId) {
          router.push(`/profiles/${createdProfileId}`);
        } else {
          router.push('/profiles');
        }
      } else {
        const err = await res.json();
        setError(err.message || err.error || 'Fehler');
      }
    } catch {
      setError('Netzwerkfehler');
    }
    setLoading(false);
  }

  function formatDuration(ms: number): string {
    const totalSec = Math.floor(ms / 1000);
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    return `${min}:${sec.toString().padStart(2, '0')}`;
  }

  return (
    <div className="max-w-2xl">
      {/* Step indicator */}
      <div className="flex items-center gap-2 mb-6">
        {[1, 2, 3, 4].map((s) => (
          <div key={s} className="flex items-center gap-2">
            <div
              className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-medium ${
                s === step
                  ? 'bg-blue-500 text-white'
                  : s < step
                  ? 'bg-blue-500/20 text-blue-400'
                  : 'bg-neutral-800 text-neutral-500'
              }`}
            >
              {s}
            </div>
            {s < 4 && <div className="w-8 h-px bg-neutral-700" />}
          </div>
        ))}
        <span className="ml-2 text-xs text-neutral-500">Schritt {step} von 4</span>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-500/10 border border-red-500/30 rounded text-sm text-red-300">
          {error}
        </div>
      )}

      {/* Step 1: Device name + profile form */}
      {step === 1 && (
        <div className="bg-neutral-900 rounded-lg p-6">
          <h2 className="text-lg font-semibold text-neutral-100 mb-4">Geraetename</h2>
          <ProfileForm
            initialValues={profileValues ?? undefined}
            onSubmit={handleProfileSubmit}
            submitLabel="Weiter"
            disabled={loading}
          />
        </div>
      )}

      {/* Step 2: Select plug */}
      {step === 2 && (
        <div className="bg-neutral-900 rounded-lg p-6">
          <h2 className="text-lg font-semibold text-neutral-100 mb-4">
            Shelly Plug auswaehlen
          </h2>
          {plugs.length === 0 ? (
            <p className="text-neutral-400 text-sm">
              Keine Shelly Plugs registriert. Registriere zuerst einen Plug unter Geraete.
            </p>
          ) : (
            <div className="grid gap-2">
              {plugs.map((plug) => (
                <button
                  key={plug.id}
                  onClick={() => setSelectedPlugId(plug.id)}
                  className={`text-left p-3 rounded-lg border transition-colors ${
                    selectedPlugId === plug.id
                      ? 'border-blue-500 bg-blue-500/10'
                      : 'border-neutral-700 bg-neutral-800 hover:border-neutral-600'
                  }`}
                >
                  <div className="text-sm font-medium text-neutral-100">
                    {plug.name || plug.shellyDeviceId}
                  </div>
                  <div className="text-xs text-neutral-500">
                    {plug.ipAddress || plug.id}
                  </div>
                </button>
              ))}
            </div>
          )}

          <div className="flex gap-2 mt-4">
            <button
              onClick={() => setStep(1)}
              className="px-4 py-2 text-sm rounded bg-neutral-800 text-neutral-300 hover:bg-neutral-700 transition-colors"
            >
              Zurueck
            </button>
            <button
              onClick={() => setStep(3)}
              disabled={!selectedPlugId}
              className="px-4 py-2 text-sm rounded bg-blue-500 text-white hover:bg-blue-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Weiter
            </button>
          </div>
        </div>
      )}

      {/* Step 3: Battery hint */}
      {step === 3 && (
        <div className="bg-neutral-900 rounded-lg p-6">
          <h2 className="text-lg font-semibold text-neutral-100 mb-4">Hinweis</h2>

          <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-lg p-4 mb-4">
            <p className="text-sm text-yellow-200">
              Akku moeglichst leer? Fuer ein genaues Profil sollte der Akku vor dem Anlernen
              moeglichst leer sein. Schliesse das Ladegeraet an den Shelly Plug an und
              verbinde den Akku.
            </p>
          </div>

          <label className="flex items-center gap-2 mb-4 cursor-pointer">
            <input
              type="checkbox"
              checked={batteryConfirmed}
              onChange={(e) => setBatteryConfirmed(e.target.checked)}
              className="accent-blue-500"
            />
            <span className="text-sm text-neutral-300">Ja, Akku ist leer</span>
          </label>

          <div className="flex gap-2">
            <button
              onClick={() => setStep(2)}
              className="px-4 py-2 text-sm rounded bg-neutral-800 text-neutral-300 hover:bg-neutral-700 transition-colors"
            >
              Zurueck
            </button>
            <button
              onClick={startLearning}
              disabled={!batteryConfirmed || loading}
              className="px-4 py-2 text-sm rounded bg-blue-500 text-white hover:bg-blue-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? 'Starte...' : 'Aufnahme starten'}
            </button>
          </div>
        </div>
      )}

      {/* Step 4: Live recording */}
      {step === 4 && selectedPlugId && (
        <div className="space-y-4">
          <div className="bg-neutral-900 rounded-lg p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-neutral-100">Aufnahme</h2>
              {!showComplete && (
                <span className="flex items-center gap-2 text-xs text-green-400">
                  <span className="relative flex h-2.5 w-2.5">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
                    <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-green-500" />
                  </span>
                  Ladevorgang aktiv
                </span>
              )}
            </div>

            {/* Stats */}
            <div className="grid grid-cols-3 gap-4 mb-4">
              <div className="bg-neutral-800 rounded p-3">
                <div className="text-xs text-neutral-500">Energie</div>
                <div className="text-lg font-mono text-neutral-100">
                  {(learnStatus?.cumulativeWh ?? 0).toFixed(1)} Wh
                </div>
              </div>
              <div className="bg-neutral-800 rounded p-3">
                <div className="text-xs text-neutral-500">Dauer</div>
                <div className="text-lg font-mono text-neutral-100">
                  {formatDuration(learnStatus?.durationMs ?? 0)}
                </div>
              </div>
              <div className="bg-neutral-800 rounded p-3">
                <div className="text-xs text-neutral-500">Leistung</div>
                <div className="text-lg font-mono text-neutral-100">
                  {(learnStatus?.latestPower ?? 0).toFixed(1)} W
                </div>
              </div>
            </div>

            {/* Live chart */}
            <PowerChart plugId={selectedPlugId} height="250px" />
          </div>

          {/* Complete dialog (D-27) */}
          {showComplete && (
            <div className="bg-green-500/10 border border-green-500/30 rounded-lg p-4">
              <h3 className="text-sm font-semibold text-green-300 mb-2">
                Ladevorgang abgeschlossen
              </h3>
              <p className="text-sm text-neutral-300 mb-3">
                Profil speichern?
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() => stopLearning('save')}
                  disabled={loading}
                  className="px-4 py-2 text-sm rounded bg-green-500 text-white hover:bg-green-600 transition-colors disabled:opacity-50"
                >
                  {loading ? 'Speichere...' : 'Speichern'}
                </button>
                <button
                  onClick={() => stopLearning('discard')}
                  disabled={loading}
                  className="px-4 py-2 text-sm rounded bg-neutral-800 text-neutral-300 hover:bg-neutral-700 transition-colors disabled:opacity-50"
                >
                  Verwerfen
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
