import { db } from '@/db/client';
import { updateRuns } from '@/db/schema';
import { desc } from 'drizzle-orm';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

export function GET(request: Request): Response {
  const url = new URL(request.url);
  const limitParam = url.searchParams.get('limit');
  let limit = DEFAULT_LIMIT;
  if (limitParam !== null) {
    const parsed = parseInt(limitParam, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      limit = Math.min(parsed, MAX_LIMIT);
    }
  }

  try {
    const rows = db
      .select()
      .from(updateRuns)
      .orderBy(desc(updateRuns.startAt))
      .limit(limit)
      .all();

    const runs = rows.map((r) => ({
      id: r.id,
      startAt: r.startAt.getTime(),
      endAt: r.endAt?.getTime() ?? null,
      fromSha: r.fromSha,
      fromShaShort: r.fromSha.substring(0, 7),
      toSha: r.toSha,
      toShaShort: r.toSha?.substring(0, 7) ?? null,
      status: r.status,
      stage: r.stage,
      errorMessage: r.errorMessage,
      rollbackStage: r.rollbackStage,
      durationMs: r.endAt ? r.endAt.getTime() - r.startAt.getTime() : null,
    }));

    return Response.json({ runs });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: 'internal_error', message }, { status: 500 });
  }
}
