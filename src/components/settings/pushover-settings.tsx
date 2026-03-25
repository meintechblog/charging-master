'use client';

import { useState, useEffect, useRef } from 'react';

type PushoverSettingsProps = {
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
      }).then(() => {
        lastSavedValue.current = value;
        setSaveStatus('saved');
        setTimeout(() => setSaveStatus('idle'), 2000);
      }).catch(() => {
        setSaveStatus('idle');
      });
    }, 500);

    return () => clearTimeout(timer);
  }, [key, value]);

  return saveStatus;
}

const inputClasses =
  'bg-neutral-800 border border-neutral-700 text-neutral-100 rounded-md px-3 py-2 w-full focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none';
const labelClasses = 'text-sm font-medium text-neutral-300';

export function PushoverSettings({ initialSettings }: PushoverSettingsProps) {
  const [userKey, setUserKey] = useState(initialSettings['pushover.userKey'] ?? '');
  const [apiToken, setApiToken] = useState(initialSettings['pushover.apiToken'] ?? '');
  const [showToken, setShowToken] = useState(false);

  const userKeyStatus = useAutoSave('pushover.userKey', userKey, initialSettings['pushover.userKey'] ?? '');
  const apiTokenStatus = useAutoSave('pushover.apiToken', apiToken, initialSettings['pushover.apiToken'] ?? '');

  const anySaving = [userKeyStatus, apiTokenStatus].some((s) => s === 'saving');
  const anySaved = [userKeyStatus, apiTokenStatus].some((s) => s === 'saved');

  return (
    <div className="space-y-4">
      {/* User Key */}
      <div>
        <label className={labelClasses}>User Key</label>
        <input
          type="text"
          className={inputClasses}
          value={userKey}
          onChange={(e) => setUserKey(e.target.value)}
          placeholder="Pushover User Key"
        />
      </div>

      {/* API Token */}
      <div>
        <label className={labelClasses}>API Token</label>
        <div className="relative">
          <input
            type={showToken ? 'text' : 'password'}
            className={inputClasses}
            value={apiToken}
            onChange={(e) => setApiToken(e.target.value)}
            placeholder="Pushover API Token"
          />
          <button
            type="button"
            className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-neutral-400 hover:text-neutral-200 transition-colors"
            onClick={() => setShowToken(!showToken)}
          >
            {showToken ? 'Verbergen' : 'Anzeigen'}
          </button>
        </div>
      </div>

      {/* Save indicator */}
      {anySaving && (
        <p className="text-sm text-neutral-400">Speichere...</p>
      )}
      {anySaved && !anySaving && (
        <p className="text-sm text-green-400">Gespeichert</p>
      )}
    </div>
  );
}
