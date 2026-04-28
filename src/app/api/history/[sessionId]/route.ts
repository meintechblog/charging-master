import { db } from '@/db/client';
import {
  chargeSessions,
  deviceProfiles,
  plugs,
  sessionReadings,
  sessionEvents,
  referenceCurves,
  referenceCurvePoints,
  powerReadings,
} from '@/db/schema';
import { eq, asc, and, gte } from 'drizzle-orm';

// States considered "still running" — we serve live data from power_readings
// instead of relying on session_readings (which is only populated for charge
// sessions, not learn sessions).
const NON_TERMINAL_STATES = new Set(['detecting', 'matched', 'charging', 'countdown', 'stopping', 'learning']);

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

  // Readings: prefer the live raw stream from power_readings while the
  // session is still running (covers learn sessions, which never write into
  // session_readings, and gives near-real-time updates for charging sessions
  // too). Fall back to session_readings for completed sessions where
  // power_readings has been pruned but session_readings remains.
  const useLive = NON_TERMINAL_STATES.has(session.state);

  let readings: Array<{
    offsetMs: number;
    apower: number;
    voltage: number | null;
    current: number | null;
    timestamp: number;
  }> = [];

  if (useLive) {
    const raw = db
      .select({
        timestamp: powerReadings.timestamp,
        apower: powerReadings.apower,
        voltage: powerReadings.voltage,
        current: powerReadings.current,
      })
      .from(powerReadings)
      .where(and(
        eq(powerReadings.plugId, session.plugId),
        gte(powerReadings.timestamp, session.startedAt),
      ))
      .orderBy(asc(powerReadings.timestamp))
      .all();

    readings = raw.map((r) => ({
      offsetMs: r.timestamp - session.startedAt,
      apower: r.apower,
      voltage: r.voltage,
      current: r.current,
      timestamp: r.timestamp,
    }));
  } else {
    readings = db
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

    // For completed learn sessions, session_readings is empty — fall back
    // to the persisted power_readings so the recorded curve is still visible.
    if (readings.length === 0) {
      const upTo = session.stoppedAt ?? Date.now();
      const raw = db
        .select({
          timestamp: powerReadings.timestamp,
          apower: powerReadings.apower,
          voltage: powerReadings.voltage,
          current: powerReadings.current,
        })
        .from(powerReadings)
        .where(and(
          eq(powerReadings.plugId, session.plugId),
          gte(powerReadings.timestamp, session.startedAt),
        ))
        .orderBy(asc(powerReadings.timestamp))
        .all();

      readings = raw
        .filter((r) => r.timestamp <= upTo)
        .map((r) => ({
          offsetMs: r.timestamp - session.startedAt,
          apower: r.apower,
          voltage: r.voltage,
          current: r.current,
          timestamp: r.timestamp,
        }));
    }
  }

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
