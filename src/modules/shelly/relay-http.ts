/**
 * HTTP relay control for Shelly Plug S Gen3 devices.
 * Pure HTTP functions -- no MQTT dependency.
 */

// Strict dotted-quad + RFC1918 + loopback. Prevents using relay endpoints
// as a generic HTTP proxy into anything on the public internet.
export function isPrivateIpv4(ip: string): boolean {
  if (typeof ip !== 'string') return false;
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const o = m.slice(1).map((s) => Number(s));
  if (o.some((n) => n < 0 || n > 255)) return false;
  if (o[0] === 10) return true;
  if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true;
  if (o[0] === 192 && o[1] === 168) return true;
  if (o[0] === 127) return true;
  return false;
}

/**
 * Switch relay on via Shelly HTTP API.
 * Returns true if the command was acknowledged.
 */
export async function switchRelayOnHttp(ipAddress: string): Promise<boolean> {
  try {
    const res = await fetch(
      `http://${ipAddress}/rpc/Switch.Set?id=0&on=true`,
      { signal: AbortSignal.timeout(3000) }
    );
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Switch relay off via Shelly HTTP API.
 * Returns true if the command was acknowledged.
 */
export async function switchRelayOffHttp(ipAddress: string): Promise<boolean> {
  try {
    const res = await fetch(
      `http://${ipAddress}/rpc/Switch.Set?id=0&on=false`,
      { signal: AbortSignal.timeout(3000) }
    );
    return res.ok;
  } catch {
    return false;
  }
}
