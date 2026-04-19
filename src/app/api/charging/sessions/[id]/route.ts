import { db } from '@/db/client';
import { chargeSessions, deviceProfiles, plugs, sessionReadings } from '@/db/schema';
import { eq, desc } from 'drizzle-orm';

export const runtime = 'nodejs';

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const sessionId = parseInt(id, 10);

  if (isNaN(sessionId)) {
    return Response.json({ error: 'invalid_session_id' }, { status: 400 });
  }

  const session = db
    .select({
      id: chargeSessions.id,
      plugId: chargeSessions.plugId,
      profileId: chargeSessions.profileId,
      state: chargeSessions.state,
      detectionConfidence: chargeSessions.detectionConfidence,
      curveOffsetSeconds: chargeSessions.curveOffsetSeconds,
      targetSoc: chargeSessions.targetSoc,
      estimatedSoc: chargeSessions.estimatedSoc,
      energyWh: chargeSessions.energyWh,
      dtwScore: chargeSessions.dtwScore,
      startedAt: chargeSessions.startedAt,
      stoppedAt: chargeSessions.stoppedAt,
      stopReason: chargeSessions.stopReason,
      plugName: plugs.name,
      profileName: deviceProfiles.name,
    })
    .from(chargeSessions)
    .leftJoin(plugs, eq(chargeSessions.plugId, plugs.id))
    .leftJoin(deviceProfiles, eq(chargeSessions.profileId, deviceProfiles.id))
    .where(eq(chargeSessions.id, sessionId))
    .get();

  if (!session) {
    return Response.json({ error: 'session_not_found' }, { status: 404 });
  }

  // Include recent readings (last 60) for mini-chart
  const recentReadings = db
    .select({
      offsetMs: sessionReadings.offsetMs,
      apower: sessionReadings.apower,
      voltage: sessionReadings.voltage,
      current: sessionReadings.current,
      timestamp: sessionReadings.timestamp,
    })
    .from(sessionReadings)
    .where(eq(sessionReadings.sessionId, sessionId))
    .orderBy(desc(sessionReadings.offsetMs))
    .limit(60)
    .all()
    .reverse(); // chronological order

  const now = Date.now();

  return Response.json({
    ...session,
    durationMs: session.stoppedAt
      ? session.stoppedAt - session.startedAt
      : now - session.startedAt,
    recentReadings,
  });
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const sessionId = parseInt(id, 10);

  if (isNaN(sessionId)) {
    return Response.json({ error: 'invalid_session_id' }, { status: 400 });
  }

  const session = db
    .select({ id: chargeSessions.id, state: chargeSessions.state })
    .from(chargeSessions)
    .where(eq(chargeSessions.id, sessionId))
    .get();

  if (!session) {
    return Response.json({ error: 'session_not_found' }, { status: 404 });
  }

  // Refuse to delete sessions that are still live — would orphan runtime state.
  const active = ['detecting', 'matched', 'charging', 'countdown', 'learning'];
  if (active.includes(session.state)) {
    return Response.json(
      { error: 'session_active', state: session.state },
      { status: 409 }
    );
  }

  // session_readings + session_events cascade via ON DELETE CASCADE (schema.ts).
  db.delete(chargeSessions).where(eq(chargeSessions.id, sessionId)).run();

  return Response.json({ ok: true, id: sessionId });
}

const VALID_TARGET_SOC = new Set([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);

export async function PUT(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const sessionId = parseInt(id, 10);

  if (isNaN(sessionId)) {
    return Response.json({ error: 'invalid_session_id' }, { status: 400 });
  }

  let body: { profileId?: number; targetSoc?: number; estimatedSoc?: number };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'invalid_body' }, { status: 400 });
  }

  const session = db
    .select()
    .from(chargeSessions)
    .where(eq(chargeSessions.id, sessionId))
    .get();

  if (!session) {
    return Response.json({ error: 'session_not_found' }, { status: 404 });
  }

  const updates: Record<string, unknown> = {};

  if (body.profileId !== undefined) {
    if (typeof body.profileId !== 'number') {
      return Response.json({ error: 'invalid_profile_id' }, { status: 400 });
    }
    // Validate profile exists
    const profile = db
      .select({ id: deviceProfiles.id })
      .from(deviceProfiles)
      .where(eq(deviceProfiles.id, body.profileId))
      .get();
    if (!profile) {
      return Response.json({ error: 'profile_not_found' }, { status: 404 });
    }
    updates.profileId = body.profileId;
  }

  if (body.targetSoc !== undefined) {
    if (typeof body.targetSoc !== 'number' || !VALID_TARGET_SOC.has(body.targetSoc)) {
      return Response.json(
        { error: 'invalid_target_soc', expected: '10-100 in steps of 10' },
        { status: 400 }
      );
    }
    updates.targetSoc = body.targetSoc;
  }

  if (body.estimatedSoc !== undefined) {
    if (
      typeof body.estimatedSoc !== 'number' ||
      !Number.isInteger(body.estimatedSoc) ||
      body.estimatedSoc < 0 ||
      body.estimatedSoc > 100
    ) {
      return Response.json(
        { error: 'invalid_estimated_soc', expected: 'integer 0-100' },
        { status: 400 }
      );
    }
    // ChargeMonitor.overrideSession rebases energy baseline + DB state
    // atomically; we don't write estimatedSoc into `updates` here to avoid
    // two separate writes racing against the next power reading.
  }

  if (
    Object.keys(updates).length === 0 &&
    body.estimatedSoc === undefined
  ) {
    return Response.json({ error: 'no_updates_provided' }, { status: 400 });
  }

  if (Object.keys(updates).length > 0) {
    db.update(chargeSessions)
      .set(updates)
      .where(eq(chargeSessions.id, sessionId))
      .run();
  }

  // Notify ChargeMonitor of override
  if (globalThis.__chargeMonitor) {
    globalThis.__chargeMonitor.overrideSession(sessionId, {
      profileId: body.profileId,
      targetSoc: body.targetSoc,
      estimatedSoc: body.estimatedSoc,
    });
  }

  // Return updated session
  const updated = db
    .select()
    .from(chargeSessions)
    .where(eq(chargeSessions.id, sessionId))
    .get();

  return Response.json(updated);
}
