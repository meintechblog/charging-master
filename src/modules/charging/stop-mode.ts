/**
 * Stop-mode resolver + decision function.
 *
 * Two policies for the auto-stop transition (Phase 11 SOCB-03):
 *
 * - **conservative** — stop only when the lower band edge has reached target
 *   (`socMin >= targetSoc`). Never undershoots; may overshoot slightly when
 *   the band is wide.
 * - **aggressive** — stop when the band has collapsed AND the best estimate
 *   is at or above target (`socMax - socMin <= DEFAULT_BAND_WIDTH_LIMIT AND
 *   socBest >= targetSoc`). Snappier for narrow-band scenarios.
 *
 * **Pitfall 5 ordering** (Phase-11 RESEARCH.md): the width gate MUST come
 * first in the aggressive branch. Writing `socBest >= target && width <= 5`
 * makes the rule trip on the initial wide-band-with-socBest-on-target case
 * (the exact iPad-Session-16 bug we are mitigating). Tests in
 * `stop-mode.test.ts` lock the ordering by asserting that
 * `{socMin:20, socMax:80, socBest:80, target:80}` returns FALSE.
 *
 * Mode is read from a `config` row keyed `charging.stopMode`. Cached for
 * `CACHE_TTL_MS` to avoid hitting the DB on every reading (Pitfall 6).
 */

import { db } from '@/db/client';
import { config } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { DEFAULT_BAND_THRESHOLD_PCT } from './curve-matcher';

export type StopMode = 'aggressive' | 'conservative';
export const DEFAULT_STOP_MODE: StopMode = 'aggressive';
export const DEFAULT_BAND_WIDTH_LIMIT = 5;
// Phase 12 FPD-01 stale-power watchdog defaults. Both are config-tunable via
// charging.stalePowerThresholdW / charging.stalePowerWindowSec; counter is
// reading-based (NOT wall-clock — see RESEARCH Pitfall 1) so polling gaps
// pause it naturally.
export const DEFAULT_STALE_POWER_THRESHOLD_W = 1.0;
export const DEFAULT_STALE_POWER_WINDOW_SEC = 300;

const CACHE_TTL_MS = 30_000;

let cachedMode: StopMode | null = null;
let cachedModeAt = 0;

let cachedThreshold: number | null = null;
let cachedThresholdAt = 0;

let cachedStalePowerThresholdW: number | null = null;
let cachedStalePowerThresholdAt = 0;

let cachedStalePowerWindowSec: number | null = null;
let cachedStalePowerWindowAt = 0;

export function shouldStop(opts: {
  mode: StopMode;
  socMin: number;
  socMax: number;
  socBest: number;
  targetSoc: number;
}): boolean {
  if (opts.mode === 'conservative') {
    return opts.socMin >= opts.targetSoc;
  }
  // Aggressive — Pitfall 5: width check FIRST, then target check.
  // Do NOT reorder.
  const width = opts.socMax - opts.socMin;
  return width <= DEFAULT_BAND_WIDTH_LIMIT && opts.socBest >= opts.targetSoc;
}

export function readStopMode(): StopMode {
  const now = Date.now();
  if (cachedMode !== null && now - cachedModeAt < CACHE_TTL_MS) {
    return cachedMode;
  }
  let value: string | undefined;
  try {
    const row = db
      .select()
      .from(config)
      .where(eq(config.key, 'charging.stopMode'))
      .get() as { value?: string } | undefined;
    value = row?.value;
  } catch {
    // DB unreachable — fall back to default. Never throw from a hot path.
    value = undefined;
  }
  cachedMode = value === 'conservative' || value === 'aggressive' ? value : DEFAULT_STOP_MODE;
  cachedModeAt = now;
  return cachedMode;
}

export function readBandThreshold(): number {
  const now = Date.now();
  if (cachedThreshold !== null && now - cachedThresholdAt < CACHE_TTL_MS) {
    return cachedThreshold;
  }
  let value: string | undefined;
  try {
    const row = db
      .select()
      .from(config)
      .where(eq(config.key, 'charging.bandThreshold'))
      .get() as { value?: string } | undefined;
    value = row?.value;
  } catch {
    value = undefined;
  }
  let parsed = NaN;
  if (typeof value === 'string' && value.trim() !== '') {
    parsed = parseFloat(value);
  }
  cachedThreshold =
    Number.isFinite(parsed) && parsed > 0 && parsed < 1
      ? parsed
      : DEFAULT_BAND_THRESHOLD_PCT;
  cachedThresholdAt = now;
  return cachedThreshold;
}

export function readStalePowerThresholdW(): number {
  const now = Date.now();
  if (cachedStalePowerThresholdW !== null && now - cachedStalePowerThresholdAt < CACHE_TTL_MS) {
    return cachedStalePowerThresholdW;
  }
  let value: string | undefined;
  try {
    const row = db
      .select()
      .from(config)
      .where(eq(config.key, 'charging.stalePowerThresholdW'))
      .get() as { value?: string } | undefined;
    value = row?.value;
  } catch {
    value = undefined;
  }
  let parsed = NaN;
  if (typeof value === 'string' && value.trim() !== '') {
    parsed = parseFloat(value);
  }
  cachedStalePowerThresholdW =
    Number.isFinite(parsed) && parsed > 0
      ? parsed
      : DEFAULT_STALE_POWER_THRESHOLD_W;
  cachedStalePowerThresholdAt = now;
  return cachedStalePowerThresholdW;
}

export function readStalePowerWindowSec(): number {
  const now = Date.now();
  if (cachedStalePowerWindowSec !== null && now - cachedStalePowerWindowAt < CACHE_TTL_MS) {
    return cachedStalePowerWindowSec;
  }
  let value: string | undefined;
  try {
    const row = db
      .select()
      .from(config)
      .where(eq(config.key, 'charging.stalePowerWindowSec'))
      .get() as { value?: string } | undefined;
    value = row?.value;
  } catch {
    value = undefined;
  }
  let parsed = NaN;
  if (typeof value === 'string' && value.trim() !== '') {
    parsed = parseInt(value, 10);
  }
  cachedStalePowerWindowSec =
    Number.isFinite(parsed) && parsed > 0
      ? parsed
      : DEFAULT_STALE_POWER_WINDOW_SEC;
  cachedStalePowerWindowAt = now;
  return cachedStalePowerWindowSec;
}

export function __resetStopModeCacheForTests(): void {
  cachedMode = null;
  cachedModeAt = 0;
}

export function __resetBandThresholdCacheForTests(): void {
  cachedThreshold = null;
  cachedThresholdAt = 0;
}

export function __resetStalePowerThresholdCacheForTests(): void {
  cachedStalePowerThresholdW = null;
  cachedStalePowerThresholdAt = 0;
}

export function __resetStalePowerWindowCacheForTests(): void {
  cachedStalePowerWindowSec = null;
  cachedStalePowerWindowAt = 0;
}
