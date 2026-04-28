'use client';

import { useState, useEffect, useRef } from 'react';

type Props = {
  initialSettings: Record<string, string>;
};

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
    }, 500);
    return () => clearTimeout(timer);
  }, [key, value]);

  return saveStatus;
}

const inputClasses = 'bg-neutral-800 border border-neutral-700 text-neutral-100 rounded-md px-3 py-2 w-full focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none';
const labelClasses = 'text-sm font-medium text-neutral-300';

export function ElectricitySettings({ initialSettings }: Props) {
  const initial = initialSettings['electricity.priceEurPerKwh'] ?? '0.40';
  const [price, setPrice] = useState(initial);
  const status = useAutoSave('electricity.priceEurPerKwh', price, initial);

  return (
    <div className="space-y-3">
      <div>
        <label className={labelClasses}>Strompreis (EUR / kWh)</label>
        <input
          type="number"
          step="0.01"
          min="0"
          className={inputClasses}
          value={price}
          onChange={(e) => setPrice(e.target.value)}
          placeholder="0.40"
        />
        <p className="text-[11px] text-neutral-500 mt-1">
          Wird für die Kosten-Anzeige in Notifications und Session-Details verwendet. Default 0,40 €/kWh.
        </p>
      </div>
      <div className="text-xs text-neutral-500 h-4">
        {status === 'saving' && <span>Speichere…</span>}
        {status === 'saved' && <span className="text-green-400">Gespeichert ✓</span>}
      </div>
    </div>
  );
}
