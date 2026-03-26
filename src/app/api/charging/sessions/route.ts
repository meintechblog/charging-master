import { db } from '@/db/client';
import { chargeSessions, deviceProfiles, plugs } from '@/db/schema';
import { eq, notInArray } from 'drizzle-orm';

export const runtime = 'nodejs';

export async function GET() {
  const now = Date.now();

  // Active sessions: not in terminal states
  const sessions = db
    .select({
      id: chargeSessions.id,
      plugId: chargeSessions.plugId,
      profileId: chargeSessions.profileId,
      state: chargeSessions.state,
      detectionConfidence: chargeSessions.detectionConfidence,
      targetSoc: chargeSessions.targetSoc,
      estimatedSoc: chargeSessions.estimatedSoc,
      energyWh: chargeSessions.energyWh,
      startedAt: chargeSessions.startedAt,
      plugName: plugs.name,
      profileName: deviceProfiles.name,
    })
    .from(chargeSessions)
    .leftJoin(plugs, eq(chargeSessions.plugId, plugs.id))
    .leftJoin(deviceProfiles, eq(chargeSessions.profileId, deviceProfiles.id))
    .where(
      notInArray(chargeSessions.state, ['complete', 'aborted', 'error', 'idle'])
    )
    .all();

  const result = sessions.map((s) => ({
    id: s.id,
    plugId: s.plugId,
    plugName: s.plugName ?? null,
    profileId: s.profileId,
    profileName: s.profileName ?? null,
    state: s.state,
    detectionConfidence: s.detectionConfidence,
    targetSoc: s.targetSoc,
    estimatedSoc: s.estimatedSoc,
    energyWh: s.energyWh,
    startedAt: s.startedAt,
    durationMs: now - s.startedAt,
  }));

  return Response.json(result);
}
