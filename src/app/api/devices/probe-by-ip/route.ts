import { isPrivateIpv4 } from '@/modules/shelly/relay-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type ProbeTarget = { ip: string; channel?: number };

type ProbeResult = {
  ip: string;
  channel: number;
  ok: boolean;
  apower?: number;
  output?: boolean;
};

const MAX_TARGETS = 32;
const PROBE_TIMEOUT_MS = 1500;

async function probeOne(target: ProbeTarget): Promise<ProbeResult> {
  const ch = Number.isInteger(target.channel) && (target.channel as number) >= 0
    ? (target.channel as number)
    : 0;
  try {
    const res = await fetch(
      `http://${target.ip}/rpc/Switch.GetStatus?id=${ch}`,
      { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) }
    );
    if (!res.ok) return { ip: target.ip, channel: ch, ok: false };
    const status = (await res.json()) as { apower?: number; output?: boolean };
    return {
      ip: target.ip,
      channel: ch,
      ok: true,
      apower: typeof status.apower === 'number' ? status.apower : 0,
      output: typeof status.output === 'boolean' ? status.output : false,
    };
  } catch {
    return { ip: target.ip, channel: ch, ok: false };
  }
}

export async function POST(request: Request) {
  let body: { targets?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'invalid_body' }, { status: 400 });
  }

  if (!Array.isArray(body.targets)) {
    return Response.json({ error: 'targets_required' }, { status: 400 });
  }

  if (body.targets.length === 0) {
    return Response.json({ results: [] });
  }

  if (body.targets.length > MAX_TARGETS) {
    return Response.json(
      { error: 'too_many_targets', max: MAX_TARGETS },
      { status: 400 }
    );
  }

  const targets: ProbeTarget[] = [];
  for (const raw of body.targets) {
    if (!raw || typeof raw !== 'object') {
      return Response.json({ error: 'invalid_target' }, { status: 400 });
    }
    const ip = (raw as { ip?: unknown }).ip;
    const channel = (raw as { channel?: unknown }).channel;
    if (typeof ip !== 'string' || !isPrivateIpv4(ip)) {
      return Response.json(
        { error: 'not_private_ip', allowed: '10/8, 172.16/12, 192.168/16, 127/8' },
        { status: 400 }
      );
    }
    if (channel !== undefined) {
      if (!Number.isInteger(channel) || (channel as number) < 0 || (channel as number) > 7) {
        return Response.json({ error: 'invalid_channel', valid: '0-7 integer' }, { status: 400 });
      }
    }
    targets.push({ ip, channel: typeof channel === 'number' ? channel : 0 });
  }

  const results = await Promise.all(targets.map(probeOne));
  return Response.json({ results });
}
