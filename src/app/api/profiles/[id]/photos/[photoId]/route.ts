import { db } from '@/db/client';
import { profilePhotos } from '@/db/schema';
import { eq, and, ne } from 'drizzle-orm';
import { unlinkSync } from 'node:fs';
import { resolve, join } from 'node:path';

export const runtime = 'nodejs';

const PROFILE_PHOTOS_ROOT = resolve(process.cwd(), 'data/profile-photos');

function parseIds(profileIdStr: string, photoIdStr: string) {
  const profileId = parseInt(profileIdStr, 10);
  const photoId = parseInt(photoIdStr, 10);
  if (isNaN(profileId) || isNaN(photoId)) return null;
  return { profileId, photoId };
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string; photoId: string }> }
) {
  const { id, photoId: pid } = await context.params;
  const ids = parseIds(id, pid);
  if (!ids) return Response.json({ error: 'invalid_id' }, { status: 400 });

  const photo = db.select().from(profilePhotos).where(eq(profilePhotos.id, ids.photoId)).get();
  if (!photo || photo.profileId !== ids.profileId) {
    return Response.json({ error: 'not_found' }, { status: 404 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'invalid_body' }, { status: 400 });
  }

  const updates: Record<string, unknown> = {};
  if (body.isPrimary === true) {
    db.update(profilePhotos)
      .set({ isPrimary: false })
      .where(and(eq(profilePhotos.profileId, ids.profileId), ne(profilePhotos.id, ids.photoId)))
      .run();
    updates.isPrimary = true;
  } else if (body.isPrimary === false) {
    updates.isPrimary = false;
  }

  if (typeof body.caption === 'string') {
    updates.caption = body.caption.trim() || null;
  } else if (body.caption === null) {
    updates.caption = null;
  }

  if (Object.keys(updates).length === 0) {
    return Response.json({ error: 'nothing_to_update' }, { status: 400 });
  }

  db.update(profilePhotos).set(updates).where(eq(profilePhotos.id, ids.photoId)).run();
  const updated = db.select().from(profilePhotos).where(eq(profilePhotos.id, ids.photoId)).get();
  return Response.json({ photo: updated });
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string; photoId: string }> }
) {
  const { id, photoId: pid } = await context.params;
  const ids = parseIds(id, pid);
  if (!ids) return Response.json({ error: 'invalid_id' }, { status: 400 });

  const photo = db.select().from(profilePhotos).where(eq(profilePhotos.id, ids.photoId)).get();
  if (!photo || photo.profileId !== ids.profileId) {
    return Response.json({ error: 'not_found' }, { status: 404 });
  }

  try {
    unlinkSync(join(PROFILE_PHOTOS_ROOT, String(ids.profileId), photo.fileName));
  } catch {
    // file may already be gone — proceed with DB delete
  }

  db.delete(profilePhotos).where(eq(profilePhotos.id, ids.photoId)).run();

  // If we deleted the primary, promote the next-oldest survivor (if any).
  if (photo.isPrimary) {
    const successor = db.select()
      .from(profilePhotos)
      .where(eq(profilePhotos.profileId, ids.profileId))
      .all()[0];
    if (successor) {
      db.update(profilePhotos)
        .set({ isPrimary: true })
        .where(eq(profilePhotos.id, successor.id))
        .run();
    }
  }

  return Response.json({ ok: true });
}
