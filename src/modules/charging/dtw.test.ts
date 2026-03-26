import { describe, it, expect } from 'vitest';
import { dtwDistance, subsequenceDtw } from './dtw';

describe('dtwDistance', () => {
  it('returns 0 for identical sequences', () => {
    expect(dtwDistance([1, 2, 3], [1, 2, 3])).toBe(0);
  });

  it('returns positive distance for different sequences', () => {
    const dist = dtwDistance([1, 2, 3], [4, 5, 6]);
    expect(dist).toBeGreaterThan(0);
  });

  it('returns 0 for identical power-scale sequences', () => {
    expect(dtwDistance([100, 200, 300], [100, 200, 300])).toBe(0);
  });

  it('handles single-element sequences', () => {
    expect(dtwDistance([5], [5])).toBe(0);
    expect(dtwDistance([5], [10])).toBe(5);
  });

  it('is symmetric', () => {
    const a = [10, 20, 30, 40];
    const b = [15, 25, 35, 45];
    expect(dtwDistance(a, b)).toBeCloseTo(dtwDistance(b, a));
  });
});

describe('subsequenceDtw', () => {
  it('finds correct offset when query is a subsequence of reference', () => {
    // Reference: ramp from 0 to 19
    const reference = Array.from({ length: 20 }, (_, i) => i * 10);
    // Query: matches offset 5..9
    const query = [50, 60, 70, 80, 90];

    const result = subsequenceDtw(query, reference, 1);
    expect(result.offset).toBe(5);
    expect(result.distance).toBe(0);
  });

  it('returns offset=0 when query matches the start of reference', () => {
    const reference = [10, 20, 30, 40, 50, 60, 70, 80];
    const query = [10, 20, 30];

    const result = subsequenceDtw(query, reference, 1);
    expect(result.offset).toBe(0);
    expect(result.distance).toBe(0);
  });

  it('finds best match in noisy data', () => {
    const reference = [5, 5, 5, 100, 200, 300, 200, 100, 5, 5];
    const query = [100, 200, 300];

    const result = subsequenceDtw(query, reference, 1);
    expect(result.offset).toBe(3);
    expect(result.distance).toBe(0);
  });

  it('uses default windowStep of 5', () => {
    const reference = Array.from({ length: 100 }, (_, i) => i);
    const query = [50, 51, 52, 53, 54];

    const result = subsequenceDtw(query, reference);
    // With step=5, the offset should be a multiple of 5, closest to 50
    expect(result.offset).toBe(50);
    expect(result.distance).toBe(0);
  });
});
