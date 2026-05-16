import { describe, it, expect } from 'vitest';
import {
  buildPrior,
  parseAllowedProfileIds,
  isEnergyImpossible,
  ENERGY_BOUND_TOLERANCE,
  PRIOR_ALPHA,
} from './plug-prior';

describe('parseAllowedProfileIds', () => {
  it('returns null when input is null/undefined/empty', () => {
    expect(parseAllowedProfileIds(null)).toBeNull();
    expect(parseAllowedProfileIds(undefined)).toBeNull();
    expect(parseAllowedProfileIds('')).toBeNull();
  });

  it('parses a single-element JSON array (pin)', () => {
    expect(parseAllowedProfileIds('[4]')).toEqual([4]);
  });

  it('parses a multi-element JSON array (whitelist)', () => {
    expect(parseAllowedProfileIds('[4, 6, 8]')).toEqual([4, 6, 8]);
  });

  it('returns null on malformed JSON without throwing', () => {
    expect(parseAllowedProfileIds('{not json')).toBeNull();
    expect(parseAllowedProfileIds('"a string"')).toBeNull();
    expect(parseAllowedProfileIds('42')).toBeNull();
  });

  it('drops non-integer entries (defensive)', () => {
    expect(parseAllowedProfileIds('[4, "five", 8.5, 6]')).toEqual([4, 6]);
  });

  it('returns null for empty array', () => {
    expect(parseAllowedProfileIds('[]')).toBeNull();
  });
});

describe('buildPrior — Dirichlet–multinomial', () => {
  it('returns empty map for empty candidate list', () => {
    expect(buildPrior([], new Map())).toEqual(new Map());
  });

  it('returns probability 1 for a single-element whitelist (hard pin)', () => {
    // Single pin: prior collapses to certainty regardless of history.
    const prior = buildPrior([4], new Map([[4, 0], [6, 99]]));
    expect(prior.get(4)).toBe(1.0);
    expect(prior.size).toBe(1);
  });

  it('produces uniform prior with empty history (Laplace alpha=1)', () => {
    // No completed sessions → all profiles equally likely.
    const prior = buildPrior([4, 6, 8], new Map());
    expect(prior.get(4)).toBeCloseTo(1 / 3);
    expect(prior.get(6)).toBeCloseTo(1 / 3);
    expect(prior.get(8)).toBeCloseTo(1 / 3);
  });

  it('skews toward the most-frequent historical profile', () => {
    // 90 iPad sessions, 1 MacBook session, 0 iPhone sessions on this plug.
    // alpha=1 each → numerators 91, 2, 1; denom = 94 → ≈ 0.968, 0.021, 0.011.
    const counts = new Map([[4, 90], [6, 1], [8, 0]]);
    const prior = buildPrior([4, 6, 8], counts);
    expect(prior.get(4)!).toBeGreaterThan(0.95);
    expect(prior.get(6)!).toBeLessThan(0.05);
    expect(prior.get(8)!).toBeGreaterThan(0); // Laplace floor
    const sum = [...prior.values()].reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1.0);
  });

  it('ignores counts for profiles not in the whitelist', () => {
    // 100 sessions on profile 99 — but it's not in the candidate set, so
    // those counts vanish from the prior.
    const counts = new Map([[4, 1], [6, 1], [99, 100]]);
    const prior = buildPrior([4, 6], counts);
    expect(prior.size).toBe(2);
    expect(prior.has(99)).toBe(false);
    // 4 and 6 had equal counts → uniform.
    expect(prior.get(4)).toBeCloseTo(0.5);
  });

  it('exports the agreed PRIOR_ALPHA at the documented value', () => {
    expect(PRIOR_ALPHA).toBe(1);
  });
});

describe('isEnergyImpossible — full-cycle elimination', () => {
  // Bosch Professional GBA 10,8V 2.0Ah reference total = 19.18 Wh.
  // iPad Pro 12.9" reference total = 61.95 Wh.
  it('eliminates a candidate once delivered exceeds 1.1 × reference', () => {
    expect(isEnergyImpossible(21.5, 19.18)).toBe(true);  // > 19.18 × 1.1 = 21.098
    expect(isEnergyImpossible(21.0, 19.18)).toBe(false); // within tolerance
  });

  it('keeps a candidate alive while delivered is below tolerance', () => {
    // After 30 Wh delivered, iPad (62 Wh ref) is still in play.
    expect(isEnergyImpossible(30, 61.95)).toBe(false);
    expect(isEnergyImpossible(60, 61.95)).toBe(false);
    expect(isEnergyImpossible(70, 61.95)).toBe(true); // > 62 × 1.1
  });

  it('returns false for degenerate profile (totalEnergyWh ≤ 0)', () => {
    expect(isEnergyImpossible(100, 0)).toBe(false);
    expect(isEnergyImpossible(100, -1)).toBe(false);
  });

  it('exports the tolerance at the documented value', () => {
    expect(ENERGY_BOUND_TOLERANCE).toBe(1.1);
  });
});
