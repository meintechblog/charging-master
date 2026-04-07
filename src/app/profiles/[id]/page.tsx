'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';

type SessionSummary = {
  id: number;
  state: string;
  startedAt: number;
  stoppedAt: number | null;
  energyWh: number | null;
  estimatedSoc: number | null;
};
import { ProfileForm, type ProfileFormValues } from '@/components/charging/profile-form';
import { SocButtons } from '@/components/charging/soc-buttons';
import { PowerChart } from '@/components/charts/power-chart';

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
  priceUpdatedAt: number | null;
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
  priceHistory?: Array<{ id: number; priceEur: number; recordedAt: number }>;
};

type CurvePoint = {
  offsetSeconds: number;
  apower: number;
  voltage: number | null;
  current: number | null;
  cumulativeWh: number;
};

// SVG icon components (inline, no dependency)
function IconBolt() {
  return <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>;
}
function IconClock() {
  return <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>;
}
function IconWeight() {
  return <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 3a4 4 0 014 4H8a4 4 0 014-4z"/><path d="M5 7h14l-1.5 14H6.5L5 7z"/></svg>;
}
function IconTag() {
  return <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>;
}
function IconLink() {
  return <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></svg>;
}
function IconFile() {
  return <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14,2 14,8 20,8"/></svg>;
}
function IconEuro() {
  return <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17 5.5A7 7 0 007.1 9H4m0 0h3.1M4 9h13m0 0a7 7 0 01-9.9 8.5M4 15h3.1m0 0A7 7 0 0017 18.5M7.1 15H20"/></svg>;
}
function IconFactory() {
  return <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M2 20h20M4 20V10l4-2v4l4-2v4l4-2v4l4-2v4"/></svg>;
}
function IconBarcode() {
  return <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="4" width="18" height="16" rx="1"/><line x1="7" y1="8" x2="7" y2="16"/><line x1="11" y1="8" x2="11" y2="16"/><line x1="15" y1="8" x2="15" y2="16"/></svg>;
}
function IconCalendar() {
  return <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>;
}
function IconRepeat() {
  return <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 014-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 01-4 4H3"/></svg>;
}
function IconZap() {
  return <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>;
}

type AttrCardProps = {
  icon: React.ReactNode;
  label: string;
  value: string;
  accent?: string;
  href?: string;
};

function AttrCard({ icon, label, value, accent, href }: AttrCardProps) {
  const content = (
    <div className={`bg-neutral-800/50 rounded-lg p-3 flex items-start gap-3 ${href ? 'hover:bg-neutral-800 transition-colors' : ''}`}>
      <div className={`mt-0.5 ${accent ?? 'text-neutral-500'}`}>{icon}</div>
      <div className="min-w-0 flex-1">
        <div className="text-xs text-neutral-500">{label}</div>
        <div className="text-sm text-neutral-100 truncate">{value}</div>
      </div>
    </div>
  );
  if (href) {
    return <a href={href} target="_blank" rel="noopener noreferrer">{content}</a>;
  }
  return content;
}

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
  const [recentSessions, setRecentSessions] = useState<SessionSummary[]>([]);

  const loadSessions = useCallback(async () => {
    try {
      const res = await fetch(`/api/history?profileId=${profileId}&limit=10`);
      if (res.ok) {
        const data = await res.json();
        setRecentSessions(data.sessions ?? []);
      }
    } catch { /* ignore */ }
  }, [profileId]);

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
      const baseTime = Date.now();
      const chartData: Array<[number, number]> = (data.points as CurvePoint[]).map(
        (pt) => [baseTime + pt.offsetSeconds * 1000, pt.apower]
      );
      setCurveData(chartData);
    }
  }, [profileId]);

  useEffect(() => {
    Promise.all([loadProfile(), loadCurve(), loadSessions()]).finally(() => setLoading(false));
  }, [loadProfile, loadCurve, loadSessions]);

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

  // Build attribute cards — only show fields that have values
  const attrs: AttrCardProps[] = [];

  if (profile.manufacturer) {
    attrs.push({ icon: <IconFactory />, label: 'Hersteller', value: profile.manufacturer, accent: 'text-blue-400' });
  }
  if (profile.modelName) {
    attrs.push({ icon: <IconTag />, label: 'Modell', value: profile.modelName, accent: 'text-blue-400' });
  }
  if (profile.capacityWh != null) {
    const capStr = profile.capacityWh >= 1000
      ? `${(profile.capacityWh / 1000).toFixed(2)} kWh`
      : `${profile.capacityWh} Wh`;
    attrs.push({ icon: <IconBolt />, label: 'Akkukapazität', value: capStr, accent: 'text-yellow-400' });
  }
  if (profile.description) {
    attrs.push({ icon: <IconFile />, label: 'Beschreibung', value: profile.description });
  }
  if (profile.articleNumber) {
    attrs.push({ icon: <IconBarcode />, label: 'Artikelnummer', value: profile.articleNumber });
  }
  if (profile.gtin) {
    attrs.push({ icon: <IconBarcode />, label: 'GTIN / EAN', value: profile.gtin });
  }
  if (profile.weightGrams) {
    const weightStr = profile.weightGrams >= 1000
      ? `${(profile.weightGrams / 1000).toFixed(1)} kg`
      : `${profile.weightGrams} g`;
    attrs.push({ icon: <IconWeight />, label: 'Gewicht', value: weightStr });
  }
  if (profile.purchaseDate) {
    attrs.push({ icon: <IconCalendar />, label: 'Kaufdatum', value: new Date(profile.purchaseDate).toLocaleDateString('de-DE') });
  }
  if (profile.estimatedCycles) {
    attrs.push({ icon: <IconRepeat />, label: 'Geschätzte Zyklen', value: String(profile.estimatedCycles) });
  }
  if (profile.priceEur != null) {
    attrs.push({ icon: <IconEuro />, label: 'Preis', value: `${profile.priceEur.toFixed(2)} €`, accent: 'text-green-400' });
  }
  if (profile.productUrl) {
    attrs.push({ icon: <IconLink />, label: 'Produkt-Link', value: profile.productUrl, accent: 'text-blue-400', href: profile.productUrl });
  }
  if (profile.documentUrl) {
    attrs.push({ icon: <IconFile />, label: 'Datenblatt', value: profile.documentUrl, accent: 'text-blue-400', href: profile.documentUrl });
  }

  // Curve stats as hero cards
  const curveStats: AttrCardProps[] = [];
  if (profile.curve) {
    const c = profile.curve;
    const durationMin = Math.floor(c.durationSeconds / 60);
    const durationStr = durationMin >= 60
      ? `${Math.floor(durationMin / 60)}h ${durationMin % 60}min`
      : `${durationMin} min`;
    const energyStr = c.totalEnergyWh >= 1000
      ? `${(c.totalEnergyWh / 1000).toFixed(2)} kWh`
      : `${c.totalEnergyWh.toFixed(1)} Wh`;

    curveStats.push({ icon: <IconZap />, label: 'Startleistung', value: `${c.startPower.toFixed(1)} W`, accent: 'text-yellow-400' });
    curveStats.push({ icon: <IconBolt />, label: 'Spitzenleistung', value: `${c.peakPower.toFixed(1)} W`, accent: 'text-orange-400' });
    curveStats.push({ icon: <IconBolt />, label: 'Energie (AC-seitig)', value: energyStr, accent: 'text-green-400' });
    curveStats.push({ icon: <IconClock />, label: 'Ladedauer', value: durationStr, accent: 'text-blue-400' });
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <Link href="/profiles" className="text-xs text-neutral-500 hover:text-neutral-300 transition-colors">
            ← Profile
          </Link>
          <h1 className="text-2xl font-bold text-neutral-100">{profile.name}</h1>
          {profile.manufacturer && (
            <p className="text-sm text-neutral-400">{profile.manufacturer}{profile.modelName ? ` — ${profile.modelName}` : ''}</p>
          )}
        </div>
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
            Löschen
          </button>
        </div>
      </div>

      {/* Delete confirmation */}
      {confirmDelete && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-4">
          <p className="text-sm text-red-300 mb-3">
            Profil &quot;{profile.name}&quot; wirklich löschen? Alle Referenzkurven und SOC-Daten gehen verloren.
          </p>
          <div className="flex gap-2">
            <button onClick={handleDelete} className="px-3 py-1.5 text-sm rounded bg-red-500 text-white hover:bg-red-600 transition-colors">
              Endgültig löschen
            </button>
            <button onClick={() => setConfirmDelete(false)} className="px-3 py-1.5 text-sm rounded bg-neutral-800 text-neutral-300 hover:bg-neutral-700 transition-colors">
              Abbrechen
            </button>
          </div>
        </div>
      )}

      {/* Curve hero stats */}
      {curveStats.length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {curveStats.map((stat) => (
            <div key={stat.label} className="bg-neutral-900 rounded-lg p-4 border border-neutral-800">
              <div className="flex items-center gap-2 mb-1">
                <span className={stat.accent ?? 'text-neutral-500'}>{stat.icon}</span>
                <span className="text-xs text-neutral-500">{stat.label}</span>
              </div>
              <div className="text-xl font-bold font-mono text-neutral-100">{stat.value}</div>
            </div>
          ))}
        </div>
      )}

      {/* Edit form OR attribute display */}
      {editing ? (
        <div className="bg-neutral-900 rounded-lg p-4">
          <h2 className="text-sm font-medium text-neutral-400 mb-3">Profil bearbeiten</h2>
          <ProfileForm
            initialValues={{
              name: profile.name,
              description: profile.description ?? '',
              manufacturer: profile.manufacturer ?? '',
              modelName: profile.modelName ?? '',
              articleNumber: profile.articleNumber ?? '',
              gtin: profile.gtin ?? '',
              capacityWh: profile.capacityWh,
              weightGrams: profile.weightGrams,
              purchaseDate: profile.purchaseDate ?? '',
              estimatedCycles: profile.estimatedCycles,
              productUrl: profile.productUrl ?? '',
              documentUrl: profile.documentUrl ?? '',
              priceEur: profile.priceEur,
            }}
            onSubmit={handleEditSubmit}
            submitLabel="Speichern"
            disabled={saving}
          />
        </div>
      ) : attrs.length > 0 ? (
        <div className="bg-neutral-900 rounded-lg p-4">
          <h2 className="text-sm font-medium text-neutral-400 mb-3">Details</h2>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
            {attrs.map((attr) => (
              <AttrCard key={attr.label} {...attr} />
            ))}
          </div>
        </div>
      ) : null}

      {/* Target SOC */}
      <div className="bg-neutral-900 rounded-lg p-4">
        <h2 className="text-sm font-medium text-neutral-400 mb-3">Ziel-SOC</h2>
        <SocButtons value={profile.targetSoc} onChange={handleSocChange} disabled={saving} />
      </div>

      {/* Letzte Ladevorgaenge */}
      <div className="bg-neutral-900 rounded-lg p-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-medium text-neutral-400">Letzte Ladevorgaenge</h2>
          <Link href={`/history?profileId=${profile.id}`} className="text-xs text-blue-400 hover:text-blue-300 transition-colors">
            Alle anzeigen
          </Link>
        </div>
        {recentSessions.length > 0 ? (
          <div className="space-y-2">
            {recentSessions.map((s) => {
              const sessionStateColors: Record<string, string> = {
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
              const sessionStateLabels: Record<string, string> = {
                detecting: 'Erkennung', matched: 'Erkannt', charging: 'Laden',
                countdown: 'Countdown', complete: 'Abgeschlossen', error: 'Fehler',
                aborted: 'Abgebrochen', learning: 'Lernen', learn_complete: 'Lernvorgang abgeschlossen',
                stopping: 'Wird gestoppt',
              };
              const badgeColor = sessionStateColors[s.state] ?? 'bg-neutral-700 text-neutral-300';
              const badgeLabel = sessionStateLabels[s.state] ?? s.state;
              const dateStr = new Date(s.startedAt).toLocaleString('de-DE', {
                day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
              });
              const durationStr = (() => {
                const ms = (s.stoppedAt ?? Date.now()) - s.startedAt;
                const totalMin = Math.floor(ms / 60000);
                if (totalMin >= 60) return `${Math.floor(totalMin / 60)}h ${totalMin % 60}min`;
                return `${totalMin} min`;
              })();
              const energyStr = s.energyWh != null
                ? (s.energyWh >= 1000 ? `${(s.energyWh / 1000).toFixed(2)} kWh` : `${s.energyWh.toFixed(1)} Wh`)
                : '-';

              return (
                <Link
                  key={s.id}
                  href={`/history/${s.id}`}
                  className="flex items-center justify-between px-3 py-2 rounded bg-neutral-800/50 hover:bg-neutral-800 transition-colors"
                >
                  <div className="flex items-center gap-3">
                    <span className={`inline-block px-1.5 py-0.5 rounded text-xs font-medium ${badgeColor}`}>
                      {badgeLabel}
                    </span>
                    <span className="text-sm text-neutral-100">{dateStr}</span>
                  </div>
                  <div className="flex items-center gap-4 text-xs text-neutral-400">
                    <span>{durationStr}</span>
                    <span>{energyStr}</span>
                    {s.estimatedSoc != null && <span>{s.estimatedSoc}%</span>}
                  </div>
                </Link>
              );
            })}
          </div>
        ) : (
          <p className="text-sm text-neutral-500">Noch keine Ladevorgaenge fuer dieses Profil.</p>
        )}
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

        {profile.hasCurve && curveData.length > 0 ? (
          <PowerChart
            plugId={`profile-${profile.id}`}
            initialData={curveData}
            height="300px"
            initialWindow="max"
          />
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
