export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { db } from '@/db/client';
import { powerReadings } from '@/db/schema';
import { eq, and, gte, asc } from 'drizzle-orm';

const WINDOW_MS: Record<string, number> = {
  '5m': 300_000,
  '15m': 900_000,
  '30m': 1_800_000,
  '1h': 3_600_000,
};

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const url = new URL(request.url);
  const window = url.searchParams.get('window') ?? '15m';
  const sinceParam = url.searchParams.get('since');

  // If 'since' timestamp provided, use it directly (for learn mode: all readings since session start)
  // Otherwise use window-based calculation
  let since: number;
  if (sinceParam) {
    since = parseInt(sinceParam, 10);
  } else if (window === 'max' || window === 'all') {
    since = 0;
  } else {
    const windowMs = WINDOW_MS[window] ?? WINDOW_MS['15m'];
    since = Date.now() - windowMs;
  }

  const rows = db
    .select({
      apower: powerReadings.apower,
      timestamp: powerReadings.timestamp,
    })
    .from(powerReadings)
    .where(and(eq(powerReadings.plugId, id), gte(powerReadings.timestamp, since)))
    .orderBy(asc(powerReadings.timestamp))
    .all();

  return Response.json({
    readings: rows.map((r) => [r.timestamp, r.apower]),
    count: rows.length,
  });
}
