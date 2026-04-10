'use client';

import { useEffect, useRef, useState } from 'react';

type ActiveSession = {
  id: number;
  plugName: string | null;
  profileName: string | null;
  state: string;
  estimatedSoc: number | null;
  targetSoc: number | null;
};

type Props = {
  currentShaShort: string;
  targetShaShort: string;
  commitMessage: string;
  commitAuthor: string;
  commitDateIso: string;
  isSubmitting: boolean;
  submitError: string | null;
  onConfirm: () => void;
  onCancel: () => void;
};

const DATE_FMT = new Intl.DateTimeFormat('de', { dateStyle: 'medium', timeStyle: 'short' });

export function InstallModal(props: Props) {
  const {
    currentShaShort,
    targetShaShort,
    commitMessage,
    commitAuthor,
    commitDateIso,
    isSubmitting,
    submitError,
    onConfirm,
    onCancel,
  } = props;

  const confirmBtnRef = useRef<HTMLButtonElement>(null);
  const cancelBtnRef = useRef<HTMLButtonElement>(null);
  const [activeSessions, setActiveSessions] = useState<ActiveSession[] | null>(null);

  // Fetch active charge sessions on mount — user must see if a charge will be interrupted
  useEffect(() => {
    const ctrl = new AbortController();
    fetch('/api/charging/sessions', { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : []))
      .then((data: ActiveSession[]) => setActiveSessions(Array.isArray(data) ? data : []))
      .catch(() => setActiveSessions([])); // fail-open: don't block update on fetch error
    return () => ctrl.abort();
  }, []);

  // ESC to close + focus trap (very minimal — just bounce focus between the two buttons)
  useEffect(() => {
    // Focus the cancel button on open (safer default — user has to actively pick Install)
    cancelBtnRef.current?.focus();

    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape' && !isSubmitting) {
        e.preventDefault();
        onCancel();
      }
      if (e.key === 'Tab') {
        // Trap: Tab/Shift-Tab cycles between cancel and confirm only
        e.preventDefault();
        const active = document.activeElement;
        if (active === cancelBtnRef.current) {
          confirmBtnRef.current?.focus();
        } else {
          cancelBtnRef.current?.focus();
        }
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isSubmitting, onCancel]);

  let formattedDate = commitDateIso;
  try { formattedDate = DATE_FMT.format(new Date(commitDateIso)); } catch { /* keep raw */ }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="install-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={(e) => { if (e.target === e.currentTarget && !isSubmitting) onCancel(); }}
    >
      <div className="w-full max-w-md rounded-lg border border-neutral-700 bg-neutral-900 p-6 shadow-2xl">
        <h2 id="install-modal-title" className="text-lg font-semibold text-neutral-100">
          Update installieren?
        </h2>

        <div className="mt-4 space-y-3 text-sm">
          <div className="flex items-center gap-2 font-mono text-xs">
            <span className="text-neutral-500">{currentShaShort}</span>
            <span className="text-neutral-600">→</span>
            <span className="text-neutral-100 font-semibold">{targetShaShort}</span>
          </div>
          <div className="rounded bg-neutral-950 border border-neutral-800 p-3 text-xs">
            <p className="whitespace-pre-wrap break-words text-neutral-200">{commitMessage}</p>
            <p className="mt-2 text-neutral-500">
              {commitAuthor} · {formattedDate}
            </p>
          </div>
          {activeSessions !== null && activeSessions.length > 0 && (
            <div className="rounded border border-red-500/40 bg-red-500/10 p-3 text-xs">
              <p className="font-semibold text-red-300">
                ⚠ {activeSessions.length === 1 ? 'Aktiver Ladevorgang' : `${activeSessions.length} aktive Ladevorgänge`} wird unterbrochen
              </p>
              <ul className="mt-2 space-y-1 text-red-200/90">
                {activeSessions.map((s) => {
                  const label = s.profileName ?? s.plugName ?? `Session ${s.id}`;
                  const soc = s.estimatedSoc !== null ? `${Math.round(s.estimatedSoc)}%` : '?';
                  const target = s.targetSoc !== null ? `${s.targetSoc}%` : '?';
                  return (
                    <li key={s.id} className="font-mono">
                      {label}: {soc} / {target} ({s.state})
                    </li>
                  );
                })}
              </ul>
              <p className="mt-2 text-red-200/70">
                Der Updater stoppt den Server und startet ihn neu. Der Akku lädt nach dem Restart weiter, aber der SOC-Tracker verliert die aktuelle Position in der Referenzkurve.
              </p>
            </div>
          )}
          <p className="text-xs text-amber-300">
            Dies wird den Server kurz neu starten.{' '}
            {activeSessions !== null && activeSessions.length === 0 && 'Keine aktiven Ladevorgänge — sicherer Zeitpunkt.'}
          </p>
          {submitError !== null && (
            <p className="rounded bg-red-500/10 border border-red-500/30 px-3 py-2 text-xs text-red-300">
              {submitError}
            </p>
          )}
        </div>

        <div className="mt-6 flex items-center justify-end gap-2">
          <button
            ref={cancelBtnRef}
            type="button"
            disabled={isSubmitting}
            onClick={onCancel}
            className="rounded border border-neutral-700 bg-neutral-800 px-4 py-1.5 text-sm text-neutral-200 hover:bg-neutral-700 disabled:opacity-50"
          >
            Abbrechen
          </button>
          <button
            ref={confirmBtnRef}
            type="button"
            disabled={isSubmitting}
            onClick={onConfirm}
            className="rounded bg-green-600 px-4 py-1.5 text-sm font-semibold text-white hover:bg-green-500 disabled:opacity-50"
          >
            {isSubmitting ? 'Starte…' : 'Jetzt installieren'}
          </button>
        </div>
      </div>
    </div>
  );
}
