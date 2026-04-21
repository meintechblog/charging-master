'use client';

import { useState } from 'react';
import { IpRelayToggle } from '@/components/devices/ip-relay-toggle';

type DiscoveredDevice = {
  ip: string;
  deviceId: string;
  model: string;
  gen: number;
  apower: number;
  output: boolean;
};

type DiscoveryListProps = {
  registeredIds: string[];
  onAddDevice: (deviceId: string, ip: string) => void;
};

export function DiscoveryList({ registeredIds, onAddDevice }: DiscoveryListProps) {
  const [devices, setDevices] = useState<DiscoveredDevice[]>([]);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasScanned, setHasScanned] = useState(false);
  const [relayState, setRelayState] = useState<Map<string, boolean>>(new Map());

  function setRelay(deviceId: string, on: boolean) {
    setRelayState((prev) => {
      const next = new Map(prev);
      next.set(deviceId, on);
      return next;
    });
  }

  async function handleScan() {
    setScanning(true);
    setError(null);
    setDevices([]);

    try {
      const res = await fetch('/api/devices/discover');
      const data = await res.json();

      if (!res.ok) {
        setError(data.error ?? 'Scan fehlgeschlagen');
        return;
      }

      const list: DiscoveredDevice[] = data.devices ?? [];
      setDevices(list);
      setHasScanned(true);
      setRelayState(new Map(list.map((d) => [d.deviceId, d.output])));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Netzwerkfehler');
    } finally {
      setScanning(false);
    }
  }

  const unregistered = devices.filter((d) => !registeredIds.includes(d.deviceId));

  return (
    <div className="flex flex-col gap-4">
      {/* Scan Button */}
      <button
        onClick={handleScan}
        disabled={scanning}
        className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white px-4 py-2 rounded-md text-sm font-medium transition-colors w-fit"
      >
        {scanning ? (
          <span className="flex items-center gap-2">
            <span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />
            Scanne Netzwerk...
          </span>
        ) : (
          'Geraete suchen'
        )}
      </button>

      {/* Error */}
      {error && (
        <div className="text-sm text-red-400">{error}</div>
      )}

      {/* Results */}
      {scanning && (
        <div className="flex items-center gap-2 text-sm text-neutral-400">
          <span className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
          Scanne Netzwerk...
        </div>
      )}

      {!scanning && hasScanned && unregistered.length === 0 && (
        <div className="text-sm text-neutral-500">
          Keine neuen Geraete gefunden.
        </div>
      )}

      {unregistered.length > 0 && (
        <div className="flex flex-col gap-2">
          {unregistered.map((device) => {
            const relayOn = relayState.get(device.deviceId) ?? device.output;
            return (
              <div
                key={device.deviceId}
                className="bg-neutral-800 rounded-md p-3 flex items-center justify-between gap-3"
              >
                <div className="flex flex-col gap-1 min-w-0 flex-1">
                  <span className="text-sm text-neutral-100 font-mono truncate">
                    {device.deviceId}
                  </span>
                  <div className="flex items-center gap-3 text-xs text-neutral-400 tabular-nums">
                    <span>{device.ip}</span>
                    <span>{device.model}</span>
                    <span>{device.apower.toFixed(1)} W</span>
                    <span className={relayOn ? 'text-green-400' : 'text-neutral-500'}>
                      {relayOn ? 'Ein' : 'Aus'}
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <IpRelayToggle
                    ip={device.ip}
                    state={relayOn}
                    onToggle={(next) => setRelay(device.deviceId, next)}
                  />
                  <button
                    onClick={() => onAddDevice(device.deviceId, device.ip)}
                    className="text-xs bg-blue-600 hover:bg-blue-700 text-white px-3 py-1 rounded-md transition-colors"
                  >
                    Hinzufuegen
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
