import { describe, it, expect, vi } from 'vitest';

// `server-only` throws in non-Next bundlers. Stub it to a no-op so vitest can
// import the loader / match modules.
vi.mock('server-only', () => ({}));

const { findMatches, resamplePower } = await import('./match');
const { loadCurvePoints, loadIndex } = await import('./loader');
import type { CurvePoint } from './types';

describe('resamplePower', () => {
  it('returns N evenly-spaced linear-interp samples', () => {
    const pts: CurvePoint[] = [
      { offsetSeconds: 0, apower: 10 },
      { offsetSeconds: 10, apower: 20 },
    ];
    const out = resamplePower(pts, 11);
    expect(out).toHaveLength(11);
    expect(out[0]).toBe(10);
    expect(out[10]).toBe(20);
    expect(out[5]).toBeCloseTo(15, 5);
  });

  it('handles degenerate single point', () => {
    const out = resamplePower([{ offsetSeconds: 0, apower: 7 }], 5);
    expect(out).toEqual([7, 7, 7, 7, 7]);
  });

  it('handles zero span (all same offset)', () => {
    const out = resamplePower(
      [
        { offsetSeconds: 5, apower: 3 },
        { offsetSeconds: 5, apower: 4 },
      ],
      4,
    );
    // span = 0 → constant fallback at first value
    expect(out).toEqual([3, 3, 3, 3]);
  });

  it('returns [] for empty input', () => {
    expect(resamplePower([], 10)).toEqual([]);
  });
});

describe('findMatches (against real seed catalog)', () => {
  it('finds the seed catalog (sanity)', () => {
    const idx = loadIndex();
    expect(idx).not.toBeNull();
    expect(idx!.profiles.length).toBeGreaterThanOrEqual(5);
  });

  it('a curve scored against itself yields similarity ≥ 0.99', () => {
    const idx = loadIndex();
    expect(idx).not.toBeNull();
    const seedId = idx!.profiles[0].id;
    const points = loadCurvePoints(seedId);
    expect(points.length).toBeGreaterThan(10);

    const results = findMatches(points, { topN: 3, minSimilarity: 0.5 });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].catalogId).toBe(seedId);
    expect(results[0].similarity).toBeGreaterThanOrEqual(0.99);
  });

  it('similar but noisier curve still matches the right entry highest', () => {
    const idx = loadIndex();
    const seedId = idx!.profiles[0].id;
    const points = loadCurvePoints(seedId);
    // Add 2% gaussian-ish noise (cheap deterministic perturbation)
    const noisy = points.map((p, i) => ({
      offsetSeconds: p.offsetSeconds,
      apower: Math.max(0, p.apower * (1 + 0.02 * Math.sin(i * 0.5))),
    }));
    const results = findMatches(noisy, { topN: 3, minSimilarity: 0.5 });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].catalogId).toBe(seedId);
    expect(results[0].similarity).toBeGreaterThan(0.85);
  });

  it('rejects empty / single-point queries', () => {
    expect(findMatches([])).toEqual([]);
    expect(findMatches([{ offsetSeconds: 0, apower: 5 }])).toEqual([]);
  });

  it('filters out matches outside the default peakRatio window', () => {
    const idx = loadIndex();
    expect(idx).not.toBeNull();
    // Build a curve with the SAME shape as the seed[0] but 10x the peak.
    // Default peakRatio window is [0.5, 2] — 10x should be filtered out.
    const seedId = idx!.profiles[0].id;
    const points = loadCurvePoints(seedId);
    const scaled = points.map((p) => ({
      offsetSeconds: p.offsetSeconds,
      apower: p.apower * 10,
    }));
    const results = findMatches(scaled, { topN: 5, minSimilarity: 0.5 });
    // The seed entry itself would shape-match perfectly but peakRatio=10 is
    // outside [0.5, 2].
    expect(results.find((r) => r.catalogId === seedId)).toBeUndefined();
  });

  it('peakRatio window can be widened explicitly', () => {
    const idx = loadIndex();
    const seedId = idx!.profiles[0].id;
    const points = loadCurvePoints(seedId);
    const scaled = points.map((p) => ({
      offsetSeconds: p.offsetSeconds,
      apower: p.apower * 10,
    }));
    const results = findMatches(scaled, {
      topN: 5,
      minSimilarity: 0.5,
      peakRatioMin: 0,
      peakRatioMax: Infinity,
    });
    // With the filter disabled, the self-match comes back at peakRatio=10
    const self = results.find((r) => r.catalogId === seedId);
    expect(self).toBeDefined();
    expect(self!.peakRatio).toBeCloseTo(10, 1);
  });

  it('does not surface matches below minSimilarity', () => {
    // Flat low-power curve unlike anything in the seed (all 0.5W for 1h)
    const flat: CurvePoint[] = Array.from({ length: 100 }, (_, i) => ({
      offsetSeconds: i * 36,
      apower: 0.5,
    }));
    const results = findMatches(flat, { topN: 5, minSimilarity: 0.95 });
    // The shape is suspiciously matching SOME profile in unnormalized space
    // but the 0.95 floor should filter most or all of them.
    // We don't assert empty (depends on seed shapes) — only that we honor
    // the minSimilarity floor.
    for (const r of results) {
      expect(r.similarity).toBeGreaterThanOrEqual(0.95);
    }
  });
});

describe('isCatalogEnabled gate via loader id safety', () => {
  it('loader.loadProfile rejects unsafe ids (path traversal etc.)', async () => {
    const { loadProfile, loadCharger } = await import('./loader');
    expect(loadProfile('../../../etc/passwd')).toBeNull();
    expect(loadProfile('zzzzzzzzzzzzzzzz')).toBeNull(); // valid format but no file
    expect(loadProfile('not-hex-at-all')).toBeNull();
    expect(loadCharger('/')).toBeNull();
  });
});
