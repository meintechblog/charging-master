import 'server-only';
import { dtwDistance } from '@/modules/charging/dtw';
import { loadIndex, loadCurvePoints } from './loader';
import type { CatalogMatch, CurvePoint } from './types';

const RESAMPLE_N = 100; // points each curve is reduced to before DTW
const SIMILARITY_FLOOR = 0.6; // suppress matches below this score
const TOP_N_DEFAULT = 5;

/**
 * Find catalog profiles whose normalized shape resembles `query`.
 *
 * Both curves are linearly resampled to RESAMPLE_N points and scaled to
 * peak=1 before DTW. Returns up to `topN` matches sorted by similarity desc.
 * Matches with similarity < SIMILARITY_FLOOR are dropped.
 */
export function findMatches(
  query: CurvePoint[],
  opts: { topN?: number; minSimilarity?: number } = {}
): CatalogMatch[] {
  const idx = loadIndex();
  if (!idx || idx.profiles.length === 0) return [];
  if (query.length < 2) return [];

  const sorted = query.slice().sort((a, b) => a.offsetSeconds - b.offsetSeconds);
  const qResampled = resamplePower(sorted, RESAMPLE_N);
  const qPeak = peak(qResampled);
  if (qPeak <= 0) return [];
  const qNorm = qResampled.map((v) => v / qPeak);

  const topN = opts.topN ?? TOP_N_DEFAULT;
  const minSim = opts.minSimilarity ?? SIMILARITY_FLOOR;

  const matches: CatalogMatch[] = [];
  for (const entry of idx.profiles) {
    const cPts = loadCurvePoints(entry.id);
    if (cPts.length < 2) continue;
    const cResampled = resamplePower(cPts, RESAMPLE_N);
    const cPeak = peak(cResampled);
    if (cPeak <= 0) continue;
    const cNorm = cResampled.map((v) => v / cPeak);

    const d = dtwDistance(qNorm, cNorm); // 0..~1 on normalized curves
    const similarity = Math.max(0, 1 - d);
    if (similarity < minSim) continue;

    matches.push({
      catalogId: entry.id,
      name: entry.name,
      manufacturer: entry.manufacturer,
      modelName: entry.modelName,
      similarity,
      peakRatio: qPeak / cPeak,
    });
  }

  matches.sort((a, b) => b.similarity - a.similarity);
  return matches.slice(0, topN);
}

/**
 * Linear-interpolate `points` (sorted by offsetSeconds) to N evenly-spaced
 * power samples between the first and last offset.
 */
export function resamplePower(points: CurvePoint[], n: number): number[] {
  if (points.length === 0) return [];
  if (points.length === 1) return new Array(n).fill(points[0].apower);

  const first = points[0].offsetSeconds;
  const last = points[points.length - 1].offsetSeconds;
  const span = last - first;
  if (span <= 0) return new Array(n).fill(points[0].apower);

  const out = new Array<number>(n);
  let j = 0;
  for (let i = 0; i < n; i++) {
    const t = first + (i * span) / (n - 1);
    while (j + 1 < points.length && points[j + 1].offsetSeconds < t) j++;
    if (j + 1 >= points.length) {
      out[i] = points[points.length - 1].apower;
      continue;
    }
    const a = points[j];
    const b = points[j + 1];
    const denom = b.offsetSeconds - a.offsetSeconds;
    if (denom <= 0) {
      out[i] = a.apower;
      continue;
    }
    const f = (t - a.offsetSeconds) / denom;
    out[i] = a.apower + (b.apower - a.apower) * f;
  }
  return out;
}

function peak(values: number[]): number {
  let m = 0;
  for (const v of values) if (v > m) m = v;
  return m;
}
