/**
 * Energy-based State-of-Charge (SOC) estimation from reference curve data.
 *
 * SOC boundaries are pre-computed from a reference charge curve by dividing
 * total energy into 10 equal buckets (10%, 20%, ... 100%).
 *
 * During charging, current SOC is estimated by comparing cumulative Wh
 * consumed against the reference curve's total energy.
 */

import type { SocBoundary } from './types';

interface CurvePoint {
  offsetSeconds: number;
  cumulativeWh: number;
  apower: number;
}

/**
 * Compute 10 SOC boundaries (10%, 20%, ... 100%) from reference curve points.
 * Each boundary represents the curve point closest to that energy percentage.
 */
export function computeSocBoundaries(curvePoints: CurvePoint[]): SocBoundary[] {
  if (curvePoints.length === 0) return [];

  const totalWh = curvePoints[curvePoints.length - 1].cumulativeWh;
  if (totalWh <= 0) return [];

  const boundaries: SocBoundary[] = [];

  for (let pct = 10; pct <= 100; pct += 10) {
    const targetWh = (pct / 100) * totalWh;

    // Find the curve point closest to this energy target
    let closestIdx = 0;
    let closestDiff = Infinity;

    for (let i = 0; i < curvePoints.length; i++) {
      const diff = Math.abs(curvePoints[i].cumulativeWh - targetWh);
      if (diff < closestDiff) {
        closestDiff = diff;
        closestIdx = i;
      }
    }

    boundaries.push({
      soc: pct,
      offsetSeconds: curvePoints[closestIdx].offsetSeconds,
      cumulativeWh: curvePoints[closestIdx].cumulativeWh,
    });
  }

  return boundaries;
}

/**
 * Estimate current SOC from cumulative energy consumed.
 *
 * For full charges (startSoc = 0): SOC = (currentWh / totalWh) * 100
 * For partial charges (startSoc > 0): SOC = startSoc + (currentWh / remainingCapacityWh) * (100 - startSoc)
 *
 * Returns integer 0-100.
 */
export function estimateSoc(currentWh: number, totalWh: number, startSoc: number = 0): number {
  if (totalWh <= 0) return 0;

  let soc: number;

  if (startSoc <= 0) {
    // Full charge
    soc = (currentWh / totalWh) * 100;
  } else {
    // Partial charge: remaining capacity = totalWh * (1 - startSoc / 100)
    const remainingCapacityWh = totalWh * (1 - startSoc / 100);
    if (remainingCapacityWh <= 0) return 100;
    soc = startSoc + (currentWh / remainingCapacityWh) * (100 - startSoc);
  }

  // Clamp to 0-100 and round to integer
  return Math.round(Math.max(0, Math.min(100, soc)));
}

/**
 * Fraction-of-peak below which a reading is "in taper". 0.7 = anything under
 * 70% of the reference curve's peakPower. iPad Pro CC-region: ~40-44W,
 * peakPower 44.6W → CC stays at ~90%+ of peak, taper begins when iPad's BMS
 * starts dialing back (~80% real SoC, dropping into the 20-35W range).
 *
 * Diagnosed via scripts/diagnose/replay-session.ts on Session 22: the iPad's
 * energy-fallback SoC overshot real by ~15% precisely because the energy
 * math kept treating taper-region Wh as if the BMS were still in CC region.
 */
export const TAPER_THRESHOLD_FRACTION = 0.7;

/**
 * Taper-aware SoC. Two-phase estimator that picks the right method per
 * regime:
 *
 *   - **CC region** (`apower ≥ TAPER_THRESHOLD_FRACTION × peakPower`):
 *     classic energy-fallback math via `estimateSoc()`. Linear, fast, fine
 *     in CC where power is roughly constant.
 *   - **Taper region** (`apower < TAPER_THRESHOLD_FRACTION × peakPower`):
 *     binary search across reference-curve points for the offset whose
 *     `apower` best matches the live reading. The matched offset maps
 *     directly to SoC via `offsetSeconds / curve.durationSeconds × 100`.
 *     This DECOUPLES the SoC math from accumulated Wh in the regime where
 *     iPad/laptop/phone BMSs nonlinearly throttle current.
 *
 * Fallback: if no taper-region curve point matches within tolerance (e.g.
 * malformed profile or noisy reading), defer to energy math.
 *
 * Pure function — no I/O. Callers (ChargeMonitor.updateSocTracking) pass
 * the curve points filtered for taper region; this keeps the helper
 * profile-agnostic.
 */
export interface TaperCurvePoint {
  offsetSeconds: number;
  apower: number;
}

export function estimateSocTaperAware(opts: {
  apower: number;
  peakPower: number;
  currentWh: number;
  totalWh: number;
  startSoc: number;
  curvePoints: TaperCurvePoint[];
  totalDurationSeconds: number;
}): { soc: number; method: 'energy' | 'taper' } {
  const energySoc = estimateSoc(opts.currentWh, opts.totalWh, opts.startSoc);

  const taperGate = opts.peakPower * TAPER_THRESHOLD_FRACTION;
  if (opts.apower >= taperGate || opts.curvePoints.length === 0 || opts.totalDurationSeconds <= 0) {
    return { soc: energySoc, method: 'energy' };
  }

  // Find the curve point in the taper region whose apower is closest to the
  // live reading. Linear scan — curves are ~1-6k points, this is single-µs.
  // Limit candidates to the SECOND HALF of the curve to avoid matching the
  // early-charge low-power "screen-wake oscillation" region that some
  // profiles include (Bosch GBA's start_power is 0W — a 30W taper reading
  // would otherwise match offset 0 and produce SoC=0).
  const halfIdx = Math.floor(opts.curvePoints.length / 2);
  let bestIdx = -1;
  let bestDelta = Infinity;
  for (let i = halfIdx; i < opts.curvePoints.length; i++) {
    const delta = Math.abs(opts.curvePoints[i].apower - opts.apower);
    if (delta < bestDelta) {
      bestDelta = delta;
      bestIdx = i;
    }
  }

  // Reject the taper match if the closest point is still 5W off — likely
  // means the live reading doesn't actually correspond to anything on this
  // profile's curve (wrong profile or anomaly). Fall back to energy math.
  if (bestIdx < 0 || bestDelta > 5) {
    return { soc: energySoc, method: 'energy' };
  }

  const offsetSeconds = opts.curvePoints[bestIdx].offsetSeconds;
  const taperSoc = Math.round(
    Math.max(0, Math.min(100, (offsetSeconds / opts.totalDurationSeconds) * 100)),
  );

  // Honour the monotonic-SoC invariant — the BMS doesn't un-charge. If the
  // taper estimate is *below* the energy estimate, the curve fit is jittering
  // and the energy floor is more conservative. Pick the larger.
  return { soc: Math.max(taperSoc, energySoc), method: 'taper' };
}
