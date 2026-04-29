'use client';

import { useState, useEffect, useRef } from 'react';

type Props = { initialSettings: Record<string, string> };

function useAutoSave(key: string, value: string, initialValue: string) {
  const lastSavedValue = useRef(initialValue);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle');

  useEffect(() => {
    if (value === lastSavedValue.current) return;
    setSaveStatus('saving');
    const timer = setTimeout(() => {
      fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, value }),
      })
        .then(() => {
          lastSavedValue.current = value;
          setSaveStatus('saved');
          setTimeout(() => setSaveStatus('idle'), 2000);
        })
        .catch(() => setSaveStatus('idle'));
    }, 300);
    return () => clearTimeout(timer);
  }, [key, value]);

  return saveStatus;
}

const inputClasses = 'bg-neutral-800 border border-neutral-700 text-neutral-100 rounded-md px-3 py-2 focus:ring-2 focus:ring-blue-500 outline-none';

export function AutoUpdateSettings({ initialSettings }: Props) {
  const initialEnabled = initialSettings['update.autoUpdate'] === 'true' ? 'true' : 'false';
  const initialHour = initialSettings['update.autoUpdateHour'] ?? '3';

  const [enabled, setEnabled] = useState(initialEnabled);
  const [hour, setHour] = useState(initialHour);

  const enabledStatus = useAutoSave('update.autoUpdate', enabled, initialEnabled);
  const hourStatus = useAutoSave('update.autoUpdateHour', hour, initialHour);

  const anySaving = enabledStatus === 'saving' || hourStatus === 'saving';
  const anySaved = enabledStatus === 'saved' || hourStatus === 'saved';
  const isOn = enabled === 'true';

  return (
    <div className="space-y-4">
      <label className="flex items-center gap-3 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={isOn}
          onChange={(e) => setEnabled(e.target.checked ? 'true' : 'false')}
          className="w-4 h-4 accent-blue-500"
        />
        <span className="text-sm text-neutral-200">
          Auto-Update aktiviert
        </span>
      </label>

      <div className={`transition-opacity ${isOn ? 'opacity-100' : 'opacity-50 pointer-events-none'}`}>
        <label className="block text-sm font-medium text-neutral-300 mb-1">Update-Stunde (lokal)</label>
        <select value={hour} onChange={(e) => setHour(e.target.value)} className={inputClasses + ' w-32'} disabled={!isOn}>
          {Array.from({ length: 24 }, (_, i) => (
            <option key={i} value={String(i)}>{String(i).padStart(2, '0')}:00</option>
          ))}
        </select>
        <p className="text-[11px] text-neutral-500 mt-1">
          Wenn ein Update verfügbar ist UND keine aktive Lade-Session läuft, startet die App in dieser Stunde automatisch das Update. Default 03:00.
        </p>
      </div>

      <div className="text-xs text-neutral-500 h-4">
        {anySaving && <span>Speichere…</span>}
        {anySaved && !anySaving && <span className="text-green-400">Gespeichert ✓</span>}
      </div>
    </div>
  );
}
