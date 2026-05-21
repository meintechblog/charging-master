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
 *   - Confidence chip (top-right) when the band is < 100 %.
 *
 * V2 styling (industrial instrument): CSS-variable driven, hairline tick
 * marks at 0/25/50/75/100 for scale, tight inset shadow on the track.
 */

type SocConfidenceBarProps = {
  socBest: number;
  socMin: number;
  socMax: number;
  targetSoc: number;
  /** CSS color (var or hex) for the solid fill. Defaults to brand accent. */
  fillColor?: string;
  /** 0..1 — the matcher's overall confidence. */
  bandConfidence?: number;
  /** When true, suppress the small "Ziel xy %" caption under the bar — the
      caller already shows the target in a larger badge nearby and the
      duplicate caption becomes visual noise. */
  hideTargetCaption?: boolean;
};

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(100, v));
}

export function SocConfidenceBar({
  socMin,
  socMax,
  targetSoc,
  fillColor = 'var(--color-accent)',
  bandConfidence,
  hideTargetCaption = false,
}: SocConfidenceBarProps) {
  const lo = clamp01(Math.min(socMin, socMax));
  const hi = clamp01(Math.max(socMin, socMax));
  const target = clamp01(targetSoc);
  const bandWidth = Math.max(0, hi - lo);
  const hasBand = bandWidth > 1;

  const confidencePct =
    bandConfidence != null && Number.isFinite(bandConfidence) && bandConfidence < 0.999
      ? Math.round(bandConfidence * 100)
      : null;
  let confColor = 'var(--color-ok)';
  if (confidencePct != null) {
    if (confidencePct < 50) confColor = 'var(--color-danger)';
    else if (confidencePct < 80) confColor = 'var(--color-warn)';
  }

  return (
    <div className="relative">
      {/* Battery-style track. Generous height (h-10) preserved from prior
          UAT-approved version — the chunky bar reads instantly as "this is
          a battery fill", not "this is a generic progress slider". */}
      <div
        className="relative h-10 rounded-full overflow-hidden"
        style={{
          background: 'var(--color-ink-3)',
          boxShadow: 'inset 0 1px 0 0 rgba(0,0,0,0.4)',
        }}
      >
        {/* Tick marks at 25 / 50 / 75 — hairlines, not numbers. Anchors
            the eye without adding scale labels. */}
        {[25, 50, 75].map((pct) => (
          <div
            key={pct}
            className="absolute top-1.5 bottom-1.5 w-px pointer-events-none"
            style={{
              left: `${pct}%`,
              background: 'var(--color-line-faint)',
            }}
          />
        ))}

        {/* Solid "definitely at least" fill. */}
        <div
          className="absolute inset-y-0 left-0 transition-[width] duration-1000 ease-linear"
          style={{
            width: `${lo}%`,
            background: `linear-gradient(180deg, ${fillColor} 0%, color-mix(in srgb, ${fillColor} 85%, black) 100%)`,
            boxShadow: `0 0 16px -4px ${fillColor}`,
          }}
        />
        {/* Translucent "could be up to" fill — only when band > 1 pp */}
        {hasBand && (
          <div
            className="absolute inset-y-0 transition-[left,width] duration-1000 ease-linear opacity-35"
            style={{
              left: `${lo}%`,
              width: `${bandWidth}%`,
              background: fillColor,
            }}
            title={`Wahrscheinlich ${Math.round(lo)} – ${Math.round(hi)} %`}
          />
        )}
        {/* Vertical target line — amber, with a soft glow so it pops over
            the cyan fill without competing on saturation. */}
        <div
          className="absolute top-0 bottom-0 w-[2px] pointer-events-none"
          style={{
            left: `${target}%`,
            background: 'var(--color-warn)',
            boxShadow: '0 0 8px 0 var(--color-warn-soft)',
          }}
          title={`Ziel ${Math.round(target)} %`}
        />
      </div>

      {/* Bottom annotation row. Hidden caption when the caller already
          shows a target badge above (no point repeating the number). */}
      {(!hideTargetCaption || confidencePct != null) && (
        <div className="relative mt-1.5 h-3.5 text-[10px] tabular-nums">
          {!hideTargetCaption && (
            <span
              className="absolute -translate-x-1/2 font-medium whitespace-nowrap font-mono"
              style={{ left: `${target}%`, color: 'var(--color-warn)' }}
            >
              Ziel {Math.round(target)} %
            </span>
          )}
          {confidencePct != null && (
            <span
              className="absolute right-0 font-mono font-medium uppercase tracking-wider"
              style={{ color: confColor }}
              title="Konfidenz des Matchers in der aktuellen SoC-Schätzung"
            >
              {confidencePct}% Konfidenz
            </span>
          )}
        </div>
      )}
    </div>
  );
}
