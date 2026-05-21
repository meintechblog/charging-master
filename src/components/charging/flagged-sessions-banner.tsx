/**
 * v1.7-C dashboard banner — surfaces the count of sessions flagged by
 * the post-cycle self-calibration scorer. Click-through to /history,
 * where each flagged row carries the per-session `flagReason` text.
 *
 * Industrial instrument styling: amber rail on the left, mono index,
 * eyebrow label, and a "→" hint that this is actionable.
 */

import Link from 'next/link';

type Props = {
  count: number;
};

export function FlaggedSessionsBanner({ count }: Props) {
  if (count <= 0) return null;
  return (
    <Link
      href="/history?filter=flagged"
      className="group relative block overflow-hidden mb-6 lift-hover"
      style={{
        background: 'var(--color-warn-soft)',
        border: '1px solid color-mix(in srgb, var(--color-warn) 30%, transparent)',
        borderRadius: 'var(--radius-lg)',
      }}
    >
      <div
        className="absolute left-0 top-0 bottom-0 w-[3px]"
        style={{
          background: 'var(--color-warn)',
          boxShadow: '0 0 14px 0 var(--color-warn-soft)',
        }}
      />
      <div className="relative flex items-center gap-4 pl-5 pr-5 py-4">
        <div
          className="font-mono text-[28px] font-medium leading-none tabular-nums"
          style={{ color: 'var(--color-warn)' }}
        >
          {count.toString().padStart(2, '0')}
        </div>
        <div className="flex-1 min-w-0">
          <div
            className="font-mono text-[10px] uppercase tracking-[0.2em] mb-0.5"
            style={{ color: 'var(--color-warn)' }}
          >
            Prüfung empfohlen
          </div>
          <div className="text-[13px] leading-snug text-[color:var(--color-text-default)]">
            {count === 1
              ? '1 Ladevorgang braucht eine zweite Meinung'
              : `${count} Ladevorgänge brauchen eine zweite Meinung`}
            <span className="text-[color:var(--color-text-faint)]">
              {' · '}Post-Cycle-Kalibrierung sieht eine Diskrepanz.
            </span>
          </div>
        </div>
        <span
          className="font-mono text-[11px] uppercase tracking-[0.18em] transition-transform group-hover:translate-x-0.5 shrink-0"
          style={{ color: 'var(--color-warn)' }}
        >
          Öffnen →
        </span>
      </div>
    </Link>
  );
}
