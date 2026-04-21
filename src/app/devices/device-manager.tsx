'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { DiscoveryList } from '@/components/devices/discovery-list';
import { AddDeviceForm } from '@/components/devices/add-device-form';
import { usePowerStream, useOnlineStream } from '@/hooks/use-power-stream';
import { useChargeStream } from '@/hooks/use-charge-stream';
import { RelayToggle } from '@/components/devices/relay-toggle';
import type { ChargeStateEvent } from '@/modules/charging/types';

type Plug = {
  id: string;
  name: string;
  online: boolean;
  enabled: boolean;
  ipAddress: string | null;
  lastSeen: number | null;
};

type DeviceManagerProps = {
  registeredPlugs: Plug[];
};

const ACTIVE_CHARGE_STATES: ReadonlySet<ChargeStateEvent['state']> = new Set([
  'detecting',
  'matched',
  'charging',
  'countdown',
  'learning',
]);

function deriveModelLabel(deviceId: string): string {
  if (deviceId.startsWith('shellyplugsg3-')) return 'Shelly Plug S Gen3';
  if (deviceId.startsWith('shellyplugsg-')) return 'Shelly Plug S Gen2';
  if (deviceId.startsWith('shellyplug-')) return 'Shelly Plug';
  return deviceId.split('-')[0] ?? 'Unbekannt';
}

export function DeviceManager({ registeredPlugs }: DeviceManagerProps) {
  const router = useRouter();
  const [showManual, setShowManual] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<{ id: string; message: string } | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameInput, setRenameInput] = useState('');
  const [savingRename, setSavingRename] = useState(false);
  const [activeSessions, setActiveSessions] = useState<Set<string>>(new Set());
  const confirmTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const errorTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const registeredIds = registeredPlugs.map((p) => p.id);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/charging/sessions')
      .then((res) => res.json())
      .then((list: Array<{ plugId: string }>) => {
        if (cancelled || !Array.isArray(list)) return;
        setActiveSessions(new Set(list.map((s) => s.plugId)));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const onChargeEvent = useCallback((event: ChargeStateEvent) => {
    setActiveSessions((prev) => {
      const next = new Set(prev);
      if (ACTIVE_CHARGE_STATES.has(event.state)) {
        next.add(event.plugId);
      } else {
        next.delete(event.plugId);
      }
      return next;
    });
  }, []);

  useChargeStream('*', onChargeEvent);

  async function handleRename(id: string) {
    const trimmed = renameInput.trim();
    if (!trimmed) return;
    setSavingRename(true);
    try {
      const res = await fetch('/api/devices', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, name: trimmed }),
      });
      if (res.ok) {
        setRenamingId(null);
        setRenameInput('');
        router.refresh();
      }
    } finally {
      setSavingRename(false);
    }
  }

  async function handleAddFromDiscovery(deviceId: string, ip: string, defaultName?: string) {
    const res = await fetch('/api/devices', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: deviceId,
        name: defaultName && defaultName.trim().length > 0 ? defaultName.trim() : deviceId,
        ipAddress: ip,
      }),
    });

    if (res.ok) {
      router.refresh();
    }
  }

  function clearConfirm() {
    if (confirmTimeoutRef.current) {
      clearTimeout(confirmTimeoutRef.current);
      confirmTimeoutRef.current = null;
    }
    setConfirmingDelete(null);
  }

  function showError(id: string, message: string) {
    if (errorTimeoutRef.current) clearTimeout(errorTimeoutRef.current);
    setDeleteError({ id, message });
    errorTimeoutRef.current = setTimeout(() => setDeleteError(null), 5000);
  }

  async function handleDeleteClick(id: string) {
    if (activeSessions.has(id)) return;

    if (confirmingDelete !== id) {
      clearConfirm();
      setConfirmingDelete(id);
      confirmTimeoutRef.current = setTimeout(() => setConfirmingDelete(null), 4000);
      return;
    }

    clearConfirm();
    setDeleting(id);
    try {
      const res = await fetch('/api/devices', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      if (res.ok) {
        router.refresh();
        return;
      }
      const data = await res.json().catch(() => ({}));
      if (res.status === 409 && data?.error === 'active_session') {
        showError(id, 'Ein Ladevorgang ist aktiv — bitte erst beenden.');
      } else {
        showError(id, data?.error ? `Fehler: ${data.error}` : 'Löschen fehlgeschlagen.');
      }
    } catch {
      showError(id, 'Netzwerkfehler beim Löschen.');
    } finally {
      setDeleting(null);
    }
  }

  useEffect(() => {
    return () => {
      if (confirmTimeoutRef.current) clearTimeout(confirmTimeoutRef.current);
      if (errorTimeoutRef.current) clearTimeout(errorTimeoutRef.current);
    };
  }, []);

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
              <RegisteredDeviceRow
                key={plug.id}
                plug={plug}
                model={deriveModelLabel(plug.id)}
                isActiveCharge={activeSessions.has(plug.id)}
                isRenaming={renamingId === plug.id}
                renameInput={renameInput}
                savingRename={savingRename}
                onRenameStart={() => { setRenamingId(plug.id); setRenameInput(plug.name); }}
                onRenameChange={setRenameInput}
                onRenameSubmit={() => handleRename(plug.id)}
                onRenameCancel={() => { setRenamingId(null); setRenameInput(''); }}
                isDeleting={deleting === plug.id}
                isConfirmingDelete={confirmingDelete === plug.id}
                onDeleteClick={() => handleDeleteClick(plug.id)}
                errorMessage={deleteError?.id === plug.id ? deleteError.message : null}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

type RegisteredDeviceRowProps = {
  plug: Plug;
  model: string;
  isActiveCharge: boolean;
  isRenaming: boolean;
  renameInput: string;
  savingRename: boolean;
  onRenameStart: () => void;
  onRenameChange: (v: string) => void;
  onRenameSubmit: () => void;
  onRenameCancel: () => void;
  isDeleting: boolean;
  isConfirmingDelete: boolean;
  onDeleteClick: () => void;
  errorMessage: string | null;
};

function RegisteredDeviceRow({
  plug,
  model,
  isActiveCharge,
  isRenaming,
  renameInput,
  savingRename,
  onRenameStart,
  onRenameChange,
  onRenameSubmit,
  onRenameCancel,
  isDeleting,
  isConfirmingDelete,
  onDeleteClick,
  errorMessage,
}: RegisteredDeviceRowProps) {
  const [watts, setWatts] = useState<number | null>(null);
  const [relayOn, setRelayOn] = useState<boolean | null>(null);
  const [isOnline, setIsOnline] = useState(plug.online);
  const lastToggleAtRef = useRef<number>(0);

  const onReading = useCallback(
    (reading: { plugId: string; apower: number; output: boolean }) => {
      if (reading.plugId !== plug.id) return;
      setWatts(reading.apower);
      setIsOnline(true);
      const elapsed = Date.now() - lastToggleAtRef.current;
      if (elapsed >= 4000) {
        setRelayOn(reading.output);
      }
    },
    [plug.id]
  );

  const handleRelayToggle = useCallback((newState: boolean) => {
    lastToggleAtRef.current = Date.now();
    setRelayOn(newState);
  }, []);

  const onOnline = useCallback(
    (event: { plugId: string; online: boolean }) => {
      if (event.plugId === plug.id) setIsOnline(event.online);
    },
    [plug.id]
  );

  usePowerStream(plug.id, onReading);
  useOnlineStream(onOnline);

  const deleteDisabled = isActiveCharge || isDeleting;
  const deleteLabel = isDeleting
    ? 'Löschen...'
    : isConfirmingDelete
      ? 'Wirklich löschen?'
      : 'Löschen';

  return (
    <div className="bg-neutral-800 rounded-md p-3 flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <span
            className={`w-2 h-2 rounded-full shrink-0 ${
              isOnline ? 'bg-green-500' : 'bg-red-500'
            }`}
          />
          <div className="min-w-0 flex-1">
            {isRenaming ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  onRenameSubmit();
                }}
                className="flex items-center gap-1"
              >
                <input
                  type="text"
                  value={renameInput}
                  onChange={(e) => onRenameChange(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') onRenameCancel();
                  }}
                  autoFocus
                  disabled={savingRename}
                  className="px-2 py-0.5 text-sm bg-neutral-900 border border-neutral-700 rounded text-neutral-100 focus:outline-none focus:border-blue-500 w-full max-w-xs"
                />
                <button
                  type="submit"
                  disabled={savingRename || !renameInput.trim()}
                  className="px-2 py-0.5 text-xs bg-blue-500 hover:bg-blue-600 text-white rounded disabled:opacity-50"
                >
                  OK
                </button>
                <button
                  type="button"
                  onClick={onRenameCancel}
                  className="text-xs text-neutral-500 hover:text-neutral-300 px-1"
                >
                  ×
                </button>
              </form>
            ) : (
              <div className="flex items-center gap-2">
                <div className="text-sm text-neutral-100 truncate">{plug.name}</div>
                <button
                  onClick={onRenameStart}
                  className="text-xs text-neutral-500 hover:text-blue-400 transition-colors shrink-0"
                  title="Umbenennen"
                >
                  Umbenennen
                </button>
              </div>
            )}
            <div className="text-xs text-neutral-500 font-mono truncate">{plug.id}</div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-neutral-400 mt-1 tabular-nums">
              {plug.ipAddress && (
                <a
                  href={`http://${plug.ipAddress}/`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:text-blue-400 underline-offset-2 hover:underline"
                  title="Shelly Admin-UI in neuem Tab öffnen"
                >
                  {plug.ipAddress}
                </a>
              )}
              <span>{model}</span>
              {isActiveCharge && (
                <span className="text-blue-400">● Ladevorgang aktiv</span>
              )}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <span className="text-xs text-neutral-400 tabular-nums w-14 text-right">
            {watts != null ? `${watts.toFixed(1)} W` : '-- W'}
          </span>
          <RelayToggle
            plugId={plug.id}
            state={relayOn ?? false}
            disabled={!isOnline || relayOn === null}
            onToggle={handleRelayToggle}
          />
          <button
            onClick={onDeleteClick}
            disabled={deleteDisabled}
            title={
              isActiveCharge
                ? 'Ladevorgang aktiv — erst beenden, um das Gerät zu löschen.'
                : undefined
            }
            className={`text-xs transition-colors ${
              deleteDisabled
                ? 'text-neutral-600 cursor-not-allowed'
                : isConfirmingDelete
                  ? 'text-red-300 font-medium'
                  : 'text-red-400 hover:text-red-300'
            }`}
          >
            {deleteLabel}
          </button>
        </div>
      </div>
      {errorMessage && (
        <div className="text-xs text-red-400 mt-1">{errorMessage}</div>
      )}
    </div>
  );
}
