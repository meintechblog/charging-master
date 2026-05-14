'use client';

import { useState, useEffect, useRef } from 'react';
import { DEFAULT_BAND_THRESHOLD_PCT } from '@/modules/charging/curve-matcher';

type Props = {
  initialSettings: Record<string, string>;
};

// Duplicated from electricity-settings.tsx per the plan's N2 note — folding
// both call-sites into a shared hook is a deliberate v1.3 backlog item; for
// this plan we accept the duplication to keep the diff minimal.
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

const inputClasses =
  'bg-neutral-800 border border-neutral-700 text-neutral-100 rounded-md px-3 py-2 w-full focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none';
const labelClasses = 'text-sm font-medium text-neutral-300';

export function ChargingSettings({ initialSettings }: Props) {
  const initialMode = initialSettings['charging.stopMode'] ?? 'aggressive';
  const [stopMode, setStopMode] = useState(initialMode);
  const modeStatus = useAutoSave('charging.stopMode', stopMode, initialMode);

  const initialThreshold =
    initialSettings['charging.bandThreshold'] ?? String(DEFAULT_BAND_THRESHOLD_PCT);
  const [threshold, setThreshold] = useState(initialThreshold);

  // Only persist values that parse to a sensible threshold; otherwise hold at
  // initial. Prevents typing intermediates ("0.", "0.0") from triggering bad PUTs.
  const validatedThreshold = (() => {
    const n = Number.parseFloat(threshold);
    return Number.isFinite(n) && n >= 0.05 && n <= 0.5 ? threshold : initialThreshold;
  })();
  const thresholdStatus = useAutoSave(
    'charging.bandThreshold',
    validatedThreshold,
    initialThreshold,
  );

  const [showAdvanced, setShowAdvanced] = useState(false);

  return (
    <div className="space-y-4">
      <div>
        <span className={labelClasses}>Stopp-Verhalten</span>
        <div className="mt-2 space-y-2">
          <label className="flex items-start gap-2 cursor-pointer">
            <input
              type="radio"
              name="charging-stop-mode"
              value="aggressive"
              checked={stopMode === 'aggressive'}
              onChange={(e) => setStopMode(e.target.value)}
              className="mt-1"
            />
            <span>
              <span className="text-sm text-neutral-200 font-medium">Aggressiv</span>
              <span className="block text-[11px] text-neutral-500">
                Stoppt sobald die Band-Schätzung schmal genug ist (±2-3 %). Schnellerer Stopp, geringes
                Untershoot-Risiko.
              </span>
            </span>
          </label>
          <label className="flex items-start gap-2 cursor-pointer">
            <input
              type="radio"
              name="charging-stop-mode"
              value="conservative"
              checked={stopMode === 'conservative'}
              onChange={(e) => setStopMode(e.target.value)}
              className="mt-1"
            />
            <span>
              <span className="text-sm text-neutral-200 font-medium">Konservativ</span>
              <span className="block text-[11px] text-neutral-500">
                Stoppt erst wenn die untere Bandgrenze das Ziel erreicht. Garantiert kein Untershoot,
                dauert länger.
              </span>
            </span>
          </label>
        </div>
        <div className="text-xs text-neutral-500 h-4 mt-1">
          {modeStatus === 'saving' && <span>Speichere…</span>}
          {modeStatus === 'saved' && <span className="text-green-400">Gespeichert ✓</span>}
        </div>
      </div>

      <div>
        <button
          type="button"
          onClick={() => setShowAdvanced((v) => !v)}
          className="text-xs text-neutral-400 hover:text-blue-400 transition-colors underline-offset-2 hover:underline"
        >
          {showAdvanced ? 'Erweitert ausblenden' : 'Erweitert anzeigen'}
        </button>

        {showAdvanced && (
          <div className="mt-3">
            <label className={labelClasses} htmlFor="charging-band-threshold">
              Band-Schwellenwert (0 - 1)
            </label>
            <input
              id="charging-band-threshold"
              type="number"
              step="0.01"
              min="0.05"
              max="0.50"
              className={inputClasses}
              value={threshold}
              onChange={(e) => setThreshold(e.target.value)}
              placeholder={String(DEFAULT_BAND_THRESHOLD_PCT)}
            />
            <p className="text-[11px] text-neutral-500 mt-1">
              Beeinflusst, wie weit das Band initial gespannt wird. Standard wird empirisch via Plan
              11-01-Kalibration gepinnt. Nur ändern wenn man weiß was man tut.
            </p>
            <div className="text-xs text-neutral-500 h-4 mt-1">
              {thresholdStatus === 'saving' && <span>Speichere…</span>}
              {thresholdStatus === 'saved' && (
                <span className="text-green-400">Gespeichert ✓</span>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
