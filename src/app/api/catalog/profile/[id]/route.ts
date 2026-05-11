import { loadProfile, loadCurvePoints, isCatalogEnabled } from '@/modules/catalog';

export const runtime = 'nodejs';

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  if (!isCatalogEnabled()) {
    return Response.json({ error: 'catalog_disabled' }, { status: 403 });
  }
  const { id } = await context.params;
  const profile = loadProfile(id);
  if (!profile) {
    return Response.json({ error: 'not_found' }, { status: 404 });
  }
  const points = loadCurvePoints(id);
  return Response.json({ ...profile, curvePoints: points });
}
