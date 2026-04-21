'use client';

import { useState, useRef, useCallback } from 'react';

type RelayToggleProps = {
  plugId: string;
  state: boolean;
  disabled?: boolean;
  onToggle?: (newState: boolean) => void;
};

export function RelayToggle({ plugId, state, disabled, onToggle }: RelayToggleProps) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const handleToggle = useCallback(async () => {
    if (pending || disabled) return;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const newState = !state;
    setPending(true);
    setError(false);
    onToggle?.(newState);

    try {
      const res = await fetch(`/api/devices/${plugId}/relay`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: newState ? 'on' : 'off' }),
        signal: controller.signal,
      });

      if (!res.ok) {
        onToggle?.(!newState);
        setError(true);
        setTimeout(() => setError(false), 2000);
      }
    } catch (e) {
      if ((e as Error).name !== 'AbortError') {
        onToggle?.(!newState);
        setError(true);
        setTimeout(() => setError(false), 2000);
      }
    } finally {
      setPending(false);
    }
  }, [state, pending, disabled, plugId, onToggle]);

  return (
    <button
      type="button"
      role="switch"
      aria-checked={state}
      disabled={disabled}
      onClick={handleToggle}
      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-all duration-200 focus:outline-none ${
        disabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'
      } ${error ? 'bg-red-500' : state ? 'bg-green-500' : 'bg-neutral-600'}`}
    >
      <span
        className={`inline-flex h-5 w-5 items-center justify-center rounded-full bg-white transition-transform duration-200 ${
          state ? 'translate-x-5' : 'translate-x-0.5'
        }`}
      >
        {pending && (
          <svg
            className="h-3 w-3 animate-spin text-neutral-500"
            viewBox="0 0 16 16"
            fill="none"
          >
            <circle
              cx="8"
              cy="8"
              r="6"
              stroke="currentColor"
              strokeWidth="2"
              strokeDasharray="28"
              strokeDashoffset="8"
              strokeLinecap="round"
            />
          </svg>
        )}
      </span>
    </button>
  );
}
