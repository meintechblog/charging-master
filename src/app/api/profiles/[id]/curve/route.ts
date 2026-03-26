import { db } from '@/db/client';
import { deviceProfiles, referenceCurves, referenceCurvePoints } from '@/db/schema';
import { eq } from 'drizzle-orm';

export const runtime = 'nodejs';

/**
 * GET /api/profiles/[id]/curve -- Fetch reference curve points for chart display.
 * Provides data for D-32 reference curve chart and VIZL-03 overlay.
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
    return Response.json({ error: 'profile_not_found' }, { status: 404 });
  }

  const curve = db.select().from(referenceCurves)
    .where(eq(referenceCurves.profileId, profileId)).get();

  if (!curve) {
    return Response.json({ error: 'no_curve' }, { status: 404 });
  }

  const points = db.select({
    offsetSeconds: referenceCurvePoints.offsetSeconds,
    apower: referenceCurvePoints.apower,
    voltage: referenceCurvePoints.voltage,
    current: referenceCurvePoints.current,
    cumulativeWh: referenceCurvePoints.cumulativeWh,
  }).from(referenceCurvePoints)
    .where(eq(referenceCurvePoints.curveId, curve.id))
    .all();

  return Response.json({
    curveId: curve.id,
    profileId: profile.id,
    profileName: profile.name,
    startPower: curve.startPower,
    peakPower: curve.peakPower,
    totalEnergyWh: curve.totalEnergyWh,
    durationSeconds: curve.durationSeconds,
    points,
  });
}
