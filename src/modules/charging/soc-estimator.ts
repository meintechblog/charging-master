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
