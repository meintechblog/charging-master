/**
 * v1.7-C Post-Cycle Self-Calibration.
 *
 * After a session reaches a terminal state (state='complete' or
 * stop_reason='stale_power'), the total delivered Wh is a near-immutable
 * physical fingerprint of the device's battery pack — assuming the
 * session ran from "near empty" to "physically full" (taper to 0 W, BMS
 * cut-off). We can compare it to the committed profile's reference
 * total energy AND the rest of the plug's whitelist; if the committed
 * profile is the best match within tolerance, the session is
 * `verified_at` (Bayesian counter trusts it as ground truth). If
 * another candidate fits noticeably better, `flag_reason` surfaces the
 * discrepancy to the dashboard so the user can re-classify or update
 * the profile catalogue.
 *
 * Pure-functional scorer + a DB-shaped wrapper:
 *
 *   - `scoreSessionVsProfiles(deliveredWh, committedProfileId, candidates)`
 *     → `{ verifiedAt: number | null, flagReason: string | null }`
 *   - `runPostCycleCalibration(db, sessionId, plugId, committedProfileId,
 *      deliveredWh)` → writes the verdict to chargeSessions.
 */

import { eq } from 'drizzle-orm';
import { chargeSessions, deviceProfiles, referenceCurves, plugs } from '@/db/schema';
import { parseAllowedProfileIds } from './plug-prior';
import type { db as DbType } from '@/db/client';

export type Db = typeof DbType;

/**
 * Tolerance for "committed profile is good enough" verdict. Charger
 * efficiency, BMS cutoff variance, and degraded batteries can shift the
 * delivered Wh by ±20 % from the reference. Tighter than this we'd
 * false-flag healthy sessions; looser we'd let a clear mis-classification
 * (Bosch GBA 19 Wh vs iPad 62 Wh = 3× factor) slip through.
 */
export const VERIFY_TOLERANCE = 0.20;

/**
 * Minimum delivered Wh for calibration to be meaningful. Below this we
 * either had a short session (user aborted early) or the BMS rejected
 * the charger after a couple seconds — neither produces useful ground
 * truth.
 */
export const MIN_CALIBRATION_WH = 5;

export interface CandidateProfile {
  id: number;
  name: string;
  totalEnergyWh: number;
}

export interface CalibrationVerdict {
  verifiedAt: number | null;
  flagReason: string | null;
}

/**
 * Score a session's delivered Wh against the committed profile and a
 * candidate set. Returns:
 *
 *   - `{ verifiedAt: now, flagReason: null }` when the committed
 *     profile's expected total energy is within ±VERIFY_TOLERANCE of
 *     delivered AND no other candidate fits closer.
 *   - `{ verifiedAt: null, flagReason: <text> }` when another candidate
 *     fits closer OR the committed profile is out of tolerance.
 *   - `{ verifiedAt: null, flagReason: null }` when calibration was
 *     skipped (too little energy, missing candidates) — neutral state.
 */
export function scoreSessionVsProfiles(
  deliveredWh: number,
  committedProfileId: number | null,
  candidates: CandidateProfile[],
  now: number = Date.now(),
): CalibrationVerdict {
  if (deliveredWh < MIN_CALIBRATION_WH || committedProfileId === null || candidates.length === 0) {
    return { verifiedAt: null, flagReason: null };
  }

  // Score = relative absolute error against the profile's expected total
  // energy. Lower = better fit. Sessions that end at "physically full"
  // typically land within 0.15 of 1.0 (charger ~85 % efficient).
  function fitError(p: CandidateProfile): number {
    if (p.totalEnergyWh <= 0) return Infinity;
    return Math.abs(deliveredWh / p.totalEnergyWh - 1.0);
  }

  const committed = candidates.find((c) => c.id === committedProfileId);
  const committedError = committed ? fitError(committed) : Infinity;

  // Find the best-fitting candidate. If it's NOT the committed one AND
  // its error is meaningfully better, flag the session.
  const bestFit = candidates.reduce((best, c) =>
    fitError(c) < fitError(best) ? c : best,
  );
  const bestError = fitError(bestFit);

  if (committed && committedError <= VERIFY_TOLERANCE && bestFit.id === committedProfileId) {
    return { verifiedAt: now, flagReason: null };
  }

  if (bestFit.id !== committedProfileId && bestError < committedError - 0.05) {
    // Another candidate is meaningfully better. Surface it.
    return {
      verifiedAt: null,
      flagReason:
        `Energie ${deliveredWh.toFixed(1)} Wh passt besser zu "${bestFit.name}" ` +
        `(Δ ${(bestError * 100).toFixed(0)} %) als zur erkannten "${committed?.name ?? '?'}" ` +
        `(Δ ${(committedError * 100).toFixed(0)} %). Profil prüfen?`,
    };
  }

  if (committed && committedError > VERIFY_TOLERANCE) {
    return {
      verifiedAt: null,
      flagReason:
        `Geliefert ${deliveredWh.toFixed(1)} Wh weicht ${(committedError * 100).toFixed(0)} % ` +
        `von Referenz "${committed.name}" (${committed.totalEnergyWh.toFixed(1)} Wh) ab.`,
    };
  }

  return { verifiedAt: null, flagReason: null };
}

/**
 * DB-shaped runner. Loads the plug's whitelist, joins device_profiles +
 * reference_curves, scores the session, and writes the verdict to
 * chargeSessions in one shot. Fail-safe: any DB error is logged and the
 * session is left unflagged (no false positives from infrastructure
 * hiccups).
 */
export function runPostCycleCalibration(
  db: Db,
  sessionId: number,
  plugId: string,
  committedProfileId: number | null,
  deliveredWh: number,
): CalibrationVerdict {
  let candidates: CandidateProfile[] = [];
  try {
    const plug = db.select().from(plugs).where(eq(plugs.id, plugId)).get();
    const whitelistIds = parseAllowedProfileIds(plug?.allowedProfileIds ?? null);

    // Pull device_profiles JOIN reference_curves so we have totalEnergyWh
    // per candidate without a second roundtrip. Either restrict to the
    // plug's whitelist (if set) or pull every profile (unpinned plug).
    const allProfiles = db
      .select({
        id: deviceProfiles.id,
        name: deviceProfiles.name,
        totalEnergyWh: referenceCurves.totalEnergyWh,
      })
      .from(deviceProfiles)
      .leftJoin(referenceCurves, eq(referenceCurves.profileId, deviceProfiles.id))
      .all();

    candidates = allProfiles
      .filter((p) => p.totalEnergyWh != null && (whitelistIds === null || whitelistIds.includes(p.id)))
      .map((p) => ({ id: p.id, name: p.name, totalEnergyWh: p.totalEnergyWh as number }));
  } catch (err) {
    console.error('[post-cycle-calibration] failed to load candidates:', err instanceof Error ? err.message : err);
    return { verifiedAt: null, flagReason: null };
  }

  const verdict = scoreSessionVsProfiles(deliveredWh, committedProfileId, candidates);

  try {
    db.update(chargeSessions)
      .set({ verifiedAt: verdict.verifiedAt, flagReason: verdict.flagReason })
      .where(eq(chargeSessions.id, sessionId))
      .run();
  } catch (err) {
    console.error('[post-cycle-calibration] failed to persist verdict:', err instanceof Error ? err.message : err);
  }

  if (verdict.verifiedAt) {
    console.log(`[post-cycle-calibration] session ${sessionId} verified (${deliveredWh.toFixed(1)} Wh fits committed profile)`);
  } else if (verdict.flagReason) {
    console.warn(`[post-cycle-calibration] session ${sessionId} FLAGGED: ${verdict.flagReason}`);
  }

  return verdict;
}
