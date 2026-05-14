/**
 * Curve Matcher — runs subsequence DTW against every known profile and
 * returns the best fit with its confidence score AND the SOC confidence band
 * derived from the full distribution of plausible offsets (Phase 11 SOCB-01).
 *
 * DTW on 60–120 query samples × ~1.6k reference points is <1 ms per profile,
 * so a quick-reject pre-filter would only add brittle heuristics with no
 * measurable speed benefit. We tried that earlier with a startPower±25 % gate;
 * it rejected legitimate matches whenever the live plug-in curve started in a
 * different state than the recorded reference (e.g. iPad reference starts
 * with screen-wake oscillation, but the live charge from a sleeping screen
 * jumps straight to 40 W).
 */

import { subsequenceDtw } from './dtw';
import type { MatchResult } from './types';

export const DEFAULT_CONFIDENCE_THRESHOLD = 0.70;

/**
 * Plausible-offset cutoff for the confidence band: every offset whose DTW
 * distance is within (1 + DEFAULT_BAND_THRESHOLD_PCT) × best is considered a
 * plausible start-SOC.
 *
 * Pinned at 0.20 by a dual-criterion calibration enforced in
 * curve-matcher.test.ts. Both criteria must hold at the current value:
 *   (a) Synthetic-iPad taper precision — bandwidth ≤ 5 (matcher is confident
 *       when the query uniquely localizes to the taper region).
 *   (b) Real Session 14 first-120 flat-region honest uncertainty —
 *       bandwidth ≥ 10 (matcher reports honest doubt when the query
 *       matches an ambiguous flat plateau).
 *
 * Plan 11-01 originally pinned 0.05 by picking the smallest threshold that
 * satisfied (a) alone against synthetic data. A real-data sweep against
 * production Session 14 (192.168.3.185, profile_id=4, 2026-04-29) showed
 * 0.05 collapsed the band to Δ=0 on real flat-power readings after only
 * ~10 min — exactly the false-confidence anti-pattern v1.3 was designed
 * to prevent. 0.20 keeps Δ ≥ 17 in flat region while still collapsing to
 * Δ ≤ 5 in taper. Use scripts/calibration/sweep-real.ts to re-verify this
 * trade-off against new device profiles before adjusting.
 *
 * Note: `socBest` can still anchor to a wrong-offset (~31 %) on real
 * flat-region data regardless of threshold — a fundamental DTW-flat-power
 * ambiguity. Mitigation (stale-power watchdog) is v1.4 scope.
 *
 * Plan 11-02 reads this value from a `charging.bandThreshold` config row at
 * runtime, defaulting to this constant.
 *
 * See audiolabs-erlangen MIR C7S2 (Subsequence DTW matching function
 * Δ_DTW(m)) for the underlying technique.
 */
export const DEFAULT_BAND_THRESHOLD_PCT = 0.20;

export interface ProfileWithCurve {
  id: number;
  name: string;
  curve: {
    startPower: number;
    durationSeconds: number;
    totalEnergyWh: number;
  };
  curvePoints: Array<{
    offsetSeconds: number;
    apower: number;
    cumulativeWh: number;
  }>;
}

/**
 * Derive a SOC confidence band from the per-offset DTW distance vector.
 *
 * Picks every offset whose distance is within `(1 + thresholdPct) * best` and
 * maps it to a start-SOC via `(offsetSeconds / totalDuration) * 100`. The
 * band is the [min, max] of those SOC values; bandConfidence is `1 - width/100`
 * so a collapsed point reads as 1.0 and a fully uncertain band reads as 0.
 *
 * Pure function — no side effects, no I/O. Exported for direct testing.
 *
 * Reference: audiolabs-erlangen MIR FMP C7S2 Subsequence DTW. The matching
 * function Δ_DTW(m) row of the accumulated-cost matrix is exactly this
 * `distances` array; scanning it for plausible offsets is the textbook
 * subsequence-DTW alignment-ambiguity quantification technique.
 *
 * @see https://www.audiolabs-erlangen.de/resources/MIR/FMP/C7/C7S2_SubsequenceDTW.html
 */
export function deriveBand(
  distances: Float64Array,
  windowStep: number,
  curvePoints: ProfileWithCurve['curvePoints'],
  totalDurationSeconds: number,
  thresholdPct: number,
): { socMin: number; socMax: number; socBest: number; bandConfidence: number } {
  if (distances.length === 0) {
    return { socMin: 0, socMax: 100, socBest: 0, bandConfidence: 0 };
  }

  let best = Infinity;
  let bestIdx = 0;
  for (let i = 0; i < distances.length; i++) {
    if (distances[i] < best) {
      best = distances[i];
      bestIdx = i;
    }
  }

  const cutoff = best * (1 + thresholdPct);
  let socMin = 100;
  let socMax = 0;

  for (let i = 0; i < distances.length; i++) {
    if (distances[i] > cutoff) continue;
    const offsetSeconds = curvePoints[i * windowStep]?.offsetSeconds ?? 0;
    const soc =
      totalDurationSeconds > 0
        ? Math.round((offsetSeconds / totalDurationSeconds) * 100)
        : 0;
    if (soc < socMin) socMin = soc;
    if (soc > socMax) socMax = soc;
  }

  const bestOffsetSeconds = curvePoints[bestIdx * windowStep]?.offsetSeconds ?? 0;
  const socBest =
    totalDurationSeconds > 0
      ? Math.round((bestOffsetSeconds / totalDurationSeconds) * 100)
      : 0;

  // 1 - width/100. Floored at 0 so a degenerate full-uncertainty band reads
  // as 0 not negative. NEVER divide by width — collapsed bands divide by zero.
  const bandConfidence = Math.max(0, 1 - (socMax - socMin) / 100);

  return { socMin, socMax, socBest, bandConfidence };
}

/**
 * Run the matcher and return the best candidate (regardless of threshold).
 * Returns null only when no profile is structurally comparable
 * (empty query, no profiles, or every reference shorter than the query).
 *
 * Caller filters by `result.confidence >= threshold` for its phase.
 */
export function findBestCandidate(
  queryReadings: number[],
  profiles: ProfileWithCurve[]
): MatchResult | null {
  if (queryReadings.length === 0 || profiles.length === 0) return null;

  const avgQueryPower = queryReadings.reduce((a, b) => a + b, 0) / queryReadings.length;

  let bestMatch: MatchResult | null = null;
  let bestConfidence = -1;

  for (const profile of profiles) {
    const referencePowers = profile.curvePoints.map((p) => p.apower);
    if (referencePowers.length < queryReadings.length) continue;

    const { offset, distance, distances, windowStep } = subsequenceDtw(
      queryReadings,
      referencePowers,
    );
    const confidence = Math.max(0, 1 - distance / (avgQueryPower || 1));

    if (confidence > bestConfidence) {
      bestConfidence = confidence;

      const totalDuration = profile.curve.durationSeconds;
      const offsetSeconds = profile.curvePoints[offset]?.offsetSeconds ?? 0;
      const band = deriveBand(
        distances,
        windowStep,
        profile.curvePoints,
        totalDuration,
        DEFAULT_BAND_THRESHOLD_PCT,
      );

      bestMatch = {
        profileId: profile.id,
        profileName: profile.name,
        confidence,
        curveOffsetSeconds: offsetSeconds,
        // Back-compat alias: estimatedStartSoc IS socBest. Existing consumers
        // (charge-monitor.ts, charge-state-machine.ts) keep reading
        // estimatedStartSoc unchanged.
        estimatedStartSoc: band.socBest,
        socMin: band.socMin,
        socMax: band.socMax,
        socBest: band.socBest,
        bandConfidence: band.bandConfidence,
      };
    }
  }

  return bestMatch;
}

/**
 * Backward-compatible convenience wrapper. Returns the best match only if
 * its confidence meets the threshold (default 0.70). Existing callers can
 * keep using this; new callers that want progress visibility should use
 * findBestCandidate() and apply the threshold themselves.
 */
export function matchCurve(
  queryReadings: number[],
  profiles: ProfileWithCurve[],
  threshold: number = DEFAULT_CONFIDENCE_THRESHOLD
): MatchResult | null {
  const best = findBestCandidate(queryReadings, profiles);
  if (best && best.confidence >= threshold) return best;
  return null;
}
