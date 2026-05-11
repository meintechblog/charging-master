import { importProfile, isCatalogEnabled } from '@/modules/catalog';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  if (!isCatalogEnabled()) {
    return Response.json({ error: 'catalog_disabled' }, { status: 403 });
  }
  let body: { id?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'invalid_body' }, { status: 400 });
  }
  if (typeof body.id !== 'string' || !/^[a-f0-9]{16}$/.test(body.id)) {
    return Response.json({ error: 'invalid_id' }, { status: 400 });
  }
  const result = importProfile(body.id);
  if (!result) {
    return Response.json({ error: 'not_found' }, { status: 404 });
  }
  return Response.json(result);
}
