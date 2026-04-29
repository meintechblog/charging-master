/**
 * Calibration — turns user SOC corrections into a feedback loop that
 * raises future detection accuracy.
 *
 * Two outputs:
 *  1. Start-SOC bias (applied on every match): median of recent
 *     (corrected − predicted) deltas per profile, clipped to ±15 %.
 *  2. Charger efficiency (applied on session complete, only when an
 *     early correction gave us a clean start-SOC anchor): EMA-blended
 *     observed eta = delivered_dc_wh / consumed_ac_wh, clipped [0.5, 0.99].
 */

import { db } from '@/db/client';
import { socCorrections, deviceProfiles, chargers } from '@/db/schema';
import { eq, desc } from 'drizzle-orm';

const MAX_BIAS_PCT = 15;
const RECENT_CORRECTIONS = 5;

const ETA_EMA_ALPHA = 0.3;
const ETA_MIN = 0.5;
const ETA_MAX = 0.99;
const ETA_DEFAULT = 0.85;

// An early correction = chargedWh below this anchor counts as "the user told
// us the real start-SOC". Above this, the correction is treated as drift
// signal only (used for bias) and not as an eta anchor.
const EARLY_CORRECTION_WH_THRESHOLD = 10;

export function logSocCorrection(args: {
  profileId: number;
  sessionId: number;
  predictedSoc: number;
  correctedSoc: number;
  chargedWhAtCorrection: number;
}): void {
  db.insert(socCorrections).values({
    profileId: args.profileId,
    sessionId: args.sessionId,
    createdAt: Date.now(),
    predictedSoc: args.predictedSoc,
    correctedSoc: args.correctedSoc,
    chargedWhAtCorrection: args.chargedWhAtCorrection,
  }).run();
}

/**
 * Median of the (corrected − predicted) deltas over the last
 * RECENT_CORRECTIONS entries for this profile, clipped to ±MAX_BIAS_PCT.
 * Median over mean: a single wildly-wrong correction shouldn't pull the
 * bias.
 */
export function getStartSocBias(profileId: number): number {
  const recent = db
    .select({
      predictedSoc: socCorrections.predictedSoc,
      correctedSoc: socCorrections.correctedSoc,
    })
    .from(socCorrections)
    .where(eq(socCorrections.profileId, profileId))
    .orderBy(desc(socCorrections.createdAt))
    .limit(RECENT_CORRECTIONS)
    .all();

  if (recent.length === 0) return 0;

  const deltas = recent
    .map((r) => r.correctedSoc - r.predictedSoc)
    .sort((a, b) => a - b);

  // Median (handles even/odd lengths simply by lower middle)
  const median = deltas[Math.floor(deltas.length / 2)];
  return Math.max(-MAX_BIAS_PCT, Math.min(MAX_BIAS_PCT, median));
}

/**
 * Recalibrate the charger efficiency from a clean (start, end) SOC pair
 * and the AC Wh consumed between them. Returns the change so the caller
 * can log it.
 *
 * Writes to chargers.efficiency when profile.chargerId is set (preferred,
 * shared across profiles using the same charger), otherwise falls back to
 * deviceProfiles.chargerEfficiency.
 */
export function recalibrateEta(args: {
  profileId: number;
  startSoc: number;
  endSoc: number;
  acWh: number;
}): { applied: boolean; oldEta?: number; newEta?: number; reason?: string } {
  if (args.endSoc <= args.startSoc) return { applied: false, reason: 'no_soc_progress' };
  if (args.acWh <= 0) return { applied: false, reason: 'no_energy_consumed' };

  const profile = db
    .select()
    .from(deviceProfiles)
    .where(eq(deviceProfiles.id, args.profileId))
    .get();
  if (!profile) return { applied: false, reason: 'profile_missing' };
  if (!profile.capacityWh || profile.capacityWh <= 0) {
    return { applied: false, reason: 'no_capacity' };
  }

  const deltaSoc = (args.endSoc - args.startSoc) / 100;
  const deliveredDcWh = deltaSoc * profile.capacityWh;
  const observedEta = deliveredDcWh / args.acWh;
  if (!Number.isFinite(observedEta) || observedEta <= 0) {
    return { applied: false, reason: 'invalid_observed_eta' };
  }
  const observedClipped = Math.max(ETA_MIN, Math.min(ETA_MAX, observedEta));

  // Resolve the current stored eta. Charger-level wins when the profile
  // links to a charger record (a shared charger should aggregate signal
  // across all profiles charging through it).
  let oldEta: number;
  let target: 'charger' | 'profile';
  if (profile.chargerId != null) {
    const ch = db.select().from(chargers).where(eq(chargers.id, profile.chargerId)).get();
    oldEta = ch?.efficiency ?? profile.chargerEfficiency ?? ETA_DEFAULT;
    target = 'charger';
  } else {
    oldEta = profile.chargerEfficiency ?? ETA_DEFAULT;
    target = 'profile';
  }

  const blended = (1 - ETA_EMA_ALPHA) * oldEta + ETA_EMA_ALPHA * observedClipped;
  const newEta = Math.max(ETA_MIN, Math.min(ETA_MAX, blended));

  if (target === 'charger' && profile.chargerId != null) {
    db.update(chargers)
      .set({ efficiency: newEta, updatedAt: Date.now() })
      .where(eq(chargers.id, profile.chargerId))
      .run();
  } else {
    db.update(deviceProfiles)
      .set({ chargerEfficiency: newEta })
      .where(eq(deviceProfiles.id, profile.id))
      .run();
  }

  return { applied: true, oldEta, newEta };
}

/**
 * Returns the earliest correction logged for this session that has
 * chargedWhAtCorrection below the early-anchor threshold, or null. The
 * matcher uses this on session complete as a clean start-SOC ground truth
 * for eta recalibration.
 */
export function getEarlyCorrection(sessionId: number): {
  correctedSoc: number;
  chargedWhAtCorrection: number;
} | null {
  const row = db
    .select({
      correctedSoc: socCorrections.correctedSoc,
      chargedWhAtCorrection: socCorrections.chargedWhAtCorrection,
    })
    .from(socCorrections)
    .where(eq(socCorrections.sessionId, sessionId))
    .orderBy(socCorrections.createdAt)
    .limit(1)
    .get();
  if (!row) return null;
  if (row.chargedWhAtCorrection > EARLY_CORRECTION_WH_THRESHOLD) return null;
  return row;
}
