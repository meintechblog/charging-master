import { db } from '@/db/client';
import { deviceProfiles, referenceCurves, socBoundaries, priceHistory, chargeSessions } from '@/db/schema';
import { eq, desc, and, sql } from 'drizzle-orm';

export const runtime = 'nodejs';

/**
 * GET /api/profiles/[id] -- Fetch single profile with curve metadata and SOC boundaries.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const profileId = parseInt(id, 10);

  if (isNaN(profileId)) {
    return Response.json({ error: 'invalid_id' }, { status: 400 });
  }

  const profile = db.select().from(deviceProfiles)
    .where(eq(deviceProfiles.id, profileId)).get();

  if (!profile) {
    return Response.json({ error: 'not_found' }, { status: 404 });
  }

  const curve = db.select().from(referenceCurves)
    .where(eq(referenceCurves.profileId, profileId)).get();

  let boundaries: Array<{ soc: number; offsetSeconds: number; cumulativeWh: number }> = [];
  if (curve) {
    boundaries = db.select({
      soc: socBoundaries.soc,
      offsetSeconds: socBoundaries.offsetSeconds,
      cumulativeWh: socBoundaries.cumulativeWh,
    }).from(socBoundaries)
      .where(eq(socBoundaries.curveId, curve.id)).all();
  }

  const prices = db.select().from(priceHistory)
    .where(eq(priceHistory.profileId, profileId))
    .orderBy(desc(priceHistory.recordedAt))
    .all();

  // Cycles-used estimate from session history: sum of delivered energy across
  // all sessions that referenced this profile, divided by the user-entered
  // capacity. "1 cycle" = enough energy to fully charge from 0-100 %.
  const totalDeliveredRow = db
    .select({ total: sql<number>`COALESCE(SUM(${chargeSessions.energyWh}), 0)` })
    .from(chargeSessions)
    .where(and(
      eq(chargeSessions.profileId, profileId),
      sql`${chargeSessions.state} IN ('complete', 'charging', 'countdown', 'stopping', 'matched')`,
    ))
    .get();
  const totalDeliveredWh = totalDeliveredRow?.total ?? 0;
  const sessionCountRow = db
    .select({ c: sql<number>`COUNT(*)` })
    .from(chargeSessions)
    .where(eq(chargeSessions.profileId, profileId))
    .get();
  const sessionCount = sessionCountRow?.c ?? 0;
  // Prefer the measured reference-curve total Wh as "per cycle" because it
  // already reflects real-world charging losses end-to-end. Fall back to
  // user-entered capacityWh (which is net battery capacity, underestimates
  // cycles when charging losses are significant).
  const perCycleWh = curve?.totalEnergyWh ?? profile.capacityWh;
  const cyclesUsed = perCycleWh && perCycleWh > 0
    ? totalDeliveredWh / perCycleWh
    : null;

  return Response.json({
    ...profile,
    certifications: parseJsonArray(profile.certifications),
    extra: parseJsonObject(profile.extra),
    hasCurve: !!curve,
    curve: curve ? {
      id: curve.id,
      startPower: curve.startPower,
      peakPower: curve.peakPower,
      totalEnergyWh: curve.totalEnergyWh,
      durationSeconds: curve.durationSeconds,
      pointCount: curve.pointCount,
    } : null,
    socBoundaries: boundaries,
    priceHistory: prices,
    cyclesUsed,
    totalDeliveredWh,
    sessionCount,
  });
}

function parseJsonArray(raw: string | null): string[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : null;
  } catch {
    return null;
  }
}

function parseJsonObject(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * PUT /api/profiles/[id] -- Update profile attributes.
 * Per D-31: targetSoc must be 10-100 in steps of 10.
 * Per D-06/PROF-06: user can set target SOC per device profile.
 */
export async function PUT(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const profileId = parseInt(id, 10);

  if (isNaN(profileId)) {
    return Response.json({ error: 'invalid_id' }, { status: 400 });
  }

  const existing = db.select().from(deviceProfiles)
    .where(eq(deviceProfiles.id, profileId)).get();

  if (!existing) {
    return Response.json({ error: 'not_found' }, { status: 404 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'invalid_body' }, { status: 400 });
  }

  // Validate name if provided
  if (body.name !== undefined) {
    if (typeof body.name !== 'string' || body.name.length < 1 || body.name.length > 100) {
      return Response.json({ error: 'invalid_name', message: 'Name must be 1-100 characters' }, { status: 400 });
    }
  }

  // Validate targetSoc if provided
  if (body.targetSoc !== undefined) {
    const soc = Number(body.targetSoc);
    if (isNaN(soc) || soc < 10 || soc > 100 || soc % 10 !== 0) {
      return Response.json({ error: 'invalid_target_soc', message: 'targetSoc must be 10-100 in steps of 10' }, { status: 400 });
    }
  }

  const updates: Record<string, unknown> = { updatedAt: Date.now() };

  if (typeof body.name === 'string') updates.name = body.name.trim();
  if (typeof body.description === 'string') updates.description = body.description;
  if (typeof body.modelName === 'string') updates.modelName = body.modelName;
  if (typeof body.purchaseDate === 'string') updates.purchaseDate = body.purchaseDate;
  if (body.capacityWh !== undefined) updates.capacityWh = body.capacityWh === null ? null : Number(body.capacityWh);
  if (typeof body.estimatedCycles === 'number') updates.estimatedCycles = body.estimatedCycles;
  if (body.targetSoc !== undefined) updates.targetSoc = Number(body.targetSoc);
  if (typeof body.manufacturer === 'string') updates.manufacturer = body.manufacturer;
  if (typeof body.articleNumber === 'string') updates.articleNumber = body.articleNumber;
  if (typeof body.gtin === 'string') updates.gtin = body.gtin;
  if (body.weightGrams !== undefined) updates.weightGrams = body.weightGrams === null ? null : Number(body.weightGrams);
  if (typeof body.productUrl === 'string') updates.productUrl = body.productUrl;
  if (typeof body.documentUrl === 'string') updates.documentUrl = body.documentUrl;

  // --- Extended battery metadata (Phase: profile-schema-extension) ---
  const stringFields = [
    'chemistry', 'cellDesignation', 'cellConfiguration',
    'serialNumber', 'productionDate', 'countryOfOrigin',
    'batteryFormFactor', 'warrantyUntil', 'chargerModel', 'notes',
  ] as const;
  for (const field of stringFields) {
    const v = body[field];
    if (v === null) updates[field] = null;
    else if (typeof v === 'string') updates[field] = v.trim() || null;
  }

  const numberFields = [
    'nominalVoltageV', 'nominalCapacityMah',
    'maxChargeCurrentA', 'maxChargeVoltageV',
    'chargeTempMinC', 'chargeTempMaxC',
    'dischargeTempMinC', 'dischargeTempMaxC',
    'endOfLifeCapacityPct', 'warrantyCycles',
  ] as const;
  for (const field of numberFields) {
    const v = body[field];
    if (v === null) updates[field] = null;
    else if (typeof v === 'number' && Number.isFinite(v)) updates[field] = v;
    else if (typeof v === 'string' && v.trim() !== '') {
      const n = Number(v);
      if (Number.isFinite(n)) updates[field] = n;
    }
  }

  if (body.replaceable === null) updates.replaceable = null;
  else if (typeof body.replaceable === 'boolean') updates.replaceable = body.replaceable;

  // certifications: accept array<string> or null; serialize as JSON
  if (body.certifications === null) {
    updates.certifications = null;
  } else if (Array.isArray(body.certifications)) {
    const cleaned = body.certifications
      .filter((s): s is string => typeof s === 'string' && s.trim() !== '')
      .map((s) => s.trim());
    updates.certifications = cleaned.length > 0 ? JSON.stringify(cleaned) : null;
  }

  // extra: free-form JSON object; accept object/null, reject other types
  if (body.extra === null) {
    updates.extra = null;
  } else if (body.extra !== undefined && typeof body.extra === 'object' && !Array.isArray(body.extra)) {
    updates.extra = JSON.stringify(body.extra);
  }

  // Price with history tracking
  if (body.priceEur !== undefined) {
    const newPrice = body.priceEur === null ? null : Number(body.priceEur);
    const oldPrice = existing.priceEur;

    if (newPrice !== oldPrice && newPrice !== null) {
      const now = Date.now();
      updates.priceEur = newPrice;
      updates.priceUpdatedAt = now;

      // Record price history entry
      db.insert(priceHistory).values({
        profileId,
        priceEur: newPrice,
        recordedAt: now,
      }).run();
    } else if (newPrice === null) {
      updates.priceEur = null;
      updates.priceUpdatedAt = null;
    }
  }

  db.update(deviceProfiles).set(updates)
    .where(eq(deviceProfiles.id, profileId)).run();

  const updated = db.select().from(deviceProfiles)
    .where(eq(deviceProfiles.id, profileId)).get();

  // Include price history
  const prices = db.select().from(priceHistory)
    .where(eq(priceHistory.profileId, profileId))
    .orderBy(desc(priceHistory.recordedAt))
    .all();

  return Response.json({
    ...updated,
    certifications: parseJsonArray(updated?.certifications ?? null),
    extra: parseJsonObject(updated?.extra ?? null),
    priceHistory: prices,
  });
}

/**
 * DELETE /api/profiles/[id] -- Delete profile (cascades to curves, points, boundaries).
 * Per D-32: Profile actions include delete.
 */
export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const profileId = parseInt(id, 10);

  if (isNaN(profileId)) {
    return Response.json({ error: 'invalid_id' }, { status: 400 });
  }

  const existing = db.select().from(deviceProfiles)
    .where(eq(deviceProfiles.id, profileId)).get();

  if (!existing) {
    return Response.json({ error: 'not_found' }, { status: 404 });
  }

  // Detach from any charge_sessions that still reference this profile. Keeping
  // the session history is more useful than cascade-deleting it; the sessions
  // just show up without a profile name afterwards.
  db.update(chargeSessions)
    .set({ profileId: null })
    .where(eq(chargeSessions.profileId, profileId))
    .run();

  db.delete(deviceProfiles).where(eq(deviceProfiles.id, profileId)).run();

  return Response.json({ ok: true });
}
