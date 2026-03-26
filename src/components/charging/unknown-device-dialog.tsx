'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';

type Profile = {
  id: number;
  name: string;
};

type UnknownDeviceDialogProps = {
  plugId: string;
  sessionId: number;
  onClose: () => void;
};

export function UnknownDeviceDialog({ plugId, sessionId, onClose }: UnknownDeviceDialogProps) {
  const router = useRouter();
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [assigning, setAssigning] = useState(false);
  const [showDropdown, setShowDropdown] = useState(false);

  useEffect(() => {
    fetch('/api/profiles')
      .then((res) => res.json())
      .then((data: { profiles: Profile[] }) => setProfiles(data.profiles ?? []))
      .catch(() => {});
  }, []);

  const handleLearn = useCallback(() => {
    router.push(`/profiles/learn?plugId=${plugId}`);
    onClose();
  }, [router, plugId, onClose]);

  const handleAssign = useCallback(
    async (profileId: number) => {
      setAssigning(true);
      try {
        await fetch(`/api/charging/sessions/${sessionId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ profileId }),
        });
        onClose();
      } catch {
        // Ignore
      } finally {
        setAssigning(false);
      }
    },
    [sessionId, onClose]
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/70"
        onClick={onClose}
        onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
        role="presentation"
      />

      {/* Dialog */}
      <div className="relative bg-neutral-800 border border-neutral-700 rounded-lg p-6 max-w-md w-full mx-4 shadow-xl">
        <h2 className="text-lg font-semibold text-neutral-100 mb-2">
          Unbekanntes Geraet
        </h2>
        <p className="text-sm text-neutral-400 mb-6">
          Es wurde ein Ladevorgang erkannt, aber kein passendes Profil gefunden.
        </p>

        <div className="flex flex-col gap-3">
          {/* Learn option */}
          <button
            onClick={handleLearn}
            className="w-full px-4 py-3 bg-blue-500 hover:bg-blue-600 text-white rounded-lg text-sm font-medium transition-colors"
          >
            Jetzt anlernen
          </button>

          {/* Assign option */}
          {!showDropdown ? (
            <button
              onClick={() => setShowDropdown(true)}
              disabled={profiles.length === 0}
              className="w-full px-4 py-3 bg-neutral-700 hover:bg-neutral-600 text-neutral-200 rounded-lg text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Bestehendes Profil zuweisen
            </button>
          ) : (
            <div className="space-y-2">
              <p className="text-xs text-neutral-400">Profil auswaehlen:</p>
              <div className="max-h-48 overflow-y-auto space-y-1">
                {profiles.map((profile) => (
                  <button
                    key={profile.id}
                    onClick={() => handleAssign(profile.id)}
                    disabled={assigning}
                    className="w-full px-3 py-2 bg-neutral-700 hover:bg-neutral-600 text-neutral-200 rounded text-sm text-left transition-colors disabled:opacity-50"
                  >
                    {profile.name}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Cancel */}
          <button
            onClick={onClose}
            className="w-full px-4 py-2 text-neutral-400 hover:text-neutral-200 text-sm transition-colors"
          >
            Schliessen
          </button>
        </div>
      </div>
    </div>
  );
}
