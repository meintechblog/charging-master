'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

type DiscoveredDevice = {
  deviceId: string;
  firstSeen: number;
  lastSeen: number;
  online: boolean;
};

type DiscoveryListProps = {
  registeredIds: string[];
  onAddDevice: (deviceId: string) => void;
};

export function DiscoveryList({ registeredIds, onAddDevice }: DiscoveryListProps) {
  const [devices, setDevices] = useState<DiscoveredDevice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mqttDisconnected, setMqttDisconnected] = useState(false);

  useEffect(() => {
    let active = true;

    async function fetchDiscovered() {
      try {
        const res = await fetch('/api/devices/discover');
        const data = await res.json();

        if (!active) return;

        if (res.status === 503) {
          setMqttDisconnected(true);
          setDevices([]);
        } else {
          setMqttDisconnected(false);
          setDevices(data.devices ?? []);
        }
        setError(null);
      } catch (err) {
        if (!active) return;
        setError(err instanceof Error ? err.message : 'Fehler beim Laden');
      } finally {
        if (active) setLoading(false);
      }
    }

    fetchDiscovered();
    const interval = setInterval(fetchDiscovered, 5000);

    return () => {
      active = false;
      clearInterval(interval);
    };
  }, []);

  if (mqttDisconnected) {
    return (
      <div className="text-sm text-neutral-400">
        MQTT nicht verbunden.{' '}
        <Link href="/settings" className="text-blue-400 hover:text-blue-300 underline">
          Verbindung in Einstellungen konfigurieren.
        </Link>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-neutral-400">
        <span className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
        Suche nach Shelly-Geräten...
      </div>
    );
  }

  if (error) {
    return <div className="text-sm text-red-400">{error}</div>;
  }

  if (devices.length === 0) {
    return (
      <div className="flex items-center gap-2 text-sm text-neutral-400">
        <span className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
        Suche nach Shelly-Geräten...
      </div>
    );
  }

  const unregistered = devices.filter((d) => !registeredIds.includes(d.deviceId));

  if (unregistered.length === 0) {
    return (
      <div className="text-sm text-neutral-500">
        Keine neuen Geräte gefunden.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {unregistered.map((device) => (
        <div
          key={device.deviceId}
          className="bg-neutral-800 rounded-md p-3 flex items-center justify-between"
        >
          <div className="flex items-center gap-2">
            <span
              className={`w-2 h-2 rounded-full ${
                device.online ? 'bg-green-500' : 'bg-red-500'
              }`}
            />
            <span className="text-sm text-neutral-100 font-mono">
              {device.deviceId}
            </span>
          </div>
          <button
            onClick={() => onAddDevice(device.deviceId)}
            className="text-xs bg-blue-600 hover:bg-blue-700 text-white px-3 py-1 rounded-md transition-colors"
          >
            Hinzufügen
          </button>
        </div>
      ))}
    </div>
  );
}
