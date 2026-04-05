import { db } from '@/db/client';
import { plugs, deviceProfiles, chargeSessions } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { switchRelayOn } from '@/modules/charging/relay-controller';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  let body: { plugId?: string; profileId?: number };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'invalid_body' }, { status: 400 });
  }

  const { plugId, profileId } = body;

  if (!plugId || typeof plugId !== 'string') {
    return Response.json({ error: 'invalid_plug_id' }, { status: 400 });
  }
  if (!profileId || typeof profileId !== 'number') {
    return Response.json({ error: 'invalid_profile_id' }, { status: 400 });
  }

  // Validate plug exists
  const plug = db.select().from(plugs).where(eq(plugs.id, plugId)).get();
  if (!plug) {
    return Response.json({ error: 'plug_not_found' }, { status: 404 });
  }

  // Validate profile exists
  const profile = db.select().from(deviceProfiles).where(eq(deviceProfiles.id, profileId)).get();
  if (!profile) {
    return Response.json({ error: 'profile_not_found' }, { status: 404 });
  }

  // Check no active learning session for this plug
  const activeLearning = db
    .select()
    .from(chargeSessions)
    .where(and(eq(chargeSessions.plugId, plugId), eq(chargeSessions.state, 'learning')))
    .get();

  if (activeLearning) {
    return Response.json(
      { error: 'learning_already_active', sessionId: activeLearning.id },
      { status: 409 }
    );
  }

  const now = Date.now();
  const result = db
    .insert(chargeSessions)
    .values({
      plugId,
      profileId,
      state: 'learning',
      startedAt: now,
      createdAt: now,
    })
    .returning({ id: chargeSessions.id })
    .get();

  const sessionId = result.id;

  // Turn the Shelly plug on so the charging cycle can actually start.
  // Without this the wizard sits in "Ladevorgang aktiv" with 0 W because
  // the relay defaults to off after a fresh teach-in.
  const mqttService = globalThis.__mqttService;
  if (mqttService) {
    try {
      await switchRelayOn(mqttService, {
        mqttTopicPrefix: plug.mqttTopicPrefix,
        ipAddress: plug.ipAddress,
      });
    } catch {
      // Non-fatal: learning can still proceed and user can toggle manually.
    }
  }

  // Activate server-side recording via ChargeMonitor
  if (globalThis.__chargeMonitor) {
    globalThis.__chargeMonitor.startLearning(plugId, sessionId);
  }

  return Response.json(
    { sessionId, plugId, profileId, state: 'learning' },
    { status: 201 }
  );
}
