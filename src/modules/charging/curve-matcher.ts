/**
 * Curve Matcher -- orchestrates quick-reject + DTW to identify charging device.
 *
 * Phase 1: Quick-reject by initial power range (25% tolerance on first 10 readings avg vs profile startPower)
 * Phase 2: Subsequence DTW on remaining candidates
 * Confidence: Math.max(0, 1 - (distance / avgQueryPower))
 * Threshold: 0.70 minimum confidence
 */

import { subsequenceDtw } from './dtw';
import type { MatchResult } from './types';

const CONFIDENCE_THRESHOLD = 0.70;
const QUICK_REJECT_TOLERANCE = 0.25;
const QUICK_REJECT_READINGS = 10;

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
 * Match a query power reading sequence against known device profiles.
 * Returns the best MatchResult if confidence >= 0.70, or null.
 */
export function matchCurve(
  queryReadings: number[],
  profiles: ProfileWithCurve[]
): MatchResult | null {
  if (queryReadings.length === 0 || profiles.length === 0) return null;

  // Phase 1: Quick-reject by initial power range
  const initialReadings = queryReadings.slice(0, QUICK_REJECT_READINGS);
  const avgInitialPower = initialReadings.reduce((a, b) => a + b, 0) / initialReadings.length;

  const candidates = profiles.filter((profile) => {
    const startPower = profile.curve.startPower;
    const lowerBound = startPower * (1 - QUICK_REJECT_TOLERANCE);
    const upperBound = startPower * (1 + QUICK_REJECT_TOLERANCE);
    return avgInitialPower >= lowerBound && avgInitialPower <= upperBound;
  });

  if (candidates.length === 0) return null;

  // Phase 2: Subsequence DTW on remaining candidates
  const avgQueryPower = queryReadings.reduce((a, b) => a + b, 0) / queryReadings.length;

  let bestMatch: MatchResult | null = null;
  let bestConfidence = -1;

  for (const profile of candidates) {
    const referencePowers = profile.curvePoints.map((p) => p.apower);

    if (referencePowers.length < queryReadings.length) continue;

    const { offset, distance } = subsequenceDtw(queryReadings, referencePowers);
    const confidence = Math.max(0, 1 - (distance / (avgQueryPower || 1)));

    if (confidence > bestConfidence) {
      bestConfidence = confidence;

      // Estimate start SOC from offset position in reference curve
      const totalDuration = profile.curve.durationSeconds;
      const offsetSeconds = profile.curvePoints[offset]?.offsetSeconds ?? 0;
      const estimatedStartSoc = totalDuration > 0
        ? Math.round((offsetSeconds / totalDuration) * 100)
        : 0;

      bestMatch = {
        profileId: profile.id,
        profileName: profile.name,
        confidence,
        curveOffsetSeconds: offsetSeconds,
        estimatedStartSoc,
      };
    }
  }

  if (bestMatch && bestMatch.confidence >= CONFIDENCE_THRESHOLD) {
    return bestMatch;
  }

  return null;
}
