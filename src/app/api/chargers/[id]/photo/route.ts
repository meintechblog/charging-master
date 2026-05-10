import { db } from '@/db/client';
import { chargers } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve, join } from 'node:path';

export const runtime = 'nodejs';

const CHARGER_PHOTOS_ROOT = resolve(process.cwd(), 'data/charger-photos');
const MAX_BYTES = 8 * 1024 * 1024;
const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const TYPE_TO_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

function parseId(s: string): number | null {
  const n = parseInt(s, 10);
  return isNaN(n) ? null : n;
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const chargerId = parseId(id);
  if (chargerId === null) return Response.json({ error: 'invalid_id' }, { status: 400 });

  const charger = db.select().from(chargers).where(eq(chargers.id, chargerId)).get();
  if (!charger) return Response.json({ error: 'not_found' }, { status: 404 });

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return Response.json({ error: 'invalid_body', message: 'expected multipart/form-data' }, { status: 400 });
  }

  const file = formData.get('file');
  if (!(file instanceof File)) {
    return Response.json({ error: 'missing_file', message: 'field "file" must be a file' }, { status: 400 });
  }
  if (!ALLOWED_TYPES.has(file.type)) {
    return Response.json({ error: 'unsupported_type', message: `expected one of ${[...ALLOWED_TYPES].join(', ')}` }, { status: 415 });
  }
  if (file.size > MAX_BYTES) {
    return Response.json({ error: 'too_large', message: `max ${MAX_BYTES} bytes` }, { status: 413 });
  }

  const ext = TYPE_TO_EXT[file.type];
  const fileName = `${chargerId}.${ext}`;

  // If a previous photo exists with a different extension, drop it so we don't
  // leave orphan files lying around (e.g. swapping .png for .jpg).
  if (charger.photoFileName && charger.photoFileName !== fileName) {
    try {
      unlinkSync(join(CHARGER_PHOTOS_ROOT, charger.photoFileName));
    } catch {
      /* missing/permission — non-fatal, log nothing to keep journal clean */
    }
  }

  mkdirSync(CHARGER_PHOTOS_ROOT, { recursive: true });
  const buf = Buffer.from(await file.arrayBuffer());
  writeFileSync(join(CHARGER_PHOTOS_ROOT, fileName), buf);

  db.update(chargers)
    .set({
      photoFileName: fileName,
      photoContentType: file.type,
      photoSizeBytes: file.size,
      updatedAt: Date.now(),
    })
    .where(eq(chargers.id, chargerId))
    .run();

  const updated = db.select().from(chargers).where(eq(chargers.id, chargerId)).get();
  return Response.json({ charger: updated }, { status: 201 });
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const chargerId = parseId(id);
  if (chargerId === null) return Response.json({ error: 'invalid_id' }, { status: 400 });

  const charger = db.select().from(chargers).where(eq(chargers.id, chargerId)).get();
  if (!charger) return Response.json({ error: 'not_found' }, { status: 404 });
  if (!charger.photoFileName) {
    return Response.json({ error: 'no_photo' }, { status: 404 });
  }

  try {
    unlinkSync(join(CHARGER_PHOTOS_ROOT, charger.photoFileName));
  } catch {
    /* file already gone — proceed with metadata clear */
  }

  db.update(chargers)
    .set({
      photoFileName: null,
      photoContentType: null,
      photoSizeBytes: null,
      updatedAt: Date.now(),
    })
    .where(eq(chargers.id, chargerId))
    .run();

  return Response.json({ ok: true });
}
