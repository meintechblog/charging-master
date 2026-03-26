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
 * Subsequence DTW: find the best matching window of `query` within `reference`.
 * Slides the query along the reference with configurable step size.
 * Returns { offset, distance } where offset is the starting index in reference.
 */
export function subsequenceDtw(
  query: number[],
  reference: number[],
  windowStep: number = 5
): { offset: number; distance: number } {
  const queryLen = query.length;
  const refLen = reference.length;

  let bestOffset = 0;
  let bestDistance = Infinity;

  // Slide query window along reference
  for (let offset = 0; offset <= refLen - queryLen; offset += windowStep) {
    const refWindow = reference.slice(offset, offset + queryLen);
    const dist = dtwDistance(query, refWindow);

    if (dist < bestDistance) {
      bestDistance = dist;
      bestOffset = offset;
    }
  }

  return { offset: bestOffset, distance: bestDistance };
}
