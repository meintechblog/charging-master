import { readPhoto, isCatalogEnabled } from '@/modules/catalog';

export const runtime = 'nodejs';

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  if (!isCatalogEnabled()) {
    return new Response('catalog disabled', { status: 403 });
  }
  const { id } = await context.params;
  const photo = readPhoto('charger', id);
  if (!photo) {
    return new Response('not found', { status: 404 });
  }
  return new Response(new Uint8Array(photo.buffer), {
    headers: {
      'Content-Type': photo.contentType,
      'Cache-Control': 'public, max-age=86400, immutable',
    },
  });
}
