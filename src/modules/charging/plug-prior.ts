/**
 * v1.6 per-plug Bayesian prior + whitelist + energy-bound elimination.
 *
 * Stacked above the DTW matcher in three independent gates:
 *
 *   1. **Whitelist gate** (`getAllowedProfileIds`)
 *      Reads `plugs.allowed_profile_ids` — a JSON-serialised array of
 *      integer profile IDs. NULL → match against everything. Length 1 →
 *      hard pin (caller short-circuits DTW entirely). Length ≥ 2 → DTW
 *      runs against just that subset. Replaces v1.5's single-column
 *      pinnedProfileId — same semantics for the single-pin case.
 *
 *   2. **Bayesian prior** (`getPlugProfilePrior`)
 *      Dirichlet–multinomial over `charge_sessions.profile_id` filtered
 *      by `plug_id` and `state IN ('complete')` — the historical record
 *      of "which device finished a full cycle on this plug". With a flat
 *      Dirichlet alpha=1 (Laplace smoothing), an unseen profile still
 *      gets a non-zero prior so the matcher can recover from a new
 *      device. The literature (see [feedback_socb_failed_uat]'s research
 *      brief on NILM) consistently cites per-plug MAP priors as the
 *      single highest-ROI disambiguation move for low-frequency
 *      single-plug data — exactly our regime.
 *
 *   3. **Energy-bound elimination** (`isEnergyImpossible`)
 *      A candidate profile whose reference-curve total energy is less
 *      than `currentSessionWh / ENERGY_TOLERANCE` is mathematically
 *      eliminated: we have already delivered more energy than its full
 *      reference cycle. Bosch GBA (19 Wh ref) is killed within 5 min on
 *      a 40 W plug, leaving iPad/MacBook/eBike standing. Continuous —
 *      re-applied on every reading.
 *
 * Pure functions where possible; the DB-backed helpers take an injectable
 * `db` for testability. No side-effects outside the SELECTs.
 */

import { eq, and } from 'drizzle-orm';
import { plugs, chargeSessions } from '@/db/schema';
import type { db as DbType } from '@/db/client';

export type Db = typeof DbType;

/** Energy-bound tolerance — eliminate a candidate when delivered > ref × this. */
export const ENERGY_BOUND_TOLERANCE = 1.1;

/** Laplace smoothing — every profile gets a "1 prior pseudo-session". */
export const PRIOR_ALPHA = 1;

/**
 * Parse the JSON-stored allowed_profile_ids column. Returns:
 *   - null when no whitelist set (DTW runs against everything)
 *   - integer[] when set (caller filters candidates to this list)
 *
 * Tolerates malformed values — falls back to null + console.warn rather
 * than throwing, because a broken JSON cell shouldn't disable a plug.
 */
export function parseAllowedProfileIds(raw: string | null | undefined): number[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const cleaned = parsed
      .map((x) => (typeof x === 'number' && Number.isInteger(x) ? x : NaN))
      .filter((x) => !Number.isNaN(x));
    return cleaned.length > 0 ? cleaned : null;
  } catch {
    console.warn('[plug-prior] malformed allowed_profile_ids JSON:', raw);
    return null;
  }
}

/**
 * Convenience wrapper — read+parse the whitelist for a single plug.
 */
export function getAllowedProfileIds(db: Db, plugId: string): number[] | null {
  const row = db.select({ raw: plugs.allowedProfileIds }).from(plugs).where(eq(plugs.id, plugId)).get();
  return parseAllowedProfileIds(row?.raw ?? null);
}

/**
 * Compute the Dirichlet–multinomial prior P(profile | plug) for every
 * profile in `candidateIds`. Counts come from `charge_sessions` rows
 * matching this plug AND `state='complete'` (we ONLY trust completed
 * cycles as ground-truth — aborted sessions might be mis-classifications).
 *
 * Returns a Map keyed by profile id with values normalised to sum=1
 * across candidateIds. An empty history → uniform prior. A pin
 * (candidateIds.length=1) → prior {id: 1.0} — confidence comes entirely
 * from the user-set whitelist, not from past sessions.
 */
export function getPlugProfileCounts(db: Db, plugId: string): Map<number, number> {
  const rows = db
    .select({ profileId: chargeSessions.profileId })
    .from(chargeSessions)
    .where(
      and(eq(chargeSessions.plugId, plugId), eq(chargeSessions.state, 'complete'))
    )
    .all();
  const counts = new Map<number, number>();
  for (const r of rows) {
    if (r.profileId == null) continue;
    counts.set(r.profileId, (counts.get(r.profileId) ?? 0) + 1);
  }
  return counts;
}

export function buildPrior(
  candidateIds: number[],
  counts: Map<number, number>,
): Map<number, number> {
  if (candidateIds.length === 0) return new Map();
  if (candidateIds.length === 1) return new Map([[candidateIds[0], 1.0]]);
  const totalAlpha = candidateIds.length * PRIOR_ALPHA;
  const totalCounts = candidateIds.reduce((acc, id) => acc + (counts.get(id) ?? 0), 0);
  const denominator = totalCounts + totalAlpha;
  const prior = new Map<number, number>();
  for (const id of candidateIds) {
    prior.set(id, ((counts.get(id) ?? 0) + PRIOR_ALPHA) / denominator);
  }
  return prior;
}

export function getPlugProfilePrior(db: Db, plugId: string, candidateIds: number[]): Map<number, number> {
  return buildPrior(candidateIds, getPlugProfileCounts(db, plugId));
}

/**
 * Energy-bound test. Returns true iff the profile is mathematically
 * impossible given the session's current delivered Wh.
 *
 * Implementation note: `totalEnergyWh` is the curve's recorded full
 * cycle. We tolerate 10% over (charger-efficiency drift, BMS variance)
 * before eliminating. Below the tolerance, the candidate is still in
 * play and the matcher can keep ranking it normally.
 */
export function isEnergyImpossible(
  currentSessionWh: number,
  profileTotalEnergyWh: number,
): boolean {
  if (profileTotalEnergyWh <= 0) return false;
  return currentSessionWh > profileTotalEnergyWh * ENERGY_BOUND_TOLERANCE;
}
