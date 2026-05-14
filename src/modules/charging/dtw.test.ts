import { describe, it, expect } from 'vitest';
import { dtwDistance, subsequenceDtw } from './dtw';
import type { SubsequenceDtwResult } from './dtw';

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

describe('subsequenceDtw — distances vector (SOCB-01 band foundation)', () => {
  it('returns distances of length (refLen - queryLen + 1) for windowStep=1 and identical query/reference start', () => {
    const reference = Array.from({ length: 20 }, (_, i) => i * 10);
    const query = reference.slice(0, 5);

    const result = subsequenceDtw(query, reference, 1);

    expect(result.distances.length).toBe(reference.length - query.length + 1);
    // bestIdx for windowStep=1 equals offset; result.distances[offset] === result.distance
    expect(result.distances[result.offset]).toBe(result.distance);
    // Query is the prefix of reference → distances[0] is 0
    expect(result.distances[0]).toBe(0);
  });

  it('returns distances sized to Math.floor((refLen - queryLen) / windowStep) + 1 for windowStep=5', () => {
    const reference = Array.from({ length: 80 }, (_, i) => i);
    const query = reference.slice(40, 50);

    const result = subsequenceDtw(query, reference, 5);

    expect(result.distances.length).toBe(Math.floor((80 - 10) / 5) + 1);
    expect(result.distances.length).toBe(15);
    expect(result.windowStep).toBe(5);
  });

  it('returns distances as a Float64Array (dense numeric indexing)', () => {
    const reference = Array.from({ length: 10 }, (_, i) => i);
    const query = [3, 4, 5];

    const result = subsequenceDtw(query, reference, 1);

    expect(result.distances).toBeInstanceOf(Float64Array);
  });

  it('legacy destructuring of { offset, distance } stays valid (back-compat)', () => {
    const reference = [10, 20, 30, 40, 50, 60];
    const query = [30, 40];

    // Existing callers in curve-matcher.ts do this exact destructure
    const { offset, distance } = subsequenceDtw(query, reference, 1);

    expect(offset).toBe(2);
    expect(distance).toBe(0);
  });

  it('returns degenerate result when query is empty', () => {
    const result = subsequenceDtw([], [1, 2, 3], 1);

    expect(result.distances.length).toBe(0);
    expect(result.distance).toBe(Infinity);
    expect(result.offset).toBe(0);
  });

  it('returns degenerate result when query is longer than reference', () => {
    const result = subsequenceDtw([1, 2, 3, 4, 5], [1, 2], 1);

    expect(result.distances.length).toBe(0);
    expect(result.distance).toBe(Infinity);
    expect(result.offset).toBe(0);
  });

  it('distances[bestIdx] equals Math.min over all evaluated windows (regression: best distance unchanged)', () => {
    const reference = [5, 5, 5, 100, 200, 300, 200, 100, 5, 5];
    const query = [100, 200, 300];

    const result: SubsequenceDtwResult = subsequenceDtw(query, reference, 1);

    let min = Infinity;
    for (let i = 0; i < result.distances.length; i++) {
      if (result.distances[i] < min) min = result.distances[i];
    }
    expect(result.distance).toBe(min);
    const bestIdx = result.offset / result.windowStep;
    expect(result.distances[bestIdx]).toBe(min);
  });
});
