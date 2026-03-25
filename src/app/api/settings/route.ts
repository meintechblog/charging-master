import { db } from '@/db/client';
import { config } from '@/db/schema';

export async function GET() {
  const rows = db.select().from(config).all();
  const settings = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return Response.json(settings);
}

export async function PUT(request: Request) {
  const body = await request.json();
  const { key, value } = body as { key: unknown; value: unknown };

  if (typeof key !== 'string' || key.trim() === '' || typeof value !== 'string') {
    return Response.json({ error: 'invalid_input' }, { status: 400 });
  }

  db.insert(config)
    .values({ key, value, updatedAt: Date.now() })
    .onConflictDoUpdate({
      target: config.key,
      set: { value, updatedAt: Date.now() },
    })
    .run();

  return Response.json({ ok: true });
}
