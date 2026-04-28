import { db } from '@/db/client';
import { deviceProfiles, profilePhotos } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

export const runtime = 'nodejs';

const PROFILE_PHOTOS_ROOT = resolve(process.cwd(), 'data/profile-photos');
const MAX_BYTES = 8 * 1024 * 1024;
const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const TYPE_TO_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const profileId = parseInt(id, 10);
  if (isNaN(profileId)) return Response.json({ error: 'invalid_id' }, { status: 400 });

  const photos = db.select({
    id: profilePhotos.id,
    profileId: profilePhotos.profileId,
    originalName: profilePhotos.originalName,
    contentType: profilePhotos.contentType,
    sizeBytes: profilePhotos.sizeBytes,
    isPrimary: profilePhotos.isPrimary,
    caption: profilePhotos.caption,
    createdAt: profilePhotos.createdAt,
  })
    .from(profilePhotos)
    .where(eq(profilePhotos.profileId, profileId))
    .all();

  return Response.json({ photos });
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const profileId = parseInt(id, 10);
  if (isNaN(profileId)) return Response.json({ error: 'invalid_id' }, { status: 400 });

  const profile = db.select().from(deviceProfiles).where(eq(deviceProfiles.id, profileId)).get();
  if (!profile) return Response.json({ error: 'not_found' }, { status: 404 });

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
  const now = Date.now();

  const existingCount = db.select({ id: profilePhotos.id })
    .from(profilePhotos)
    .where(eq(profilePhotos.profileId, profileId))
    .all().length;
  const isFirst = existingCount === 0;

  const inserted = db.insert(profilePhotos).values({
    profileId,
    fileName: 'pending',
    originalName: file.name || null,
    contentType: file.type,
    sizeBytes: file.size,
    isPrimary: isFirst,
    createdAt: now,
  }).returning({ id: profilePhotos.id }).get();

  const fileName = `${inserted.id}.${ext}`;
  const dir = join(PROFILE_PHOTOS_ROOT, String(profileId));
  mkdirSync(dir, { recursive: true });
  const buf = Buffer.from(await file.arrayBuffer());
  writeFileSync(join(dir, fileName), buf);

  db.update(profilePhotos).set({ fileName }).where(eq(profilePhotos.id, inserted.id)).run();

  const saved = db.select().from(profilePhotos).where(eq(profilePhotos.id, inserted.id)).get();
  return Response.json({ photo: saved }, { status: 201 });
}
