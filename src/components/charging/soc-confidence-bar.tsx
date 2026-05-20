/**
 * SoC confidence bar — battery-style fill with uncertainty band.
 *
 * The bar reads like a battery icon: SOLID fill = "definitely at least this
 * full" (= socMin), translucent fill = "probably up to here" (= socMax). The
 * gap between them is the matcher's honest uncertainty. With a clean
 * user-override anchor (socMin == socMax) the bar collapses to a single
 * solid fill — what the user sees matches the precision they have.
 *
 * Layered over the fill:
 *   - Vertical amber line at targetSoc with a "Ziel" label — matches the
 *     amber Ziel-line on the ChargeSessionChart below for visual parity.
 *   - Scale labels at 0 / 50 / 100 underneath.
 *
 * Pure presentational — caller passes resolved {socMin, socMax, socBest,
 * targetSoc}. socBest is currently unused for rendering (kept in props
 * because semantically it's the point estimate; future versions may surface
 * it as a tick mark inside the band).
 */

type SocConfidenceBarProps = {
  socBest: number;
  socMin: number;
  socMax: number;
  targetSoc: number;
  /** Tailwind bg-* class for the solid fill (e.g. "bg-blue-500" during
      charging, "bg-amber-400" during countdown). */
  fillClass: string;
};

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(100, v));
}

export function SocConfidenceBar({
  socMin,
  socMax,
  targetSoc,
  fillClass,
}: SocConfidenceBarProps) {
  const lo = clamp01(Math.min(socMin, socMax));
  const hi = clamp01(Math.max(socMin, socMax));
  const target = clamp01(targetSoc);
  const bandWidth = Math.max(0, hi - lo);
  const hasBand = bandWidth > 1;

  return (
    <div className="relative">
      {/* Battery-style track — tall + fully rounded so it reads as a
          chunky battery indicator, not a thin slider. */}
      <div className="relative h-10 bg-neutral-800 rounded-full overflow-hidden">
        {/* Solid "definitely at least" fill — extends to socMin */}
        <div
          className={`absolute inset-y-0 left-0 ${fillClass} transition-[width] duration-1000 ease-linear`}
          style={{ width: `${lo}%` }}
        />
        {/* Translucent "could be up to" fill — only when band > 1 pp */}
        {hasBand && (
          <div
            className={`absolute inset-y-0 ${fillClass} opacity-35 transition-[left,width] duration-1000 ease-linear`}
            style={{
              left: `${lo}%`,
              width: `${bandWidth}%`,
            }}
            title={`Wahrscheinlich ${Math.round(lo)} – ${Math.round(hi)} %`}
          />
        )}
        {/* Vertical target line — clear amber divider at the stop-point */}
        <div
          className="absolute top-0 bottom-0 w-0.5 bg-amber-400 pointer-events-none"
          style={{ left: `${target}%` }}
          title={`Ziel ${Math.round(target)} %`}
        />
      </div>

      {/* Only the target label under the bar — 0/100 are implicit (a
          horizontal fill bar reads as 0→full). Keeps the label from
          colliding with the right edge when target sits at 80 %+. */}
      <div className="relative mt-1 h-3 text-[10px] tabular-nums">
        <span
          className="absolute -translate-x-1/2 text-amber-400 font-medium whitespace-nowrap"
          style={{ left: `${target}%` }}
        >
          Ziel {Math.round(target)} %
        </span>
      </div>
    </div>
  );
}
