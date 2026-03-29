import { db } from '@/db/client';
import {
  chargeSessions,
  deviceProfiles,
  plugs,
  sessionReadings,
  sessionEvents,
  referenceCurves,
  referenceCurvePoints,
} from '@/db/schema';
import { eq, asc } from 'drizzle-orm';

export const runtime = 'nodejs';

export async function GET(
  _request: Request,
  context: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId: rawId } = await context.params;
  const sessionId = parseInt(rawId, 10);

  if (isNaN(sessionId)) {
    return Response.json({ error: 'invalid_session_id' }, { status: 400 });
  }

  // Query session with joins
  const session = db
    .select({
      id: chargeSessions.id,
      plugId: chargeSessions.plugId,
      plugName: plugs.name,
      profileId: chargeSessions.profileId,
      profileName: deviceProfiles.name,
      state: chargeSessions.state,
      detectionConfidence: chargeSessions.detectionConfidence,
      curveOffsetSeconds: chargeSessions.curveOffsetSeconds,
      targetSoc: chargeSessions.targetSoc,
      estimatedSoc: chargeSessions.estimatedSoc,
      startedAt: chargeSessions.startedAt,
      stoppedAt: chargeSessions.stoppedAt,
      stopReason: chargeSessions.stopReason,
      energyWh: chargeSessions.energyWh,
      dtwScore: chargeSessions.dtwScore,
    })
    .from(chargeSessions)
    .leftJoin(plugs, eq(chargeSessions.plugId, plugs.id))
    .leftJoin(deviceProfiles, eq(chargeSessions.profileId, deviceProfiles.id))
    .where(eq(chargeSessions.id, sessionId))
    .get();

  if (!session) {
    return Response.json({ error: 'session_not_found' }, { status: 404 });
  }

  // All readings for full chart replay
  const readings = db
    .select({
      offsetMs: sessionReadings.offsetMs,
      apower: sessionReadings.apower,
      voltage: sessionReadings.voltage,
      current: sessionReadings.current,
      timestamp: sessionReadings.timestamp,
    })
    .from(sessionReadings)
    .where(eq(sessionReadings.sessionId, sessionId))
    .orderBy(asc(sessionReadings.offsetMs))
    .all();

  // All state transition events
  const events = db
    .select({
      state: sessionEvents.state,
      timestamp: sessionEvents.timestamp,
    })
    .from(sessionEvents)
    .where(eq(sessionEvents.sessionId, sessionId))
    .orderBy(asc(sessionEvents.timestamp))
    .all();

  // Load reference curve if session has a profile
  let referenceCurve: {
    points: Array<{ offsetSeconds: number; apower: number; cumulativeWh: number }>;
    curveOffsetSeconds: number | null;
  } | null = null;

  if (session.profileId) {
    const curve = db
      .select({ id: referenceCurves.id })
      .from(referenceCurves)
      .where(eq(referenceCurves.profileId, session.profileId))
      .get();

    if (curve) {
      const points = db
        .select({
          offsetSeconds: referenceCurvePoints.offsetSeconds,
          apower: referenceCurvePoints.apower,
          cumulativeWh: referenceCurvePoints.cumulativeWh,
        })
        .from(referenceCurvePoints)
        .where(eq(referenceCurvePoints.curveId, curve.id))
        .orderBy(asc(referenceCurvePoints.offsetSeconds))
        .all();

      referenceCurve = {
        points,
        curveOffsetSeconds: session.curveOffsetSeconds,
      };
    }
  }

  const now = Date.now();
  const durationMs = session.stoppedAt
    ? session.stoppedAt - session.startedAt
    : now - session.startedAt;

  return Response.json({
    ...session,
    durationMs,
    readings,
    events,
    referenceCurve,
  });
}
