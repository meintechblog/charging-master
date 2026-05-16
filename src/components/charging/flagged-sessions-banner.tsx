/**
 * v1.7-C dashboard banner — surfaces the count of sessions flagged by
 * the post-cycle self-calibration scorer. Click-through to /history,
 * where each flagged row carries the per-session `flagReason` text.
 *
 * Intentionally minimal: a single yellow info strip, no expand/collapse,
 * no inline list. The banner exists to bring the user to the history
 * page where they can re-classify or accept the calibration verdict.
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
      className="block bg-amber-500/10 border border-amber-500/30 rounded-lg p-3 mb-4 hover:bg-amber-500/20 transition-colors"
    >
      <div className="flex items-center gap-3">
        <div className="text-amber-400 text-xl shrink-0" aria-hidden="true">⚠</div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-amber-200">
            {count === 1
              ? '1 Ladevorgang braucht Prüfung'
              : `${count} Ladevorgänge brauchen Prüfung`}
          </div>
          <div className="text-xs text-amber-300/70">
            Post-Cycle-Kalibrierung zeigt eine Diskrepanz zwischen der gelieferten
            Energie und dem erkannten Profil. Tippen für Details.
          </div>
        </div>
      </div>
    </Link>
  );
}
