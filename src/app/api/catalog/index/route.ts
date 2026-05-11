import { loadIndex, isCatalogEnabled } from '@/modules/catalog';

export const runtime = 'nodejs';

export async function GET() {
  if (!isCatalogEnabled()) {
    return Response.json({ error: 'catalog_disabled' }, { status: 403 });
  }
  const idx = loadIndex();
  if (!idx) {
    return Response.json({ error: 'catalog_unavailable' }, { status: 503 });
  }
  return Response.json(idx);
}
