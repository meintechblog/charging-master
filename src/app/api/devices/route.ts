import { db } from '@/db/client';
import { plugs } from '@/db/schema';
import { eq } from 'drizzle-orm';

export const runtime = 'nodejs';

export async function GET() {
  const allPlugs = db.select().from(plugs).all();
  return Response.json(allPlugs);
}

export async function POST(request: Request) {
  const body = await request.json();
  const { id, name, mqttTopicPrefix, ipAddress, pollingInterval } = body as {
    id: string;
    name: string;
    mqttTopicPrefix: string;
    ipAddress?: string;
    pollingInterval?: number;
  };

  if (!id || typeof id !== 'string' || !name || typeof name !== 'string') {
    return Response.json({ error: 'invalid_input' }, { status: 400 });
  }

  // Check for duplicate
  const existing = db.select().from(plugs).where(eq(plugs.id, id)).get();
  if (existing) {
    return Response.json({ error: 'device_exists' }, { status: 409 });
  }

  const now = Date.now();
  const newPlug = {
    id,
    name,
    mqttTopicPrefix: mqttTopicPrefix || id,
    ipAddress: ipAddress ?? null,
    pollingInterval: pollingInterval ?? 5,
    enabled: true,
    online: false,
    lastSeen: null,
    createdAt: now,
    updatedAt: now,
  };

  db.insert(plugs).values(newPlug).run();

  // Subscribe to MQTT topics for the new plug
  if (globalThis.__mqttService) {
    globalThis.__mqttService.subscribeToPlug(id);
  }

  return Response.json(newPlug, { status: 201 });
}

export async function DELETE(request: Request) {
  const body = await request.json();
  const { id } = body as { id: string };

  if (!id || typeof id !== 'string') {
    return Response.json({ error: 'invalid_input' }, { status: 400 });
  }

  const existing = db.select().from(plugs).where(eq(plugs.id, id)).get();
  if (!existing) {
    return Response.json({ error: 'not_found' }, { status: 404 });
  }

  db.delete(plugs).where(eq(plugs.id, id)).run();

  // Unsubscribe from MQTT topics
  if (globalThis.__mqttService) {
    globalThis.__mqttService.unsubscribeFromPlug(id);
  }

  return Response.json({ ok: true });
}
