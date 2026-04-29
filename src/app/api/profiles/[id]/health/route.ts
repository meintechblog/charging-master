import { db } from '@/db/client';
import { batteryHealthSnapshots } from '@/db/schema';
import { eq, asc } from 'drizzle-orm';

export const runtime = 'nodejs';

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const profileId = parseInt(id, 10);
  if (isNaN(profileId)) return Response.json({ error: 'invalid_id' }, { status: 400 });

  const snapshots = db.select()
    .from(batteryHealthSnapshots)
    .where(eq(batteryHealthSnapshots.profileId, profileId))
    .orderBy(asc(batteryHealthSnapshots.recordedAt))
    .all();

  let degradationPct: number | null = null;
  let baselineDcWh: number | null = null;
  let latestDcWh: number | null = null;
  let baselineDate: number | null = null;
  let latestDate: number | null = null;

  if (snapshots.length >= 2) {
    const first = snapshots[0];
    const last = snapshots[snapshots.length - 1];
    baselineDcWh = first.effectiveDcWh;
    latestDcWh = last.effectiveDcWh;
    baselineDate = first.recordedAt;
    latestDate = last.recordedAt;
    if (baselineDcWh > 0) {
      degradationPct = ((baselineDcWh - latestDcWh) / baselineDcWh) * 100;
    }
  } else if (snapshots.length === 1) {
    baselineDcWh = snapshots[0].effectiveDcWh;
    latestDcWh = snapshots[0].effectiveDcWh;
    baselineDate = snapshots[0].recordedAt;
    latestDate = snapshots[0].recordedAt;
  }

  return Response.json({
    snapshots,
    summary: {
      count: snapshots.length,
      baselineDcWh,
      latestDcWh,
      baselineDate,
      latestDate,
      degradationPct,
    },
  });
}
