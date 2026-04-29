/**
 * Curve Matcher — runs subsequence DTW against every known profile and
 * returns the best fit with its confidence score. The caller decides
 * whether to commit based on a phase-appropriate threshold (high early,
 * normal late). DTW on 60–120 query samples × ~1.6k reference points is
 * <1 ms per profile, so a quick-reject pre-filter would only add brittle
 * heuristics with no measurable speed benefit. We tried that earlier with
 * a startPower±25% gate; it rejected legitimate matches whenever the
 * live plug-in curve started in a different state than the recorded
 * reference (e.g. iPad reference starts with screen-wake oscillation,
 * but the live charge from a sleeping screen jumps straight to 40 W).
 */

import { subsequenceDtw } from './dtw';
import type { MatchResult } from './types';

export const DEFAULT_CONFIDENCE_THRESHOLD = 0.70;

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

    const { offset, distance } = subsequenceDtw(queryReadings, referencePowers);
    const confidence = Math.max(0, 1 - distance / (avgQueryPower || 1));

    if (confidence > bestConfidence) {
      bestConfidence = confidence;

      const totalDuration = profile.curve.durationSeconds;
      const offsetSeconds = profile.curvePoints[offset]?.offsetSeconds ?? 0;
      const estimatedStartSoc =
        totalDuration > 0 ? Math.round((offsetSeconds / totalDuration) * 100) : 0;

      bestMatch = {
        profileId: profile.id,
        profileName: profile.name,
        confidence,
        curveOffsetSeconds: offsetSeconds,
        estimatedStartSoc,
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
