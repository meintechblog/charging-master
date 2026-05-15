import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock db client + drizzle BEFORE importing the module under test. The
// stop-mode resolver reads `config` rows via db.select().from(config).where(eq(...)).get().
const cfgRows = new Map<string, { key: string; value: string; updatedAt: number }>();
function resetCfg() {
  cfgRows.clear();
}
function seedCfg(key: string, value: string): void {
  cfgRows.set(key, { key, value, updatedAt: Date.now() });
}

vi.mock('@/db/client', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn((pred: { col: unknown; val: unknown }) => ({
          get: vi.fn(() => {
            // The eq mock packs the queried key into pred.val
            const key = (pred as { val?: string }).val;
            return key ? cfgRows.get(key) ?? undefined : undefined;
          }),
        })),
      })),
    })),
  },
}));

vi.mock('@/db/schema', () => ({
  config: { key: 'key', value: 'value', updatedAt: 'updatedAt' },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((col, val) => ({ col, val })),
}));

import {
  DEFAULT_STOP_MODE,
  DEFAULT_BAND_WIDTH_LIMIT,
  DEFAULT_STALE_POWER_THRESHOLD_W,
  DEFAULT_STALE_POWER_WINDOW_SEC,
  DEFAULT_LOW_CONFIDENCE_THRESHOLD,
  DEFAULT_MATCHER_REFRESH_READINGS,
  shouldStop,
  shouldStopEnergyFallback,
  readStopMode,
  readBandThreshold,
  readStalePowerThresholdW,
  readStalePowerWindowSec,
  readLowConfidenceThreshold,
  readMatcherRefreshReadings,
  __resetStopModeCacheForTests,
  __resetBandThresholdCacheForTests,
  __resetStalePowerThresholdCacheForTests,
  __resetStalePowerWindowCacheForTests,
  __resetLowConfidenceThresholdCacheForTests,
  __resetMatcherRefreshReadingsCacheForTests,
} from './stop-mode';
import { DEFAULT_BAND_THRESHOLD_PCT } from './curve-matcher';

beforeEach(() => {
  resetCfg();
  __resetStopModeCacheForTests();
  __resetBandThresholdCacheForTests();
  __resetStalePowerThresholdCacheForTests();
  __resetStalePowerWindowCacheForTests();
  __resetLowConfidenceThresholdCacheForTests();
  __resetMatcherRefreshReadingsCacheForTests();
});

describe('shouldStop — conservative mode', () => {
  it('returns true when socMin >= target', () => {
    expect(
      shouldStop({ mode: 'conservative', socMin: 80, socMax: 90, socBest: 85, targetSoc: 80 })
    ).toBe(true);
  });

  it('returns false when socMin < target (band straddles target)', () => {
    expect(
      shouldStop({ mode: 'conservative', socMin: 79, socMax: 81, socBest: 80, targetSoc: 80 })
    ).toBe(false);
  });
});

describe('shouldStop — aggressive mode (Pitfall 5 ordering)', () => {
  it('does NOT trip on a wide band whose socBest happens to land on target', () => {
    // The exact production case that caused iPad Session 16 mis-stop. width=60.
    expect(
      shouldStop({ mode: 'aggressive', socMin: 20, socMax: 80, socBest: 80, targetSoc: 80 })
    ).toBe(false);
  });

  it('trips on a narrow band with socBest >= target', () => {
    // width=4 ≤ 5, socBest=80 ≥ target=80
    expect(
      shouldStop({ mode: 'aggressive', socMin: 78, socMax: 82, socBest: 80, targetSoc: 80 })
    ).toBe(true);
  });

  it('does NOT trip on a narrow band below target', () => {
    expect(
      shouldStop({ mode: 'aggressive', socMin: 73, socMax: 77, socBest: 75, targetSoc: 80 })
    ).toBe(false);
  });

  it('uses DEFAULT_BAND_WIDTH_LIMIT (=5) as the width cutoff (boundary check)', () => {
    expect(DEFAULT_BAND_WIDTH_LIMIT).toBe(5);
    // Width exactly at the boundary (5) AND socBest at target → trip
    expect(
      shouldStop({ mode: 'aggressive', socMin: 77, socMax: 82, socBest: 80, targetSoc: 80 })
    ).toBe(true);
    // Width just over (6) → do NOT trip
    expect(
      shouldStop({ mode: 'aggressive', socMin: 77, socMax: 83, socBest: 80, targetSoc: 80 })
    ).toBe(false);
  });
});

describe('readStopMode', () => {
  it('defaults to aggressive when no config row', () => {
    expect(readStopMode()).toBe(DEFAULT_STOP_MODE);
    expect(DEFAULT_STOP_MODE).toBe('aggressive');
  });

  it('reads "conservative" from a seeded config row', () => {
    seedCfg('charging.stopMode', 'conservative');
    expect(readStopMode()).toBe('conservative');
  });

  it('falls back to aggressive on invalid value (does not throw)', () => {
    seedCfg('charging.stopMode', 'garbage');
    expect(readStopMode()).toBe('aggressive');
  });

  it('caches result within the 30s TTL window', () => {
    const realNow = Date.now;
    let now = 1_000_000;
    Date.now = () => now;
    try {
      seedCfg('charging.stopMode', 'conservative');
      expect(readStopMode()).toBe('conservative');
      // Mutate cfg behind the cache; advance < TTL
      seedCfg('charging.stopMode', 'aggressive');
      now += 5_000; // 5s
      expect(readStopMode()).toBe('conservative'); // still cached
      // Advance past TTL → re-read from DB
      now += 26_000; // total +31s
      expect(readStopMode()).toBe('aggressive');
    } finally {
      Date.now = realNow;
    }
  });
});

describe('readBandThreshold', () => {
  it('defaults to DEFAULT_BAND_THRESHOLD_PCT from curve-matcher', () => {
    expect(readBandThreshold()).toBe(DEFAULT_BAND_THRESHOLD_PCT);
  });

  it('parses a valid numeric string from config', () => {
    seedCfg('charging.bandThreshold', '0.20');
    expect(readBandThreshold()).toBe(0.20);
  });

  it('falls back on empty string or invalid number', () => {
    seedCfg('charging.bandThreshold', '');
    expect(readBandThreshold()).toBe(DEFAULT_BAND_THRESHOLD_PCT);
    __resetBandThresholdCacheForTests();
    seedCfg('charging.bandThreshold', 'NaN-garbage');
    expect(readBandThreshold()).toBe(DEFAULT_BAND_THRESHOLD_PCT);
    __resetBandThresholdCacheForTests();
    seedCfg('charging.bandThreshold', '0'); // not >0
    expect(readBandThreshold()).toBe(DEFAULT_BAND_THRESHOLD_PCT);
    __resetBandThresholdCacheForTests();
    seedCfg('charging.bandThreshold', '1.5'); // not <1
    expect(readBandThreshold()).toBe(DEFAULT_BAND_THRESHOLD_PCT);
  });
});

describe('readStalePowerThresholdW (FPD-01)', () => {
  it('exposes a 1.0 W default', () => {
    expect(DEFAULT_STALE_POWER_THRESHOLD_W).toBe(1.0);
    expect(readStalePowerThresholdW()).toBe(1.0);
  });

  it('parses a valid numeric string from config', () => {
    seedCfg('charging.stalePowerThresholdW', '0.5');
    expect(readStalePowerThresholdW()).toBe(0.5);
  });

  it('falls back on empty / non-numeric / non-positive values', () => {
    seedCfg('charging.stalePowerThresholdW', '');
    expect(readStalePowerThresholdW()).toBe(DEFAULT_STALE_POWER_THRESHOLD_W);
    __resetStalePowerThresholdCacheForTests();
    seedCfg('charging.stalePowerThresholdW', 'garbage');
    expect(readStalePowerThresholdW()).toBe(DEFAULT_STALE_POWER_THRESHOLD_W);
    __resetStalePowerThresholdCacheForTests();
    seedCfg('charging.stalePowerThresholdW', '0'); // not >0
    expect(readStalePowerThresholdW()).toBe(DEFAULT_STALE_POWER_THRESHOLD_W);
    __resetStalePowerThresholdCacheForTests();
    seedCfg('charging.stalePowerThresholdW', '-2'); // negative
    expect(readStalePowerThresholdW()).toBe(DEFAULT_STALE_POWER_THRESHOLD_W);
  });

  it('caches result within the 30s TTL window', () => {
    const realNow = Date.now;
    let now = 2_000_000;
    Date.now = () => now;
    try {
      seedCfg('charging.stalePowerThresholdW', '2.5');
      expect(readStalePowerThresholdW()).toBe(2.5);
      seedCfg('charging.stalePowerThresholdW', '4.0');
      now += 5_000;
      expect(readStalePowerThresholdW()).toBe(2.5); // cached
      now += 26_000; // total +31s — past TTL
      expect(readStalePowerThresholdW()).toBe(4.0);
    } finally {
      Date.now = realNow;
    }
  });
});

describe('readStalePowerWindowSec (FPD-01)', () => {
  it('exposes a 300s default', () => {
    expect(DEFAULT_STALE_POWER_WINDOW_SEC).toBe(300);
    expect(readStalePowerWindowSec()).toBe(300);
  });

  it('parses a valid integer string from config', () => {
    seedCfg('charging.stalePowerWindowSec', '120');
    expect(readStalePowerWindowSec()).toBe(120);
  });

  it('falls back on empty / non-integer / non-positive values', () => {
    seedCfg('charging.stalePowerWindowSec', '');
    expect(readStalePowerWindowSec()).toBe(DEFAULT_STALE_POWER_WINDOW_SEC);
    __resetStalePowerWindowCacheForTests();
    seedCfg('charging.stalePowerWindowSec', 'abc');
    expect(readStalePowerWindowSec()).toBe(DEFAULT_STALE_POWER_WINDOW_SEC);
    __resetStalePowerWindowCacheForTests();
    seedCfg('charging.stalePowerWindowSec', '0');
    expect(readStalePowerWindowSec()).toBe(DEFAULT_STALE_POWER_WINDOW_SEC);
    __resetStalePowerWindowCacheForTests();
    seedCfg('charging.stalePowerWindowSec', '-50');
    expect(readStalePowerWindowSec()).toBe(DEFAULT_STALE_POWER_WINDOW_SEC);
  });

  it('caches result within the 30s TTL window', () => {
    const realNow = Date.now;
    let now = 3_000_000;
    Date.now = () => now;
    try {
      seedCfg('charging.stalePowerWindowSec', '60');
      expect(readStalePowerWindowSec()).toBe(60);
      seedCfg('charging.stalePowerWindowSec', '900');
      now += 5_000;
      expect(readStalePowerWindowSec()).toBe(60); // cached
      now += 26_000;
      expect(readStalePowerWindowSec()).toBe(900);
    } finally {
      Date.now = realNow;
    }
  });
});

describe('readLowConfidenceThreshold (FPD-03)', () => {
  it('exposes a 0.5 default', () => {
    expect(DEFAULT_LOW_CONFIDENCE_THRESHOLD).toBe(0.5);
    expect(readLowConfidenceThreshold()).toBe(0.5);
  });

  it('parses a valid numeric string from config', () => {
    seedCfg('charging.lowConfidenceThreshold', '0.3');
    expect(readLowConfidenceThreshold()).toBe(0.3);
  });

  it('accepts the upper inclusive bound of 1', () => {
    seedCfg('charging.lowConfidenceThreshold', '1');
    expect(readLowConfidenceThreshold()).toBe(1);
  });

  it('falls back on empty / non-numeric / out-of-range values', () => {
    seedCfg('charging.lowConfidenceThreshold', '');
    expect(readLowConfidenceThreshold()).toBe(DEFAULT_LOW_CONFIDENCE_THRESHOLD);
    __resetLowConfidenceThresholdCacheForTests();
    seedCfg('charging.lowConfidenceThreshold', 'garbage');
    expect(readLowConfidenceThreshold()).toBe(DEFAULT_LOW_CONFIDENCE_THRESHOLD);
    __resetLowConfidenceThresholdCacheForTests();
    seedCfg('charging.lowConfidenceThreshold', '0'); // not >0
    expect(readLowConfidenceThreshold()).toBe(DEFAULT_LOW_CONFIDENCE_THRESHOLD);
    __resetLowConfidenceThresholdCacheForTests();
    seedCfg('charging.lowConfidenceThreshold', '1.01'); // >1
    expect(readLowConfidenceThreshold()).toBe(DEFAULT_LOW_CONFIDENCE_THRESHOLD);
    __resetLowConfidenceThresholdCacheForTests();
    seedCfg('charging.lowConfidenceThreshold', '-0.2'); // negative
    expect(readLowConfidenceThreshold()).toBe(DEFAULT_LOW_CONFIDENCE_THRESHOLD);
  });

  it('caches result within the 30s TTL window', () => {
    const realNow = Date.now;
    let now = 4_000_000;
    Date.now = () => now;
    try {
      seedCfg('charging.lowConfidenceThreshold', '0.4');
      expect(readLowConfidenceThreshold()).toBe(0.4);
      seedCfg('charging.lowConfidenceThreshold', '0.7');
      now += 5_000;
      expect(readLowConfidenceThreshold()).toBe(0.4); // cached
      now += 26_000;
      expect(readLowConfidenceThreshold()).toBe(0.7);
    } finally {
      Date.now = realNow;
    }
  });
});

describe('readMatcherRefreshReadings (FPD-02)', () => {
  it('exposes a 60 default', () => {
    expect(DEFAULT_MATCHER_REFRESH_READINGS).toBe(60);
    expect(readMatcherRefreshReadings()).toBe(60);
  });

  it('parses a valid integer from config', () => {
    seedCfg('charging.matcherRefreshReadings', '120');
    expect(readMatcherRefreshReadings()).toBe(120);
  });

  it('falls back on empty / non-integer / non-positive values', () => {
    seedCfg('charging.matcherRefreshReadings', '');
    expect(readMatcherRefreshReadings()).toBe(DEFAULT_MATCHER_REFRESH_READINGS);
    __resetMatcherRefreshReadingsCacheForTests();
    seedCfg('charging.matcherRefreshReadings', 'abc');
    expect(readMatcherRefreshReadings()).toBe(DEFAULT_MATCHER_REFRESH_READINGS);
    __resetMatcherRefreshReadingsCacheForTests();
    seedCfg('charging.matcherRefreshReadings', '0'); // T-12-07: prevent tight-loop
    expect(readMatcherRefreshReadings()).toBe(DEFAULT_MATCHER_REFRESH_READINGS);
    __resetMatcherRefreshReadingsCacheForTests();
    seedCfg('charging.matcherRefreshReadings', '-30');
    expect(readMatcherRefreshReadings()).toBe(DEFAULT_MATCHER_REFRESH_READINGS);
    __resetMatcherRefreshReadingsCacheForTests();
    seedCfg('charging.matcherRefreshReadings', '12.5'); // non-integer
    expect(readMatcherRefreshReadings()).toBe(DEFAULT_MATCHER_REFRESH_READINGS);
  });

  it('caches result within the 30s TTL window', () => {
    const realNow = Date.now;
    let now = 5_000_000;
    Date.now = () => now;
    try {
      seedCfg('charging.matcherRefreshReadings', '30');
      expect(readMatcherRefreshReadings()).toBe(30);
      seedCfg('charging.matcherRefreshReadings', '90');
      now += 5_000;
      expect(readMatcherRefreshReadings()).toBe(30); // cached
      now += 26_000;
      expect(readMatcherRefreshReadings()).toBe(90);
    } finally {
      Date.now = realNow;
    }
  });
});

describe('shouldStopEnergyFallback (FPD-03)', () => {
  // Mathematically identical to estimatedSoc >= targetSoc (the v1.2 energy
  // formula inverted — see RESEARCH §FPD-03 Q1). Pure function; the caller
  // gates on bandConfidence < lowConfidenceThreshold before invoking this.
  it('returns true when estimatedSoc exactly equals targetSoc (inclusive)', () => {
    expect(shouldStopEnergyFallback({ estimatedSoc: 80, targetSoc: 80 })).toBe(true);
  });

  it('returns false when estimatedSoc is one below target', () => {
    expect(shouldStopEnergyFallback({ estimatedSoc: 79, targetSoc: 80 })).toBe(false);
  });

  it('returns true when estimatedSoc is well above target', () => {
    expect(shouldStopEnergyFallback({ estimatedSoc: 95, targetSoc: 80 })).toBe(true);
  });

  it('returns true on the zero/zero edge (inclusive comparison: 0 >= 0)', () => {
    // Documented explicitly: degenerate case at session boundary. shouldStop
    // is only invoked from updateSocTracking during charging — by that point
    // targetSoc is always > 0 in production. The 0/0 case is a unit-test
    // contract assertion of inclusive comparison semantics.
    expect(shouldStopEnergyFallback({ estimatedSoc: 0, targetSoc: 0 })).toBe(true);
  });
});
