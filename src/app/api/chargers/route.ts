import { db } from '@/db/client';
import { chargers, deviceProfiles } from '@/db/schema';
import { eq, sql } from 'drizzle-orm';

export const runtime = 'nodejs';

export async function GET() {
  const rows = db.select({
    id: chargers.id,
    name: chargers.name,
    manufacturer: chargers.manufacturer,
    model: chargers.model,
    efficiency: chargers.efficiency,
    maxCurrentA: chargers.maxCurrentA,
    maxVoltageV: chargers.maxVoltageV,
    outputType: chargers.outputType,
    notes: chargers.notes,
    createdAt: chargers.createdAt,
    updatedAt: chargers.updatedAt,
    profileCount: sql<number>`(SELECT COUNT(*) FROM ${deviceProfiles} WHERE ${deviceProfiles.chargerId} = ${chargers.id})`,
  })
    .from(chargers)
    .all();

  return Response.json({ chargers: rows });
}

export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'invalid_body' }, { status: 400 });
  }

  if (typeof body.name !== 'string' || body.name.trim().length === 0) {
    return Response.json({ error: 'invalid_name' }, { status: 400 });
  }

  const now = Date.now();
  const inserted = db.insert(chargers).values({
    name: body.name.trim(),
    manufacturer: typeof body.manufacturer === 'string' ? body.manufacturer.trim() || null : null,
    model: typeof body.model === 'string' ? body.model.trim() || null : null,
    efficiency: typeof body.efficiency === 'number' && Number.isFinite(body.efficiency)
      ? body.efficiency
      : 0.85,
    maxCurrentA: typeof body.maxCurrentA === 'number' && Number.isFinite(body.maxCurrentA) ? body.maxCurrentA : null,
    maxVoltageV: typeof body.maxVoltageV === 'number' && Number.isFinite(body.maxVoltageV) ? body.maxVoltageV : null,
    outputType: body.outputType === 'AC' ? 'AC' : 'DC',
    notes: typeof body.notes === 'string' ? body.notes.trim() || null : null,
    createdAt: now,
    updatedAt: now,
  }).returning().get();

  return Response.json({ charger: inserted }, { status: 201 });
}
