import { networkInterfaces } from 'os';

/**
 * HTTP-based subnet scanner for Shelly Plug S Gen3 devices.
 * Probes each IP in the local /24 subnet via Shelly HTTP API.
 */

export type ScanResult = {
  ip: string;
  deviceId: string;
  model: string;
  gen: number;
  apower: number;
  output: boolean;
  channelName: string | null;
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

/**
 * Probe a single IP for a Shelly device.
 * Returns ScanResult if a Shelly device responds, null otherwise.
 */
export async function probeDevice(ip: string, timeoutMs: number): Promise<ScanResult | null> {
  try {
    const infoRes = await fetch(
      `http://${ip}/rpc/Shelly.GetDeviceInfo`,
      { signal: AbortSignal.timeout(timeoutMs) }
    );

    if (!infoRes.ok) return null;

    const info = await infoRes.json();
    const { id, model, gen } = info as { id: string; model: string; gen: number };

    // Fetch current switch status for power reading
    let apower = 0;
    let output = false;
    let channelName: string | null = null;

    try {
      const statusRes = await fetch(
        `http://${ip}/rpc/Switch.GetStatus?id=0`,
        { signal: AbortSignal.timeout(timeoutMs) }
      );

      if (statusRes.ok) {
        const status = await statusRes.json();
        apower = status.apower ?? 0;
        output = status.output ?? false;
      }
    } catch {
      // Switch status is optional -- device info is enough
    }

    try {
      const cfgRes = await fetch(
        `http://${ip}/rpc/Switch.GetConfig?id=0`,
        { signal: AbortSignal.timeout(timeoutMs) }
      );

      if (cfgRes.ok) {
        const cfg = await cfgRes.json();
        const raw = typeof cfg?.name === 'string' ? cfg.name.trim() : '';
        channelName = raw.length > 0 ? raw : null;
      }
    } catch {
      // Channel name is optional
    }

    return { ip, deviceId: id, model, gen, apower, output, channelName };
  } catch {
    return null;
  }
}

/**
 * Scan the local /24 subnet for Shelly devices.
 * Probes IPs 1-254 in parallel batches.
 *
 * @param options.concurrency - Number of parallel probes (default: 20)
 * @param options.timeoutMs - Per-IP timeout in ms (default: 1500)
 * @param options.onProgress - Callback with (scanned, total) after each batch
 * @returns Array of discovered Shelly devices
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

  // Scan in batches of `concurrency`
  for (let start = 1; start <= total; start += concurrency) {
    const batchEnd = Math.min(start + concurrency - 1, total);
    const batch: Promise<ScanResult | null>[] = [];

    for (let i = start; i <= batchEnd; i++) {
      batch.push(probeDevice(`${subnet}.${i}`, timeoutMs));
    }

    const batchResults = await Promise.all(batch);

    for (const result of batchResults) {
      if (result) {
        results.push(result);
        onDevice?.(result);
      }
    }

    scanned = batchEnd;
    onProgress?.(scanned, total);
  }

  return results;
}
