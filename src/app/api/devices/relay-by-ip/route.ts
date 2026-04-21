import {
  switchRelayOnHttp,
  switchRelayOffHttp,
  isPrivateIpv4,
} from '@/modules/shelly/relay-http';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  let body: { ip?: string; command?: string; channel?: number };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'invalid_body' }, { status: 400 });
  }

  const { ip, command, channel } = body;

  if (!ip || typeof ip !== 'string' || !isPrivateIpv4(ip)) {
    return Response.json(
      { error: 'not_private_ip', allowed: '10/8, 172.16/12, 192.168/16, 127/8' },
      { status: 400 }
    );
  }

  if (command !== 'on' && command !== 'off') {
    return Response.json(
      { error: 'invalid_command', valid: ['on', 'off'] },
      { status: 400 }
    );
  }

  let ch = 0;
  if (channel !== undefined) {
    if (!Number.isInteger(channel) || channel < 0 || channel > 7) {
      return Response.json(
        { error: 'invalid_channel', valid: '0-7 integer' },
        { status: 400 }
      );
    }
    ch = channel;
  }

  const success =
    command === 'on' ? await switchRelayOnHttp(ip, ch) : await switchRelayOffHttp(ip, ch);

  if (!success) {
    return Response.json({ error: 'device_unreachable' }, { status: 502 });
  }

  return Response.json({ ok: true, command, channel: ch });
}
