import { db } from '@/db/client';
import { plugs } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { switchRelayOnHttp, switchRelayOffHttp } from '@/modules/shelly/relay-http';

export const runtime = 'nodejs';

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;

  let body: { command?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'invalid_body' }, { status: 400 });
  }

  const command = body.command;
  if (command !== 'on' && command !== 'off') {
    return Response.json({ error: 'invalid_command', valid: ['on', 'off'] }, { status: 400 });
  }

  const plug = db.select().from(plugs).where(eq(plugs.id, id)).get();
  if (!plug) {
    return Response.json({ error: 'plug_not_found' }, { status: 404 });
  }

  if (!plug.ipAddress) {
    return Response.json({ error: 'no_ip_address' }, { status: 422 });
  }

  const success = command === 'on'
    ? await switchRelayOnHttp(plug.ipAddress)
    : await switchRelayOffHttp(plug.ipAddress);

  if (!success) {
    return Response.json({ error: 'device_unreachable' }, { status: 502 });
  }

  return Response.json({ ok: true, command });
}
