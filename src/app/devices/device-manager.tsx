'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { DiscoveryList } from '@/components/devices/discovery-list';
import { AddDeviceForm } from '@/components/devices/add-device-form';

type Plug = {
  id: string;
  name: string;
  online: boolean;
  enabled: boolean;
  lastSeen: number | null;
};

type DeviceManagerProps = {
  registeredPlugs: Plug[];
};

export function DeviceManager({ registeredPlugs }: DeviceManagerProps) {
  const router = useRouter();
  const [showManual, setShowManual] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);

  const registeredIds = registeredPlugs.map((p) => p.id);

  async function handleAddFromDiscovery(deviceId: string) {
    const res = await fetch('/api/devices', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: deviceId,
        name: deviceId,
        mqttTopicPrefix: deviceId,
      }),
    });

    if (res.ok) {
      router.refresh();
    }
  }

  async function handleDelete(id: string) {
    setDeleting(id);
    try {
      const res = await fetch('/api/devices', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      if (res.ok) {
        router.refresh();
      }
    } finally {
      setDeleting(null);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Auto-Discovery Section */}
      <section className="bg-neutral-900 rounded-lg border border-neutral-800 p-6">
        <h2 className="text-lg font-semibold text-neutral-100 mb-4">
          Geräte-Erkennung
        </h2>
        <DiscoveryList
          registeredIds={registeredIds}
          onAddDevice={handleAddFromDiscovery}
        />
      </section>

      {/* Manual Add Section */}
      <section className="bg-neutral-900 rounded-lg border border-neutral-800 p-6">
        <button
          onClick={() => setShowManual(!showManual)}
          className="flex items-center justify-between w-full text-lg font-semibold text-neutral-100"
        >
          <span>Manuell hinzufügen</span>
          <span className="text-neutral-500 text-sm">
            {showManual ? 'Einklappen' : 'Aufklappen'}
          </span>
        </button>
        {showManual && (
          <div className="mt-4">
            <AddDeviceForm onAdded={() => router.refresh()} />
          </div>
        )}
      </section>

      {/* Registered Devices */}
      {registeredPlugs.length > 0 && (
        <section className="bg-neutral-900 rounded-lg border border-neutral-800 p-6">
          <h2 className="text-lg font-semibold text-neutral-100 mb-4">
            Registrierte Geräte
          </h2>
          <div className="flex flex-col gap-2">
            {registeredPlugs.map((plug) => (
              <div
                key={plug.id}
                className="bg-neutral-800 rounded-md p-3 flex items-center justify-between"
              >
                <div className="flex items-center gap-3">
                  <span
                    className={`w-2 h-2 rounded-full ${
                      plug.online ? 'bg-green-500' : 'bg-red-500'
                    }`}
                  />
                  <div>
                    <div className="text-sm text-neutral-100">{plug.name}</div>
                    <div className="text-xs text-neutral-500 font-mono">{plug.id}</div>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <span className={`text-xs ${plug.enabled ? 'text-green-400' : 'text-neutral-500'}`}>
                    {plug.enabled ? 'Aktiv' : 'Deaktiviert'}
                  </span>
                  <button
                    onClick={() => handleDelete(plug.id)}
                    disabled={deleting === plug.id}
                    className="text-xs text-red-400 hover:text-red-300 disabled:opacity-50 transition-colors"
                  >
                    {deleting === plug.id ? 'Löschen...' : 'Löschen'}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
