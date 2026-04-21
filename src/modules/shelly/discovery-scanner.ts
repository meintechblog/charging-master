import { networkInterfaces } from 'os';

/**
 * HTTP-based subnet scanner for Shelly Gen2+ devices.
 * Probes each IP in the local /24 subnet via Shelly HTTP API.
 * Emits one ScanResult per switch component (multi-channel aware).
 */

export type ScanResult = {
  ip: string;
  deviceId: string;
  model: string;
  gen: number;
  channel: number;
  channelName: string | null;
  apower: number;
  output: boolean;
};

/**
 * Detect the local /24 subnet prefix from the server's network interfaces.
 * Returns e.g. "192.168.3" for a host at 192.168.3.100.
 */
export function getLocalSubnet(): string {
  const ifaces = networkInterfaces();

  for (const entries of Object.values(ifaces)) {
    if (!entries) continue;
    for (const entry of entries) {
      if (entry.family === 'IPv4' && !entry.internal) {
        const parts = entry.address.split('.');
        return `${parts[0]}.${parts[1]}.${parts[2]}`;
      }
    }
  }

  throw new Error('No suitable network interface found');
}

function extractSwitchName(configNode: unknown): string | null {
  if (!configNode || typeof configNode !== 'object') return null;
  const name = (configNode as { name?: unknown }).name;
  if (typeof name !== 'string') return null;
  const trimmed = name.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Probe a single IP for a Shelly device.
 * Returns one ScanResult per switch component, or null if the IP is not a Shelly.
 * Falls back to a single channel=0 result for older firmware that doesn't
 * expose Shelly.GetStatus / Shelly.GetConfig.
 */
export async function probeDevice(ip: string, timeoutMs: number): Promise<ScanResult[] | null> {
  try {
    const infoRes = await fetch(
      `http://${ip}/rpc/Shelly.GetDeviceInfo`,
      { signal: AbortSignal.timeout(timeoutMs) }
    );

    if (!infoRes.ok) return null;

    const info = await infoRes.json();
    const { id, model, gen } = info as { id: string; model: string; gen: number };

    // Fetch status + config in parallel. Either may fail on older firmware —
    // we degrade to the single-switch fallback below.
    const [statusRes, configRes] = await Promise.allSettled([
      fetch(`http://${ip}/rpc/Shelly.GetStatus`, {
        signal: AbortSignal.timeout(timeoutMs),
      }),
      fetch(`http://${ip}/rpc/Shelly.GetConfig`, {
        signal: AbortSignal.timeout(timeoutMs),
      }),
    ]);

    let statusBody: Record<string, unknown> | null = null;
    let configBody: Record<string, unknown> | null = null;

    if (statusRes.status === 'fulfilled' && statusRes.value.ok) {
      try {
        statusBody = (await statusRes.value.json()) as Record<string, unknown>;
      } catch {
        statusBody = null;
      }
    }
    if (configRes.status === 'fulfilled' && configRes.value.ok) {
      try {
        configBody = (await configRes.value.json()) as Record<string, unknown>;
      } catch {
        configBody = null;
      }
    }

    if (statusBody) {
      const channels: number[] = [];
      for (const key of Object.keys(statusBody)) {
        const match = key.match(/^switch:(\d+)$/);
        if (match) channels.push(Number(match[1]));
      }
      channels.sort((a, b) => a - b);

      if (channels.length > 0) {
        return channels.map((ch) => {
          const statusNode = statusBody![`switch:${ch}`] as
            | { apower?: number; output?: boolean }
            | undefined;
          const configNode = configBody?.[`switch:${ch}`];
          return {
            ip,
            deviceId: id,
            model,
            gen,
            channel: ch,
            channelName: extractSwitchName(configNode),
            apower: statusNode?.apower ?? 0,
            output: statusNode?.output ?? false,
          };
        });
      }
    }

    // Fallback: single-channel firmware that doesn't expose Shelly.GetStatus
    // in the multi-component shape. Probe the id=0 switch directly.
    let apower = 0;
    let output = false;
    let channelName: string | null = null;

    try {
      const s0 = await fetch(
        `http://${ip}/rpc/Switch.GetStatus?id=0`,
        { signal: AbortSignal.timeout(timeoutMs) }
      );
      if (s0.ok) {
        const s = await s0.json();
        apower = s.apower ?? 0;
        output = s.output ?? false;
      }
    } catch {
      // optional
    }

    try {
      const c0 = await fetch(
        `http://${ip}/rpc/Switch.GetConfig?id=0`,
        { signal: AbortSignal.timeout(timeoutMs) }
      );
      if (c0.ok) {
        channelName = extractSwitchName(await c0.json());
      }
    } catch {
      // optional
    }

    return [
      {
        ip,
        deviceId: id,
        model,
        gen,
        channel: 0,
        channelName,
        apower,
        output,
      },
    ];
  } catch {
    return null;
  }
}

/**
 * Scan the local /24 subnet for Shelly devices.
 * Probes IPs 1-254 in parallel batches. Each discovered switch (multi-channel
 * devices produce multiple results per IP) is fed through onDevice as soon as
 * the probe resolves.
 */
export async function scanSubnet(options?: {
  concurrency?: number;
  timeoutMs?: number;
  onProgress?: (scanned: number, total: number) => void;
  onDevice?: (device: ScanResult) => void;
}): Promise<ScanResult[]> {
  const concurrency = options?.concurrency ?? 20;
  const timeoutMs = options?.timeoutMs ?? 1500;
  const onProgress = options?.onProgress;
  const onDevice = options?.onDevice;

  const subnet = getLocalSubnet();
  const total = 254;
  const results: ScanResult[] = [];
  let scanned = 0;

  for (let start = 1; start <= total; start += concurrency) {
    const batchEnd = Math.min(start + concurrency - 1, total);
    const batch: Promise<ScanResult[] | null>[] = [];

    for (let i = start; i <= batchEnd; i++) {
      batch.push(probeDevice(`${subnet}.${i}`, timeoutMs));
    }

    const batchResults = await Promise.all(batch);

    for (const probeResult of batchResults) {
      if (!probeResult) continue;
      for (const device of probeResult) {
        results.push(device);
        onDevice?.(device);
      }
    }

    scanned = batchEnd;
    onProgress?.(scanned, total);
  }

  return results;
}
