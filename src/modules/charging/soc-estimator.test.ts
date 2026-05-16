import { describe, it, expect } from 'vitest';
import { computeSocBoundaries, estimateSoc, estimateSocTaperAware, TAPER_THRESHOLD_FRACTION } from './soc-estimator';

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

describe('estimateSocTaperAware — v1.5 taper-aware SoC', () => {
  // Synthetic iPad-shaped curve: flat 40W for 1000 s (CC), tapering linearly
  // 40 → 5W over the last 500 s. Total points spaced every 1 s.
  const iPadLikeCurve = (() => {
    const points = [];
    for (let t = 0; t < 1000; t++) points.push({ offsetSeconds: t, apower: 40 });
    for (let t = 0; t < 500; t++) {
      const apower = 40 - (t / 499) * 35;
      points.push({ offsetSeconds: 1000 + t, apower });
    }
    return points;
  })();
  const totalDurationSeconds = 1499;
  const peakPower = 40;
  const totalWh = 16; // not critical for the taper branch

  it('uses energy math while apower stays above the taper gate', () => {
    const result = estimateSocTaperAware({
      apower: 40,                              // 100 % of peak → CC region
      peakPower,
      currentWh: 5,
      totalWh,
      startSoc: 0,
      curvePoints: iPadLikeCurve,
      totalDurationSeconds,
    });
    expect(result.method).toBe('energy');
    expect(result.soc).toBe(estimateSoc(5, totalWh, 0));
  });

  it('switches to curve-position SoC when apower drops into taper', () => {
    // Pick a taper reading. apower=20 is mid-taper region.
    // Linear taper: 40 → 5 over offsets 1000..1499. apower=20 → offset ≈ 1000 + 285 = 1285 → SoC ≈ 1285/1499 ≈ 86%.
    const result = estimateSocTaperAware({
      apower: 20,
      peakPower,
      currentWh: 1,                            // tiny — energy math would say SoC≈6%
      totalWh,
      startSoc: 0,
      curvePoints: iPadLikeCurve,
      totalDurationSeconds,
    });
    expect(result.method).toBe('taper');
    // Curve-derived SoC dominates the trivial energy estimate.
    expect(result.soc).toBeGreaterThan(80);
    expect(result.soc).toBeLessThan(95);
  });

  it('honours the monotonic-SoC invariant — never reports BELOW energy estimate', () => {
    // Force a contrived case where energy estimate > taper estimate.
    // apower=25 < taper gate (40 × 0.7 = 28) → taper branch active.
    // Linear taper 40→5 over offsets 1000..1499: apower=25 → offset ≈ 1214
    // → taperSoc ≈ 1214/1499 = 81%. Push energy higher than that.
    const result = estimateSocTaperAware({
      apower: 25,
      peakPower,
      currentWh: 15.5,                         // energy math says ~97%
      totalWh,
      startSoc: 0,
      curvePoints: iPadLikeCurve,
      totalDurationSeconds,
    });
    expect(result.method).toBe('taper');
    expect(result.soc).toBeGreaterThanOrEqual(estimateSoc(15.5, totalWh, 0));
  });

  it('falls back to energy math when no taper point matches within 5W', () => {
    // Reading is 50W — above peak (no curve point that high anywhere).
    // The function won't even enter the taper branch since apower > taper gate.
    const result = estimateSocTaperAware({
      apower: 50,
      peakPower,
      currentWh: 4,
      totalWh,
      startSoc: 0,
      curvePoints: iPadLikeCurve,
      totalDurationSeconds,
    });
    expect(result.method).toBe('energy');
  });

  it('exports TAPER_THRESHOLD_FRACTION at the agreed default', () => {
    // 0.7 chosen for iPad CC ~40W with peak 44.6W → CC stays at 90% of peak,
    // taper kicks in well below 0.7×peak (= 31W for iPad). Changing this
    // requires re-running scripts/diagnose/replay-session.ts.
    expect(TAPER_THRESHOLD_FRACTION).toBe(0.7);
  });
});
