'use client';

import { useState, useEffect, useCallback, useRef } from 'react';

type MqttSettingsProps = {
  initialSettings: Record<string, string>;
};

function useAutoSave(key: string, value: string, initialValue: string) {
  const lastSavedValue = useRef(initialValue);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle');

  useEffect(() => {
    // Only save if value actually changed from what we last saved/loaded
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

export function MqttSettings({ initialSettings }: MqttSettingsProps) {
  const [host, setHost] = useState(initialSettings['mqtt.host'] ?? '');
  const [port, setPort] = useState(initialSettings['mqtt.port'] ?? '1883');
  const [username, setUsername] = useState(initialSettings['mqtt.username'] ?? '');
  const [password, setPassword] = useState(initialSettings['mqtt.password'] ?? '');

  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');

  const hostStatus = useAutoSave('mqtt.host', host, initialSettings['mqtt.host'] ?? '');
  const portStatus = useAutoSave('mqtt.port', port, initialSettings['mqtt.port'] ?? '1883');
  const usernameStatus = useAutoSave('mqtt.username', username, initialSettings['mqtt.username'] ?? '');
  const passwordStatus = useAutoSave('mqtt.password', password, initialSettings['mqtt.password'] ?? '');

  const anySaving = [hostStatus, portStatus, usernameStatus, passwordStatus].some(
    (s) => s === 'saving',
  );
  const anySaved = [hostStatus, portStatus, usernameStatus, passwordStatus].some(
    (s) => s === 'saved',
  );

  const handleTest = useCallback(async () => {
    setTestStatus('testing');
    try {
      const res = await fetch('/api/mqtt/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          host,
          port: parseInt(port, 10) || 1883,
          username: username || undefined,
          password: password || undefined,
        }),
      });
      const data = await res.json();
      setTestStatus(data.success ? 'success' : 'error');
    } catch {
      setTestStatus('error');
    }
  }, [host, port, username, password]);

  return (
    <div className="space-y-4">
      {/* Host / Port row */}
      <div className="grid grid-cols-3 gap-4">
        <div className="col-span-2">
          <label className={labelClasses}>Host</label>
          <input
            type="text"
            className={inputClasses}
            value={host}
            onChange={(e) => setHost(e.target.value)}
            placeholder="mqtt-master.local"
          />
        </div>
        <div>
          <label className={labelClasses}>Port</label>
          <input
            type="text"
            className={inputClasses}
            value={port}
            onChange={(e) => setPort(e.target.value)}
            placeholder="1883"
          />
        </div>
      </div>

      {/* Username */}
      <div>
        <label className={labelClasses}>Benutzername (optional)</label>
        <input
          type="text"
          className={inputClasses}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="Benutzername"
        />
      </div>

      {/* Password */}
      <div>
        <label className={labelClasses}>Passwort (optional)</label>
        <input
          type="password"
          className={inputClasses}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Passwort"
        />
      </div>

      {/* Save indicator */}
      {anySaving && (
        <p className="text-sm text-neutral-400">Speichere...</p>
      )}
      {anySaved && !anySaving && (
        <p className="text-sm text-green-400">Gespeichert</p>
      )}

      {/* Test button */}
      <div>
        <button
          type="button"
          className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-md transition-colors disabled:opacity-50"
          onClick={handleTest}
          disabled={testStatus === 'testing' || !host.trim()}
        >
          {testStatus === 'testing' ? 'Teste Verbindung...' : 'Verbindung testen'}
        </button>

        {testStatus === 'success' && (
          <p className="text-sm text-green-400 mt-2">Verbindung erfolgreich</p>
        )}
        {testStatus === 'error' && (
          <p className="text-sm text-red-400 mt-2">Verbindung fehlgeschlagen</p>
        )}
      </div>
    </div>
  );
}
