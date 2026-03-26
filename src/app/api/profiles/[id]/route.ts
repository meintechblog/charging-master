import { db } from '@/db/client';
import { deviceProfiles, referenceCurves, socBoundaries } from '@/db/schema';
import { eq } from 'drizzle-orm';

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

  return Response.json({
    ...profile,
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
  });
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
  if (typeof body.estimatedCycles === 'number') updates.estimatedCycles = body.estimatedCycles;
  if (body.targetSoc !== undefined) updates.targetSoc = Number(body.targetSoc);

  db.update(deviceProfiles).set(updates)
    .where(eq(deviceProfiles.id, profileId)).run();

  const updated = db.select().from(deviceProfiles)
    .where(eq(deviceProfiles.id, profileId)).get();

  return Response.json(updated);
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

  db.delete(deviceProfiles).where(eq(deviceProfiles.id, profileId)).run();

  return Response.json({ ok: true });
}
