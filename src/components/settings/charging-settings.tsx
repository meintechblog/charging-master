'use client';

import { useState, useEffect, useRef } from 'react';
import { DEFAULT_BAND_THRESHOLD_PCT } from '@/modules/charging/curve-matcher';
import {
  DEFAULT_STALE_POWER_THRESHOLD_W,
  DEFAULT_STALE_POWER_WINDOW_SEC,
  DEFAULT_MATCHER_REFRESH_READINGS,
  DEFAULT_LOW_CONFIDENCE_THRESHOLD,
  DEFAULT_MAX_SESSION_HOURS,
} from '@/modules/charging/stop-mode';

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

  // ---- Phase 12 Flat-Power Defense config rows ----
  // Each row mirrors the bandThreshold pattern: useState for editing buffer,
  // a validated-value gate so intermediate keystrokes ("0.", "") don't fire
  // a PUT, then useAutoSave with the validated value. Validation predicates
  // match the server-side parsers in stop-mode.ts.

  const initialStaleThresholdW =
    initialSettings['charging.stalePowerThresholdW'] ?? String(DEFAULT_STALE_POWER_THRESHOLD_W);
  const [staleThresholdW, setStaleThresholdW] = useState(initialStaleThresholdW);
  const validatedStaleThresholdW = (() => {
    const n = Number.parseFloat(staleThresholdW);
    return Number.isFinite(n) && n > 0 && n < 50 ? staleThresholdW : initialStaleThresholdW;
  })();
  const staleThresholdWStatus = useAutoSave(
    'charging.stalePowerThresholdW',
    validatedStaleThresholdW,
    initialStaleThresholdW,
  );

  const initialStaleWindowSec =
    initialSettings['charging.stalePowerWindowSec'] ?? String(DEFAULT_STALE_POWER_WINDOW_SEC);
  const [staleWindowSec, setStaleWindowSec] = useState(initialStaleWindowSec);
  const validatedStaleWindowSec = (() => {
    const n = Number.parseInt(staleWindowSec, 10);
    return Number.isFinite(n) && n > 0 && n <= 3600 ? staleWindowSec : initialStaleWindowSec;
  })();
  const staleWindowSecStatus = useAutoSave(
    'charging.stalePowerWindowSec',
    validatedStaleWindowSec,
    initialStaleWindowSec,
  );

  const initialMatcherRefresh =
    initialSettings['charging.matcherRefreshReadings'] ?? String(DEFAULT_MATCHER_REFRESH_READINGS);
  const [matcherRefresh, setMatcherRefresh] = useState(initialMatcherRefresh);
  const validatedMatcherRefresh = (() => {
    const n = Number.parseInt(matcherRefresh, 10);
    return Number.isFinite(n) && n > 0 && n <= 3600 ? matcherRefresh : initialMatcherRefresh;
  })();
  const matcherRefreshStatus = useAutoSave(
    'charging.matcherRefreshReadings',
    validatedMatcherRefresh,
    initialMatcherRefresh,
  );

  const initialLowConfidence =
    initialSettings['charging.lowConfidenceThreshold'] ?? String(DEFAULT_LOW_CONFIDENCE_THRESHOLD);
  const [lowConfidence, setLowConfidence] = useState(initialLowConfidence);
  const validatedLowConfidence = (() => {
    const n = Number.parseFloat(lowConfidence);
    return Number.isFinite(n) && n > 0 && n <= 1 ? lowConfidence : initialLowConfidence;
  })();
  const lowConfidenceStatus = useAutoSave(
    'charging.lowConfidenceThreshold',
    validatedLowConfidence,
    initialLowConfidence,
  );

  const initialMaxSessionHours =
    initialSettings['charging.maxSessionHours'] ?? String(DEFAULT_MAX_SESSION_HOURS);
  const [maxSessionHours, setMaxSessionHours] = useState(initialMaxSessionHours);
  const validatedMaxSessionHours = (() => {
    const n = Number.parseInt(maxSessionHours, 10);
    return Number.isFinite(n) && n > 0 && n <= 168 ? maxSessionHours : initialMaxSessionHours;
  })();
  const maxSessionHoursStatus = useAutoSave(
    'charging.maxSessionHours',
    validatedMaxSessionHours,
    initialMaxSessionHours,
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
          <div className="mt-3 space-y-5">
            <div>
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

            <div className="pt-4 border-t border-neutral-800/80">
              <h3 className="text-sm font-semibold text-neutral-200 mb-3">
                Flat-Power Defense (Phase 12)
              </h3>
              <div className="space-y-4">
                <div>
                  <label className={labelClasses} htmlFor="charging-stale-threshold-w">
                    Stale-Power Schwellwert (W)
                  </label>
                  <input
                    id="charging-stale-threshold-w"
                    type="number"
                    step="0.1"
                    min="0.1"
                    max="49.9"
                    className={inputClasses}
                    value={staleThresholdW}
                    onChange={(e) => setStaleThresholdW(e.target.value)}
                    placeholder={String(DEFAULT_STALE_POWER_THRESHOLD_W)}
                    title="Unterhalb dieser Wattzahl gilt der Plug als 'stale' (Standard: 1.0 W)"
                  />
                  <p className="text-[11px] text-neutral-500 mt-1">
                    Unterhalb dieser Wattzahl gilt der Plug als &quot;stale&quot;. Standard: 1.0 W.
                  </p>
                  <div className="text-xs text-neutral-500 h-4 mt-1">
                    {staleThresholdWStatus === 'saving' && <span>Speichere…</span>}
                    {staleThresholdWStatus === 'saved' && (
                      <span className="text-green-400">Gespeichert ✓</span>
                    )}
                  </div>
                </div>

                <div>
                  <label className={labelClasses} htmlFor="charging-stale-window-sec">
                    Stale-Power Fenster (s)
                  </label>
                  <input
                    id="charging-stale-window-sec"
                    type="number"
                    step="60"
                    min="1"
                    max="3600"
                    className={inputClasses}
                    value={staleWindowSec}
                    onChange={(e) => setStaleWindowSec(e.target.value)}
                    placeholder={String(DEFAULT_STALE_POWER_WINDOW_SEC)}
                    title="Wie lange am Stueck unterhalb des Schwellwerts, bevor der Watchdog feuert (Standard: 300 s)"
                  />
                  <p className="text-[11px] text-neutral-500 mt-1">
                    Dauer am Stück unterhalb des Schwellwerts, bevor der Watchdog die Session
                    abbricht. Standard: 300 s.
                  </p>
                  <div className="text-xs text-neutral-500 h-4 mt-1">
                    {staleWindowSecStatus === 'saving' && <span>Speichere…</span>}
                    {staleWindowSecStatus === 'saved' && (
                      <span className="text-green-400">Gespeichert ✓</span>
                    )}
                  </div>
                </div>

                <div>
                  <label className={labelClasses} htmlFor="charging-matcher-refresh">
                    Matcher-Refresh (Readings)
                  </label>
                  <input
                    id="charging-matcher-refresh"
                    type="number"
                    step="10"
                    min="1"
                    max="3600"
                    className={inputClasses}
                    value={matcherRefresh}
                    onChange={(e) => setMatcherRefresh(e.target.value)}
                    placeholder={String(DEFAULT_MATCHER_REFRESH_READINGS)}
                    title="Wie viele Messwerte vergehen zwischen Re-Matches der Lade-Kurve (Standard: 60 Readings = 5 min)"
                  />
                  <p className="text-[11px] text-neutral-500 mt-1">
                    Anzahl Messwerte zwischen Re-Match-Versuchen der Ladekurve. Standard: 60.
                  </p>
                  <div className="text-xs text-neutral-500 h-4 mt-1">
                    {matcherRefreshStatus === 'saving' && <span>Speichere…</span>}
                    {matcherRefreshStatus === 'saved' && (
                      <span className="text-green-400">Gespeichert ✓</span>
                    )}
                  </div>
                </div>

                <div>
                  <label className={labelClasses} htmlFor="charging-low-confidence">
                    Confidence-Schwellwert (0 - 1)
                  </label>
                  <input
                    id="charging-low-confidence"
                    type="number"
                    step="0.05"
                    min="0.05"
                    max="1"
                    className={inputClasses}
                    value={lowConfidence}
                    onChange={(e) => setLowConfidence(e.target.value)}
                    placeholder={String(DEFAULT_LOW_CONFIDENCE_THRESHOLD)}
                    title="Unterhalb dieser Konfidenz wechselt der Stop auf den Energie-Fallback (Standard: 0.5)"
                  />
                  <p className="text-[11px] text-neutral-500 mt-1">
                    Unterhalb dieser Band-Konfidenz wechselt das Stop-Verhalten in den
                    Energie-Fallback. Standard: 0.5.
                  </p>
                  <div className="text-xs text-neutral-500 h-4 mt-1">
                    {lowConfidenceStatus === 'saving' && <span>Speichere…</span>}
                    {lowConfidenceStatus === 'saved' && (
                      <span className="text-green-400">Gespeichert ✓</span>
                    )}
                  </div>
                </div>

                <div>
                  <label className={labelClasses} htmlFor="charging-max-session-hours">
                    Max Session-Dauer (Stunden)
                  </label>
                  <input
                    id="charging-max-session-hours"
                    type="number"
                    step="1"
                    min="1"
                    max="168"
                    className={inputClasses}
                    value={maxSessionHours}
                    onChange={(e) => setMaxSessionHours(e.target.value)}
                    placeholder={String(DEFAULT_MAX_SESSION_HOURS)}
                    title="Hard timeout: nach so vielen Stunden bricht eine Session unabhaengig vom SOC ab (Standard: 24 h)"
                  />
                  <p className="text-[11px] text-neutral-500 mt-1">
                    Hard-Timeout: Eine Session wird nach so vielen Stunden unabhängig vom SOC
                    abgebrochen. Standard: 24 h.
                  </p>
                  <div className="text-xs text-neutral-500 h-4 mt-1">
                    {maxSessionHoursStatus === 'saving' && <span>Speichere…</span>}
                    {maxSessionHoursStatus === 'saved' && (
                      <span className="text-green-400">Gespeichert ✓</span>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
