import { db } from '@/db/client';
import {
  chargeSessions,
  sessionReadings,
  referenceCurves,
  referenceCurvePoints,
  socBoundaries,
} from '@/db/schema';
import { eq, and, inArray, asc } from 'drizzle-orm';
import { computeSocBoundaries } from '@/modules/charging/soc-estimator';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  let body: { plugId?: string; action?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'invalid_body' }, { status: 400 });
  }

  const { plugId, action } = body;

  if (!plugId || typeof plugId !== 'string') {
    return Response.json({ error: 'invalid_plug_id' }, { status: 400 });
  }
  if (action !== 'save' && action !== 'discard') {
    return Response.json({ error: 'invalid_action', expected: 'save | discard' }, { status: 400 });
  }

  // Find active learning session for this plug
  const session = db
    .select()
    .from(chargeSessions)
    .where(
      and(
        eq(chargeSessions.plugId, plugId),
        inArray(chargeSessions.state, ['learning', 'learn_complete'])
      )
    )
    .get();

  if (!session) {
    return Response.json({ error: 'no_active_learning_session' }, { status: 404 });
  }

  // Stop server-side recording
  if (globalThis.__chargeMonitor) {
    globalThis.__chargeMonitor.stopLearning(plugId);
  }

  const now = Date.now();

  if (action === 'discard') {
    db.update(chargeSessions)
      .set({ state: 'aborted', stoppedAt: now, stopReason: 'manual' })
      .where(eq(chargeSessions.id, session.id))
      .run();

    db.delete(sessionReadings)
      .where(eq(sessionReadings.sessionId, session.id))
      .run();

    return Response.json({ ok: true, action: 'discarded' });
  }

  // action === 'save'
  // 1. Fetch all readings ordered by offsetMs
  const readings = db
    .select()
    .from(sessionReadings)
    .where(eq(sessionReadings.sessionId, session.id))
    .orderBy(asc(sessionReadings.offsetMs))
    .all();

  if (readings.length === 0) {
    return Response.json({ error: 'no_readings_recorded' }, { status: 400 });
  }

  // 2. Downsample to 1 reading per second (last reading in each second bucket)
  const bucketMap = new Map<number, typeof readings[number]>();
  for (const r of readings) {
    const bucket = Math.floor(r.offsetMs / 1000);
    bucketMap.set(bucket, r); // last one wins
  }
  const downsampled = Array.from(bucketMap.entries())
    .sort(([a], [b]) => a - b)
    .map(([bucket, r]) => ({
      offsetSeconds: bucket,
      apower: r.apower,
      voltage: r.voltage,
      current: r.current,
    }));

  // 3. Compute cumulative Wh
  const curvePoints: Array<{
    offsetSeconds: number;
    apower: number;
    voltage: number | null;
    current: number | null;
    cumulativeWh: number;
  }> = [];

  let cumulativeWh = 0;
  for (let i = 0; i < downsampled.length; i++) {
    const pt = downsampled[i];
    if (i > 0) {
      const intervalSeconds = pt.offsetSeconds - downsampled[i - 1].offsetSeconds;
      cumulativeWh += (pt.apower * intervalSeconds) / 3600;
    }
    curvePoints.push({
      offsetSeconds: pt.offsetSeconds,
      apower: pt.apower,
      voltage: pt.voltage,
      current: pt.current,
      cumulativeWh,
    });
  }

  // 4. Compute metadata
  const startPower = curvePoints[0].apower;
  const peakPower = Math.max(...curvePoints.map((p) => p.apower));
  const totalEnergyWh = curvePoints[curvePoints.length - 1].cumulativeWh;
  const durationSeconds = curvePoints[curvePoints.length - 1].offsetSeconds;
  const pointCount = curvePoints.length;

  const profileId = session.profileId;
  if (!profileId) {
    return Response.json({ error: 'session_missing_profile' }, { status: 400 });
  }

  // 5. Delete any existing reference curve for this profile (re-learn overwrites)
  const existingCurves = db
    .select({ id: referenceCurves.id })
    .from(referenceCurves)
    .where(eq(referenceCurves.profileId, profileId))
    .all();

  for (const curve of existingCurves) {
    db.delete(referenceCurves).where(eq(referenceCurves.id, curve.id)).run();
  }

  // 6. Insert new reference curve
  const curveResult = db
    .insert(referenceCurves)
    .values({
      profileId,
      startPower,
      peakPower,
      totalEnergyWh,
      durationSeconds,
      pointCount,
      createdAt: now,
    })
    .returning({ id: referenceCurves.id })
    .get();

  const curveId = curveResult.id;

  // 7. Bulk insert curve points
  if (curvePoints.length > 0) {
    db.insert(referenceCurvePoints)
      .values(
        curvePoints.map((p) => ({
          curveId,
          offsetSeconds: p.offsetSeconds,
          apower: p.apower,
          voltage: p.voltage,
          current: p.current,
          cumulativeWh: p.cumulativeWh,
        }))
      )
      .run();
  }

  // 8. Compute and insert SOC boundaries
  const boundaries = computeSocBoundaries(curvePoints);
  if (boundaries.length > 0) {
    db.insert(socBoundaries)
      .values(
        boundaries.map((b) => ({
          curveId,
          soc: b.soc,
          offsetSeconds: b.offsetSeconds,
          cumulativeWh: b.cumulativeWh,
          expectedPower: curvePoints.find((p) => p.offsetSeconds === b.offsetSeconds)?.apower ?? 0,
        }))
      )
      .run();
  }

  // 9. Update session
  db.update(chargeSessions)
    .set({
      state: 'complete',
      stoppedAt: now,
      stopReason: 'learn_complete',
      energyWh: totalEnergyWh,
    })
    .where(eq(chargeSessions.id, session.id))
    .run();

  return Response.json({
    ok: true,
    action: 'saved',
    curveId,
    pointCount,
    totalEnergyWh,
    durationSeconds,
  });
}
