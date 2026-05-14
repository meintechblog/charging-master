/**
 * Dynamic Time Warping (DTW) for power curve matching.
 *
 * Standard DTW computes alignment distance between two 1D sequences.
 * Subsequence DTW finds the best matching window of a query within a longer reference.
 */

/**
 * Standard DTW distance between two 1D sequences.
 * Returns normalized distance (lower = more similar, 0 = identical).
 */
export function dtwDistance(query: number[], reference: number[]): number {
  const n = query.length;
  const m = reference.length;

  // Cost matrix -- flat Float64Array for performance
  const cost = new Float64Array((n + 1) * (m + 1));
  const w = m + 1;

  // Initialize with infinity
  cost.fill(Infinity);
  cost[0] = 0;

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const d = Math.abs(query[i - 1] - reference[j - 1]);
      cost[i * w + j] = d + Math.min(
        cost[(i - 1) * w + j],       // insertion
        cost[i * w + (j - 1)],       // deletion
        cost[(i - 1) * w + (j - 1)]  // match
      );
    }
  }

  return cost[n * w + m] / Math.max(n, m);
}

/**
 * Result of subsequence DTW: the global best { offset, distance } plus the full
 * per-offset distance vector for downstream confidence-band derivation.
 *
 * distances[k] is the DTW distance at reference offset (k * windowStep). The
 * vector is dense and indexed by step, NOT by reference position — consumers
 * must multiply by windowStep to recover the absolute reference offset.
 *
 * See audiolabs-erlangen MIR C7S2 (Subsequence DTW Δ_DTW(m) row) for the
 * underlying technique: scanning the matching function to find every offset
 * within a relative threshold of the best.
 */
export interface SubsequenceDtwResult {
  offset: number;
  distance: number;
  distances: Float64Array;
  windowStep: number;
}

/**
 * Subsequence DTW: find the best matching window of `query` within `reference`.
 * Slides the query along the reference with configurable step size.
 *
 * Returns SubsequenceDtwResult with both the legacy { offset, distance } and
 * the full distances vector — the latter feeds deriveBand in curve-matcher.ts
 * for confidence-band derivation (Phase 11 SOCB-01).
 *
 * Degenerate inputs (empty query, query longer than reference) return
 * { offset: 0, distance: Infinity, distances: new Float64Array(0), windowStep }.
 */
export function subsequenceDtw(
  query: number[],
  reference: number[],
  windowStep: number = 5
): SubsequenceDtwResult {
  const queryLen = query.length;
  const refLen = reference.length;

  if (queryLen === 0 || queryLen > refLen) {
    return { offset: 0, distance: Infinity, distances: new Float64Array(0), windowStep };
  }

  const numOffsets = Math.max(0, Math.floor((refLen - queryLen) / windowStep) + 1);
  const distances = new Float64Array(numOffsets);

  let bestOffset = 0;
  let bestDistance = Infinity;
  let idx = 0;

  // Slide query window along reference
  for (let offset = 0; offset <= refLen - queryLen; offset += windowStep) {
    const refWindow = reference.slice(offset, offset + queryLen);
    const dist = dtwDistance(query, refWindow);
    distances[idx++] = dist;

    if (dist < bestDistance) {
      bestDistance = dist;
      bestOffset = offset;
    }
  }

  return { offset: bestOffset, distance: bestDistance, distances, windowStep };
}
