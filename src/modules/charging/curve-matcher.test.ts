import { describe, it, expect } from 'vitest';

import {
  DEFAULT_BAND_THRESHOLD_PCT,
  DEFAULT_CONFIDENCE_MARGIN_RATIO,
  deriveBand,
  findBestCandidate,
  findMatchWithMargin,
  findMatchWithMarginAndPrior,
  type ProfileWithCurve,
} from './curve-matcher';
import { subsequenceDtw } from './dtw';
import ipadFixture from './fixtures/ipad-reference-curve.json';
import session14 from './fixtures/ipad-session-14-readings.json';

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

describe('DEFAULT_BAND_THRESHOLD_PCT empirical calibration sweep (B1 / RESEARCH Pitfall 4 / 260515 real-data calibration)', () => {
  // Dual-criterion calibration. The exported constant must satisfy BOTH:
  //
  //   (A) Taper precision — synthetic-iPad taper query against the synthetic
  //       reference curve collapses the band to ≤ 5. If this fails, the
  //       threshold is too LOOSE: the taper region no longer uniquely
  //       localizes and consumers see falsely wide bands in the precision
  //       phase.
  //
  //   (B) Flat-region honest uncertainty — first 120 readings (~10 min at 5 s
  //       polling) of real production Session 14 against the same synthetic
  //       reference curve yield bandwidth ≥ 10. If this fails, the threshold
  //       is too TIGHT: flat-region matching collapses to a point — the
  //       false-confidence anti-pattern that motivated v1.3.1.
  //
  // Plan 11-01 originally pinned 0.05 by picking the smallest threshold
  // satisfying (A) alone. A real-data sweep on 192.168.3.185 (profile_id=4,
  // Session 14) showed 0.05 collapsed the band to Δ=0 on real flat power.
  // The constant moved to 0.20; both criteria hold there. Lowering it back
  // toward 0.10/0.05 will eventually fail Criterion B; raising it past ~0.30
  // risks failing Criterion A.
  //
  // The test consumes `DEFAULT_BAND_THRESHOLD_PCT` directly — it must NOT
  // hardcode the value. A future calibration can move the constant without
  // touching this test as long as both criteria still pass at the new value.
  it('enforces both taper-precision (Criterion A) and flat-region honest-uncertainty (Criterion B) at DEFAULT_BAND_THRESHOLD_PCT', () => {
    const { profile, totalDurationSeconds } = ipadFixtureProfile();
    const referencePowers = profile.curvePoints.map((p) => p.apower);

    // --- Diagnostic sweep over both queries (kept for failure debugging) ---
    const thresholds = [0.05, 0.10, 0.15, 0.20, 0.30];
    const taperQuery = Array.from({ length: 60 }, (_, i) => 10 - i * (5 / 60));
    const flatQuery = session14.readings.slice(0, 120).map((r) => r.apower);

    const taperDtw = subsequenceDtw(taperQuery, referencePowers);
    const flatDtw = subsequenceDtw(flatQuery, referencePowers);

    const sweep = thresholds.map((threshold) => {
      const taperBand = deriveBand(
        taperDtw.distances,
        taperDtw.windowStep,
        profile.curvePoints,
        totalDurationSeconds,
        threshold,
      );
      const flatBand = deriveBand(
        flatDtw.distances,
        flatDtw.windowStep,
        profile.curvePoints,
        totalDurationSeconds,
        threshold,
      );
      return {
        threshold,
        taperBandWidth: taperBand.socMax - taperBand.socMin,
        flatBandWidth: flatBand.socMax - flatBand.socMin,
      };
    });

    console.log('[calibration-sweep]', sweep);

    // --- Criterion A: taper precision at the current constant ---
    const taperBandAtConstant = deriveBand(
      taperDtw.distances,
      taperDtw.windowStep,
      profile.curvePoints,
      totalDurationSeconds,
      DEFAULT_BAND_THRESHOLD_PCT,
    );
    const taperWidth = taperBandAtConstant.socMax - taperBandAtConstant.socMin;
    expect(taperWidth).toBeLessThanOrEqual(5);

    // --- Criterion B: real flat-region honest uncertainty at the current constant ---
    const flatBandAtConstant = deriveBand(
      flatDtw.distances,
      flatDtw.windowStep,
      profile.curvePoints,
      totalDurationSeconds,
      DEFAULT_BAND_THRESHOLD_PCT,
    );
    const flatWidth = flatBandAtConstant.socMax - flatBandAtConstant.socMin;
    expect(flatWidth).toBeGreaterThanOrEqual(10);
  });
});

describe('findMatchWithMargin — v1.5 flat-power-ambiguity gate', () => {
  // Two structurally-similar profiles, both with a flat 40W region. A query
  // matching that flat region produces near-identical DTW distances on both —
  // exactly the Session 19/20/21 production failure mode.
  function makeFlatProfile(id: number, name: string, flatLen: number): ProfileWithCurve {
    const points: CurvePoint[] = [];
    let cumulativeWh = 0;
    for (let t = 0; t < flatLen; t++) {
      cumulativeWh += 40 / 3600;
      points.push({ offsetSeconds: t, apower: 40, cumulativeWh });
    }
    return {
      id,
      name,
      curve: { startPower: 40, durationSeconds: flatLen, totalEnergyWh: cumulativeWh },
      curvePoints: points,
    };
  }

  it('rejects the match with low_margin when two profiles tie within ×1.05', () => {
    const profileA = makeFlatProfile(10, 'flat-A', 600);
    const profileB = makeFlatProfile(11, 'flat-B', 600);
    const query = new Array(30).fill(40);

    const result = findMatchWithMargin(query, [profileA, profileB], 0.7, 1.05);
    expect(result.match).toBeNull();
    expect(result.rejectionReason).toBe('low_margin');
  });

  it('commits the match when the winner clearly out-confidences the runner-up', () => {
    // profileA matches 40W exactly; profileB is 100W everywhere — DTW distance
    // for B is huge, confidence near 0. Margin trivially exceeded.
    const profileA = makeFlatProfile(10, 'flat-A', 600);
    const profileB = makeFlatProfile(11, 'flat-B', 600);
    profileB.curvePoints = profileB.curvePoints.map((p) => ({ ...p, apower: 100 }));
    const query = new Array(30).fill(40);

    const result = findMatchWithMargin(query, [profileA, profileB], 0.7, 1.05);
    expect(result.match).not.toBeNull();
    expect(result.match!.profileId).toBe(10);
    expect(result.rejectionReason).toBeNull();
  });

  it('rejects when no profile clears the confidence floor', () => {
    const profile = makeFlatProfile(10, 'flat', 600);
    const query = new Array(30).fill(200); // wildly off the profile's 40W

    const result = findMatchWithMargin(query, [profile], 0.7, 1.05);
    expect(result.match).toBeNull();
    expect(result.rejectionReason).toBe('low_confidence');
  });

  it('falls back to single-profile commit when only one profile is comparable', () => {
    const profile = makeFlatProfile(10, 'flat', 600);
    const query = new Array(30).fill(40);

    const result = findMatchWithMargin(query, [profile], 0.7, 1.05);
    expect(result.match).not.toBeNull();
    expect(result.match!.profileId).toBe(10);
    expect(result.rejectionReason).toBeNull();
  });

  it('exports the default margin ratio at the agreed value', () => {
    // 1.05 was chosen via scripts/diagnose/replay-session.ts against four
    // real-iPad sessions; changing it requires re-running the replay.
    expect(DEFAULT_CONFIDENCE_MARGIN_RATIO).toBe(1.05);
  });
});

describe('findMatchWithMarginAndPrior — v1.6 stacked gates', () => {
  function makeFlatProfile(id: number, name: string, totalEnergyWh: number, peakW = 40): ProfileWithCurve {
    const points: CurvePoint[] = [];
    let cumulativeWh = 0;
    const flatLen = 600;
    for (let t = 0; t < flatLen; t++) {
      cumulativeWh += peakW / 3600;
      points.push({ offsetSeconds: t, apower: peakW, cumulativeWh });
    }
    return {
      id,
      name,
      curve: { startPower: peakW, durationSeconds: flatLen, totalEnergyWh },
      curvePoints: points,
    };
  }

  it('whitelist filters profile set BEFORE DTW runs', () => {
    const iPad = makeFlatProfile(4, 'iPad', 60);
    const macBook = makeFlatProfile(6, 'MacBook', 100);
    const winbot = makeFlatProfile(5, 'Winbot', 250);
    const query = new Array(30).fill(40);
    // Margin gate would reject identical-shape ties; pass marginRatio=0 so
    // the whitelist-only behaviour is unambiguous in this test.
    const result = findMatchWithMarginAndPrior(query, [iPad, macBook, winbot], {
      whitelistIds: [4, 6],
      marginRatio: 0,
    });
    expect(result.match).not.toBeNull();
    expect([4, 6]).toContain(result.match!.profileId);
    // Winbot must have been filtered out before DTW.
    expect(result.match!.profileId).not.toBe(5);
  });

  it('empty candidate set (whitelist excludes everything) returns no_candidates', () => {
    const iPad = makeFlatProfile(4, 'iPad', 60);
    const query = new Array(30).fill(40);
    const result = findMatchWithMarginAndPrior(query, [iPad], { whitelistIds: [999] });
    expect(result.match).toBeNull();
    expect(result.rejectionReason).toBe('no_candidates');
  });

  it('energy-bound eliminates candidates whose ref total is too small', () => {
    // Bosch GBA-style profile: tiny 20 Wh total. We've already delivered 40 Wh.
    // Bosch is mathematically dead — only iPad (60 Wh) survives.
    const bosch = makeFlatProfile(2, 'Bosch', 20);
    const iPad = makeFlatProfile(4, 'iPad', 60);
    const query = new Array(30).fill(40);
    const profileMaxEnergyWh = new Map<number, number>([[2, 20], [4, 60]]);
    const result = findMatchWithMarginAndPrior(query, [bosch, iPad], {
      profileMaxEnergyWh,
      currentSessionWh: 40,
    });
    expect(result.match).not.toBeNull();
    expect(result.match!.profileId).toBe(4); // iPad wins by elimination
  });

  it('Bayesian prior breaks ties between DTW-equivalent candidates', () => {
    // Two identical-shape profiles → DTW gives equal confidence. Without
    // prior, undefined which wins. With prior favouring profile 4, posterior
    // collapses to 4.
    const profileA = makeFlatProfile(4, 'iPad', 60);
    const profileB = makeFlatProfile(6, 'MacBook', 60);
    const query = new Array(30).fill(40);
    const prior = new Map<number, number>([[4, 0.95], [6, 0.05]]);
    const result = findMatchWithMarginAndPrior(query, [profileA, profileB], { prior });
    expect(result.match).not.toBeNull();
    expect(result.match!.profileId).toBe(4);
  });

  it('prior cannot rescue a candidate with zero DTW confidence', () => {
    // Even with a heavy prior, 0 × 1 = 0 — the candidate fails the
    // confidence floor and the matcher reports low_confidence.
    const flat = makeFlatProfile(4, 'iPad', 60);
    const query = new Array(30).fill(200); // wildly wrong power level
    const prior = new Map<number, number>([[4, 1.0]]);
    const result = findMatchWithMarginAndPrior(query, [flat], { prior });
    expect(result.match).toBeNull();
    expect(result.rejectionReason).toBe('low_confidence');
  });
});
