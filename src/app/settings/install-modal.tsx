'use client';

import { useEffect, useRef } from 'react';

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
          <p className="text-xs text-amber-300">
            Dies wird den Server kurz neu starten. Aktive Ladesessions werden sauber beendet.
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
