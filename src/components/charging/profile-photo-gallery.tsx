'use client';

import { useState, useEffect, useRef, useCallback } from 'react';

export type ProfilePhoto = {
  id: number;
  profileId: number;
  originalName: string | null;
  contentType: string;
  sizeBytes: number;
  isPrimary: boolean;
  caption: string | null;
  createdAt: number;
};

type Props = {
  profileId: number;
  onPrimaryChange?: (photo: ProfilePhoto | null) => void;
};

export function ProfilePhotoGallery({ profileId, onPrimaryChange }: Props) {
  const [photos, setPhotos] = useState<ProfilePhoto[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/profiles/${profileId}/photos`);
    if (res.ok) {
      const data: { photos: ProfilePhoto[] } = await res.json();
      const list = data.photos ?? [];
      setPhotos(list);
      onPrimaryChange?.(list.find((p) => p.isPrimary) ?? list[0] ?? null);
    }
    setLoading(false);
  }, [profileId, onPrimaryChange]);

  useEffect(() => { load(); }, [load]);

  async function handleUpload(file: File) {
    setError(null);
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch(`/api/profiles/${profileId}/photos`, { method: 'POST', body: fd });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.message || body.error || `Upload failed (${res.status})`);
      } else {
        await load();
      }
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  async function setPrimary(id: number) {
    await fetch(`/api/profiles/${profileId}/photos/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isPrimary: true }),
    });
    await load();
  }

  async function deletePhoto(id: number) {
    if (!confirm('Bild löschen?')) return;
    await fetch(`/api/profiles/${profileId}/photos/${id}`, { method: 'DELETE' });
    await load();
  }

  return (
    <div className="bg-neutral-900 rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-medium text-neutral-400">Bilder</h2>
        <label className={`px-3 py-1.5 text-sm rounded transition-colors cursor-pointer ${uploading ? 'bg-neutral-800 text-neutral-500' : 'bg-neutral-800 text-neutral-300 hover:bg-neutral-700'}`}>
          {uploading ? 'Lade hoch…' : '+ Bild hinzufügen'}
          <input
            ref={inputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="hidden"
            disabled={uploading}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleUpload(f);
            }}
          />
        </label>
      </div>

      {error && (
        <div className="mb-3 px-3 py-2 rounded bg-red-500/10 border border-red-500/30 text-sm text-red-300">
          {error}
        </div>
      )}

      {loading ? (
        <p className="text-sm text-neutral-500">Lade…</p>
      ) : photos.length === 0 ? (
        <p className="text-sm text-neutral-500">Noch keine Bilder. JPG, PNG oder WebP, max 8 MB.</p>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
          {photos.map((p) => {
            const url = `/api/profiles/${profileId}/photos/${p.id}/file`;
            return (
              <div
                key={p.id}
                className={`relative group rounded-lg overflow-hidden border-2 ${p.isPrimary ? 'border-blue-500' : 'border-neutral-800 hover:border-neutral-700'}`}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={url} alt={p.originalName ?? 'Profilbild'} className="w-full h-32 object-cover bg-neutral-950" />
                {p.isPrimary && (
                  <span className="absolute top-1 left-1 px-1.5 py-0.5 rounded text-xs font-medium bg-blue-500/90 text-white">
                    Profilbild
                  </span>
                )}
                <div className="absolute inset-0 bg-black/0 group-hover:bg-black/40 transition-colors flex items-end justify-end gap-1 p-2 opacity-0 group-hover:opacity-100">
                  {!p.isPrimary && (
                    <button
                      onClick={() => setPrimary(p.id)}
                      className="px-2 py-1 text-xs rounded bg-blue-500/90 text-white hover:bg-blue-500"
                    >
                      Als Profilbild
                    </button>
                  )}
                  <button
                    onClick={() => deletePhoto(p.id)}
                    className="px-2 py-1 text-xs rounded bg-red-500/90 text-white hover:bg-red-500"
                  >
                    Löschen
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
