import { db } from '@/db/client';
import { chargeSessions, deviceProfiles, plugs } from '@/db/schema';
import { eq, and, desc, count, sql } from 'drizzle-orm';

export const runtime = 'nodejs';

const VALID_STATES = new Set([
  'complete', 'error', 'aborted', 'detecting', 'charging',
  'learning', 'learn_complete', 'matched', 'countdown',
]);

export async function GET(request: Request) {
  const url = new URL(request.url);

  const plugId = url.searchParams.get('plugId') || undefined;
  const profileIdParam = url.searchParams.get('profileId') || undefined;
  const status = url.searchParams.get('status') || undefined;

  const limitParam = parseInt(url.searchParams.get('limit') || '50', 10);
  const offsetParam = parseInt(url.searchParams.get('offset') || '0', 10);

  const limit = Math.min(Math.max(1, isNaN(limitParam) ? 50 : limitParam), 200);
  const offset = Math.max(0, isNaN(offsetParam) ? 0 : offsetParam);

  // Build filter conditions
  const conditions = [];
  if (plugId) {
    conditions.push(eq(chargeSessions.plugId, plugId));
  }
  if (profileIdParam) {
    const pid = parseInt(profileIdParam, 10);
    if (!isNaN(pid)) {
      conditions.push(eq(chargeSessions.profileId, pid));
    }
  }
  if (status && VALID_STATES.has(status)) {
    conditions.push(eq(chargeSessions.state, status));
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  // Query sessions with joins
  const sessions = db
    .select({
      id: chargeSessions.id,
      plugId: chargeSessions.plugId,
      plugName: plugs.name,
      profileId: chargeSessions.profileId,
      profileName: deviceProfiles.name,
      state: chargeSessions.state,
      detectionConfidence: chargeSessions.detectionConfidence,
      targetSoc: chargeSessions.targetSoc,
      estimatedSoc: chargeSessions.estimatedSoc,
      startedAt: chargeSessions.startedAt,
      stoppedAt: chargeSessions.stoppedAt,
      stopReason: chargeSessions.stopReason,
      energyWh: chargeSessions.energyWh,
    })
    .from(chargeSessions)
    .leftJoin(plugs, eq(chargeSessions.plugId, plugs.id))
    .leftJoin(deviceProfiles, eq(chargeSessions.profileId, deviceProfiles.id))
    .where(whereClause)
    .orderBy(desc(chargeSessions.startedAt))
    .limit(limit)
    .offset(offset)
    .all();

  // Count total with same filters
  const totalResult = db
    .select({ total: count() })
    .from(chargeSessions)
    .where(whereClause)
    .get();

  const total = totalResult?.total ?? 0;

  // Distinct plugs for filter dropdown
  const plugList = db
    .select({ id: plugs.id, name: plugs.name })
    .from(plugs)
    .orderBy(plugs.name)
    .all();

  return Response.json({ sessions, total, plugs: plugList });
}
