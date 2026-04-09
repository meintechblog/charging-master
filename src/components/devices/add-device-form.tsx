'use client';

import { useState } from 'react';

type AddDeviceFormProps = {
  onAdded: () => void;
};

export function AddDeviceForm({ onAdded }: AddDeviceFormProps) {
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [ipAddress, setIpAddress] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!id.trim() || !name.trim() || !ipAddress.trim()) {
      setError('Geraete-ID, Name und IP-Adresse sind erforderlich');
      return;
    }

    setSubmitting(true);

    try {
      const res = await fetch('/api/devices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: id.trim(),
          name: name.trim(),
          ipAddress: ipAddress.trim(),
        }),
      });

      if (res.status === 201) {
        setId('');
        setName('');
        setIpAddress('');
        onAdded();
      } else if (res.status === 409) {
        setError('Geraet bereits registriert');
      } else {
        const data = await res.json();
        setError(data.error ?? 'Fehler beim Hinzufuegen');
      }
    } catch {
      setError('Netzwerkfehler');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <div>
        <label htmlFor="device-id" className="block text-sm font-medium text-neutral-300 mb-1">
          Geraete-ID
        </label>
        <input
          id="device-id"
          type="text"
          value={id}
          onChange={(e) => setId(e.target.value)}
          placeholder="shellyplugsg3-AABBCC"
          className="w-full bg-neutral-800 border border-neutral-700 text-neutral-100 rounded-md px-3 py-2 text-sm placeholder:text-neutral-500 focus:outline-none focus:border-neutral-600"
        />
      </div>

      <div>
        <label htmlFor="device-name" className="block text-sm font-medium text-neutral-300 mb-1">
          Name / Alias
        </label>
        <input
          id="device-name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Wohnzimmer Ladegeraet"
          className="w-full bg-neutral-800 border border-neutral-700 text-neutral-100 rounded-md px-3 py-2 text-sm placeholder:text-neutral-500 focus:outline-none focus:border-neutral-600"
        />
      </div>

      <div>
        <label htmlFor="device-ip" className="block text-sm font-medium text-neutral-300 mb-1">
          IP-Adresse <span className="text-red-400">(erforderlich)</span>
        </label>
        <input
          id="device-ip"
          type="text"
          value={ipAddress}
          onChange={(e) => setIpAddress(e.target.value)}
          placeholder="192.168.3.167"
          className="w-full bg-neutral-800 border border-neutral-700 text-neutral-100 rounded-md px-3 py-2 text-sm placeholder:text-neutral-500 focus:outline-none focus:border-neutral-600"
        />
      </div>

      {error && (
        <div className="text-sm text-red-400">{error}</div>
      )}

      <button
        type="submit"
        disabled={submitting}
        className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white px-4 py-2 rounded-md text-sm font-medium transition-colors"
      >
        {submitting ? 'Wird hinzugefuegt...' : 'Geraet hinzufuegen'}
      </button>
    </form>
  );
}
