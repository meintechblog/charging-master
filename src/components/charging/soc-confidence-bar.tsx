/**
 * SoC confidence bar — graphical replacement for the ASCII SocBandIndicator.
 *
 * Renders a full 0–100 % horizontal scale with three overlaid layers:
 *   1. Background scale (0–100), with subtle tick marks at 0/25/50/75/100.
 *   2. Uncertainty band [socMin .. socMax] as a translucent fill — the
 *      "where the matcher thinks the device is" range.
 *   3. Bright dot at socBest (the matcher's point estimate).
 *   4. Amber inverted-V notch at targetSoc.
 *
 * Pure presentational component — no streams, no fetches. Caller passes the
 * already-resolved {socMin, socMax, socBest, targetSoc}.
 */

type SocConfidenceBarProps = {
  socBest: number;
  socMin: number;
  socMax: number;
  targetSoc: number;
  /** Tailwind bg-* class for the bright "current SoC" dot (matches the
      banner's blue/amber accent). */
  fillClass: string;
};

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(100, v));
}

export function SocConfidenceBar({
  socBest,
  socMin,
  socMax,
  targetSoc,
  fillClass,
}: SocConfidenceBarProps) {
  const best = clamp01(socBest);
  const lo = clamp01(Math.min(socMin, socMax));
  const hi = clamp01(Math.max(socMin, socMax));
  const target = clamp01(targetSoc);
  const bandWidth = Math.max(0, hi - lo);
  const hasBand = bandWidth > 1; // ≤1 pp → degenerate; hide.

  return (
    <div className="relative">
      {/* Track */}
      <div className="relative h-3 bg-neutral-800 rounded-full overflow-hidden">
        {/* Tick marks at 25/50/75 % */}
        {[25, 50, 75].map((t) => (
          <div
            key={t}
            className="absolute top-0 bottom-0 w-px bg-neutral-700/60"
            style={{ left: `${t}%` }}
          />
        ))}
        {/* Uncertainty band (where the matcher thinks the device is) */}
        {hasBand && (
          <div
            className={`absolute top-0 bottom-0 ${fillClass} opacity-25`}
            style={{
              left: `${lo}%`,
              width: `${bandWidth}%`,
            }}
            title={`Wahrscheinlich ${Math.round(lo)} – ${Math.round(hi)} %`}
          />
        )}
        {/* Bright dot at best estimate */}
        <div
          className={`absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-3 h-3 ${fillClass} rounded-full shadow-md ring-1 ring-neutral-900 transition-[left] duration-1000 ease-linear`}
          style={{ left: `${best}%` }}
          title={`Aktuell ${Math.round(best)} %`}
        />
      </div>
      {/* Target marker — amber inverted V notch ABOVE the bar (matches the
          chart's amber Ziel line for visual consistency). */}
      <div
        className="absolute -top-1.5 -translate-x-1/2 pointer-events-none"
        style={{ left: `${target}%` }}
        title={`Ziel ${Math.round(target)} %`}
      >
        <svg width="10" height="6" viewBox="0 0 10 6" fill="none">
          <path d="M5 6 L0 0 L10 0 Z" fill="#f59e0b" />
        </svg>
      </div>
      {/* Scale labels (0 / 50 / 100) — tiny, subtle */}
      <div className="flex justify-between mt-1 text-[10px] text-neutral-600 tabular-nums">
        <span>0</span>
        <span>50</span>
        <span>100</span>
      </div>
    </div>
  );
}
