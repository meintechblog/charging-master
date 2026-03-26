import { describe, it, expect } from 'vitest';
import { computeSocBoundaries, estimateSoc } from './soc-estimator';

describe('computeSocBoundaries', () => {
  it('produces 10 boundaries (10%..100%) from curve points', () => {
    // Simulate a linear charge curve: 100 points over 1000 seconds, 0-500 Wh
    const curvePoints = Array.from({ length: 100 }, (_, i) => ({
      offsetSeconds: i * 10,
      cumulativeWh: i * 5,
      apower: 18, // ~18W average
    }));

    const boundaries = computeSocBoundaries(curvePoints);
    expect(boundaries).toHaveLength(10);
    expect(boundaries[0].soc).toBe(10);
    expect(boundaries[9].soc).toBe(100);

    // Each boundary should have increasing cumulativeWh
    for (let i = 1; i < boundaries.length; i++) {
      expect(boundaries[i].cumulativeWh).toBeGreaterThan(boundaries[i - 1].cumulativeWh);
    }
  });

  it('handles non-linear energy distribution', () => {
    // Quadratic energy curve (accelerating charge)
    const curvePoints = Array.from({ length: 50 }, (_, i) => ({
      offsetSeconds: i * 20,
      cumulativeWh: (i / 49) * (i / 49) * 1000,
      apower: i * 2,
    }));

    const boundaries = computeSocBoundaries(curvePoints);
    expect(boundaries).toHaveLength(10);
    // 10% boundary should be earlier in time relative to linear
    expect(boundaries[0].soc).toBe(10);
    expect(boundaries[9].soc).toBe(100);
  });
});

describe('estimateSoc', () => {
  it('returns 0 when cumulativeWh is 0', () => {
    expect(estimateSoc(0, 500)).toBe(0);
  });

  it('returns 50 when cumulativeWh is half of totalWh', () => {
    expect(estimateSoc(250, 500)).toBe(50);
  });

  it('returns 100 when cumulativeWh >= totalWh', () => {
    expect(estimateSoc(500, 500)).toBe(100);
    expect(estimateSoc(600, 500)).toBe(100);
  });

  it('handles partial charges (startSoc > 0)', () => {
    // Starting at 50%, need to charge remaining 50%
    // If totalWh is 500 (full charge), remaining capacity is 250 Wh
    // At 125 Wh consumed, should be at ~75%
    const result = estimateSoc(125, 500, 50);
    expect(result).toBe(75);
  });

  it('clamps result to 0-100', () => {
    expect(estimateSoc(-10, 500)).toBe(0);
    expect(estimateSoc(1000, 500)).toBe(100);
    expect(estimateSoc(1000, 500, 50)).toBe(100);
  });
});
