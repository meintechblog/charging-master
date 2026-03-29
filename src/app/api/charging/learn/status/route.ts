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
    let startPower = 0;
    let avgPower = 0;

    if (monitor) {
      const m = monitor as unknown as Record<string, unknown>;
      const mLastPower = m.learnLastPower as Map<string, number> | undefined;
      const mReadingCount = m.learnReadingCount as Map<string, number> | undefined;
      const mCumulativeWh = m.learnCumulativeWh as Map<string, number> | undefined;
      const mStartPower = m.learnStartPower as Map<string, number> | undefined;
      const mPowerSum = m.learnPowerSum as Map<string, number> | undefined;

      if (mLastPower) latestPower = mLastPower.get(s.plugId) ?? 0;
      if (mReadingCount) readingCount = mReadingCount.get(s.plugId) ?? 0;
      if (mCumulativeWh) cumulativeWh = mCumulativeWh.get(s.plugId) ?? cumulativeWh;
      if (mStartPower) startPower = mStartPower.get(s.plugId) ?? 0;
      if (mPowerSum && readingCount > 0) avgPower = (mPowerSum.get(s.plugId) ?? 0) / readingCount;
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
      startPower,
      avgPower,
    };
  });

  return Response.json(result);
}
