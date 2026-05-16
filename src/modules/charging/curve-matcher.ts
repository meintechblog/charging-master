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
 * Margin gate — refuse to commit a match unless the winning profile's
 * confidence is at least DEFAULT_CONFIDENCE_MARGIN_RATIO × the runner-up's
 * confidence. Diagnosed via scripts/diagnose/replay-session.ts against four
 * real-iPad sessions on 2026-05-15:
 *
 *   - Sessions 19/20/21 had margins universally < ×1.01 → matcher coin-flipped
 *     between profiles whose curves all have a "40W somewhere" segment.
 *     ALL three committed to a wrong profile in production (Winbot, BoschGBA,
 *     and the lucky iPad win that still anchored at a wrong offset).
 *   - Session 22 reached the iPad's taper region after ~5 min; margin crossed
 *     ×1.05 at minute 5.5 and grew to ×1.247 by minute 30 — the correct iPad
 *     match is clearly distinguishable once taper data arrives.
 *
 * ×1.05 is the cutoff: commits at minute 5.5 of session 22 (correct), holds
 * detection mode through 19/20/21 (safe). A user who plugs in an unmatched
 * device sees "Erkennung unsicher" and can manually pin the plug profile;
 * the charge proceeds with NO auto-stop until they do.
 */
export const DEFAULT_CONFIDENCE_MARGIN_RATIO = 1.05;

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
  return rankCandidates(queryReadings, profiles)[0] ?? null;
}

/**
 * Internal — rank every comparable profile by confidence (desc). Exported via
 * findBestCandidate's single-result return AND via the matched-with-margin
 * wrapper below that needs the runner-up score. Empty array when no profile
 * is structurally comparable.
 */
function rankCandidates(
  queryReadings: number[],
  profiles: ProfileWithCurve[],
): MatchResult[] {
  if (queryReadings.length === 0 || profiles.length === 0) return [];

  const avgQueryPower = queryReadings.reduce((a, b) => a + b, 0) / queryReadings.length;
  const ranked: MatchResult[] = [];

  for (const profile of profiles) {
    const referencePowers = profile.curvePoints.map((p) => p.apower);
    if (referencePowers.length < queryReadings.length) continue;

    const { offset, distance, distances, windowStep } = subsequenceDtw(
      queryReadings,
      referencePowers,
    );
    const confidence = Math.max(0, 1 - distance / (avgQueryPower || 1));

    const totalDuration = profile.curve.durationSeconds;
    const offsetSeconds = profile.curvePoints[offset]?.offsetSeconds ?? 0;
    const band = deriveBand(
      distances,
      windowStep,
      profile.curvePoints,
      totalDuration,
      DEFAULT_BAND_THRESHOLD_PCT,
    );

    ranked.push({
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
    });
  }

  ranked.sort((a, b) => b.confidence - a.confidence);
  return ranked;
}

/**
 * Return the best match ONLY if both gates pass:
 *   1. best.confidence ≥ confidenceThreshold (default 0.70 — legacy gate)
 *   2. best.confidence ≥ marginRatio × runnerUp.confidence (default ×1.05 —
 *      flat-power-ambiguity gate, per the Session 19/20/21 diagnosis above)
 *
 * Returns null when either gate fails. Single-profile case (no runner-up)
 * skips gate 2 and falls back to gate 1 only.
 *
 * Internally calls rankCandidates once — same DTW cost as findBestCandidate,
 * just keeps the second-best score in scope so the margin can be computed.
 */
export function findMatchWithMargin(
  queryReadings: number[],
  profiles: ProfileWithCurve[],
  confidenceThreshold: number = DEFAULT_CONFIDENCE_THRESHOLD,
  marginRatio: number = DEFAULT_CONFIDENCE_MARGIN_RATIO,
): { match: MatchResult | null; rejectionReason: 'low_confidence' | 'low_margin' | null } {
  const ranked = rankCandidates(queryReadings, profiles);
  if (ranked.length === 0) return { match: null, rejectionReason: null };

  const best = ranked[0];
  if (best.confidence < confidenceThreshold) {
    return { match: null, rejectionReason: 'low_confidence' };
  }

  // Single comparable profile — no margin to check.
  if (ranked.length === 1) return { match: best, rejectionReason: null };

  const runnerUp = ranked[1];
  // runnerUp.confidence can legitimately be 0 (zero-distance match across a
  // profile that doesn't fit at all). Treat that as "no realistic competitor"
  // and commit. Otherwise enforce the multiplicative margin.
  if (runnerUp.confidence > 0 && best.confidence < runnerUp.confidence * marginRatio) {
    return { match: null, rejectionReason: 'low_margin' };
  }

  return { match: best, rejectionReason: null };
}

/**
 * v1.6 layered matcher. Three independent gates stacked on top of the
 * legacy DTW-confidence + margin pipeline:
 *
 *   - **Whitelist**: profile candidates filtered to `whitelistIds` BEFORE
 *     DTW runs. NULL = all comparable profiles (legacy behaviour).
 *   - **Bayesian prior**: `posterior = DTW_confidence × prior(profile|plug)`.
 *     The prior comes from `getPlugProfilePrior` over completed sessions.
 *     Posterior is recomputed for every candidate, then rebound onto each
 *     MatchResult's `confidence` field so downstream gates (margin) operate
 *     on the same scale.
 *   - **Energy bound**: candidates whose reference total energy is exceeded
 *     by the current session's delivered Wh are eliminated outright. Cheap
 *     guard — runs after DTW but before margin so a single survivor commits
 *     trivially.
 *
 * Returns the same shape as `findMatchWithMargin` plus a new
 * `'no_candidates'` rejection reason when the whitelist or energy bound
 * filtered everything out.
 */
export function findMatchWithMarginAndPrior(
  queryReadings: number[],
  profiles: ProfileWithCurve[],
  opts: {
    whitelistIds?: number[] | null;
    prior?: Map<number, number>;
    currentSessionWh?: number;
    profileMaxEnergyWh?: Map<number, number>;
    confidenceThreshold?: number;
    marginRatio?: number;
  } = {},
): { match: MatchResult | null; rejectionReason: 'low_confidence' | 'low_margin' | 'no_candidates' | null } {
  const confidenceThreshold = opts.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD;
  const marginRatio = opts.marginRatio ?? DEFAULT_CONFIDENCE_MARGIN_RATIO;

  let candidates = profiles;
  if (opts.whitelistIds && opts.whitelistIds.length > 0) {
    const allow = new Set(opts.whitelistIds);
    candidates = candidates.filter((p) => allow.has(p.id));
  }
  if (opts.currentSessionWh !== undefined && opts.profileMaxEnergyWh) {
    const wh = opts.currentSessionWh;
    const tolerance = 1.1;
    candidates = candidates.filter((p) => {
      const max = opts.profileMaxEnergyWh!.get(p.id);
      return max === undefined || max <= 0 || wh <= max * tolerance;
    });
  }

  if (candidates.length === 0) {
    return { match: null, rejectionReason: 'no_candidates' };
  }

  const ranked = rankCandidates(queryReadings, candidates);
  if (ranked.length === 0) return { match: null, rejectionReason: null };

  // Multiplicative posterior: confidence × prior, then re-sort. Prior of
  // 0 (impossible) effectively eliminates a candidate; prior > 1 (impossible
  // — priors are normalised to 1 across candidates) cannot occur.
  if (opts.prior) {
    for (const r of ranked) {
      const p = opts.prior.get(r.profileId);
      if (p !== undefined) r.confidence = r.confidence * p;
    }
    ranked.sort((a, b) => b.confidence - a.confidence);
  }

  const best = ranked[0];
  if (best.confidence < confidenceThreshold) {
    return { match: null, rejectionReason: 'low_confidence' };
  }

  if (ranked.length === 1) return { match: best, rejectionReason: null };

  const runnerUp = ranked[1];
  if (runnerUp.confidence > 0 && best.confidence < runnerUp.confidence * marginRatio) {
    return { match: null, rejectionReason: 'low_margin' };
  }

  return { match: best, rejectionReason: null };
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
