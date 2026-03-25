import { db } from '@/db/client';
import { plugs } from '@/db/schema';
import { eq } from 'drizzle-orm';

export const runtime = 'nodejs';

const VALID_COMMANDS = new Set(['on', 'off', 'toggle']);

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

  if (!body.command || !VALID_COMMANDS.has(body.command)) {
    return Response.json({ error: 'invalid_command' }, { status: 400 });
  }

  const command = body.command as 'on' | 'off' | 'toggle';

  const mqttService = globalThis.__mqttService;
  if (!mqttService?.isConnected()) {
    return Response.json({ error: 'mqtt_disconnected' }, { status: 503 });
  }

  const plug = db.select().from(plugs).where(eq(plugs.id, id)).get();
  if (!plug) {
    return Response.json({ error: 'plug_not_found' }, { status: 404 });
  }

  mqttService.publishCommand(plug.mqttTopicPrefix, command);

  return Response.json({ ok: true, command });
}
