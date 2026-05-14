import { describe, it, expect } from 'vitest';

import {
  DEFAULT_BAND_THRESHOLD_PCT,
  deriveBand,
  findBestCandidate,
  type ProfileWithCurve,
} from './curve-matcher';
import { subsequenceDtw } from './dtw';
import ipadFixture from './fixtures/ipad-reference-curve.json';

type CurvePoint = ProfileWithCurve['curvePoints'][number];

// Inline synthetic-iPad-shaped generator. The committed JSON fixture is the
// full-scale variant; this helper produces tiny variants for fast unit runs.
function makeFlatThenTaperProfile(
  flatLen: number,
  taperLen: number,
  flatPower: number,
  minPower: number,
): { profile: ProfileWithCurve; totalDurationSeconds: number } {
  const points: CurvePoint[] = [];
  let cumulativeWh = 0;
  for (let t = 0; t < flatLen; t++) {
    cumulativeWh += flatPower / 3600;
    points.push({ offsetSeconds: t, apower: flatPower, cumulativeWh });
  }
  for (let i = 0; i < taperLen; i++) {
    const frac = i / Math.max(1, taperLen - 1);
    const apower = flatPower + frac * (minPower - flatPower);
    cumulativeWh += apower / 3600;
    points.push({ offsetSeconds: flatLen + i, apower, cumulativeWh });
  }
  const totalDurationSeconds = points[points.length - 1].offsetSeconds;
  const profile: ProfileWithCurve = {
    id: 9999,
    name: 'synthetic-flat-then-taper',
    curve: {
      startPower: flatPower,
      durationSeconds: totalDurationSeconds,
      totalEnergyWh: cumulativeWh,
    },
    curvePoints: points,
  };
  return { profile, totalDurationSeconds };
}

function ipadFixtureProfile(): { profile: ProfileWithCurve; totalDurationSeconds: number } {
  const profile: ProfileWithCurve = {
    id: ipadFixture.profileId,
    name: 'ipad-fixture',
    curve: {
      startPower: ipadFixture.points[0].apower,
      durationSeconds: ipadFixture.durationSeconds,
      totalEnergyWh: ipadFixture.totalEnergyWh,
    },
    curvePoints: ipadFixture.points,
  };
  return { profile, totalDurationSeconds: ipadFixture.durationSeconds };
}

describe('deriveBand (pure helper)', () => {
  it('returns full-uncertainty band on empty distances', () => {
    const band = deriveBand(new Float64Array(0), 1, [], 0, 0.15);
    expect(band).toEqual({ socMin: 0, socMax: 100, socBest: 0, bandConfidence: 0 });
  });

  it('selects only offsets within (1 + threshold) * best on a hand-crafted distances array', () => {
    // distances=[10,11,12,1000,1000,1000], threshold=0.20 → cutoff=12, only 0..2 plausible
    const distances = new Float64Array([10, 11, 12, 1000, 1000, 1000]);
    // curvePoints: 6 evenly-spaced points across 100 s, so each step is 16.6 s ≈ 16-17 %
    const curvePoints: CurvePoint[] = [
      { offsetSeconds: 0, apower: 0, cumulativeWh: 0 },
      { offsetSeconds: 20, apower: 0, cumulativeWh: 0 },
      { offsetSeconds: 40, apower: 0, cumulativeWh: 0 },
      { offsetSeconds: 60, apower: 0, cumulativeWh: 0 },
      { offsetSeconds: 80, apower: 0, cumulativeWh: 0 },
      { offsetSeconds: 100, apower: 0, cumulativeWh: 0 },
    ];

    const band = deriveBand(distances, 1, curvePoints, 100, 0.20);

    expect(band.socBest).toBe(0);
    expect(band.socMin).toBe(0);
    expect(band.socMax).toBe(40);
  });

  it('bandConfidence is 0 when band fully spans 0..100, and 1 when collapsed to a point', () => {
    const cps: CurvePoint[] = [
      { offsetSeconds: 0, apower: 0, cumulativeWh: 0 },
      { offsetSeconds: 50, apower: 0, cumulativeWh: 0 },
      { offsetSeconds: 100, apower: 0, cumulativeWh: 0 },
    ];

    const wide = deriveBand(new Float64Array([1, 1, 1]), 1, cps, 100, 0.5);
    expect(wide.socMin).toBe(0);
    expect(wide.socMax).toBe(100);
    expect(wide.bandConfidence).toBe(0);

    const tight = deriveBand(new Float64Array([1, 1000, 1000]), 1, cps, 100, 0.0);
    expect(tight.socMin).toBe(tight.socMax);
    expect(tight.bandConfidence).toBe(1);
  });
});

describe('findBestCandidate — confidence band on synthetic curve', () => {
  it('produces a wide band on a flat-power query (small synthetic variant)', () => {
    const { profile } = makeFlatThenTaperProfile(300, 300, 40, 5);
    const query = Array.from({ length: 30 }, () => 40);

    const result = findBestCandidate(query, [profile]);

    expect(result).not.toBeNull();
    expect(result?.socMin).toBeDefined();
    expect(result?.socMax).toBeDefined();
    // Flat-region match is ambiguous: every offset in the flat plateau matches
    // equally well, so socMin should include the very start (0 %) and
    // socMax should reach at least ~40 % (the flat region ends at 50 %).
    expect(result!.socMin!).toBeLessThanOrEqual(5);
    expect(result!.socMax!).toBeGreaterThanOrEqual(40);
    expect(result!.socMax! - result!.socMin!).toBeGreaterThanOrEqual(20);
  });

  it('collapses the band on a taper-matching query (small synthetic variant)', () => {
    const { profile } = makeFlatThenTaperProfile(300, 300, 40, 5);
    // 30-sample steep taper matches a unique slice of the taper region
    const query = Array.from({ length: 30 }, (_, i) => 25 - i * 0.5);

    const result = findBestCandidate(query, [profile]);

    expect(result).not.toBeNull();
    expect(result!.socMax! - result!.socMin!).toBeLessThanOrEqual(10);
  });

  it('preserves estimatedStartSoc === socBest (back-compat alias)', () => {
    const { profile } = makeFlatThenTaperProfile(300, 300, 40, 5);
    const query = Array.from({ length: 30 }, () => 40);

    const result = findBestCandidate(query, [profile]);

    expect(result).not.toBeNull();
    expect(result!.estimatedStartSoc).toBe(result!.socBest);
  });

  it('returns null on empty query or empty profile list (existing behavior)', () => {
    expect(findBestCandidate([], [])).toBeNull();
    expect(findBestCandidate([1, 2, 3], [])).toBeNull();

    const { profile } = makeFlatThenTaperProfile(300, 300, 40, 5);
    expect(findBestCandidate([], [profile])).toBeNull();
  });
});

describe('findBestCandidate — synthetic-iPad-shaped fixture property tests', () => {
  it('band width is wide on flat query and narrow on taper query (non-increasing)', () => {
    const { profile } = ipadFixtureProfile();

    const flatQuery = Array.from({ length: 60 }, () => 40);
    const flatResult = findBestCandidate(flatQuery, [profile]);
    expect(flatResult).not.toBeNull();
    const flatWidth = flatResult!.socMax! - flatResult!.socMin!;
    expect(flatWidth).toBeGreaterThanOrEqual(15);

    // Taper query — 60 samples on a moderately steep descending slope
    const taperQuery = Array.from({ length: 60 }, (_, i) => 10 - i * (5 / 60));
    const taperResult = findBestCandidate(taperQuery, [profile]);
    expect(taperResult).not.toBeNull();
    const taperWidth = taperResult!.socMax! - taperResult!.socMin!;
    expect(taperWidth).toBeLessThanOrEqual(10);

    // Property: band width is non-increasing as the query moves from flat to taper
    expect(taperWidth).toBeLessThanOrEqual(flatWidth);
  });
});

describe('DEFAULT_BAND_THRESHOLD_PCT empirical calibration sweep (B1 / RESEARCH Pitfall 4)', () => {
  // This test IS the source of truth for the exported default. The constant
  // is pinned to the smallest threshold in the sweep that collapses the
  // synthetic-iPad-shaped band to ≤ 5 % in the taper region. If no threshold
  // satisfies, the test FAILS and the plan is blocked (per B1).
  it('finds the smallest threshold collapsing the band ≤ 5 % in taper and matches DEFAULT_BAND_THRESHOLD_PCT', () => {
    const { profile, totalDurationSeconds } = ipadFixtureProfile();
    // Build a taper-region query that is the same shape used in the property
    // test above so the calibration matches what consumers will actually see.
    const taperQuery = Array.from({ length: 60 }, (_, i) => 10 - i * (5 / 60));
    const referencePowers = profile.curvePoints.map((p) => p.apower);

    const dtwResult = subsequenceDtw(taperQuery, referencePowers);

    const thresholds = [0.05, 0.10, 0.15, 0.20, 0.30];
    const sweep = thresholds.map((threshold) => {
      const band = deriveBand(
        dtwResult.distances,
        dtwResult.windowStep,
        profile.curvePoints,
        totalDurationSeconds,
        threshold,
      );
      return { threshold, bandWidth: band.socMax - band.socMin };
    });

    // Surface the sweep so a failure prints the table that informs B1
    // eslint-disable-next-line no-console
    console.log('[calibration-sweep]', sweep);

    const winning = sweep.find((row) => row.bandWidth <= 5);
    expect(winning).toBeDefined();
    expect(DEFAULT_BAND_THRESHOLD_PCT).toBe(winning!.threshold);
  });
});
