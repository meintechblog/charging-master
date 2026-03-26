import { db } from '@/db/client';
import { deviceProfiles, referenceCurves } from '@/db/schema';
import { eq } from 'drizzle-orm';

export const runtime = 'nodejs';

/**
 * GET /api/profiles -- List all device profiles with curve metadata.
 */
export async function GET() {
  const profiles = db.select().from(deviceProfiles).all();

  const result = profiles.map((profile) => {
    const curve = db.select().from(referenceCurves)
      .where(eq(referenceCurves.profileId, profile.id)).get();

    return {
      ...profile,
      hasCurve: !!curve,
      totalEnergyWh: curve?.totalEnergyWh ?? null,
    };
  });

  return Response.json(result);
}

/**
 * POST /api/profiles -- Create a new device profile.
 * Per D-30: All attributes except name are optional.
 */
export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'invalid_body' }, { status: 400 });
  }

  const name = body.name;
  if (typeof name !== 'string' || name.length < 1 || name.length > 100) {
    return Response.json({ error: 'name_required', message: 'Name must be 1-100 characters' }, { status: 400 });
  }

  // Validate targetSoc if provided (D-31: 10-100 in steps of 10)
  let targetSoc = 80;
  if (body.targetSoc !== undefined) {
    const soc = Number(body.targetSoc);
    if (isNaN(soc) || soc < 10 || soc > 100 || soc % 10 !== 0) {
      return Response.json({ error: 'invalid_target_soc', message: 'targetSoc must be 10-100 in steps of 10' }, { status: 400 });
    }
    targetSoc = soc;
  }

  const now = Date.now();
  const created = db.insert(deviceProfiles).values({
    name: name.trim(),
    description: typeof body.description === 'string' ? body.description : null,
    modelName: typeof body.modelName === 'string' ? body.modelName : null,
    purchaseDate: typeof body.purchaseDate === 'string' ? body.purchaseDate : null,
    estimatedCycles: typeof body.estimatedCycles === 'number' ? body.estimatedCycles : null,
    targetSoc,
    createdAt: now,
    updatedAt: now,
  }).returning().get();

  return Response.json(created, { status: 201 });
}
