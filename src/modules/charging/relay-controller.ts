/**
 * Relay Controller -- switches Shelly relay via HTTP API.
 *
 * Strategy:
 * 1. Send HTTP relay command via Shelly RPC
 * 2. Wait 3 seconds, check if power dropped (for off commands)
 * 3. Retry up to 3 times if verification fails
 *
 * Includes hysteresis cooldown to prevent rapid on/off cycling (CHRG-07).
 */

import { switchRelayOffHttp, switchRelayOnHttp } from '../shelly/relay-http';
import type { EventBus, PowerReading } from '../events/event-bus';

const VERIFY_DELAY_MS = 3000;
const MAX_HTTP_RETRIES = 3;
const POWER_OFF_THRESHOLD = 5; // watts

/** Minimum time between relay off commands to prevent rapid cycling */
export const HYSTERESIS_COOLDOWN_MS = 60_000;

/**
 * Wait for a power reading below threshold on the given plug.
 * Returns true if power drops within the timeout.
 */
function waitForPowerDrop(
  eventBus: EventBus,
  plugId: string,
  timeoutMs: number
): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      eventBus.removeListener(`power:${plugId}`, handler);
      resolve(false);
    }, timeoutMs);

    function handler(reading: PowerReading) {
      if (reading.apower < POWER_OFF_THRESHOLD) {
        clearTimeout(timer);
        eventBus.removeListener(`power:${plugId}`, handler);
        resolve(true);
      }
    }

    eventBus.on(`power:${plugId}`, handler);
  });
}

/**
 * Attempt to switch off the relay for a plug via HTTP.
 * Returns true if relay was confirmed off.
 */
export async function switchRelayOff(
  plug: { id: string; ipAddress: string; channel?: number },
  eventBus: EventBus
): Promise<boolean> {
  for (let retry = 0; retry < MAX_HTTP_RETRIES; retry++) {
    const ok = await switchRelayOffHttp(plug.ipAddress, plug.channel ?? 0);
    if (ok) {
      const verified = await waitForPowerDrop(eventBus, plug.id, VERIFY_DELAY_MS);
      if (verified) return true;
    }
  }

  return false; // All attempts failed
}

/**
 * Attempt to switch on the relay for a plug via HTTP.
 * Returns true if the command was acknowledged.
 */
export async function switchRelayOn(
  plug: { id: string; ipAddress: string; channel?: number }
): Promise<boolean> {
  return switchRelayOnHttp(plug.ipAddress, plug.channel ?? 0);
}

/**
 * Check if relay switching is allowed (hysteresis guard).
 * Returns true if enough time has passed since last relay off.
 */
export function canSwitchRelay(lastRelayOffAt: number): boolean {
  return Date.now() - lastRelayOffAt > HYSTERESIS_COOLDOWN_MS;
}
