import { db } from '@/db/client';
import { chargers } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

export const runtime = 'nodejs';

const CHARGER_PHOTOS_ROOT = resolve(process.cwd(), 'data/charger-photos');

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const chargerId = parseInt(id, 10);
  if (isNaN(chargerId)) return new Response('invalid_id', { status: 400 });

  const charger = db.select().from(chargers).where(eq(chargers.id, chargerId)).get();
  if (!charger || !charger.photoFileName || !charger.photoContentType) {
    return new Response('not_found', { status: 404 });
  }

  let buf: Buffer;
  try {
    buf = readFileSync(join(CHARGER_PHOTOS_ROOT, charger.photoFileName));
  } catch {
    return new Response('file_missing', { status: 410 });
  }

  const body = new Blob([new Uint8Array(buf)], { type: charger.photoContentType });
  return new Response(body, {
    headers: {
      'Content-Type': charger.photoContentType,
      'Content-Length': String(buf.length),
      'Cache-Control': 'private, max-age=86400',
    },
  });
}
