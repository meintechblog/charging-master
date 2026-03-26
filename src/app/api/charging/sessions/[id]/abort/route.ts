import { db } from '@/db/client';
import { chargeSessions } from '@/db/schema';
import { eq } from 'drizzle-orm';

export const runtime = 'nodejs';

const ACTIVE_STATES = new Set(['detecting', 'matched', 'charging', 'countdown', 'learning', 'learn_complete']);

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const sessionId = parseInt(id, 10);

  if (isNaN(sessionId)) {
    return Response.json({ error: 'invalid_session_id' }, { status: 400 });
  }

  const session = db
    .select()
    .from(chargeSessions)
    .where(eq(chargeSessions.id, sessionId))
    .get();

  if (!session) {
    return Response.json({ error: 'session_not_found' }, { status: 404 });
  }

  if (!ACTIVE_STATES.has(session.state)) {
    return Response.json(
      { error: 'session_not_active', currentState: session.state },
      { status: 409 }
    );
  }

  // Notify ChargeMonitor to abort
  if (globalThis.__chargeMonitor) {
    globalThis.__chargeMonitor.abortSession(session.plugId);
  }

  const now = Date.now();
  db.update(chargeSessions)
    .set({ state: 'aborted', stoppedAt: now, stopReason: 'manual' })
    .where(eq(chargeSessions.id, sessionId))
    .run();

  return Response.json({ ok: true });
}
