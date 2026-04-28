'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';

type ChargerRow = {
  id: number;
  name: string;
  manufacturer: string | null;
  model: string | null;
  efficiency: number | null;
  maxCurrentA: number | null;
  maxVoltageV: number | null;
  outputType: string | null;
  notes: string | null;
  profileCount: number;
  createdAt: number;
  updatedAt: number;
};

const INPUT_CLASS = 'w-full bg-neutral-800 border border-neutral-700 text-neutral-100 rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-500';
const LABEL_CLASS = 'block text-sm font-medium text-neutral-300 mb-1';

export default function ChargersPage() {
  const [chargers, setChargers] = useState<ChargerRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [manufacturer, setManufacturer] = useState('');
  const [model, setModel] = useState('');
  const [efficiency, setEfficiency] = useState('0.85');
  const [maxCurrentA, setMaxCurrentA] = useState('');
  const [maxVoltageV, setMaxVoltageV] = useState('');
  const [outputType, setOutputType] = useState<'DC' | 'AC'>('DC');
  const [notes, setNotes] = useState('');

  const load = useCallback(async () => {
    const res = await fetch('/api/chargers');
    if (res.ok) {
      const data: { chargers: ChargerRow[] } = await res.json();
      setChargers(data.chargers ?? []);
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  function resetForm() {
    setName(''); setManufacturer(''); setModel('');
    setEfficiency('0.85'); setMaxCurrentA(''); setMaxVoltageV('');
    setOutputType('DC'); setNotes(''); setError(null);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        name: name.trim(),
        manufacturer: manufacturer.trim() || null,
        model: model.trim() || null,
        efficiency: efficiency ? parseFloat(efficiency) : 0.85,
        maxCurrentA: maxCurrentA ? parseFloat(maxCurrentA) : null,
        maxVoltageV: maxVoltageV ? parseFloat(maxVoltageV) : null,
        outputType,
        notes: notes.trim() || null,
      };
      const res = await fetch('/api/chargers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        setError(errBody.message || errBody.error || `Anlegen fehlgeschlagen (${res.status})`);
      } else {
        resetForm();
        setShowForm(false);
        await load();
      }
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: number, hasProfiles: boolean) {
    const msg = hasProfiles
      ? 'Ladegerät löschen? Verknüpfte Profile verlieren die Verknüpfung (Daten bleiben).'
      : 'Ladegerät löschen?';
    if (!confirm(msg)) return;
    await fetch(`/api/chargers/${id}`, { method: 'DELETE' });
    await load();
  }

  return (
    <div className="max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-neutral-100">Ladegeräte</h1>
        <button
          onClick={() => { setShowForm((v) => !v); if (!showForm) resetForm(); }}
          className="px-4 py-2 bg-blue-500 text-white text-sm font-medium rounded hover:bg-blue-600 transition-colors"
        >
          {showForm ? 'Abbrechen' : '+ Neues Ladegerät'}
        </button>
      </div>

      {showForm && (
        <form onSubmit={handleSubmit} className="bg-neutral-900 rounded-lg p-4 md:p-6 mb-6 space-y-4">
          {error && (
            <div className="px-3 py-2 rounded bg-red-500/10 border border-red-500/30 text-sm text-red-300">{error}</div>
          )}
          <div>
            <label className={LABEL_CLASS}>Name *</label>
            <input className={INPUT_CLASS} required value={name} onChange={(e) => setName(e.target.value)} placeholder="z.B. Winbot W3 Dock" disabled={saving} />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className={LABEL_CLASS}>Hersteller</label>
              <input className={INPUT_CLASS} value={manufacturer} onChange={(e) => setManufacturer(e.target.value)} placeholder="z.B. Ecovacs" disabled={saving} />
            </div>
            <div>
              <label className={LABEL_CLASS}>Modell</label>
              <input className={INPUT_CLASS} value={model} onChange={(e) => setModel(e.target.value)} disabled={saving} />
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label className={LABEL_CLASS}>Wirkungsgrad (0–1)</label>
              <input className={INPUT_CLASS} type="number" step="0.01" min={0} max={1} value={efficiency} onChange={(e) => setEfficiency(e.target.value)} disabled={saving} />
            </div>
            <div>
              <label className={LABEL_CLASS}>Max. Spannung (V)</label>
              <input className={INPUT_CLASS} type="number" step="0.1" min={0} value={maxVoltageV} onChange={(e) => setMaxVoltageV(e.target.value)} disabled={saving} />
            </div>
            <div>
              <label className={LABEL_CLASS}>Max. Strom (A)</label>
              <input className={INPUT_CLASS} type="number" step="0.1" min={0} value={maxCurrentA} onChange={(e) => setMaxCurrentA(e.target.value)} disabled={saving} />
            </div>
          </div>
          <div>
            <label className={LABEL_CLASS}>Ausgangstyp</label>
            <div className="flex gap-2">
              {(['DC', 'AC'] as const).map((opt) => (
                <button key={opt} type="button" onClick={() => setOutputType(opt)} disabled={saving}
                  className={`px-3 py-1.5 text-sm rounded ${outputType === opt ? 'bg-blue-500 text-white' : 'bg-neutral-800 text-neutral-300 hover:bg-neutral-700'}`}>
                  {opt}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className={LABEL_CLASS}>Notizen</label>
            <textarea className={INPUT_CLASS} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} disabled={saving} />
          </div>
          <button type="submit" disabled={saving || !name.trim()}
            className="px-4 py-2 bg-blue-500 text-white text-sm font-medium rounded hover:bg-blue-600 disabled:opacity-50">
            {saving ? 'Speichere…' : 'Anlegen'}
          </button>
        </form>
      )}

      {loading ? (
        <p className="text-sm text-neutral-500">Lade…</p>
      ) : chargers.length === 0 ? (
        <div className="bg-neutral-900 rounded-lg p-8 text-center">
          <p className="text-neutral-400 mb-4">Noch keine Ladegeräte angelegt.</p>
          <p className="text-xs text-neutral-500">
            Lege ein Ladegerät einmal an und verknüpfe es in mehreren Profilen — der Wirkungsgrad wird zentral gepflegt.
          </p>
        </div>
      ) : (
        <div className="bg-neutral-900 rounded-lg overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px]">
              <thead>
                <tr className="border-b border-neutral-800 text-left text-xs font-medium text-neutral-400">
                  <th className="px-4 py-3">Name</th>
                  <th className="px-4 py-3">Modell</th>
                  <th className="px-4 py-3">η</th>
                  <th className="px-4 py-3">Max</th>
                  <th className="px-4 py-3">Profile</th>
                  <th className="px-4 py-3 w-20" />
                </tr>
              </thead>
              <tbody>
                {chargers.map((c) => {
                  const max = [c.maxVoltageV ? `${c.maxVoltageV}V` : null, c.maxCurrentA ? `${c.maxCurrentA}A` : null].filter(Boolean).join(' / ');
                  const detail = [c.manufacturer, c.model].filter(Boolean).join(' ');
                  return (
                    <tr key={c.id} className="border-b border-neutral-800 last:border-0 hover:bg-neutral-800/50">
                      <td className="px-4 py-3 text-sm text-neutral-100">{c.name}</td>
                      <td className="px-4 py-3 text-sm text-neutral-400">{detail || '—'}</td>
                      <td className="px-4 py-3 text-sm text-neutral-300">{c.efficiency != null ? `${(c.efficiency * 100).toFixed(0)} %` : '—'}</td>
                      <td className="px-4 py-3 text-sm text-neutral-400">{max || '—'}</td>
                      <td className="px-4 py-3 text-sm">
                        {c.profileCount > 0 ? (
                          <span className="text-blue-400">{c.profileCount}</span>
                        ) : (
                          <span className="text-neutral-600">0</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <button onClick={() => handleDelete(c.id, c.profileCount > 0)} className="text-xs text-neutral-500 hover:text-red-400">
                          Löschen
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <p className="text-xs text-neutral-500 mt-6">
        Verknüpfung erfolgt im Profil unter „Lade-Spec“. Solange ein Profil verknüpft ist, überschreibt der Wirkungsgrad des Ladegeräts den per-Profil-Wert. <Link href="/profiles" className="text-blue-400 hover:text-blue-300">Zu den Profilen →</Link>
      </p>
    </div>
  );
}
