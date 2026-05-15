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
  shouldStop,
  readStopMode,
  readBandThreshold,
  readStalePowerThresholdW,
  readStalePowerWindowSec,
  __resetStopModeCacheForTests,
  __resetBandThresholdCacheForTests,
  __resetStalePowerThresholdCacheForTests,
  __resetStalePowerWindowCacheForTests,
} from './stop-mode';
import { DEFAULT_BAND_THRESHOLD_PCT } from './curve-matcher';

beforeEach(() => {
  resetCfg();
  __resetStopModeCacheForTests();
  __resetBandThresholdCacheForTests();
  __resetStalePowerThresholdCacheForTests();
  __resetStalePowerWindowCacheForTests();
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
