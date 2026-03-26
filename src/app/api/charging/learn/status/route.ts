import { db } from '@/db/client';
import { chargeSessions, sessionReadings } from '@/db/schema';
import { eq, inArray, desc, count, max, sql } from 'drizzle-orm';

export const runtime = 'nodejs';

export async function GET() {
  // Find active learning sessions
  const sessions = db
    .select()
    .from(chargeSessions)
    .where(inArray(chargeSessions.state, ['learning', 'learn_complete']))
    .orderBy(desc(chargeSessions.startedAt))
    .all();

  const now = Date.now();

  const result = sessions.map((s) => {
    // Get reading stats for this session
    const stats = db
      .select({
        readingCount: count(sessionReadings.id),
        latestPower: max(sessionReadings.apower),
      })
      .from(sessionReadings)
      .where(eq(sessionReadings.sessionId, s.id))
      .get();

    // Get cumulative Wh from latest reading
    const latestReading = db
      .select({
        apower: sessionReadings.apower,
        offsetMs: sessionReadings.offsetMs,
      })
      .from(sessionReadings)
      .where(eq(sessionReadings.sessionId, s.id))
      .orderBy(desc(sessionReadings.offsetMs))
      .limit(1)
      .get();

    // Compute cumulative Wh from all readings
    const allReadings = db
      .select({
        totalWh: sql<number>`sum(${sessionReadings.apower} * 1.0 / 3600)`,
      })
      .from(sessionReadings)
      .where(eq(sessionReadings.sessionId, s.id))
      .get();

    return {
      sessionId: s.id,
      plugId: s.plugId,
      profileId: s.profileId,
      state: s.state,
      startedAt: s.startedAt,
      durationMs: now - s.startedAt,
      readingCount: stats?.readingCount ?? 0,
      latestPower: latestReading?.apower ?? 0,
      cumulativeWh: allReadings?.totalWh ?? 0,
    };
  });

  return Response.json(result);
}
