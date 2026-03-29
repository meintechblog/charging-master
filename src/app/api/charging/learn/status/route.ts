import { db } from '@/db/client';
import { chargeSessions } from '@/db/schema';
import { desc, inArray } from 'drizzle-orm';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const sessions = db
    .select()
    .from(chargeSessions)
    .where(inArray(chargeSessions.state, ['learning', 'learn_complete']))
    .orderBy(desc(chargeSessions.startedAt))
    .all();

  const now = Date.now();
  const monitor = globalThis.__chargeMonitor;

  const result = sessions.map((s) => {
    // Try to get live data from ChargeMonitor
    let latestPower = 0;
    let readingCount = 0;
    let cumulativeWh = s.energyWh ?? 0;

    if (monitor) {
      // Access internal learning trackers
      const monitorAny = monitor as unknown as Record<string, unknown>;
      const learnLastPower = monitorAny.learnLastPower as Map<string, number> | undefined;
      const learnReadingCount = monitorAny.learnReadingCount as Map<string, number> | undefined;
      const learnCumulativeWh = monitorAny.learnCumulativeWh as Map<string, number> | undefined;

      if (learnLastPower) latestPower = learnLastPower.get(s.plugId) ?? 0;
      if (learnReadingCount) readingCount = learnReadingCount.get(s.plugId) ?? 0;
      if (learnCumulativeWh) cumulativeWh = learnCumulativeWh.get(s.plugId) ?? cumulativeWh;
    }

    return {
      sessionId: s.id,
      plugId: s.plugId,
      profileId: s.profileId,
      state: s.state,
      startedAt: s.startedAt,
      durationMs: now - s.startedAt,
      readingCount,
      latestPower,
      cumulativeWh,
    };
  });

  return Response.json(result);
}
