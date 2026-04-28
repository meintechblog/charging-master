import { db } from '@/db/client';
import { chargers, deviceProfiles } from '@/db/schema';
import { eq } from 'drizzle-orm';

export const runtime = 'nodejs';

function parseId(s: string): number | null {
  const n = parseInt(s, 10);
  return isNaN(n) ? null : n;
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const chargerId = parseId(id);
  if (chargerId === null) return Response.json({ error: 'invalid_id' }, { status: 400 });

  const charger = db.select().from(chargers).where(eq(chargers.id, chargerId)).get();
  if (!charger) return Response.json({ error: 'not_found' }, { status: 404 });

  const linkedProfiles = db.select({
    id: deviceProfiles.id,
    name: deviceProfiles.name,
  })
    .from(deviceProfiles)
    .where(eq(deviceProfiles.chargerId, chargerId))
    .all();

  return Response.json({ ...charger, profiles: linkedProfiles });
}

export async function PUT(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const chargerId = parseId(id);
  if (chargerId === null) return Response.json({ error: 'invalid_id' }, { status: 400 });

  const existing = db.select().from(chargers).where(eq(chargers.id, chargerId)).get();
  if (!existing) return Response.json({ error: 'not_found' }, { status: 404 });

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'invalid_body' }, { status: 400 });
  }

  const updates: Record<string, unknown> = { updatedAt: Date.now() };

  const stringFields = ['name', 'manufacturer', 'model', 'notes'] as const;
  for (const f of stringFields) {
    const v = body[f];
    if (v === null) updates[f] = null;
    else if (typeof v === 'string') updates[f] = v.trim() || null;
  }
  const numberFields = ['efficiency', 'maxCurrentA', 'maxVoltageV'] as const;
  for (const f of numberFields) {
    const v = body[f];
    if (v === null) updates[f] = null;
    else if (typeof v === 'number' && Number.isFinite(v)) updates[f] = v;
  }
  if (body.outputType === 'AC' || body.outputType === 'DC') {
    updates.outputType = body.outputType;
  }

  // Don't allow blanking the name to empty string.
  if (updates.name === null) {
    return Response.json({ error: 'invalid_name', message: 'name cannot be blank' }, { status: 400 });
  }

  db.update(chargers).set(updates).where(eq(chargers.id, chargerId)).run();
  const updated = db.select().from(chargers).where(eq(chargers.id, chargerId)).get();
  return Response.json({ charger: updated });
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const chargerId = parseId(id);
  if (chargerId === null) return Response.json({ error: 'invalid_id' }, { status: 400 });

  const existing = db.select().from(chargers).where(eq(chargers.id, chargerId)).get();
  if (!existing) return Response.json({ error: 'not_found' }, { status: 404 });

  // Detach referencing profiles before delete (FK is set-null in app code
  // because the SQLite ALTER doesn't carry the cascade clause).
  db.update(deviceProfiles)
    .set({ chargerId: null })
    .where(eq(deviceProfiles.chargerId, chargerId))
    .run();

  db.delete(chargers).where(eq(chargers.id, chargerId)).run();
  return Response.json({ ok: true });
}
