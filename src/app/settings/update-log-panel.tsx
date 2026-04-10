'use client';

import { useEffect, useRef, useState } from 'react';

type Props = {
  /** Log lines appended in arrival order. Parent owns the array and caps it at 2000 before passing down. */
  lines: string[];
};

const AT_BOTTOM_THRESHOLD_PX = 50;

export function UpdateLogPanel({ lines }: Props) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  // On every new line, if autoScroll is on AND the user hasn't scrolled up, pin to bottom.
  useEffect(() => {
    if (!autoScroll) return;
    const el = scrollerRef.current;
    if (el === null) return;
    el.scrollTop = el.scrollHeight;
  }, [lines, autoScroll]);

  // Detect user scroll-up: if they move more than 50px from the bottom, pause auto-scroll.
  // Re-enable when they scroll back within 50px of the bottom.
  function handleScroll(e: React.UIEvent<HTMLDivElement>): void {
    const el = e.currentTarget;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distanceFromBottom > AT_BOTTOM_THRESHOLD_PX && autoScroll) {
      setAutoScroll(false);
    } else if (distanceFromBottom <= AT_BOTTOM_THRESHOLD_PX && !autoScroll) {
      setAutoScroll(true);
    }
  }

  return (
    <div className="relative rounded border border-neutral-800 bg-neutral-950">
      <div className="flex items-center justify-between border-b border-neutral-800 px-3 py-1.5 text-[11px] text-neutral-400">
        <span>Update Log · {lines.length} Zeilen</span>
        <label className="flex items-center gap-2 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={autoScroll}
            onChange={(e) => setAutoScroll(e.target.checked)}
            className="h-3 w-3 accent-blue-500"
          />
          Auto-Scroll
        </label>
      </div>
      <div
        ref={scrollerRef}
        onScroll={handleScroll}
        className="max-h-80 overflow-y-auto px-3 py-2 font-mono text-[11px] leading-relaxed text-neutral-100 whitespace-pre-wrap break-words"
        role="log"
        aria-live="polite"
        aria-label="Live-Updater-Log"
      >
        {lines.length === 0 ? (
          <span className="text-neutral-500">Warte auf erste Log-Zeile…</span>
        ) : (
          lines.map((line, i) => (
            <div key={i} className={line.startsWith('[stderr]') ? 'text-amber-300' : line.startsWith('[error]') ? 'text-red-300' : line.startsWith('[dev-mode]') ? 'text-purple-300' : undefined}>
              {line}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
