import { db } from '@/db/client';
import { profilePhotos } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

export const runtime = 'nodejs';

const PROFILE_PHOTOS_ROOT = resolve(process.cwd(), 'data/profile-photos');

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string; photoId: string }> }
) {
  const { id, photoId: pid } = await context.params;
  const profileId = parseInt(id, 10);
  const photoId = parseInt(pid, 10);
  if (isNaN(profileId) || isNaN(photoId)) {
    return new Response('invalid_id', { status: 400 });
  }

  const photo = db.select().from(profilePhotos).where(eq(profilePhotos.id, photoId)).get();
  if (!photo || photo.profileId !== profileId) {
    return new Response('not_found', { status: 404 });
  }

  let buf: Buffer;
  try {
    buf = readFileSync(join(PROFILE_PHOTOS_ROOT, String(profileId), photo.fileName));
  } catch {
    return new Response('file_missing', { status: 410 });
  }

  // Wrap in a Blob so the response body type satisfies BodyInit on Node 22.
  const body = new Blob([new Uint8Array(buf)], { type: photo.contentType });
  return new Response(body, {
    headers: {
      'Content-Type': photo.contentType,
      'Content-Length': String(buf.length),
      'Cache-Control': 'private, max-age=86400',
    },
  });
}
