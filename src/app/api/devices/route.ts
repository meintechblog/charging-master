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
  const { id, name, ipAddress, pollingInterval } = body as {
    id: string;
    name: string;
    ipAddress?: string;
    pollingInterval?: number;
  };

  if (!id || typeof id !== 'string' || !name || typeof name !== 'string') {
    return Response.json({ error: 'invalid_input' }, { status: 400 });
  }

  if (!ipAddress || typeof ipAddress !== 'string') {
    return Response.json({ error: 'ip_address_required' }, { status: 400 });
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
    ipAddress: ipAddress ?? null,
    pollingInterval: pollingInterval ?? 5,
    enabled: true,
    online: false,
    lastSeen: null,
    createdAt: now,
    updatedAt: now,
  };

  db.insert(plugs).values(newPlug).run();

  // Start HTTP polling for the new plug
  if (globalThis.__httpPollingService && newPlug.ipAddress) {
    globalThis.__httpPollingService.startPolling(
      newPlug.id,
      newPlug.ipAddress,
      (newPlug.pollingInterval ?? 1) * 1000
    );
  }

  return Response.json(newPlug, { status: 201 });
}

export async function PATCH(request: Request) {
  const body = await request.json();
  const { id, ...updates } = body as {
    id: string;
    name?: string;
    ipAddress?: string | null;
    pollingInterval?: number;
    enabled?: boolean;
  };

  if (!id || typeof id !== 'string') {
    return Response.json({ error: 'invalid_input' }, { status: 400 });
  }

  const existing = db.select().from(plugs).where(eq(plugs.id, id)).get();
  if (!existing) {
    return Response.json({ error: 'not_found' }, { status: 404 });
  }

  const fields: Record<string, unknown> = { updatedAt: Date.now() };
  if (updates.name !== undefined) fields.name = updates.name;
  if (updates.ipAddress !== undefined) fields.ipAddress = updates.ipAddress;
  if (updates.pollingInterval !== undefined) fields.pollingInterval = updates.pollingInterval;
  if (updates.enabled !== undefined) fields.enabled = updates.enabled;

  db.update(plugs).set(fields).where(eq(plugs.id, id)).run();

  const updated = db.select().from(plugs).where(eq(plugs.id, id)).get();

  // Restart HTTP polling if relevant fields changed
  if (globalThis.__httpPollingService) {
    globalThis.__httpPollingService.stopPolling(id);
    if (updated?.enabled && updated?.ipAddress) {
      globalThis.__httpPollingService.startPolling(
        id,
        updated.ipAddress,
        (updated.pollingInterval ?? 1) * 1000
      );
    }
  }

  return Response.json(updated);
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

  // Stop HTTP polling for the deleted plug
  if (globalThis.__httpPollingService) {
    globalThis.__httpPollingService.stopPolling(existing.id);
  }

  return Response.json({ ok: true });
}
