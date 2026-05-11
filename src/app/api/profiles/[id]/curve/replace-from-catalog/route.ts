import { db } from '@/db/client';
import {
  deviceProfiles,
  referenceCurves,
  referenceCurvePoints,
  socBoundaries,
} from '@/db/schema';
import { eq } from 'drizzle-orm';
import { loadProfile, loadCurvePoints, isCatalogEnabled } from '@/modules/catalog';

export const runtime = 'nodejs';

/**
 * POST /api/profiles/[id]/curve/replace-from-catalog
 * Body: { catalogId: string }
 *
 * Adopts a catalog profile's reference curve into a local profile that
 * already exists. Replaces the local curve's points + SOC boundaries with
 * the catalog version and updates summary fields (pointCount, peak, total
 * energy, duration). The profile's name, photos, manufacturer, etc. stay
 * as-is — only the curve data is swapped.
 *
 * Use case: after learning a new curve, the app detected a ≥90% match in
 * the catalog. The user picks the catalog entry as the "authoritative"
 * curve while keeping their own naming.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  if (!isCatalogEnabled()) {
    return Response.json({ error: 'catalog_disabled' }, { status: 403 });
  }

  const { id } = await context.params;
  const profileId = parseInt(id, 10);
  if (!Number.isFinite(profileId)) {
    return Response.json({ error: 'invalid_id' }, { status: 400 });
  }

  let body: { catalogId?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'invalid_body' }, { status: 400 });
  }
  const catalogId = body.catalogId;
  if (typeof catalogId !== 'string' || !/^[a-f0-9]{16}$/.test(catalogId)) {
    return Response.json({ error: 'invalid_catalog_id' }, { status: 400 });
  }

  const profile = db.select().from(deviceProfiles).where(eq(deviceProfiles.id, profileId)).get();
  if (!profile) {
    return Response.json({ error: 'profile_not_found' }, { status: 404 });
  }

  const catalogProfile = loadProfile(catalogId);
  if (!catalogProfile) {
    return Response.json({ error: 'catalog_entry_not_found' }, { status: 404 });
  }
  const catalogPoints = loadCurvePoints(catalogId);
  if (catalogPoints.length < 2) {
    return Response.json({ error: 'catalog_curve_empty' }, { status: 422 });
  }

  // Find or create the local reference curve row.
  let curve = db.select().from(referenceCurves).where(eq(referenceCurves.profileId, profileId)).get();
  const now = Date.now();
  if (!curve) {
    curve = db.insert(referenceCurves).values({
      profileId,
      startPower: catalogProfile.curve.startPowerW,
      peakPower: catalogProfile.curve.peakPowerW,
      totalEnergyWh: catalogProfile.curve.totalEnergyWh,
      durationSeconds: catalogProfile.curve.durationSeconds,
      pointCount: catalogProfile.curve.pointCount,
      createdAt: now,
    }).returning().get();
  } else {
    db.delete(referenceCurvePoints).where(eq(referenceCurvePoints.curveId, curve.id)).run();
    db.delete(socBoundaries).where(eq(socBoundaries.curveId, curve.id)).run();
    db.update(referenceCurves).set({
      startPower: catalogProfile.curve.startPowerW,
      peakPower: catalogProfile.curve.peakPowerW,
      totalEnergyWh: catalogProfile.curve.totalEnergyWh,
      durationSeconds: catalogProfile.curve.durationSeconds,
      pointCount: catalogProfile.curve.pointCount,
    }).where(eq(referenceCurves.id, curve.id)).run();
  }

  // Insert catalog points (recompute cumulative Wh via trapezoid).
  const curveId = curve.id;
  let cumulativeWh = 0;
  let prevOffset = 0;
  let prevApower = 0;
  const rows = catalogPoints.map((p, i) => {
    if (i > 0) {
      const dtH = (p.offsetSeconds - prevOffset) / 3600;
      const avgP = (p.apower + prevApower) / 2;
      cumulativeWh += avgP * dtH;
    }
    prevOffset = p.offsetSeconds;
    prevApower = p.apower;
    return {
      curveId,
      offsetSeconds: p.offsetSeconds,
      apower: p.apower,
      voltage: null,
      current: null,
      cumulativeWh,
    };
  });
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    db.insert(referenceCurvePoints).values(rows.slice(i, i + CHUNK)).run();
  }

  for (const b of catalogProfile.socBoundaries) {
    db.insert(socBoundaries).values({
      curveId,
      soc: b.soc,
      offsetSeconds: b.offsetSeconds,
      cumulativeWh: b.cumulativeWh,
      expectedPower: b.expectedPower,
    }).run();
  }

  db.update(deviceProfiles).set({ updatedAt: now }).where(eq(deviceProfiles.id, profileId)).run();

  return Response.json({
    ok: true,
    curveId,
    catalogId,
    pointCount: catalogPoints.length,
  });
}
