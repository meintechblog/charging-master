import { findMatches, isCatalogEnabled } from '@/modules/catalog';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  if (!isCatalogEnabled()) {
    return Response.json({ error: 'catalog_disabled' }, { status: 403 });
  }
  let body: { points?: Array<{ offsetSeconds: number; apower: number }>; topN?: number; minSimilarity?: number };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'invalid_body' }, { status: 400 });
  }
  if (!Array.isArray(body.points) || body.points.length < 2) {
    return Response.json({ error: 'invalid_points' }, { status: 400 });
  }
  const matches = findMatches(body.points, {
    topN: body.topN,
    minSimilarity: body.minSimilarity,
  });
  return Response.json({ matches });
}
