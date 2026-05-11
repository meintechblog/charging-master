import { loadCharger, isCatalogEnabled } from '@/modules/catalog';

export const runtime = 'nodejs';

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  if (!isCatalogEnabled()) {
    return Response.json({ error: 'catalog_disabled' }, { status: 403 });
  }
  const { id } = await context.params;
  const charger = loadCharger(id);
  if (!charger) {
    return Response.json({ error: 'not_found' }, { status: 404 });
  }
  return Response.json(charger);
}
