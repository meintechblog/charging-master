/**
 * v1.7-B Plug-in Transient Capture.
 *
 * The first 30 seconds after a plug crosses the active-charge threshold
 * (apower < 2 W → ≥ 5 W) carries more discriminative information than
 * any subsequent 30-second window in the entire charge cycle, per the
 * NILM literature (Reinhardt 2012 et al. — see the v1.6 research brief).
 * That window is where the charger's PFC pre-charge spike, the device's
 * BMS handshake oscillation, and the ramp-to-CC slope live. After ~30 s
 * everything's settled into a flat-power plateau where DTW alone cannot
 * tell iPad from Bosch GBA from Winbot W3.
 *
 * This module is two pure functions:
 *
 *   1. `extractTransientFeatures(samples)` — turns a per-second burst of
 *      apower readings into a small fixed-shape feature vector. No I/O,
 *      no DB. Domain-tested against synthetic + reference-curve shapes.
 *
 *   2. `compareTransientFeatures(observed, reference)` — yields a
 *      similarity score in `[0, 1]`. The matcher consumes this as a
 *      multiplicative boost on per-candidate confidence (same regime as
 *      the v1.6 Bayesian prior).
 *
 * Numerics are scale-free (peak power normalisation, time fractions) so
 * a 40 W iPad-shaped curve and a 200 W eBike-shaped curve produce
 * comparable feature vectors — but the raw `peakInrushW` is preserved
 * so a sane sanity-check ("this profile peaks at 40 W; live burst shows
 * 180 W → DEAD") can fire in the matcher before similarity-comparison
 * even matters.
 */

export interface TransientSample {
  /** Wall-clock timestamp in ms (or any monotonic ms — only diffs matter). */
  ts: number;
  /** Active power in watts. */
  apower: number;
}

export interface TransientFeatures {
  /** Highest single-sample apower across the burst (watts). */
  peakInrushW: number;
  /** Last 5-sample mean as a fraction of peakInrushW. ~1.0 for flat CC. */
  settlingFractionOfPeak: number;
  /** Seconds (from burst start) until apower stabilises to ±1 W over 5 s. */
  tToStableSeconds: number;
  /** (peakW − startW) / tToStableSeconds. NaN-safe (defaults to 0). */
  rampSlopeWPerSec: number;
  /** Sign-flip count of d/dt(apower) within the first 10 seconds. */
  oscillationCount: number;
}

/** Default burst window length, exported so callers stay in sync. */
export const BURST_DURATION_MS = 30_000;
/** Burst polling cadence — 1 Hz beats Nyquist on 1–3 s BMS handshakes. */
export const BURST_INTERVAL_MS = 1_000;
/** apower threshold (W) — both for entry trigger and the "stable" window. */
export const TRANSIENT_ACTIVE_THRESHOLD_W = 5;
const STABILITY_TOLERANCE_W = 1;
const STABILITY_WINDOW_SAMPLES = 5;

/**
 * Extract a fixed-shape feature vector from a burst of plug-in samples.
 * Pure function — no I/O. Returns sane defaults (zeros, NaN-safe) when
 * the input is too small to extract anything meaningful, so the caller
 * never has to special-case empty/short bursts.
 */
export function extractTransientFeatures(samples: TransientSample[]): TransientFeatures {
  if (samples.length === 0) {
    return {
      peakInrushW: 0,
      settlingFractionOfPeak: 0,
      tToStableSeconds: 0,
      rampSlopeWPerSec: 0,
      oscillationCount: 0,
    };
  }

  const peakInrushW = samples.reduce((max, s) => (s.apower > max ? s.apower : max), 0);
  const tStart = samples[0].ts;

  // Settling window = mean of the last STABILITY_WINDOW_SAMPLES apower values.
  const settlingSlice = samples.slice(-STABILITY_WINDOW_SAMPLES);
  const settlingMean =
    settlingSlice.reduce((sum, s) => sum + s.apower, 0) / Math.max(1, settlingSlice.length);
  const settlingFractionOfPeak = peakInrushW > 0 ? settlingMean / peakInrushW : 0;

  // t-to-stable: first index i where the next STABILITY_WINDOW_SAMPLES
  // readings all sit within ±STABILITY_TOLERANCE_W of their mean.
  let tToStableSeconds = (samples[samples.length - 1].ts - tStart) / 1000;
  for (let i = 0; i + STABILITY_WINDOW_SAMPLES <= samples.length; i++) {
    const window = samples.slice(i, i + STABILITY_WINDOW_SAMPLES);
    const wmean =
      window.reduce((sum, s) => sum + s.apower, 0) / STABILITY_WINDOW_SAMPLES;
    const wmax = window.reduce((m, s) => Math.max(m, Math.abs(s.apower - wmean)), 0);
    if (wmax <= STABILITY_TOLERANCE_W) {
      tToStableSeconds = (samples[i].ts - tStart) / 1000;
      break;
    }
  }

  // Ramp slope from sample[0] up to stability window.
  const startApower = samples[0].apower;
  const rampSlopeWPerSec =
    tToStableSeconds > 0 ? (peakInrushW - startApower) / tToStableSeconds : 0;

  // Oscillation count = sign-flips of derivative across the first 10 samples
  // (10 s at 1 Hz). Catches BMS handshake wobble that flat-power DTW misses.
  const oscWindow = samples.slice(0, 10);
  let oscillationCount = 0;
  let prevDir: 1 | -1 | 0 = 0;
  for (let i = 1; i < oscWindow.length; i++) {
    const delta = oscWindow[i].apower - oscWindow[i - 1].apower;
    const dir: 1 | -1 | 0 = delta > 0.5 ? 1 : delta < -0.5 ? -1 : 0;
    if (dir !== 0 && prevDir !== 0 && dir !== prevDir) oscillationCount++;
    if (dir !== 0) prevDir = dir;
  }

  return {
    peakInrushW,
    settlingFractionOfPeak,
    tToStableSeconds,
    rampSlopeWPerSec,
    oscillationCount,
  };
}

/**
 * Similarity in `[0, 1]` where 1 = identical features and 0 = wildly off.
 *
 * Weighted Euclidean over normalised channels — peak-power normalised by
 * the LARGER of the two so a 40 W vs 200 W comparison ends up scale-free
 * but a 40 W observed vs 200 W reference correctly scores low (those
 * are physically different devices). Channels weighted by NILM literature
 * importance: peakInrushW (heavy) > rampSlope > settlingFraction >
 * oscillationCount > tToStable.
 */
export function compareTransientFeatures(
  observed: TransientFeatures,
  reference: TransientFeatures,
): number {
  // Peak power similarity — scale-free min/max ratio. 40 W vs 40 W → 1.
  // 40 W vs 200 W → 0.2 (the bigger killer).
  const peakRatio =
    Math.min(observed.peakInrushW, reference.peakInrushW) /
    Math.max(observed.peakInrushW, reference.peakInrushW || 1);

  const settlingDelta = Math.min(
    1,
    Math.abs(observed.settlingFractionOfPeak - reference.settlingFractionOfPeak),
  );
  const settlingScore = 1 - settlingDelta;

  // Ramp slope as fraction; clamp delta to 1 W/s so tiny ramp differences
  // don't dominate.
  const rampObs = observed.rampSlopeWPerSec;
  const rampRef = reference.rampSlopeWPerSec;
  const rampNorm = Math.max(Math.abs(rampObs), Math.abs(rampRef), 1);
  const rampScore = 1 - Math.min(1, Math.abs(rampObs - rampRef) / rampNorm);

  const oscDelta = Math.min(1, Math.abs(observed.oscillationCount - reference.oscillationCount) / 5);
  const oscScore = 1 - oscDelta;

  const tToStableDelta = Math.min(
    1,
    Math.abs(observed.tToStableSeconds - reference.tToStableSeconds) / 30,
  );
  const tToStableScore = 1 - tToStableDelta;

  // Weighted aggregate. Weights normalised inside (sum = 1).
  const score =
    peakRatio * 0.45 +
    rampScore * 0.20 +
    settlingScore * 0.15 +
    oscScore * 0.12 +
    tToStableScore * 0.08;

  return Math.max(0, Math.min(1, score));
}
