'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { IpRelayToggle } from '@/components/devices/ip-relay-toggle';

type DiscoveredDevice = {
  ip: string;
  deviceId: string;
  model: string;
  gen: number;
  apower: number;
  output: boolean;
  channelName: string | null;
};

type DiscoveryListProps = {
  registeredIds: string[];
  onAddDevice: (deviceId: string, ip: string, defaultName?: string) => void;
};

const TOTAL_IPS = 254;

export function DiscoveryList({ registeredIds, onAddDevice }: DiscoveryListProps) {
  const [devices, setDevices] = useState<DiscoveredDevice[]>([]);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasScanned, setHasScanned] = useState(false);
  const [relayState, setRelayState] = useState<Map<string, boolean>>(new Map());
  const [progress, setProgress] = useState<{ scanned: number; total: number } | null>(null);
  const esRef = useRef<EventSource | null>(null);

  function setRelay(deviceId: string, on: boolean) {
    setRelayState((prev) => {
      const next = new Map(prev);
      next.set(deviceId, on);
      return next;
    });
  }

  const handleScan = useCallback(() => {
    esRef.current?.close();
    esRef.current = null;

    setScanning(true);
    setError(null);
    setDevices([]);
    setRelayState(new Map());
    setProgress({ scanned: 0, total: TOTAL_IPS });

    const es = new EventSource('/api/devices/discover/stream');
    esRef.current = es;

    es.addEventListener('device', (event) => {
      try {
        const device: DiscoveredDevice = JSON.parse((event as MessageEvent).data);
        setDevices((prev) => {
          if (prev.some((d) => d.deviceId === device.deviceId)) return prev;
          return [...prev, device];
        });
        setRelay(device.deviceId, device.output);
      } catch {
        // ignore malformed frame
      }
    });

    es.addEventListener('progress', (event) => {
      try {
        const p: { scanned: number; total: number } = JSON.parse(
          (event as MessageEvent).data
        );
        setProgress(p);
      } catch {
        // ignore
      }
    });

    es.addEventListener('error', (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data);
        setError(data?.error ?? 'Scan fehlgeschlagen');
      } catch {
        // Browser also fires `error` with no data when the stream closes;
        // ignore unless we were still mid-scan.
      }
    });

    es.addEventListener('done', () => {
      setScanning(false);
      setHasScanned(true);
      es.close();
      esRef.current = null;
    });
  }, []);

  const didAutoScanRef = useRef(false);
  useEffect(() => {
    if (didAutoScanRef.current) return;
    didAutoScanRef.current = true;
    handleScan();
  }, [handleScan]);

  useEffect(() => {
    return () => {
      esRef.current?.close();
      esRef.current = null;
    };
  }, []);

  const unregistered = devices.filter((d) => !registeredIds.includes(d.deviceId));
  const progressPct = progress
    ? Math.round((progress.scanned / progress.total) * 100)
    : 0;

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
          'Geräte suchen'
        )}
      </button>

      {/* Progress Bar */}
      {scanning && progress && (
        <div className="flex flex-col gap-1">
          <div className="relative h-1.5 bg-neutral-800 rounded-full overflow-hidden">
            <div
              className="h-full bg-blue-500 rounded-full transition-all duration-150 ease-linear"
              style={{ width: `${progressPct}%` }}
            />
          </div>
          <div className="text-xs text-neutral-500 tabular-nums">
            {progress.scanned} / {progress.total} IPs geprüft · {progressPct}%
          </div>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="text-sm text-red-400">{error}</div>
      )}

      {/* Empty state after full scan */}
      {!scanning && hasScanned && unregistered.length === 0 && (
        <div className="text-sm text-neutral-500">
          Keine neuen Geräte gefunden.
        </div>
      )}

      {unregistered.length > 0 && (
        <div className="flex flex-col gap-2">
          {unregistered.map((device) => {
            const relayOn = relayState.get(device.deviceId) ?? device.output;
            const displayName = device.channelName ?? device.deviceId;
            return (
              <div
                key={device.deviceId}
                className="bg-neutral-800 rounded-md p-3 flex items-center justify-between gap-3"
              >
                <div className="flex flex-col gap-1 min-w-0 flex-1">
                  {device.channelName ? (
                    <>
                      <span className="text-sm text-neutral-100 truncate">
                        {device.channelName}
                      </span>
                      <span className="text-xs text-neutral-500 font-mono truncate">
                        {device.deviceId}
                      </span>
                    </>
                  ) : (
                    <span className="text-sm text-neutral-100 font-mono truncate">
                      {device.deviceId}
                    </span>
                  )}
                  <div className="flex items-center gap-3 text-xs text-neutral-400 tabular-nums">
                    <a
                      href={`http://${device.ip}/`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="hover:text-blue-400 underline-offset-2 hover:underline"
                      title="Shelly Admin-UI in neuem Tab öffnen"
                    >
                      {device.ip}
                    </a>
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
                    onClick={() => onAddDevice(device.deviceId, device.ip, displayName)}
                    className="text-xs bg-blue-600 hover:bg-blue-700 text-white px-3 py-1 rounded-md transition-colors"
                  >
                    Hinzufügen
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
