'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { ProfileForm, type ProfileFormValues } from '@/components/charging/profile-form';
import { SocButtons } from '@/components/charging/soc-buttons';
import { PowerChart } from '@/components/charts/power-chart';

type ProfileData = {
  id: number;
  name: string;
  description: string | null;
  modelName: string | null;
  purchaseDate: string | null;
  estimatedCycles: number | null;
  targetSoc: number;
  hasCurve: boolean;
  curve: {
    id: number;
    startPower: number;
    peakPower: number;
    totalEnergyWh: number;
    durationSeconds: number;
    pointCount: number;
  } | null;
};

type CurvePoint = {
  offsetSeconds: number;
  apower: number;
  voltage: number | null;
  current: number | null;
  cumulativeWh: number;
};

export default function ProfileDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const profileId = params.id;

  const [profile, setProfile] = useState<ProfileData | null>(null);
  const [curveData, setCurveData] = useState<Array<[number, number]>>([]);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [loading, setLoading] = useState(true);

  const loadProfile = useCallback(async () => {
    const res = await fetch(`/api/profiles/${profileId}`);
    if (res.ok) {
      const data = await res.json();
      setProfile(data);
    }
  }, [profileId]);

  const loadCurve = useCallback(async () => {
    const res = await fetch(`/api/profiles/${profileId}/curve`);
    if (res.ok) {
      const data = await res.json();
      // Convert curve points to [time, watts] for PowerChart
      // Use offsetSeconds as relative timestamps (base = 0)
      const baseTime = Date.now();
      const chartData: Array<[number, number]> = (data.points as CurvePoint[]).map(
        (pt) => [baseTime + pt.offsetSeconds * 1000, pt.apower]
      );
      setCurveData(chartData);
    }
  }, [profileId]);

  useEffect(() => {
    Promise.all([loadProfile(), loadCurve()]).finally(() => setLoading(false));
  }, [loadProfile, loadCurve]);

  async function handleSocChange(soc: number) {
    if (!profile) return;
    setSaving(true);
    await fetch(`/api/profiles/${profileId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetSoc: soc }),
    });
    setProfile({ ...profile, targetSoc: soc });
    setSaving(false);
  }

  async function handleEditSubmit(values: ProfileFormValues) {
    setSaving(true);
    const res = await fetch(`/api/profiles/${profileId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(values),
    });
    if (res.ok) {
      await loadProfile();
      setEditing(false);
    }
    setSaving(false);
  }

  async function handleDelete() {
    await fetch(`/api/profiles/${profileId}`, { method: 'DELETE' });
    router.push('/profiles');
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <span className="text-neutral-400 text-sm">Laden...</span>
      </div>
    );
  }

  if (!profile) {
    return (
      <div className="text-center py-12">
        <p className="text-neutral-400">Profil nicht gefunden.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-neutral-100">{profile.name}</h1>
        <div className="flex gap-2">
          <button
            onClick={() => setEditing(!editing)}
            className="px-3 py-1.5 text-sm rounded bg-neutral-800 text-neutral-300 hover:bg-neutral-700 transition-colors"
          >
            {editing ? 'Abbrechen' : 'Bearbeiten'}
          </button>
          <button
            onClick={() => setConfirmDelete(true)}
            className="px-3 py-1.5 text-sm rounded bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-colors"
          >
            Loeschen
          </button>
        </div>
      </div>

      {/* Delete confirmation */}
      {confirmDelete && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-4">
          <p className="text-sm text-red-300 mb-3">
            Profil &quot;{profile.name}&quot; wirklich loeschen? Alle Referenzkurven und SOC-Daten gehen verloren.
          </p>
          <div className="flex gap-2">
            <button
              onClick={handleDelete}
              className="px-3 py-1.5 text-sm rounded bg-red-500 text-white hover:bg-red-600 transition-colors"
            >
              Endgueltig loeschen
            </button>
            <button
              onClick={() => setConfirmDelete(false)}
              className="px-3 py-1.5 text-sm rounded bg-neutral-800 text-neutral-300 hover:bg-neutral-700 transition-colors"
            >
              Abbrechen
            </button>
          </div>
        </div>
      )}

      {/* Attributes / Edit form */}
      <div className="bg-neutral-900 rounded-lg p-4">
        <h2 className="text-sm font-medium text-neutral-400 mb-3">Attribute</h2>
        {editing ? (
          <ProfileForm
            initialValues={{
              name: profile.name,
              description: profile.description ?? '',
              modelName: profile.modelName ?? '',
              purchaseDate: profile.purchaseDate ?? '',
              estimatedCycles: profile.estimatedCycles,
            }}
            onSubmit={handleEditSubmit}
            submitLabel="Speichern"
            disabled={saving}
          />
        ) : (
          <dl className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <dt className="text-neutral-500">Name</dt>
              <dd className="text-neutral-100">{profile.name}</dd>
            </div>
            <div>
              <dt className="text-neutral-500">Modell</dt>
              <dd className="text-neutral-100">{profile.modelName || '--'}</dd>
            </div>
            <div>
              <dt className="text-neutral-500">Beschreibung</dt>
              <dd className="text-neutral-100">{profile.description || '--'}</dd>
            </div>
            <div>
              <dt className="text-neutral-500">Kaufdatum</dt>
              <dd className="text-neutral-100">{profile.purchaseDate || '--'}</dd>
            </div>
            <div>
              <dt className="text-neutral-500">Geschaetzte Zyklen</dt>
              <dd className="text-neutral-100">{profile.estimatedCycles ?? '--'}</dd>
            </div>
          </dl>
        )}
      </div>

      {/* Target SOC */}
      <div className="bg-neutral-900 rounded-lg p-4">
        <h2 className="text-sm font-medium text-neutral-400 mb-3">Ziel-SOC</h2>
        <SocButtons value={profile.targetSoc} onChange={handleSocChange} disabled={saving} />
      </div>

      {/* Reference curve */}
      <div className="bg-neutral-900 rounded-lg p-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-medium text-neutral-400">Referenzkurve</h2>
          <a
            href={`/profiles/learn?profileId=${profile.id}`}
            className="text-xs text-blue-400 hover:text-blue-300 transition-colors"
          >
            Neu anlernen
          </a>
        </div>

        {profile.hasCurve && profile.curve ? (
          <div className="space-y-3">
            <div className="grid grid-cols-3 gap-3 text-sm">
              <div>
                <span className="text-neutral-500">Dauer: </span>
                <span className="text-neutral-100">
                  {Math.floor(profile.curve.durationSeconds / 60)} min
                </span>
              </div>
              <div>
                <span className="text-neutral-500">Energie: </span>
                <span className="text-neutral-100">
                  {profile.curve.totalEnergyWh.toFixed(1)} Wh
                </span>
              </div>
              <div>
                <span className="text-neutral-500">Datenpunkte: </span>
                <span className="text-neutral-100">{profile.curve.pointCount}</span>
              </div>
            </div>

            {curveData.length > 0 && (
              <PowerChart
                plugId={`profile-${profile.id}`}
                initialData={curveData}
                height="250px"
              />
            )}
          </div>
        ) : (
          <p className="text-sm text-neutral-500">
            Noch keine Referenzkurve aufgezeichnet.{' '}
            <a href={`/profiles/learn?profileId=${profile.id}`} className="text-blue-400 hover:text-blue-300">
              Jetzt anlernen
            </a>
          </p>
        )}
      </div>
    </div>
  );
}
