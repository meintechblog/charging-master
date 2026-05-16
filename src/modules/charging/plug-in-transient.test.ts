import { describe, it, expect } from 'vitest';
import {
  extractTransientFeatures,
  compareTransientFeatures,
  type TransientSample,
} from './plug-in-transient';

function makeSamples(apowers: number[], startTs = 1_000_000): TransientSample[] {
  return apowers.map((apower, i) => ({ ts: startTs + i * 1000, apower }));
}

describe('extractTransientFeatures', () => {
  it('returns sane defaults for empty input', () => {
    const f = extractTransientFeatures([]);
    expect(f.peakInrushW).toBe(0);
    expect(f.tToStableSeconds).toBe(0);
    expect(f.oscillationCount).toBe(0);
  });

  it('detects peak from a single-sample inrush', () => {
    const samples = makeSamples([100, 40, 40, 40, 40, 40, 40, 40, 40, 40]);
    const f = extractTransientFeatures(samples);
    expect(f.peakInrushW).toBe(100);
    expect(f.settlingFractionOfPeak).toBeCloseTo(0.4, 1);
  });

  it('flat input collapses to stable immediately', () => {
    const samples = makeSamples(new Array(20).fill(40));
    const f = extractTransientFeatures(samples);
    expect(f.peakInrushW).toBe(40);
    expect(f.tToStableSeconds).toBe(0);
    expect(f.settlingFractionOfPeak).toBeCloseTo(1.0);
    expect(f.oscillationCount).toBe(0);
  });

  it('counts oscillations in the first 10 samples', () => {
    // sawtooth in first 10: 40, 35, 40, 35, 40, 35, 40, 35, 40, 40 → 7 sign-flips
    const oscPart = [40, 35, 40, 35, 40, 35, 40, 35, 40, 40];
    const flatPart = new Array(20).fill(40);
    const f = extractTransientFeatures(makeSamples([...oscPart, ...flatPart]));
    expect(f.oscillationCount).toBeGreaterThan(4);
  });

  it('computes ramp slope from start to stable window', () => {
    // Ramp 0→40 over 5 s, then flat. Slope = 40/5 = 8 W/s.
    const samples = makeSamples([0, 10, 20, 30, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40]);
    const f = extractTransientFeatures(samples);
    expect(f.peakInrushW).toBe(40);
    expect(f.tToStableSeconds).toBeGreaterThan(0);
    expect(f.rampSlopeWPerSec).toBeGreaterThan(2);
  });

  it('settlingFractionOfPeak distinguishes "inrush then drop" from "flat all the way"', () => {
    const inrushDrop = makeSamples([
      100, 80, 60, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40,
    ]);
    const flat = makeSamples(new Array(15).fill(40));
    const fA = extractTransientFeatures(inrushDrop);
    const fB = extractTransientFeatures(flat);
    expect(fA.settlingFractionOfPeak).toBeLessThan(fB.settlingFractionOfPeak);
  });
});

describe('compareTransientFeatures', () => {
  const iPadLike = extractTransientFeatures(
    makeSamples([5, 30, 38, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40]),
  );
  const eBikeLike = extractTransientFeatures(
    makeSamples([10, 80, 130, 170, 180, 180, 180, 180, 180, 180, 180, 180, 180, 180, 180]),
  );

  it('identical feature vectors score 1.0', () => {
    expect(compareTransientFeatures(iPadLike, iPadLike)).toBeCloseTo(1.0, 1);
  });

  it('iPad vs eBike scores meaningfully below same-class similarity', () => {
    // 40 W vs 180 W is a clear cross-class mismatch; the matcher uses this
    // as a multiplicative boost (NOT a hard cutoff). Same-class pairs score
    // > 0.85 (see test below), so anything noticeably under that band is
    // already discriminative. Empirical: ~0.50.
    const score = compareTransientFeatures(iPadLike, eBikeLike);
    expect(score).toBeLessThan(0.6);
  });

  it('reverse direction is symmetric', () => {
    const a = compareTransientFeatures(iPadLike, eBikeLike);
    const b = compareTransientFeatures(eBikeLike, iPadLike);
    expect(a).toBeCloseTo(b, 2);
  });

  it('two similar iPad-like profiles score high', () => {
    // 38 W steady-state vs 40 W steady-state, same shape — should remain
    // well above 0.8 (the device is "probably the same family").
    const iPadVariant = extractTransientFeatures(
      makeSamples([4, 28, 36, 38, 38, 38, 38, 38, 38, 38, 38, 38, 38, 38, 38]),
    );
    expect(compareTransientFeatures(iPadLike, iPadVariant)).toBeGreaterThan(0.85);
  });
});
