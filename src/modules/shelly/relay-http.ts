/**
 * HTTP relay control for Shelly Plug S Gen3 devices.
 * Pure HTTP functions -- no MQTT dependency.
 */

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
