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
  DEFAULT_MAX_SESSION_HOURS,
  shouldStop,
  shouldStopEnergyFallback,
  readStopMode,
  readBandThreshold,
  readStalePowerThresholdW,
  readStalePowerWindowSec,
  readLowConfidenceThreshold,
  readMatcherRefreshReadings,
  readMaxSessionHours,
  __resetStopModeCacheForTests,
  __resetBandThresholdCacheForTests,
  __resetStalePowerThresholdCacheForTests,
  __resetStalePowerWindowCacheForTests,
  __resetLowConfidenceThresholdCacheForTests,
  __resetMatcherRefreshReadingsCacheForTests,
  __resetMaxSessionHoursCacheForTests,
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
  __resetMaxSessionHoursCacheForTests();
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

describe('shouldStop — aggressive mode (socBest-only)', () => {
  it('trips on a wide band as soon as socBest crosses target', () => {
    // Session 19 incident (2026-05-15): earlier "width gate" lock-out left the
    // charge running past target. Aggressive now trusts socBest unconditionally
    // — the FPD-04 wall-clock timeout remains the runaway backstop.
    expect(
      shouldStop({ mode: 'aggressive', socMin: 20, socMax: 80, socBest: 80, targetSoc: 80 })
    ).toBe(true);
  });

  it('trips on a narrow band with socBest >= target', () => {
    expect(
      shouldStop({ mode: 'aggressive', socMin: 78, socMax: 82, socBest: 80, targetSoc: 80 })
    ).toBe(true);
  });

  it('does NOT trip below target regardless of band width', () => {
    expect(
      shouldStop({ mode: 'aggressive', socMin: 73, socMax: 77, socBest: 75, targetSoc: 80 })
    ).toBe(false);
    expect(
      shouldStop({ mode: 'aggressive', socMin: 0, socMax: 60, socBest: 30, targetSoc: 80 })
    ).toBe(false);
  });

  it('DEFAULT_BAND_WIDTH_LIMIT still exported for downstream consumers', () => {
    // Constant retained for backward-compat (used by the ASCII renderer's
    // best±5 core glyph window). The shouldStop branch no longer consults it.
    expect(DEFAULT_BAND_WIDTH_LIMIT).toBe(5);
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

describe('readMaxSessionHours (FPD-04)', () => {
  it('exposes a 24h default', () => {
    expect(DEFAULT_MAX_SESSION_HOURS).toBe(24);
    expect(readMaxSessionHours()).toBe(24);
  });

  it('parses a valid integer from config', () => {
    seedCfg('charging.maxSessionHours', '48');
    expect(readMaxSessionHours()).toBe(48);
  });

  it('falls back on empty / non-integer / non-positive values (T-12-08)', () => {
    // T-12-08 mitigation: 0/negative would abort every session at startup.
    // Float values (e.g., '12.5') are rejected — hours must be an integer.
    seedCfg('charging.maxSessionHours', '');
    expect(readMaxSessionHours()).toBe(DEFAULT_MAX_SESSION_HOURS);
    __resetMaxSessionHoursCacheForTests();
    seedCfg('charging.maxSessionHours', 'abc');
    expect(readMaxSessionHours()).toBe(DEFAULT_MAX_SESSION_HOURS);
    __resetMaxSessionHoursCacheForTests();
    seedCfg('charging.maxSessionHours', '0');
    expect(readMaxSessionHours()).toBe(DEFAULT_MAX_SESSION_HOURS);
    __resetMaxSessionHoursCacheForTests();
    seedCfg('charging.maxSessionHours', '-12');
    expect(readMaxSessionHours()).toBe(DEFAULT_MAX_SESSION_HOURS);
    __resetMaxSessionHoursCacheForTests();
    seedCfg('charging.maxSessionHours', '12.5');
    expect(readMaxSessionHours()).toBe(DEFAULT_MAX_SESSION_HOURS);
  });

  it('caches result within the 30s TTL window', () => {
    const realNow = Date.now;
    let now = 6_000_000;
    Date.now = () => now;
    try {
      seedCfg('charging.maxSessionHours', '12');
      expect(readMaxSessionHours()).toBe(12);
      seedCfg('charging.maxSessionHours', '36');
      now += 5_000;
      expect(readMaxSessionHours()).toBe(12); // cached
      now += 26_000; // total +31s — past TTL
      expect(readMaxSessionHours()).toBe(36);
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
