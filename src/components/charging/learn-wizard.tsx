'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { ProfileForm, type ProfileFormValues } from '@/components/charging/profile-form';
import { PowerChart } from '@/components/charts/power-chart';
import { formatDuration, formatEnergy } from '@/lib/format';

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
  startPower: number;
  avgPower: number;
  maxPower: number;
};

type ProfileData = {
  id: number;
  name: string;
  description: string | null;
  manufacturer: string | null;
  modelName: string | null;
  articleNumber: string | null;
  gtin: string | null;
  capacityWh: number | null;
  weightGrams: number | null;
  purchaseDate: string | null;
  estimatedCycles: number | null;
  productUrl: string | null;
  documentUrl: string | null;
  priceEur: number | null;
  targetSoc: number;
};

type LearnWizardProps = {
  initialProfileId?: string;
  initialPlugId?: string;
};

export function LearnWizard({ initialProfileId, initialPlugId }: LearnWizardProps) {
  const router = useRouter();
  // Re-learn flow: when an existing profileId is passed (and no active plug
  // session to resume), skip step 1 (profile form) and jump straight to
  // step 2 (plug selection). The profile already exists; we only need a
  // new reference curve for it.
  const isRelearn = !!initialProfileId && !initialPlugId;
  const [step, setStep] = useState<number>(isRelearn ? 2 : 1);
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
  const [autoSaving, setAutoSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<{ curveId: number; totalEnergyWh: number; durationSeconds: number } | null>(null);
  const [historicalData, setHistoricalData] = useState<Array<[number, number]> | undefined>(undefined);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTimeRef = useRef<number>(0);
  const autoSaveTriggeredRef = useRef(false);

  // Profile details for inline editing during step 4
  const [profileData, setProfileData] = useState<ProfileData | null>(null);
  const [editingProfile, setEditingProfile] = useState(false);
  const [savingProfile, setSavingProfile] = useState(false);

  const [activeSessions, setActiveSessions] = useState<LearnStatus[]>([]);

  // Load profile data when we have a profileId
  const loadProfileData = useCallback(async (pid: number) => {
    try {
      const res = await fetch(`/api/profiles/${pid}`);
      if (res.ok) {
        setProfileData(await res.json());
      }
    } catch { /* ignore */ }
  }, []);

  // On mount, check for active learning sessions (browser-close resilience)
  useEffect(() => {
    async function checkActive() {
      try {
        const res = await fetch('/api/charging/learn/status');
        if (res.ok) {
          const sessions: LearnStatus[] = await res.json();
          setActiveSessions(sessions);

          if (initialPlugId) {
            const mySession = sessions.find(
              (s) => s.plugId === initialPlugId && (s.state === 'learning' || s.state === 'learn_complete')
            );
            if (mySession) {
              setCreatedProfileId(mySession.profileId);
              setSelectedPlugId(mySession.plugId);
              setSessionId(mySession.sessionId);
              setLearnStatus(mySession);
              startTimeRef.current = mySession.startedAt;
              setStep(4);
              loadProfileData(mySession.profileId);
              if (mySession.state === 'learn_complete') {
                setShowComplete(true);
              }
            }
          }
        }
      } catch { /* ignore */ }
    }
    checkActive();
  }, [initialPlugId, loadProfileData]);

  // Re-learn flow: when entering with an existing profileId (and no active
  // plug session), preload profile data so step 2 can show which profile
  // the new reference curve will be attached to.
  useEffect(() => {
    if (isRelearn && createdProfileId && !profileData) {
      loadProfileData(createdProfileId);
    }
  }, [isRelearn, createdProfileId, profileData, loadProfileData]);

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
    if (step === 4 && !saveResult) {
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
        } catch { /* ignore */ }
      };

      poll();
      pollRef.current = setInterval(poll, 2000);

      return () => {
        if (pollRef.current) clearInterval(pollRef.current);
      };
    }
  }, [step, selectedPlugId, saveResult]);

  // Auto-save when learn_complete is detected
  useEffect(() => {
    if (showComplete && !autoSaveTriggeredRef.current && selectedPlugId) {
      autoSaveTriggeredRef.current = true;
      setAutoSaving(true);

      (async () => {
        try {
          const res = await fetch('/api/charging/learn/stop', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ plugId: selectedPlugId, action: 'save' }),
          });

          if (res.ok) {
            const data = await res.json();
            setSaveResult({
              curveId: data.curveId,
              totalEnergyWh: data.totalEnergyWh,
              durationSeconds: data.durationSeconds,
            });
          } else {
            const err = await res.json();
            setError(err.message || err.error || 'Fehler beim automatischen Speichern');
          }
        } catch {
          setError('Netzwerkfehler beim Speichern');
        }
        setAutoSaving(false);
      })();
    }
  }, [showComplete, selectedPlugId]);

  // Load historical readings when entering step 4
  useEffect(() => {
    if (step === 4 && selectedPlugId && !historicalData) {
      async function loadHistory() {
        try {
          const since = startTimeRef.current || learnStatus?.startedAt || 0;
          const res = await fetch(`/api/devices/${encodeURIComponent(selectedPlugId!)}/readings?since=${since}`);
          if (res.ok) {
            const data = await res.json();
            if (data.readings && Array.isArray(data.readings) && data.readings.length > 0) {
              setHistoricalData(data.readings as Array<[number, number]>);
            }
          }
        } catch { /* ignore */ }
      }
      loadHistory();
    }
  }, [step, selectedPlugId, historicalData]);

  // Load profile data when entering step 4
  useEffect(() => {
    if (step === 4 && createdProfileId && !profileData) {
      loadProfileData(createdProfileId);
    }
  }, [step, createdProfileId, profileData, loadProfileData]);

  // Step 1 submit: create profile
  const handleProfileSubmit = useCallback(async (values: ProfileFormValues) => {
    setProfileValues(values);

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

  // Inline profile update during step 4
  async function handleInlineProfileSave(values: ProfileFormValues) {
    if (!createdProfileId) return;
    setSavingProfile(true);
    try {
      const res = await fetch(`/api/profiles/${createdProfileId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values),
      });
      if (res.ok) {
        await loadProfileData(createdProfileId);
        setEditingProfile(false);
      }
    } catch { /* ignore */ }
    setSavingProfile(false);
  }

  return (
    <div>
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

      {/* Active learning sessions banner */}
      {activeSessions.length > 0 && step < 4 && (
        <div className="mb-4 p-3 bg-blue-500/10 border border-blue-500/30 rounded">
          <div className="text-sm font-medium text-blue-300 mb-2">
            {activeSessions.length} aktive{activeSessions.length === 1 ? 'r' : ''} Lernvorgang{activeSessions.length !== 1 ? 'e' : ''}
          </div>
          <div className="flex flex-wrap gap-2">
            {activeSessions.map((s) => (
              <a
                key={s.sessionId}
                href={`/profiles/learn?plugId=${s.plugId}`}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-blue-500/20 rounded text-xs text-blue-300 hover:bg-blue-500/30 transition-colors"
              >
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" />
                </span>
                {s.plugId.replace('shellyplugsg3-', '')} — {formatEnergy(s.cumulativeWh)} — {formatDuration(s.durationMs)}
              </a>
            ))}
          </div>
        </div>
      )}

      {error && (
        <div className="mb-4 p-3 bg-red-500/10 border border-red-500/30 rounded text-sm text-red-300">
          {error}
        </div>
      )}

      {/* Re-learn banner: shown whenever we entered with an existing profile
          (i.e. the user clicked "Neu anlernen" on a profile detail page). */}
      {isRelearn && step < 4 && (
        <div className="mb-4 p-3 bg-yellow-500/10 border border-yellow-500/30 rounded">
          <div className="text-sm font-medium text-yellow-200">
            Referenzkurve{profileData?.name ? ` für „${profileData.name}"` : ''} neu aufnehmen
          </div>
          <p className="text-xs text-yellow-200/80 mt-1">
            Das bestehende Profil bleibt erhalten — nur die Referenzkurve wird ersetzt.
          </p>
        </div>
      )}

      {/* Step 1: Device name + profile form */}
      {step === 1 && (
        <div className="bg-neutral-900 rounded-lg p-6">
          <h2 className="text-lg font-semibold text-neutral-100 mb-4">Gerätename</h2>
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
            Shelly Plug auswählen
          </h2>
          {(() => {
            const busyPlugIds = new Set(activeSessions.map((s) => s.plugId));
            const availablePlugs = plugs.filter((p) => !busyPlugIds.has(p.id));
            return availablePlugs.length === 0 && plugs.length > 0 ? (
              <p className="text-neutral-400 text-sm">
                Alle Plugs haben bereits aktive Lernvorgänge. Warte bis einer abgeschlossen ist oder nutze einen weiteren Plug.
              </p>
            ) : availablePlugs.length === 0 ? (
            <p className="text-neutral-400 text-sm">
              Keine Shelly Plugs registriert. Registriere zuerst einen Plug unter Geräte.
            </p>
          ) : (
            <div className="grid gap-2">
              {availablePlugs.map((plug) => (
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
          );
          })()}

          <div className="flex gap-2 mt-4">
            <button
              onClick={() => {
                // In re-learn mode there is no step 1 (profile form) to go
                // back to — send the user back to the profile detail page.
                if (isRelearn && createdProfileId) {
                  router.push(`/profiles/${createdProfileId}`);
                } else {
                  setStep(1);
                }
              }}
              className="px-4 py-2 text-sm rounded bg-neutral-800 text-neutral-300 hover:bg-neutral-700 transition-colors"
            >
              {isRelearn ? 'Abbrechen' : 'Zurück'}
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
              Akku möglichst leer? Für ein genaues Profil sollte der Akku vor dem Anlernen
              möglichst leer sein. Schließe das Ladegerät an den Shelly Plug an und
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
              Zurück
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

      {/* Step 4: Live recording + inline profile details */}
      {step === 4 && selectedPlugId && (
        <div className="space-y-4">
          <div className="bg-neutral-900 rounded-lg p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-neutral-100">Aufnahme</h2>
              {autoSaving ? (
                <span className="flex items-center gap-2 text-xs text-yellow-400">
                  <span className="animate-spin h-3 w-3 border-2 border-yellow-400 border-t-transparent rounded-full" />
                  Speichere Profil...
                </span>
              ) : saveResult ? (
                <span className="flex items-center gap-2 text-xs text-green-400">
                  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M20 6L9 17l-5-5"/></svg>
                  Profil gespeichert
                </span>
              ) : !showComplete ? (
                <span className="flex items-center gap-2 text-xs text-green-400">
                  <span className="relative flex h-2.5 w-2.5">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
                    <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-green-500" />
                  </span>
                  Ladevorgang aktiv
                </span>
              ) : null}
            </div>

            {/* Stats */}
            <div className="grid grid-cols-3 md:grid-cols-6 gap-3 mb-4">
              <div className="bg-neutral-800 rounded p-3">
                <div className="text-xs text-neutral-500">Aktuell</div>
                <div className="text-lg font-mono text-neutral-100">
                  {(learnStatus?.latestPower ?? 0).toFixed(1)} W
                </div>
              </div>
              <div className="bg-neutral-800 rounded p-3">
                <div className="text-xs text-neutral-500">Max</div>
                <div className="text-lg font-mono text-neutral-100">
                  {(learnStatus?.maxPower ?? 0).toFixed(1)} W
                </div>
              </div>
              <div className="bg-neutral-800 rounded p-3">
                <div className="text-xs text-neutral-500">Start</div>
                <div className="text-lg font-mono text-neutral-100">
                  {(learnStatus?.startPower ?? 0).toFixed(1)} W
                </div>
              </div>
              <div className="bg-neutral-800 rounded p-3">
                <div className="text-xs text-neutral-500">Durchschnitt</div>
                <div className="text-lg font-mono text-neutral-100">
                  {(learnStatus?.avgPower ?? 0).toFixed(1)} W
                </div>
              </div>
              <div className="bg-neutral-800 rounded p-3">
                <div className="text-xs text-neutral-500">Energie</div>
                <div className="text-lg font-mono text-neutral-100">
                  {formatEnergy(learnStatus?.cumulativeWh ?? 0)}
                </div>
              </div>
              <div className="bg-neutral-800 rounded p-3">
                <div className="text-xs text-neutral-500">Dauer</div>
                <div className="text-lg font-mono text-neutral-100">
                  {formatDuration(learnStatus?.durationMs ?? 0)}
                </div>
              </div>
            </div>

            {/* Live chart */}
            <PowerChart plugId={selectedPlugId} height="400px" initialWindow="max" initialData={historicalData} />
          </div>

          {/* Auto-save success banner */}
          {saveResult && (
            <div className="bg-green-500/10 border border-green-500/30 rounded-lg p-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-semibold text-green-300 mb-1">
                    Referenzkurve gespeichert
                  </h3>
                  <p className="text-xs text-neutral-400">
                    {formatEnergy(saveResult.totalEnergyWh)} in {formatDuration(saveResult.durationSeconds * 1000)} aufgezeichnet
                  </p>
                </div>
                <button
                  onClick={() => router.push(`/profiles/${createdProfileId}`)}
                  className="px-4 py-2 text-sm rounded bg-green-500 text-white hover:bg-green-600 transition-colors"
                >
                  Zum Profil
                </button>
              </div>
            </div>
          )}

          {/* Inline profile details panel */}
          {profileData && (
            <div className="bg-neutral-900 rounded-lg p-6">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-sm font-medium text-neutral-400">Geräte-Informationen</h2>
                <button
                  onClick={() => setEditingProfile(!editingProfile)}
                  className="px-3 py-1.5 text-xs rounded bg-neutral-800 text-neutral-300 hover:bg-neutral-700 transition-colors"
                >
                  {editingProfile ? 'Abbrechen' : 'Bearbeiten'}
                </button>
              </div>

              {editingProfile ? (
                <ProfileForm
                  initialValues={{
                    name: profileData.name,
                    description: profileData.description ?? '',
                    manufacturer: profileData.manufacturer ?? '',
                    modelName: profileData.modelName ?? '',
                    articleNumber: profileData.articleNumber ?? '',
                    gtin: profileData.gtin ?? '',
                    capacityWh: profileData.capacityWh,
                    weightGrams: profileData.weightGrams,
                    purchaseDate: profileData.purchaseDate ?? '',
                    estimatedCycles: profileData.estimatedCycles,
                    productUrl: profileData.productUrl ?? '',
                    documentUrl: profileData.documentUrl ?? '',
                    priceEur: profileData.priceEur,
                  }}
                  onSubmit={handleInlineProfileSave}
                  submitLabel="Speichern"
                  disabled={savingProfile}
                />
              ) : (
                <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
                  <ProfileInfoCard label="Name" value={profileData.name} />
                  <ProfileInfoCard label="Hersteller" value={profileData.manufacturer} />
                  <ProfileInfoCard label="Modell" value={profileData.modelName} />
                  <ProfileInfoCard label="Kapazität" value={profileData.capacityWh != null ? `${profileData.capacityWh} Wh` : null} />
                  <ProfileInfoCard label="Geschätzte Zyklen" value={profileData.estimatedCycles != null ? String(profileData.estimatedCycles) : null} />
                  <ProfileInfoCard label="Gewicht" value={profileData.weightGrams != null ? (profileData.weightGrams >= 1000 ? `${(profileData.weightGrams / 1000).toFixed(1)} kg` : `${profileData.weightGrams} g`) : null} />
                  <ProfileInfoCard label="Kaufdatum" value={profileData.purchaseDate ? new Date(profileData.purchaseDate).toLocaleDateString('de-DE') : null} />
                  <ProfileInfoCard label="Preis" value={profileData.priceEur != null ? `${profileData.priceEur.toFixed(2)} €` : null} />
                  <ProfileInfoCard label="Artikelnummer" value={profileData.articleNumber} />
                  <ProfileInfoCard label="GTIN / EAN" value={profileData.gtin} />
                  <ProfileInfoCard label="Ziel-SOC" value={`${profileData.targetSoc}%`} accent />
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ProfileInfoCard({ label, value, accent }: { label: string; value: string | null | undefined; accent?: boolean }) {
  return (
    <div className="bg-neutral-800/50 rounded-lg p-3">
      <div className="text-xs text-neutral-500 mb-0.5">{label}</div>
      <div className={`text-sm truncate ${value ? (accent ? 'text-blue-400 font-medium' : 'text-neutral-100') : 'text-neutral-600 italic'}`}>
        {value || 'Nicht angegeben'}
      </div>
    </div>
  );
}
